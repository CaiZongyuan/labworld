use axum::{
    Router,
    body::{Body, Bytes},
    http::{Request, StatusCode},
    routing::post,
};
use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
use prost::Message;
use sqlx::PgPool;
use std::{
    sync::{
        Arc,
        atomic::{AtomicU8, Ordering},
    },
    time::Duration,
};
use tower::ServiceExt;

#[sqlx::test(migrations = "../../migrations")]
async fn a_stalled_collector_drops_bounded_backlog_without_stalling_http_and_recovers(
    pool: PgPool,
) {
    let records = Arc::new(tokio::sync::Mutex::new(Vec::new()));
    let mode = Arc::new(AtomicU8::new(1));
    let entered = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let capture = Router::new()
        .route(
            "/v1/traces",
            post({
                let (records, mode, entered, release) = (
                    records.clone(),
                    mode.clone(),
                    entered.clone(),
                    release.clone(),
                );
                move |body: Bytes| {
                    let (records, mode, entered, release) = (
                        records.clone(),
                        mode.clone(),
                        entered.clone(),
                        release.clone(),
                    );
                    async move {
                        let spans = ExportTraceServiceRequest::decode(body).unwrap();
                        records.lock().await.push(spans);
                        let state = mode.load(Ordering::SeqCst);
                        let released = release.notified();
                        entered.notify_one();
                        if state == 1 {
                            released.await;
                        }
                        if state == 2 {
                            StatusCode::SERVICE_UNAVAILABLE
                        } else {
                            StatusCode::OK
                        }
                    }
                }
            }),
        )
        .route("/v1/metrics", post(|| async { StatusCode::OK }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, capture).await.unwrap() });
    let logs = tempfile::tempdir().unwrap();
    let settings = labos_threejs_platform::telemetry::TelemetrySettings {
        endpoint: Some(endpoint),
        log_directory: Some(logs.path().to_path_buf()),
        queue_size: 64,
        timeout: Duration::from_secs(2),
        ..Default::default()
    };
    let guard = tokio::task::spawn_blocking(move || {
        labos_threejs_platform::telemetry::start(settings, "labos-threejs-api", "info".parse().unwrap()).unwrap()
    })
    .await
    .unwrap();
    let app = labos_threejs_app::router(pool);
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
    tokio::time::timeout(Duration::from_secs(3), entered.notified())
        .await
        .expect("exporter must reach the stalled socket");
    // More than sixteen queue capacities, while the first export is held. No
    // transport retry or full queue may apply backpressure to business futures.
    tokio::time::timeout(Duration::from_secs(1), async {
        for _ in 0..1024 {
            assert_eq!(
                app.clone()
                    .oneshot(Request::get("/health/live").body(Body::empty()).unwrap())
                    .await
                    .unwrap()
                    .status(),
                200
            );
        }
    })
    .await
    .expect("telemetry must not block the HTTP request loop");
    mode.store(0, Ordering::SeqCst);
    release.notify_waiters();
    let recovered = app
        .clone()
        .oneshot(Request::get("/health/ready").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(recovered.status(), 200);
    // Shutdown flushes only bounded remaining data and stays within the explicit
    // trace + fixed metrics-reader + writer budgets, even if data has been lost.
    tokio::time::timeout(
        Duration::from_secs(10),
        tokio::task::spawn_blocking(move || guard.shutdown()),
    )
    .await
    .expect("bounded telemetry shutdown")
    .unwrap();
    let records = records.lock().await;
    let spans: Vec<_> = records
        .iter()
        .flat_map(|r| &r.resource_spans)
        .flat_map(|r| &r.scope_spans)
        .flat_map(|r| &r.spans)
        .collect();
    assert!(!spans.is_empty());
    assert!(
        spans.len() <= 193,
        "one active batch, one bounded queue and final readiness span only"
    );
    assert!(
        spans.len() < 1089,
        "overflow must drop instead of accumulating unbounded work"
    );
    server.abort();
}
