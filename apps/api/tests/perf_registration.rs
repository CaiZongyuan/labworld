// The registration side-effect budget of spec §17.1, pinned as row counts:
// a register that answers 201 must have written exactly one user, one
// credential, one membership and one registration audit — never more.
// This file is Core-owned: it survives the knowledge example removal, so the
// budget keeps being enforced on stripped copies. Deterministic counting,
// no wall-clock timing.

use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
    response::Response,
};
use serde_json::json;
use sqlx::PgPool;
use tower::ServiceExt;

async fn count(pool: &PgPool, sql: &str) -> i64 {
    sqlx::query_scalar(sql).fetch_one(pool).await.unwrap()
}

async fn register(app: &Router, email: &str) -> Response {
    let response = app
        .clone()
        .oneshot(
            Request::post("/api/v1/auth/register")
                .header("origin", "http://127.0.0.1:5173")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"email": email, "password": "a-long-test-password"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    response
}

#[sqlx::test(migrations = "../../migrations")]
async fn a_registration_writes_exactly_the_contracted_rows(pool: PgPool) {
    let app = labos_threejs_api::router(pool.clone(), Default::default());
    register(&app, "perf-registration@example.test").await;

    assert_eq!(
        count(&pool, "SELECT count(*) FROM labos_threejs_core.users").await,
        1
    );
    assert_eq!(
        count(&pool, "SELECT count(*) FROM labos_threejs_core.credentials").await,
        1
    );
    assert_eq!(
        count(
            &pool,
            "SELECT count(*) FROM labos_threejs_core.memberships WHERE active"
        )
        .await,
        1
    );
    assert_eq!(
        count(
            &pool,
            "SELECT count(*) FROM labos_threejs_core.audit_events WHERE action = 'identity.register'"
        )
        .await,
        1
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn registration_does_not_fund_other_contracts(pool: PgPool) {
    let app = labos_threejs_api::router(pool.clone(), Default::default());
    register(&app, "perf-scope@example.test").await;

    // The session is issued in the same flow but outside the registration
    // transaction — it has its own contract, so it is counted separately.
    assert_eq!(
        count(&pool, "SELECT count(*) FROM labos_threejs_core.sessions").await,
        1
    );
    // Registration never seeds a personal workspace for the example domain
    // and never enqueues work: no documents exist until a document is created.
    assert_eq!(count(&pool, "SELECT count(*) FROM labos_threejs_core.jobs").await, 0);
    assert_eq!(
        count(&pool, "SELECT count(*) FROM labos_threejs_core.notifications").await,
        0
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn a_rejected_duplicate_registration_writes_nothing(pool: PgPool) {
    let app = labos_threejs_api::router(pool.clone(), Default::default());
    register(&app, "perf-duplicate@example.test").await;

    let retry = app
        .clone()
        .oneshot(
            Request::post("/api/v1/auth/register")
                .header("origin", "http://127.0.0.1:5173")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"email": "perf-duplicate@example.test", "password": "a-long-test-password"})
                        .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(retry.status(), StatusCode::CONFLICT);

    assert_eq!(
        count(&pool, "SELECT count(*) FROM labos_threejs_core.users").await,
        1
    );
    assert_eq!(
        count(
            &pool,
            "SELECT count(*) FROM labos_threejs_core.audit_events WHERE action = 'identity.register'"
        )
        .await,
        1
    );
}
