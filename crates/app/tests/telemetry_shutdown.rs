use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
    routing::post,
};
use sqlx::PgPool;
use std::{
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Duration,
};
use tower::ServiceExt;

#[sqlx::test(migrations = "../../migrations")]
async fn collector_rejection_and_a_hanging_shutdown_do_not_become_business_dependencies(
    pool: PgPool,
) {
    let hang = Arc::new(AtomicBool::new(false));
    let rejected = Arc::new(tokio::sync::Notify::new());
    let stalled = Arc::new(tokio::sync::Notify::new());
    let capture = Router::new()
        .route(
            "/v1/traces",
            post({
                let (hang, rejected, stalled) = (hang.clone(), rejected.clone(), stalled.clone());
                move || {
                    let (hang, rejected, stalled) =
                        (hang.clone(), rejected.clone(), stalled.clone());
                    async move {
                        if hang.load(Ordering::SeqCst) {
                            stalled.notify_one();
                            std::future::pending::<()>().await;
                        }
                        rejected.notify_one();
                        StatusCode::SERVICE_UNAVAILABLE
                    }
                }
            }),
        )
        .route(
            "/v1/metrics",
            post(|| async { StatusCode::SERVICE_UNAVAILABLE }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, capture).await.unwrap() });
    let logs = tempfile::tempdir().unwrap();
    let settings = labos_threejs_platform::telemetry::TelemetrySettings {
        endpoint: Some(endpoint),
        log_directory: Some(logs.path().to_path_buf()),
        queue_size: 64,
        timeout: Duration::from_millis(100),
        metrics_interval: Duration::from_secs(1),
    };
    let guard = tokio::task::spawn_blocking(move || {
        labos_threejs_platform::telemetry::start(
            settings,
            "labos-threejs-api",
            "info".parse().unwrap(),
        )
        .unwrap()
    })
    .await
    .unwrap();
    let app = labos_threejs_app::router(pool);
    async fn requests(app: &Router) {
        for _ in 0..64 {
            assert_eq!(
                app.clone()
                    .oneshot(Request::get("/health/live").body(Body::empty()).unwrap())
                    .await
                    .unwrap()
                    .status(),
                200
            );
        }
    }
    requests(&app).await;
    tokio::time::timeout(Duration::from_secs(3), rejected.notified())
        .await
        .expect("real Collector 503 observed");
    hang.store(true, Ordering::SeqCst);
    requests(&app).await;
    tokio::time::timeout(Duration::from_secs(3), stalled.notified())
        .await
        .expect("real Collector stall observed");
    assert_eq!(
        app.oneshot(Request::get("/health/ready").body(Body::empty()).unwrap())
            .await
            .unwrap()
            .status(),
        200
    );
    tokio::time::timeout(
        Duration::from_secs(10),
        tokio::task::spawn_blocking(move || guard.shutdown()),
    )
    .await
    .expect("shutdown must not await the stalled peer indefinitely")
    .unwrap();
    server.abort();
}
