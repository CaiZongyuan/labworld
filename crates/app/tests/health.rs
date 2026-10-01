use axum::{
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use tower::ServiceExt;

#[tokio::test]
async fn live_endpoint_reports_the_process_is_alive() {
    let response = labos_threejs_app::router(disconnected_pool())
        .oneshot(
            Request::builder()
                .uri("/health/live")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&body).unwrap(),
        serde_json::json!({"status": "ok"})
    );
}

#[tokio::test]
async fn unknown_route_returns_a_correlated_public_error() {
    let response = labos_threejs_app::router(disconnected_pool())
        .oneshot(
            Request::builder()
                .uri("/not-a-route")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    let request_id = response
        .headers()
        .get("x-request-id")
        .expect("every HTTP result has a server request id")
        .to_str()
        .unwrap()
        .to_owned();
    assert!(!request_id.is_empty());
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["error"]["code"], "http.not_found");
    assert_eq!(json["error"]["request_id"], request_id);
}

#[tokio::test]
async fn readiness_reports_service_unavailable_without_its_database() {
    let response = labos_threejs_app::router(disconnected_pool())
        .oneshot(
            Request::builder()
                .uri("/health/ready")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["error"]["code"], "database.unavailable");
}

fn disconnected_pool() -> sqlx::PgPool {
    sqlx::postgres::PgPoolOptions::new()
        .acquire_timeout(std::time::Duration::from_millis(50))
        .connect_lazy("postgres://test:test@127.0.0.1:9/missing")
        .unwrap()
}

#[sqlx::test(migrations = "../../migrations")]
async fn status_reports_a_real_migrated_database(pool: sqlx::PgPool) {
    let response = labos_threejs_app::router(pool)
        .oneshot(
            Request::builder()
                .uri("/api/v1/system/status")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["database"], "connected");
    // Verify the public response against the migration bundle, including optional domains.
    assert_eq!(
        json["schema_version"],
        labos_threejs_platform::postgres::MIGRATOR
            .iter()
            .last()
            .unwrap()
            .version
    );
    assert_eq!(json["status"], "ok");
}

#[sqlx::test(migrations = "../../migrations")]
async fn database_with_pending_migrations_is_not_ready(pool: sqlx::PgPool) {
    // Reproduce the migration history of the preceding release.
    sqlx::query("DELETE FROM _sqlx_migrations WHERE version = 2")
        .execute(&pool)
        .await
        .unwrap();
    let response = labos_threejs_app::router(pool)
        .oneshot(Request::get("/health/ready").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
}

#[sqlx::test(migrations = false)]
async fn database_without_migrations_is_not_ready(pool: sqlx::PgPool) {
    let router = labos_threejs_app::router(pool);
    let response = router
        .clone()
        .oneshot(
            Request::builder()
                .uri("/health/ready")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    let live = router
        .oneshot(
            Request::builder()
                .uri("/health/live")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(live.status(), StatusCode::OK);
}

#[tokio::test]
async fn public_openapi_describes_the_status_contract_and_unavailability() {
    let response = labos_threejs_app::router(disconnected_pool())
        .oneshot(
            Request::builder()
                .uri("/api/openapi.json")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let document: serde_json::Value = serde_json::from_slice(&body).unwrap();
    let operation = &document["paths"]["/api/v1/system/status"]["get"];
    assert_eq!(operation["operationId"], "getSystemStatus");
    assert!(operation["responses"]["200"]["content"]["application/json"].is_object());
    assert!(operation["responses"]["503"]["content"]["application/json"].is_object());
}

#[tokio::test]
async fn unsupported_method_uses_the_same_error_contract() {
    let response = labos_threejs_app::router(disconnected_pool())
        .oneshot(
            Request::builder()
                .method("POST")
                .uri("/health/live")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(
        response.headers().get("content-type").unwrap(),
        "application/json"
    );
    let body = response.into_body().collect().await.unwrap().to_bytes();
    let json: serde_json::Value = serde_json::from_slice(&body).unwrap();
    assert_eq!(json["error"]["code"], "http.method_not_allowed");
}

#[sqlx::test(migrations = "../../migrations")]
async fn a_blocked_database_query_has_a_bounded_readiness_response(pool: sqlx::PgPool) {
    let mut lock = pool.begin().await.unwrap();
    sqlx::query("LOCK TABLE _sqlx_migrations IN ACCESS EXCLUSIVE MODE")
        .execute(&mut *lock)
        .await
        .unwrap();
    let request = Request::builder()
        .uri("/health/ready")
        .body(Body::empty())
        .unwrap();
    let response = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        labos_threejs_app::router(pool.clone()).oneshot(request),
    )
    .await
    .expect("database query must not hold readiness indefinitely")
    .unwrap();
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    lock.rollback().await.unwrap();
}
