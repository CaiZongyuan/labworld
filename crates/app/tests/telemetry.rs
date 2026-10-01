use axum::{
    Router,
    body::{Body, Bytes},
    http::Request,
    routing::post,
};
use opentelemetry_proto::tonic::collector::metrics::v1::ExportMetricsServiceRequest;
use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceRequest;
use prost::Message;
use sqlx::PgPool;
use std::sync::Arc;
use tower::ServiceExt;

#[sqlx::test(migrations = "../../migrations")]
async fn real_otlp_carries_the_http_parent_without_exporting_raw_request_content(pool: PgPool) {
    let captured = Arc::new(tokio::sync::Mutex::new(Vec::new()));
    let receiver = captured.clone();
    let metrics = Arc::new(tokio::sync::Mutex::new(Vec::new()));
    let meters = metrics.clone();
    let capture = Router::new()
        .route(
            "/v1/traces",
            post(move |body: Bytes| {
                let receiver = receiver.clone();
                async move {
                    receiver
                        .lock()
                        .await
                        .push(ExportTraceServiceRequest::decode(body).unwrap());
                    (
                        [("content-type", "application/x-protobuf")],
                        Vec::<u8>::new(),
                    )
                }
            }),
        )
        .route(
            "/v1/metrics",
            post(move |body: Bytes| {
                let meters = meters.clone();
                async move {
                    meters
                        .lock()
                        .await
                        .push(ExportMetricsServiceRequest::decode(body).unwrap());
                    (
                        [("content-type", "application/x-protobuf")],
                        Vec::<u8>::new(),
                    )
                }
            }),
        );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let endpoint = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, capture).await.unwrap() });
    let log_dir = tempfile::tempdir().unwrap();
    let settings = labos_threejs_platform::telemetry::TelemetrySettings {
        endpoint: Some(endpoint),
        log_directory: Some(log_dir.path().to_path_buf()),
        ..Default::default()
    };
    let guard = tokio::task::spawn_blocking(move || {
        labos_threejs_platform::telemetry::start(settings, "labos-threejs-api", "trace".parse().unwrap()).unwrap()
    })
    .await
    .unwrap();
    let response = labos_threejs_app::router(pool.clone())
        .oneshot(
            Request::get("/health/live?private=should-not-be-exported")
                .header(
                    "traceparent",
                    "00-0102030405060708090a0b0c0d0e0f10-0102030405060708-01",
                )
                .header("authorization", "Bearer should-not-be-exported")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 200);
    assert_eq!(
        response.headers()["x-trace-id"],
        "0102030405060708090a0b0c0d0e0f10"
    );
    let (job, actor, request) = exercise_job(pool).await;
    tokio::task::spawn_blocking(move || guard.shutdown())
        .await
        .unwrap();
    let records = captured.lock().await;
    let spans: Vec<_> = records
        .iter()
        .flat_map(|r| &r.resource_spans)
        .flat_map(|r| &r.scope_spans)
        .flat_map(|s| &s.spans)
        .collect();
    let http = spans
        .iter()
        .find(|s| s.name == "http.request")
        .expect("a real HTTP span must be exported");
    assert_eq!(
        hex::encode(&http.trace_id),
        "0102030405060708090a0b0c0d0e0f10"
    );
    assert_eq!(hex::encode(&http.parent_span_id), "0102030405060708");
    assert!(!format!("{records:?}").contains("should-not-be-exported"));
    let worker = spans
        .iter()
        .find(|s| s.name == "job.attempt")
        .expect("durable Job must have an attempt span");
    assert_eq!(worker.trace_id, http.trace_id);
    let storage = spans
        .iter()
        .find(|s| s.name == "storage.operation")
        .expect("real S3 operation must be traced");
    assert_eq!(storage.trace_id, http.trace_id);
    assert_eq!(storage.parent_span_id, worker.span_id);
    let string_attr = |span: &opentelemetry_proto::tonic::trace::v1::Span, key: &str| {
        span.attributes
            .iter()
            .find(|a| a.key == key)
            .and_then(|a| a.value.as_ref())
            .and_then(|v| v.value.as_ref())
            .and_then(|v| match v {
                opentelemetry_proto::tonic::common::v1::any_value::Value::StringValue(v) => {
                    Some(v.clone())
                }
                _ => None,
            })
    };
    assert_eq!(string_attr(worker, "job_id"), Some(job));
    assert_eq!(string_attr(worker, "actor_id"), Some(actor));
    assert_eq!(string_attr(worker, "correlation_id"), Some(request.clone()));
    assert_eq!(string_attr(worker, "causation_id"), Some(request));
    let meters = metrics.lock().await;
    let names: Vec<_> = meters
        .iter()
        .flat_map(|m| &m.resource_metrics)
        .flat_map(|m| &m.scope_metrics)
        .flat_map(|m| &m.metrics)
        .map(|m| m.name.as_str())
        .collect();
    assert!(names.contains(&"labos_threejs.http.requests"));
    assert!(names.contains(&"labos_threejs.jobs.attempts"));
    assert!(names.contains(&"labos_threejs.storage.duration"));
    assert!(!format!("{meters:?}").contains("should-not-be-exported"));
    for metric in meters
        .iter()
        .flat_map(|m| &m.resource_metrics)
        .flat_map(|m| &m.scope_metrics)
        .flat_map(|m| &m.metrics)
    {
        use opentelemetry_proto::tonic::metrics::v1::metric::Data;
        let points: Vec<_> = match metric.data.as_ref().unwrap() {
            Data::Sum(sum) => sum.data_points.iter().map(|p| &p.attributes).collect(),
            Data::Histogram(hist) => {
                for point in &hist.data_points {
                    assert!(
                        point.explicit_bounds.contains(&0.01)
                            && point.explicit_bounds.contains(&0.1),
                        "seconds histograms need millisecond/subsecond resolution for useful P95"
                    );
                }
                hist.data_points.iter().map(|p| &p.attributes).collect()
            }
            _ => panic!("only explicit counters and histograms are registered"),
        };
        for attributes in points {
            for attribute in attributes {
                assert!(
                    ["route", "method", "status", "kind", "outcome", "operation"]
                        .contains(&attribute.key.as_str()),
                    "metric labels must use the fixed low-cardinality vocabulary"
                );
            }
        }
    }
    let logs = std::fs::read_dir(log_dir.path())
        .unwrap()
        .map(|p| std::fs::read_to_string(p.unwrap().path()).unwrap())
        .collect::<String>();
    assert!(logs.contains("job attempt finished"));
    assert!(!logs.contains("should-not-be-exported"));
    server.abort();
}

