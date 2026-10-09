use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
    response::Response,
};
use http_body_util::BodyExt;
use labos_threejs_app::modules::jobs::{self, JobError, NewJob};
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
async fn an_admin_retries_a_failed_job_with_history_and_a_finite_new_batch(pool: PgPool) {
    let app = labos_threejs_api::router(pool.clone(), Default::default());
    let owner = register(&app, "job-owner@example.com").await;
    let member = register(&app, "job-member@example.com").await;
    assert_ne!(owner.id, member.id);
    let mut connection = pool.begin().await.unwrap();
    let id = jobs::enqueue(
        &mut connection,
        NewJob {
            kind: "test.recover",
            schema_version: 1,
            max_attempts: 5,
            payload: json!({"resource_id":"opaque-resource"}),
            correlation_id: "retry-history",
        },
    )
    .await
    .unwrap();
    connection.commit().await.unwrap();
    let first = jobs::claim(&pool, &["test.recover"], "first-worker", 60)
        .await
        .unwrap()
        .unwrap();
    first
        .fail(&pool, &JobError::Permanent("test.requires_operator"))
        .await
        .unwrap();
    let retry_path = format!("/api/v1/jobs/{id}/retry");
    assert_eq!(
        request_key(
            &app,
            &member,
            "POST",
            &retry_path,
            json!({}),
            "retry-command"
        )
        .await
        .status(),
        StatusCode::FORBIDDEN
    );
    let retried = request_key(
        &app,
        &owner,
        "POST",
        &retry_path,
        json!({}),
        "retry-command",
    )
    .await;
    assert_eq!(retried.status(), StatusCode::ACCEPTED);
    let retried = data(retried).await;
    assert_eq!(retried["id"], id);
    assert_eq!(retried["status"], "queued");
    assert_eq!(retried["batch"], 2);
    assert_eq!(retried["attempts"], 0);
    assert_eq!(retried["max_attempts"], 5);
    let replay = data(
        request_key(
            &app,
            &owner,
            "POST",
            &retry_path,
            json!({}),
            "retry-command",
        )
        .await,
    )
    .await;
    assert_eq!(replay["batch"], 2);
    let second = jobs::claim(&pool, &["test.recover"], "second-worker", 60)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(second.id, first.id);
    let mut tx = pool.begin().await.unwrap();
    second.succeed(&mut tx).await.unwrap();
    tx.commit().await.unwrap();
    let detail = data(
        request(
            &app,
            &owner,
            "GET",
            &format!("/api/v1/jobs/{id}"),
            json!(null),
        )
        .await,
    )
    .await;
    assert_eq!(detail["job"]["status"], "succeeded");
    assert_eq!(detail["batches"].as_array().unwrap().len(), 2);
    assert_eq!(detail["attempts"].as_array().unwrap().len(), 2);
    assert_eq!(detail["attempts"][0]["status"], "succeeded");
    assert_eq!(detail["attempts"][1]["status"], "failed");
    assert_eq!(
        detail["attempts"][1]["last_error"],
        "test.requires_operator"
    );
    assert!(detail["job"].get("payload").is_none());
    assert_eq!(
        request(
            &app,
            &member,
            "GET",
            &format!("/api/v1/jobs/{id}"),
            json!(null)
        )
        .await
        .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request(&app, &owner, "POST", &retry_path, json!({}))
            .await
            .status(),
        StatusCode::CONFLICT
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn administrators_page_and_filter_safe_job_metadata(pool: PgPool) {
    let app = labos_threejs_api::router(pool.clone(), Default::default());
    let owner = register(&app, "list-owner@example.com").await;
    let member = register(&app, "list-member@example.com").await;
    for i in 0..3 {
        let mut tx = pool.begin().await.unwrap();
        jobs::enqueue(
            &mut tx,
            NewJob {
                kind: "test.list",
                schema_version: 1,
                max_attempts: 5,
                payload: json!({"hidden":"never-return-this"}),
                correlation_id: &format!("list-{i}"),
            },
        )
        .await
        .unwrap();
        tx.commit().await.unwrap();
        let lease = jobs::claim(&pool, &["test.list"], "test-worker", 60)
            .await
            .unwrap()
            .unwrap();
        lease
            .fail(&pool, &JobError::Permanent("test.final_failure"))
            .await
            .unwrap();
    }
    assert_eq!(
        request(&app, &member, "GET", "/api/v1/jobs", json!(null))
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    let first = request(
        &app,
        &owner,
        "GET",
        "/api/v1/jobs?status=failed&limit=2",
        json!(null),
    )
    .await;
    assert_eq!(first.status(), StatusCode::OK);
    let first = data(first).await;
    assert_eq!(first["data"].as_array().unwrap().len(), 2);
    assert_eq!(first["has_more"], true);
    assert!(first["data"][0].get("payload").is_none());
    assert!(first["data"][0].get("lease_token").is_none());
    let cursor = first["next_cursor"].as_str().unwrap();
    let second = data(
        request(
            &app,
            &owner,
            "GET",
            &format!("/api/v1/jobs?status=failed&limit=2&cursor={cursor}"),
            json!(null),
        )
        .await,
    )
    .await;
    assert_eq!(second["data"].as_array().unwrap().len(), 1);
    assert_ne!(second["data"][0]["id"], first["data"][0]["id"]);
    assert_eq!(
        request(
            &app,
            &owner,
            "GET",
            &format!("/api/v1/jobs?status=queued&cursor={cursor}"),
            json!(null)
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn retry_audit_failure_rolls_back_the_batch_and_concurrent_replays_share_one_batch(
    pool: PgPool,
) {
    let app = labos_threejs_api::router(pool.clone(), Default::default());
    let owner = register(&app, "retry-atomic@example.com").await;
    let mut tx = pool.begin().await.unwrap();
    let id = jobs::enqueue(
        &mut tx,
        NewJob {
            kind: "test.atomic",
            schema_version: 1,
            max_attempts: 2,
            payload: json!({}),
            correlation_id: "retry-atomic",
        },
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let lease = jobs::claim(&pool, &["test.atomic"], "worker", 60)
        .await
        .unwrap()
        .unwrap();
    lease
        .fail(&pool, &JobError::Permanent("test.failure"))
        .await
        .unwrap();
    let retry = format!("/api/v1/jobs/{id}/retry");
    sqlx::raw_sql("CREATE FUNCTION reject_job_retry_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'jobs.retry' THEN RAISE EXCEPTION 'test audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_job_retry_audit BEFORE INSERT ON labos_threejs_core.audit_events FOR EACH ROW EXECUTE FUNCTION reject_job_retry_audit();").execute(&pool).await.unwrap();
    assert_eq!(
        request_key(&app, &owner, "POST", &retry, json!({}), "atomic-retry")
            .await
            .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    let after = data(
        request(
            &app,
            &owner,
            "GET",
            &format!("/api/v1/jobs/{id}"),
            json!(null),
        )
        .await,
    )
    .await;
    assert_eq!(after["job"]["status"], "failed");
    assert_eq!(after["job"]["batch"], 1);
    assert_eq!(after["batches"].as_array().unwrap().len(), 1);
    sqlx::query("DROP TRIGGER reject_job_retry_audit ON labos_threejs_core.audit_events")
        .execute(&pool)
        .await
        .unwrap();
    let (one, two) = tokio::join!(
        request_key(&app, &owner, "POST", &retry, json!({}), "atomic-retry"),
        request_key(&app, &owner, "POST", &retry, json!({}), "atomic-retry")
    );
    assert_eq!(one.status(), StatusCode::ACCEPTED);
    assert_eq!(two.status(), StatusCode::ACCEPTED);
    let (one, two) = (data(one).await, data(two).await);
    assert_eq!(one["batch"], 2);
    assert_eq!(two["batch"], 2);
    assert_eq!(
        request(&app, &owner, "POST", &retry, json!({}))
            .await
            .status(),
        StatusCode::CONFLICT
    );
    let after = data(
        request(
            &app,
            &owner,
            "GET",
            &format!("/api/v1/jobs/{id}"),
            json!(null),
        )
        .await,
    )
    .await;
    assert_eq!(after["batches"].as_array().unwrap().len(), 2);
    assert_eq!(after["job"]["max_attempts"], 2);
}
