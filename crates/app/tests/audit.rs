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
async fn only_administrators_can_read_real_registration_audit_events(pool: PgPool) {
    let app = labos_threejs_app::router(pool);
    let owner = register(&app, "audit-owner@example.com").await;
    let member = register(&app, "audit-member@example.com").await;
    let response = request(&app, &owner, "GET", "/api/v1/audit-events", json!(null)).await;
    assert_eq!(response.status(), StatusCode::OK);
    let page = data(response).await;
    assert_eq!(page["data"].as_array().unwrap().len(), 2);
    assert_eq!(page["data"][0]["actor_id"], member.id);
    assert_eq!(page["data"][0]["action"], "identity.register");
    assert_eq!(page["data"][0]["resource_id"], member.id);
    assert!(page["data"][0]["request_id"].is_string());
    assert!(!page.to_string().contains("a-long-test-password"));
    assert!(!page.to_string().contains("@example.com"));
    assert_eq!(
        request(&app, &member, "GET", "/api/v1/audit-events", json!(null))
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        app.oneshot(
            Request::get("/api/v1/audit-events")
                .body(Body::empty())
                .unwrap()
        )
        .await
        .unwrap()
        .status(),
        StatusCode::UNAUTHORIZED
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn administrators_filter_page_and_recheck_current_role_for_audit_history(pool: PgPool) {
    let app = labos_threejs_app::router(pool);
    let owner = register(&app, "page-owner@example.com").await;
    let admin = register(&app, "page-admin@example.com").await;
    register(&app, "page-third@example.com").await;
    let promote = format!("/api/v1/organization/members/{}", admin.id);
    assert_eq!(
        request(
            &app,
            &owner,
            "PUT",
            &promote,
            json!({"role":"admin", "active":true, "version":1})
        )
        .await
        .status(),
        StatusCode::OK
    );
    let first = data(
        request(
            &app,
            &admin,
            "GET",
            "/api/v1/audit-events?action=identity.register&limit=2",
            json!(null),
        )
        .await,
    )
    .await;
    assert_eq!(first["data"].as_array().unwrap().len(), 2);
    assert_eq!(first["has_more"], true);
    let cursor = first["next_cursor"].as_str().unwrap();
    let path = format!("/api/v1/audit-events?action=identity.register&limit=2&cursor={cursor}");
    let second = data(request(&app, &admin, "GET", &path, json!(null)).await).await;
    assert_eq!(second["data"].as_array().unwrap().len(), 1);
    assert_eq!(second["data"][0]["actor_id"], owner.id);
    assert_eq!(
        request(&app, &owner, "GET", &path, json!(null))
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        request(
            &app,
            &admin,
            "GET",
            &format!("{path}&resource_id={}", owner.id),
            json!(null)
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );
    let page = data(
        request(
            &app,
            &admin,
            "GET",
            &format!(
                "/api/v1/audit-events?actor_id={}&resource_type=identity.user",
                owner.id
            ),
            json!(null),
        )
        .await,
    )
    .await;
    assert_eq!(page["data"].as_array().unwrap().len(), 1);
    for query in [
        "limit=0",
        "limit=101",
        "cursor=broken",
        "actor_id=invalid",
        "job_id=invalid",
        "action=%00",
        "resource_id=%00",
    ] {
        assert_eq!(
            request(
                &app,
                &admin,
                "GET",
                &format!("/api/v1/audit-events?{query}"),
                json!(null)
            )
            .await
            .status(),
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(
        request(
            &app,
            &owner,
            "PUT",
            &promote,
            json!({"role":"member", "active":true, "version":2})
        )
        .await
        .status(),
        StatusCode::OK
    );
    assert_eq!(
        request(&app, &admin, "GET", &path, json!(null))
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
}
