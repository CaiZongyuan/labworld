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
async fn a_signed_in_user_has_an_empty_private_inbox(pool: PgPool) {
    let app = labos_threejs_app::router(pool);
    let actor = register(&app, "inbox@example.com").await;
    let response = request(&app, &actor, "GET", "/api/v1/notifications", json!(null)).await;
    assert_eq!(response.status(), StatusCode::OK);
    let page = data(response).await;
    assert_eq!(page["data"], json!([]));
    assert_eq!(page["unread_count"], 0);
    assert_eq!(page["has_more"], false);
    assert_eq!(
        app.oneshot(
            Request::get("/api/v1/notifications")
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
async fn a_job_outcome_belongs_only_to_its_recipient_and_read_state_survives_refresh(pool: PgPool) {
    use labos_threejs_app::modules::{jobs, notifications};
    let app = labos_threejs_app::router(pool.clone());
    let owner = register(&app, "admin-inbox@example.com").await;
    let actor = register(&app, "private-inbox@example.com").await;
    let mut tx = pool.begin().await.unwrap();
    let job = jobs::enqueue(
        &mut tx,
        jobs::NewJob {
            kind: "test.notify",
            schema_version: 1,
            max_attempts: 2,
            payload: json!({}),
            correlation_id: "notice",
        },
    )
    .await
    .unwrap();
    notifications::on_job_outcome(
        &mut tx,
        &job,
        notifications::JobNotification {
            recipient_id: &actor.id,
            event_key: "report:one",
            subject: "报告生成",
            target: notifications::NotificationTarget {
                kind: "test.report".into(),
                resource_id: "one".into(),
                context: Default::default(),
            },
        },
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    assert_eq!(
        data(request(&app, &actor, "GET", "/api/v1/notifications", json!(null)).await).await["unread_count"],
        0
    );
    let lease = jobs::claim(&pool, &["test.notify"], "worker", 60)
        .await
        .unwrap()
        .unwrap();
    let mut tx = pool.begin().await.unwrap();
    lease.succeed(&mut tx).await.unwrap();
    tx.commit().await.unwrap();
    let page = data(request(&app, &actor, "GET", "/api/v1/notifications", json!(null)).await).await;
    assert_eq!(page["unread_count"], 1);
    assert_eq!(page["data"].as_array().unwrap().len(), 1);
    let notice = &page["data"][0];
    assert_eq!(notice["outcome"], "succeeded");
    assert_eq!(notice["subject"], "报告生成");
    assert_eq!(notice["target"]["resource_id"], "one");
    assert_eq!(notice["read_at"], Value::Null);
    let read_path = format!(
        "/api/v1/notifications/{}/read",
        notice["id"].as_str().unwrap()
    );
    assert_eq!(
        request(&app, &owner, "POST", &read_path, json!({}))
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        data(request(&app, &owner, "GET", "/api/v1/notifications", json!(null)).await).await["data"],
        json!([])
    );
    let bad_csrf = Browser {
        id: actor.id.clone(),
        cookie: actor.cookie.clone(),
        csrf: "invalid".into(),
    };
    assert_eq!(
        request(&app, &bad_csrf, "POST", &read_path, json!({}))
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    let read = request(&app, &actor, "POST", &read_path, json!({})).await;
    assert_eq!(read.status(), StatusCode::OK);
    let read = data(read).await;
    assert!(read["read_at"].is_string());
    let twice = data(request(&app, &actor, "POST", &read_path, json!({})).await).await;
    assert_eq!(twice["read_at"], read["read_at"]);
    let reloaded = labos_threejs_app::router(pool);
    let page = data(
        request(
            &reloaded,
            &actor,
            "GET",
            "/api/v1/notifications",
            json!(null),
        )
        .await,
    )
    .await;
    assert_eq!(page["unread_count"], 0);
    assert_eq!(page["data"][0]["read_at"], read["read_at"]);
}

async fn enqueue_notice(pool: &PgPool, actor: &Browser, event: &str, budget: i32) -> String {
    use labos_threejs_app::modules::{jobs, notifications};
    let mut tx = pool.begin().await.unwrap();
    let id = jobs::enqueue(
        &mut tx,
        jobs::NewJob {
            kind: "test.notice",
            schema_version: 1,
            max_attempts: budget,
            payload: json!({}),
            correlation_id: "notice",
        },
    )
    .await
    .unwrap();
    notifications::on_job_outcome(
        &mut tx,
        &id,
        notifications::JobNotification {
            recipient_id: &actor.id,
            event_key: event,
            subject: "报告生成",
            target: notifications::NotificationTarget {
                kind: "test.report".into(),
                resource_id: event.into(),
                context: Default::default(),
            },
        },
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    id
}
async fn inbox(app: &Router, actor: &Browser) -> Value {
    data(request(app, actor, "GET", "/api/v1/notifications", json!(null)).await).await
}

#[sqlx::test(migrations = "../../migrations")]
async fn only_terminal_failure_notifies_and_admin_retries_deduplicate_without_resetting_read_state(
    pool: PgPool,
) {
    use labos_threejs_app::modules::jobs::{self, JobError};
    let app = labos_threejs_app::router(pool.clone());
    let actor = register(&app, "retry-notice@example.com").await;
    let job = enqueue_notice(&pool, &actor, "report:retry", 2).await;
    let lease = jobs::claim(&pool, &["test.notice"], "worker", 60)
        .await
        .unwrap()
        .unwrap();
    lease
        .fail(&pool, &JobError::Transient("test.temporary"))
        .await
        .unwrap();
    assert_eq!(inbox(&app, &actor).await["unread_count"], 0);
    // Advance only the adapter's scheduling clock, without relying on wall-clock sleep.
    sqlx::query("UPDATE labos_threejs_core.jobs SET scheduled_at = clock_timestamp() WHERE id = $1::uuid")
        .bind(&job)
        .execute(&pool)
        .await
        .unwrap();
    let lease = jobs::claim(&pool, &["test.notice"], "worker", 60)
        .await
        .unwrap()
        .unwrap();
    lease
        .fail(&pool, &JobError::Transient("test.temporary"))
        .await
        .unwrap();
    let page = inbox(&app, &actor).await;
    assert_eq!(page["data"].as_array().unwrap().len(), 1);
    assert_eq!(page["data"][0]["outcome"], "failed");
    let read_path = format!(
        "/api/v1/notifications/{}/read",
        page["data"][0]["id"].as_str().unwrap()
    );
    let read_at =
        data(request(&app, &actor, "POST", &read_path, json!({})).await).await["read_at"].clone();
    let retry = format!("/api/v1/jobs/{job}/retry");
    for attempt in 0..2 {
        assert_eq!(
            request(&app, &actor, "POST", &retry, json!({}))
                .await
                .status(),
            StatusCode::ACCEPTED
        );
        let lease = jobs::claim(&pool, &["test.notice"], "worker", 60)
            .await
            .unwrap()
            .unwrap();
        if attempt == 0 {
            lease
                .fail(&pool, &JobError::Permanent("test.failure"))
                .await
                .unwrap();
            let page = inbox(&app, &actor).await;
            assert_eq!(page["data"].as_array().unwrap().len(), 1);
            assert_eq!(page["unread_count"], 0);
            assert_eq!(page["data"][0]["read_at"], read_at);
        } else {
            let mut tx = pool.begin().await.unwrap();
            lease.succeed(&mut tx).await.unwrap();
            tx.commit().await.unwrap();
        }
    }
    let page = inbox(&app, &actor).await;
    assert_eq!(page["data"].as_array().unwrap().len(), 2);
    assert_eq!(page["data"][0]["outcome"], "succeeded");
    assert_eq!(page["unread_count"], 1);
    // Another execution for the same logical event cannot publish a second success.
    enqueue_notice(&pool, &actor, "report:retry", 1).await;
    let lease = jobs::claim(&pool, &["test.notice"], "another-worker", 60)
        .await
        .unwrap()
        .unwrap();
    let mut tx = pool.begin().await.unwrap();
    lease.succeed(&mut tx).await.unwrap();
    tx.commit().await.unwrap();
    assert_eq!(inbox(&app, &actor).await, page);
}

#[sqlx::test(migrations = "../../migrations")]
async fn a_crashed_last_attempt_emits_one_failure_even_without_a_handler(pool: PgPool) {
    use labos_threejs_app::modules::jobs;
    let app = labos_threejs_app::router(pool.clone());
    let actor = register(&app, "exhausted-notice@example.com").await;
    let job = enqueue_notice(&pool, &actor, "report:crashed", 1).await;
    let stale = jobs::claim(&pool, &["test.notice"], "crashed-worker", 60)
        .await
        .unwrap()
        .unwrap();
    sqlx::query("UPDATE labos_threejs_core.jobs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1::uuid").bind(&job).execute(&pool).await.unwrap();
    for _ in 0..2 {
        assert!(
            jobs::claim(&pool, &["test.notice"], "new-worker", 60)
                .await
                .unwrap()
                .is_none()
        );
    }
    let page = inbox(&app, &actor).await;
    assert_eq!(page["data"].as_array().unwrap().len(), 1);
    assert_eq!(page["data"][0]["outcome"], "failed");
    let mut tx = pool.begin().await.unwrap();
    assert!(matches!(
        stale.succeed(&mut tx).await,
        Err(jobs::JobError::LostLease)
    ));
    tx.rollback().await.unwrap();
    assert_eq!(inbox(&app, &actor).await, page);
}

#[sqlx::test(migrations = "../../migrations")]
async fn inbox_pages_are_bounded_and_bound_to_recipient_and_unread_filter(pool: PgPool) {
    use labos_threejs_app::modules::jobs;
    let app = labos_threejs_app::router(pool.clone());
    let actor = register(&app, "paged-notice@example.com").await;
    let other = register(&app, "other-page@example.com").await;
    for event in ["first", "second", "third"] {
        enqueue_notice(&pool, &actor, event, 1).await;
        let lease = jobs::claim(&pool, &["test.notice"], "worker", 60)
            .await
            .unwrap()
            .unwrap();
        let mut tx = pool.begin().await.unwrap();
        lease.succeed(&mut tx).await.unwrap();
        tx.commit().await.unwrap();
    }
    let first = data(
        request(
            &app,
            &actor,
            "GET",
            "/api/v1/notifications?limit=2",
            json!(null),
        )
        .await,
    )
    .await;
    assert_eq!(first["data"].as_array().unwrap().len(), 2);
    assert_eq!(first["data"][0]["target"]["resource_id"], "third");
    assert_eq!(first["has_more"], true);
    let cursor = first["next_cursor"].as_str().unwrap();
    let path = format!("/api/v1/notifications?limit=2&cursor={cursor}");
    let second = data(request(&app, &actor, "GET", &path, json!(null)).await).await;
    assert_eq!(second["data"].as_array().unwrap().len(), 1);
    assert_eq!(second["data"][0]["target"]["resource_id"], "first");
    assert_eq!(second["unread_count"], 3);
    assert_eq!(
        request(&app, &other, "GET", &path, json!(null))
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        request(
            &app,
            &actor,
            "GET",
            &format!("{path}&unread_only=true"),
            json!(null)
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );
    let read_path = format!(
        "/api/v1/notifications/{}/read",
        first["data"][0]["id"].as_str().unwrap()
    );
    assert_eq!(
        request(&app, &actor, "POST", &read_path, json!({}))
            .await
            .status(),
        StatusCode::OK
    );
    let unread = data(
        request(
            &app,
            &actor,
            "GET",
            "/api/v1/notifications?unread_only=true",
            json!(null),
        )
        .await,
    )
    .await;
    assert_eq!(unread["unread_count"], 2);
    assert_eq!(unread["data"].as_array().unwrap().len(), 2);
    assert!(
        unread["data"]
            .as_array()
            .unwrap()
            .iter()
            .all(|n| n["read_at"].is_null())
    );
    for query in [
        "limit=0",
        "limit=101",
        "cursor=garbage",
        "unread_only=maybe",
    ] {
        assert_eq!(
            request(
                &app,
                &actor,
                "GET",
                &format!("/api/v1/notifications?{query}"),
                json!(null)
            )
            .await
            .status(),
            StatusCode::BAD_REQUEST
        );
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn a_failed_notice_write_cannot_commit_terminal_job_state_without_its_notice(pool: PgPool) {
    use labos_threejs_app::modules::jobs::{self, JobError};
    let app = labos_threejs_app::router(pool.clone());
    let actor = register(&app, "failure-atomic@example.com").await;
    let job = enqueue_notice(&pool, &actor, "report:atomic", 1).await;
    let lease = jobs::claim(&pool, &["test.notice"], "worker", 60)
        .await
        .unwrap()
        .unwrap();
    sqlx::raw_sql("CREATE FUNCTION reject_notice() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test notice failure'; END $$; CREATE TRIGGER reject_notice BEFORE INSERT ON labos_threejs_core.notifications FOR EACH ROW EXECUTE FUNCTION reject_notice();").execute(&pool).await.unwrap();
    assert!(
        lease
            .fail(&pool, &JobError::Permanent("test.failure"))
            .await
            .is_err()
    );
    let mut connection = pool.acquire().await.unwrap();
    assert_eq!(
        jobs::statuses(&mut connection, std::slice::from_ref(&job))
            .await
            .unwrap()[0]
            .status,
        "running"
    );
    assert_eq!(inbox(&app, &actor).await["unread_count"], 0);
    sqlx::query("UPDATE labos_threejs_core.jobs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1::uuid").bind(&job).execute(&pool).await.unwrap();
    assert!(
        jobs::claim(&pool, &["test.notice"], "worker", 60)
            .await
            .is_err()
    );
    assert_eq!(
        jobs::statuses(&mut connection, std::slice::from_ref(&job))
            .await
            .unwrap()[0]
            .status,
        "running"
    );
    sqlx::query("DROP TRIGGER reject_notice ON labos_threejs_core.notifications")
        .execute(&pool)
        .await
        .unwrap();
    assert!(
        jobs::claim(&pool, &["test.notice"], "worker", 60)
            .await
            .unwrap()
            .is_none()
    );
    assert_eq!(
        jobs::statuses(&mut connection, &[job]).await.unwrap()[0].status,
        "failed"
    );
    let page = inbox(&app, &actor).await;
    assert_eq!(page["unread_count"], 1);
    assert_eq!(page["data"][0]["outcome"], "failed");
}
