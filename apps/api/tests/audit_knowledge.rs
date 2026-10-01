use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
    response::Response,
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

struct Browser {
    id: String,
    cookie: String,
    csrf: String,
}
async fn data(response: Response) -> Value {
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}
async fn register(app: &Router, email: &str) -> Browser {
    let response = app
        .clone()
        .oneshot(
            Request::post("/api/v1/auth/register")
                .header("origin", "http://127.0.0.1:5173")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"email":email,"password":"a-long-test-password"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let cookie = response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let result = data(response).await;
    Browser {
        id: result["user"]["id"].as_str().unwrap().into(),
        cookie,
        csrf: result["csrf_token"].as_str().unwrap().into(),
    }
}
async fn request(app: &Router, actor: &Browser, method: &str, path: &str, body: Value) -> Response {
    request_key(
        app,
        actor,
        method,
        path,
        body,
        &uuid::Uuid::now_v7().to_string(),
    )
    .await
}
async fn request_key(
    app: &Router,
    actor: &Browser,
    method: &str,
    path: &str,
    body: Value,
    key: &str,
) -> Response {
    app.clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("origin", "http://127.0.0.1:5173")
                .header("content-type", "application/json")
                .header("cookie", &actor.cookie)
                .header("x-csrf-token", &actor.csrf)
                .header("idempotency-key", key)
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap()
}

#[sqlx::test(migrations = "../../migrations")]
async fn document_and_grant_audits_have_safe_resource_actor_and_request_context(pool: PgPool) {
    let app = labos_threejs_api::router(pool, Default::default());
    let owner = register(&app, "trace-owner@example.com").await;
    let member = register(&app, "trace-member@example.com").await;
    let response = request(
        &app,
        &owner,
        "POST",
        "/api/v1/knowledge/documents",
        json!({"title":"private title", "markdown":"private document body"}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let request_id = response.headers()["x-request-id"]
        .to_str()
        .unwrap()
        .to_owned();
    let doc = data(response).await;
    let document_id = doc["id"].as_str().unwrap();
    let page = data(
        request(
            &app,
            &owner,
            "GET",
            &format!("/api/v1/audit-events?resource_id={document_id}"),
            json!(null),
        )
        .await,
    )
    .await;
    assert_eq!(page["data"].as_array().unwrap().len(), 1);
    let event = &page["data"][0];
    assert_eq!(event["actor_type"], "user");
    assert_eq!(event["actor_id"], owner.id);
    assert_eq!(event["resource_type"], "knowledge.document");
    assert_eq!(event["request_id"], request_id);
    assert_eq!(event["correlation_id"], request_id);
    assert_eq!(event["metadata"], json!({}));
    assert_eq!(event["job_id"], Value::Null);
    assert_eq!(event["trace_id"], Value::Null);
    assert!(!page.to_string().contains("private"));
    let base_id = doc["knowledge_base_id"].as_str().unwrap();
    let response = request(
        &app,
        &owner,
        "PUT",
        &format!("/api/v1/knowledge/bases/{base_id}/grants/{}", member.id),
        json!({"access":"reader"}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let request_id = response.headers()["x-request-id"]
        .to_str()
        .unwrap()
        .to_owned();
    let page = data(request(&app, &owner, "GET", &format!("/api/v1/audit-events?resource_id={base_id}&action=knowledge.grant.assign&request_id={request_id}"), json!(null)).await).await;
    assert_eq!(page["data"].as_array().unwrap().len(), 1);
    assert_eq!(
        page["data"][0]["metadata"],
        json!({"subject_user_id":member.id})
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn failed_document_mutations_leave_no_success_audit_and_preserve_the_document(pool: PgPool) {
    let app = labos_threejs_api::router(pool.clone(), Default::default());
    let owner = register(&app, "atomic-audit@example.com").await;
    let document = data(
        request(
            &app,
            &owner,
            "POST",
            "/api/v1/knowledge/documents",
            json!({"title":"Original", "markdown":"private-original-body"}),
        )
        .await,
    )
    .await;
    let document_id = document["id"].as_str().unwrap();
    let path = format!("/api/v1/knowledge/documents/{document_id}");
    sqlx::raw_sql("CREATE FUNCTION reject_document_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'knowledge.document.update' THEN RAISE EXCEPTION 'test audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_document_audit BEFORE INSERT ON labos_threejs_core.audit_events FOR EACH ROW EXECUTE FUNCTION reject_document_audit();").execute(&pool).await.unwrap();
    let failed = request(
        &app,
        &owner,
        "PUT",
        &path,
        json!({"title":"Changed", "markdown":"private-changed-body", "version":1}),
    )
    .await;
    assert_eq!(failed.status(), StatusCode::SERVICE_UNAVAILABLE);
    let request_id = failed.headers()["x-request-id"].to_str().unwrap();
    let page = data(
        request(
            &app,
            &owner,
            "GET",
            &format!("/api/v1/audit-events?request_id={request_id}"),
            json!(null),
        )
        .await,
    )
    .await;
    assert_eq!(page["data"], json!([]));
    assert_eq!(
        data(request(&app, &owner, "GET", &path, json!(null)).await).await["title"],
        "Original"
    );
    sqlx::query("DROP TRIGGER reject_document_audit ON labos_threejs_core.audit_events")
        .execute(&pool)
        .await
        .unwrap();
    let saved = request(
        &app,
        &owner,
        "PUT",
        &path,
        json!({"title":"Changed", "markdown":"private-changed-body", "version":1}),
    )
    .await;
    assert_eq!(saved.status(), StatusCode::OK);
    let request_id = saved.headers()["x-request-id"].to_str().unwrap();
    let page = data(
        request(
            &app,
            &owner,
            "GET",
            &format!(
                "/api/v1/audit-events?request_id={request_id}&action=knowledge.document.update"
            ),
            json!(null),
        )
        .await,
    )
    .await;
    assert_eq!(page["data"].as_array().unwrap().len(), 1);
    assert_eq!(page["data"][0]["resource_id"], document_id);
    assert!(!page.to_string().contains("private-changed-body"));
}