struct Probe {
    pool: PgPool,
    storage: labos_threejs_platform::object_storage::S3ObjectStorage,
    location: labos_threejs_platform::object_storage::ObjectLocation,
}
#[async_trait::async_trait]
impl labos_threejs_app::modules::jobs::Handler for Probe {
    fn kind(&self) -> &'static str {
        "test.telemetry"
    }
    async fn run(
        &self,
        lease: &labos_threejs_app::modules::jobs::Lease,
    ) -> Result<(), labos_threejs_app::modules::jobs::JobError> {
        use labos_threejs_platform::object_storage::ObjectStorage;
        self.storage
            .delete(&self.location)
            .await
            .map_err(|_| labos_threejs_app::modules::jobs::JobError::Transient("storage.unavailable"))?;
        assert!(matches!(
            self.storage.head(&self.location).await,
            Err(labos_threejs_platform::object_storage::StorageError::NotFound)
        ));
        let mut tx = self.pool.begin().await?;
        lease.lock_current(&mut tx).await?;
        labos_threejs_app::modules::audit::append(
            &mut tx,
            labos_threejs_app::modules::audit::Event {
                actor_id: lease
                    .actor_id
                    .as_deref()
                    .expect("originating actor survives restart"),
                action: "test.object.deleted",
                resource_type: "test.object",
                resource_id: &lease.id,
                source: labos_threejs_app::modules::audit::Source::Job {
                    id: &lease.id,
                    correlation_id: &lease.correlation_id,
                },
                subject_user_id: None,
            },
        )
        .await?;
        lease.succeed(&mut tx).await?;
        tx.commit().await?;
        Ok(())
    }
}
async fn exercise_job(pool: PgPool) -> (String, String, String) {
    use axum::{
        Extension, Json,
        http::{HeaderMap, StatusCode},
    };
    use http_body_util::BodyExt;
    use labos_threejs_app::modules::{audit, identity, jobs};
    let endpoint = Router::new().route(
        "/api/v1/test-job",
        post({
            let pool = pool.clone();
            move |headers: HeaderMap, Extension(id): Extension<labos_threejs_app::http::RequestId>| {
                let pool = pool.clone();
                async move {
                    let session =
                        identity::require_session(&pool, &Default::default(), &headers, &id, true)
                            .await?;
                    let mut tx = pool.begin().await.unwrap();
                    let job = jobs::enqueue(
                        &mut tx,
                        jobs::NewJob {
                            kind: "test.telemetry",
                            schema_version: 1,
                            max_attempts: 2,
                            payload: serde_json::json!({}),
                            correlation_id: &id.0,
                        },
                    )
                    .await
                    .unwrap();
                    audit::append(
                        &mut tx,
                        audit::Event {
                            actor_id: &session.user.id,
                            action: "test.object.requested",
                            resource_type: "test.object",
                            resource_id: &job,
                            source: audit::Source::Request(&id.0),
                            subject_user_id: None,
                        },
                    )
                    .await
                    .unwrap();
                    tx.commit().await.unwrap();
                    Ok::<_, axum::response::Response>((
                        StatusCode::ACCEPTED,
                        Json(serde_json::json!({"job":job,"actor":session.user.id})),
                    ))
                }
            }
        }),
    );
    let app = labos_threejs_app::compose_routes(
        pool.clone(),
        Default::default(),
        endpoint,
        labos_threejs_app::openapi(),
    );
    let registration=app.clone().oneshot(Request::post("/api/v1/auth/register").header("origin","http://127.0.0.1:5173").header("content-type","application/json").body(Body::from(serde_json::json!({"email":"trace@example.test","password":"should-not-be-exported"}).to_string())).unwrap()).await.unwrap();
    assert_eq!(registration.status(), 201);
    let cookie = registration.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let body: serde_json::Value =
        serde_json::from_slice(&registration.into_body().collect().await.unwrap().to_bytes())
            .unwrap();
    let response = app
        .clone()
        .oneshot(
            Request::post("/api/v1/test-job")
                .header("origin", "http://127.0.0.1:5173")
                .header("cookie", cookie)
                .header("x-csrf-token", body["csrf_token"].as_str().unwrap())
                .header(
                    "traceparent",
                    "00-0102030405060708090a0b0c0d0e0f10-1112131415161718-01",
                )
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), 202);
    let request = response.headers()["x-request-id"]
        .to_str()
        .unwrap()
        .to_owned();
    let data: serde_json::Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    let job = data["job"].as_str().unwrap().to_owned();
    let actor = data["actor"].as_str().unwrap().to_owned();
    drop(app); // Nothing from the original Router is available to the restarted worker.
    let abandoned = jobs::claim(&pool, &["test.telemetry"], "crashed", 60)
        .await
        .unwrap()
        .unwrap();
    sqlx::query("UPDATE labos_threejs_core.jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1::uuid").bind(&abandoned.id).execute(&pool).await.unwrap();
    let settings = labos_threejs_platform::object_storage::StorageSettings {
        endpoint: std::env::var("S3_ENDPOINT").unwrap(),
        public_endpoint: std::env::var("S3_PUBLIC_ENDPOINT").unwrap(),
        region: "us-east-1".into(),
        bucket: format!("trace-{}", uuid::Uuid::now_v7()),
        access_key: std::env::var("S3_ACCESS_KEY").unwrap(),
        secret_key: std::env::var("S3_SECRET_KEY").unwrap(),
    };
    let storage = labos_threejs_platform::object_storage::S3ObjectStorage::new(&settings);
    storage
        .bootstrap(&settings.bucket, "http://127.0.0.1:5173")
        .await
        .unwrap();
    let probe = Probe {
        pool: pool.clone(),
        storage,
        location: labos_threejs_platform::object_storage::ObjectLocation {
            bucket: settings.bucket,
            key: "should-not-be-exported".into(),
        },
    };
    let worker = jobs::Worker::new(pool.clone(), vec![Arc::new(probe)], Default::default());
    assert!(worker.run_once().await.unwrap());
    // Audit is its public Application transaction boundary, including persisted trace association.
    let traces: Vec<Option<String>> =
        sqlx::query_scalar("SELECT trace_id FROM labos_threejs_core.audit_events WHERE resource_id=$1")
            .bind(&job)
            .fetch_all(&pool)
            .await
            .unwrap();
    assert_eq!(traces.len(), 2);
    assert!(
        traces
            .iter()
            .all(|id| id.as_deref() == Some("0102030405060708090a0b0c0d0e0f10"))
    );
    (job, actor, request)
}
