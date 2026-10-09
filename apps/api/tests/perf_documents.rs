// The document-path budgets of spec §17.1, held as deterministic contracts
// rather than timings: the visible-document list stays a bounded number of
// round trips as the dataset grows and never carries bodies or oversized
// payloads; workspace preparation happens once per user even under
// concurrent first use; an export request costs one export, one job and one
// audit, and replaying its idempotency key duplicates nothing.
//
// Round trips are counted from sqlx's own statement events: sqlx emits every
// executed statement as a `sqlx::query` DEBUG event, so a capturing
// subscriber around a single request yields the exact statement count.
//
// This file is reference-app-owned: it queries the knowledge schema. The
// Core-owned budgets live in perf_registration.rs.

use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
    response::Response,
};
use http_body_util::BodyExt;
use labos_threejs_app::modules::files::{FilePolicy, FileService};
use labos_threejs_platform::object_storage::{S3ObjectStorage, StorageSettings};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::collections::HashMap;
use std::sync::{
    Arc, Mutex, Once, OnceLock,
    atomic::{AtomicU64, Ordering},
};
use std::thread::ThreadId;
use tower::ServiceExt;
use tracing::{
    Event, Metadata, Subscriber,
    span::{Attributes, Id, Record},
    subscriber::Interest,
};
use tracing_core::span::Current;

struct Browser {
    cookie: String,
    csrf: String,
}

async fn data(response: Response) -> Value {
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}

async fn count(pool: &PgPool, sql: &str) -> i64 {
    sqlx::query_scalar(sql).fetch_one(pool).await.unwrap()
}

async fn register(app: &Router, email: &str) -> Browser {
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
    let cookie = response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let result = data(response).await;
    Browser {
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

async fn get(app: &Router, actor: &Browser, path: &str) -> Response {
    app.clone()
        .oneshot(
            Request::get(path)
                .header("origin", "http://127.0.0.1:5173")
                .header("cookie", &actor.cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
}

async fn create_document(app: &Router, actor: &Browser, title: &str, markdown: &str) -> Value {
    let response = request(
        app,
        actor,
        "POST",
        "/api/v1/knowledge/documents",
        json!({"title": title, "markdown": markdown}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    data(response).await
}

async fn seed_documents(app: &Router, actor: &Browser, count: usize, markdown: &str) {
    for index in 0..count {
        create_document(app, actor, &format!("性能样本 {index:04}"), markdown).await;
    }
}

/// Per-thread counts of sqlx statement events, keyed by thread id so
/// parallel tests in this binary never see each other's statements.
fn thread_statements() -> &'static Mutex<HashMap<ThreadId, usize>> {
    static THREAD_STATEMENTS: OnceLock<Mutex<HashMap<ThreadId, usize>>> = OnceLock::new();
    THREAD_STATEMENTS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// A global tracing subscriber whose only job is counting `sqlx::query`
/// events per thread.
///
/// It reports `Interest::sometimes` unconditionally, so tracing consults it
/// for every event and never caches a callsite as disabled. That matters
/// because tracing computes a callsite's interest the first time that
/// callsite fires, against whatever subscribers exist then — in a parallel
/// test binary, a sqlx callsite that first fires from a test with no
/// capture installed would be cached as "never" and go silent for the whole
/// process, which is exactly what a scoped (thread-local) capture misses.
/// The global always-interested subscriber sidesteps the cache entirely.
struct StatementCounter;

impl Subscriber for StatementCounter {
    fn enabled(&self, _meta: &Metadata<'_>) -> bool {
        true
    }

    fn register_callsite(&self, _meta: &'static Metadata<'static>) -> Interest {
        Interest::sometimes()
    }

    fn max_level_hint(&self) -> Option<tracing::level_filters::LevelFilter> {
        Some(tracing::level_filters::LevelFilter::TRACE)
    }

    fn event(&self, event: &Event<'_>) {
        if event.metadata().target() == "sqlx::query" {
            *thread_statements()
                .lock()
                .expect("statement counter lock")
                .entry(std::thread::current().id())
                .or_default() += 1;
        }
    }

    fn new_span(&self, _attrs: &Attributes<'_>) -> Id {
        static NEXT_SPAN: AtomicU64 = AtomicU64::new(1);
        Id::from_u64(NEXT_SPAN.fetch_add(1, Ordering::Relaxed))
    }

    fn record(&self, _span: &Id, _values: &Record<'_>) {}
    fn record_follows_from(&self, _span: &Id, _follows: &Id) {}
    fn enter(&self, _span: &Id) {}
    fn exit(&self, _span: &Id) {}
    fn current_span(&self) -> Current {
        Current::none()
    }
}

/// Installs the statement counter as the process-wide subscriber, once.
fn install_statement_counter() {
    static ONCE: Once = Once::new();
    ONCE.call_once(|| {
        // The only subscriber in these tests, so a failure to install (an
        // impossible double install guarded by `Once`) would show up as a
        // count of zero, failing the measurement loudly.
        let _ = tracing::subscriber::set_global_default(StatementCounter);
    });
}

/// Counts the database round trips of exactly one list request.
async fn measured_round_trips(app: &Router, actor: &Browser, path: &str) -> usize {
    install_statement_counter();
    let id = std::thread::current().id();
    thread_statements()
        .lock()
        .expect("statement counter lock")
        .insert(id, 0);
    let response = get(app, actor, path).await;
    assert_eq!(response.status(), StatusCode::OK);
    let round_trips = thread_statements()
        .lock()
        .expect("statement counter lock")
        .get(&id)
        .copied()
        .unwrap_or_default();
    assert!(
        round_trips > 0,
        "a list request must touch the database; the counter saw nothing"
    );
    round_trips
}

async fn application(pool: PgPool) -> Router {
    let settings = StorageSettings {
        endpoint: std::env::var("S3_ENDPOINT").expect("run scripts/test-backend.mjs"),
        public_endpoint: std::env::var("S3_PUBLIC_ENDPOINT").unwrap(),
        region: "us-east-1".into(),
        bucket: format!("export-{}", uuid::Uuid::now_v7()),
        access_key: std::env::var("S3_ACCESS_KEY").unwrap(),
        secret_key: std::env::var("S3_SECRET_KEY").unwrap(),
    };
    let storage = Arc::new(S3ObjectStorage::new(&settings));
    storage
        .bootstrap(&settings.bucket, "http://127.0.0.1:5173")
        .await
        .unwrap();
    let files = FileService::new(storage, settings.bucket, FilePolicy::default());
    labos_threejs_api::router_with_files(pool, Default::default(), Some(files))
}

#[sqlx::test(migrations = "../../migrations")]
async fn document_list_round_trips_stay_flat_as_the_library_grows(pool: PgPool) {
    let app = labos_threejs_api::router(pool.clone(), Default::default());
    let owner = register(&app, "round-trips@example.test").await;

    seed_documents(&app, &owner, 5, "短正文").await;
    // A warm-up request so connection establishment never lands in a count.
    get(&app, &owner, "/api/v1/knowledge/documents").await;
    let small = measured_round_trips(&app, &owner, "/api/v1/knowledge/documents").await;

    seed_documents(&app, &owner, 95, "短正文").await;
    let large = measured_round_trips(&app, &owner, "/api/v1/knowledge/documents").await;

    assert_eq!(
        small, large,
        "list round trips must not grow with the dataset (no N+1)"
    );
    assert!(
        large <= 4,
        "list used {large} round trips, over the §17.1 budget of 4"
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn document_list_payload_stays_under_budget_and_never_carries_bodies(pool: PgPool) {
    let app = labos_threejs_api::router(pool.clone(), Default::default());
    let owner = register(&app, "payload-budget@example.test").await;
    // ~6 KiB of body per document: if bodies leaked into the list the
    // payload would blow well past 256 KiB instead of a few tens of KiB.
    seed_documents(&app, &owner, 100, &"正文内容。".repeat(400)).await;

    let response = get(&app, &owner, "/api/v1/knowledge/documents?limit=100").await;
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    assert!(
        bytes.len() <= 256 * 1024,
        "list payload is {} bytes, over the 256 KiB §17.1 budget",
        bytes.len()
    );
    let page: Value = serde_json::from_slice(&bytes).unwrap();
    let documents = page["data"].as_array().expect("list page data");
    assert_eq!(documents.len(), 100);
    for document in documents {
        assert!(
            document.get("markdown").is_none(),
            "the visible-document list must not carry document bodies"
        );
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn creating_in_an_existing_workspace_costs_one_document_and_one_audit(pool: PgPool) {
    let app = labos_threejs_api::router(pool.clone(), Default::default());
    let owner = register(&app, "create-budget@example.test").await;
    create_document(&app, &owner, "首篇", "正文").await;
    assert_eq!(
        count(&pool, "SELECT count(*) FROM knowledge.knowledge_bases").await,
        1
    );
    assert_eq!(
        count(&pool, "SELECT count(*) FROM knowledge.grants").await,
        1
    );
    assert_eq!(
        count(
            &pool,
            "SELECT count(*) FROM knowledge.grants WHERE access = 'editor'"
        )
        .await,
        1,
        "first-use preparation grants the initial editor access"
    );

    create_document(&app, &owner, "第二篇", "正文").await;

    assert_eq!(
        count(&pool, "SELECT count(*) FROM knowledge.documents").await,
        2
    );
    assert_eq!(
        count(&pool, "SELECT count(*) FROM knowledge.knowledge_bases").await,
        1,
        "first-use preparation must not repeat on later creates"
    );
    assert_eq!(
        count(&pool, "SELECT count(*) FROM knowledge.grants").await,
        1
    );
    assert_eq!(
        count(
            &pool,
            "SELECT count(*) FROM labos_threejs_core.audit_events WHERE action = 'knowledge.document.create'"
        )
        .await,
        2,
        "each create costs exactly one document-create audit"
    );
    // A create answers synchronously: no consumer-less work rows.
    assert_eq!(
        count(&pool, "SELECT count(*) FROM labos_threejs_core.jobs").await,
        0
    );
    assert_eq!(
        count(
            &pool,
            "SELECT count(*) FROM labos_threejs_core.notifications"
        )
        .await,
        0
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn first_workspace_preparation_happens_once_even_when_concurrent(pool: PgPool) {
    let app = labos_threejs_api::router(pool.clone(), Default::default());
    let owner = register(&app, "first-use-race@example.test").await;

    let first = request(
        &app,
        &owner,
        "POST",
        "/api/v1/knowledge/documents",
        json!({"title": "并发一", "markdown": "正文"}),
    );
    let second = request(
        &app,
        &owner,
        "POST",
        "/api/v1/knowledge/documents",
        json!({"title": "并发二", "markdown": "正文"}),
    );
    let (a, b) = tokio::join!(first, second);
    assert_eq!(a.status(), StatusCode::CREATED);
    assert_eq!(b.status(), StatusCode::CREATED);

    assert_eq!(
        count(&pool, "SELECT count(*) FROM knowledge.knowledge_bases").await,
        1,
        "the personal base is unique per user even under a create race"
    );
    assert_eq!(
        count(&pool, "SELECT count(*) FROM knowledge.grants").await,
        1
    );
    assert_eq!(
        count(&pool, "SELECT count(*) FROM knowledge.documents").await,
        2
    );
    assert_eq!(
        count(
            &pool,
            "SELECT count(*) FROM labos_threejs_core.audit_events WHERE action = 'knowledge.base.create'"
        )
        .await,
        1
    );
    assert_eq!(
        count(
            &pool,
            "SELECT count(*) FROM labos_threejs_core.audit_events WHERE action = 'knowledge.grant.assign'"
        )
        .await,
        1
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn list_filtering_happens_before_the_response_is_built(pool: PgPool) {
    let app = labos_threejs_api::router(pool.clone(), Default::default());
    let owner = register(&app, "filter-owner@example.test").await;
    let stranger = register(&app, "filter-stranger@example.test").await;
    create_document(&app, &owner, "私人文档", "正文").await;

    let stranger_page = data(get(&app, &stranger, "/api/v1/knowledge/documents").await).await;
    assert_eq!(
        stranger_page["data"].as_array().unwrap().len(),
        0,
        "another user's documents must never reach a stranger's response"
    );
    let owner_page = data(get(&app, &owner, "/api/v1/knowledge/documents").await).await;
    assert_eq!(owner_page["data"].as_array().unwrap().len(), 1);
}

#[sqlx::test(migrations = "../../migrations")]
async fn an_export_request_costs_one_export_one_job_and_one_audit_even_retried(pool: PgPool) {
    let app = application(pool.clone()).await;
    let owner = register(&app, "export-budget@example.test").await;
    let document = create_document(&app, &owner, "导出对象", "正文").await;
    let path = format!(
        "/api/v1/knowledge/documents/{}/exports",
        document["id"].as_str().unwrap()
    );

    let key = uuid::Uuid::now_v7().to_string();
    let first = request_key(&app, &owner, "POST", &path, json!({}), &key).await;
    assert_eq!(first.status(), StatusCode::ACCEPTED);

    // Retrying with the same idempotency key replays the recorded response
    // instead of duplicating the side effects.
    let retry = request_key(&app, &owner, "POST", &path, json!({}), &key).await;
    assert_eq!(retry.status(), StatusCode::ACCEPTED);

    assert_eq!(
        count(&pool, "SELECT count(*) FROM knowledge.exports").await,
        1
    );
    assert_eq!(
        count(
            &pool,
            "SELECT count(*) FROM labos_threejs_core.jobs WHERE kind = 'knowledge.export'"
        )
        .await,
        1
    );
    assert_eq!(
        count(
            &pool,
            "SELECT count(*) FROM labos_threejs_core.audit_events WHERE action = 'knowledge.export.request'"
        )
        .await,
        1
    );
    // The notification intent is a job_notifications row waiting on the
    // worker — the notifications table itself stays empty at request time.
    assert_eq!(
        count(
            &pool,
            "SELECT count(*) FROM labos_threejs_core.notifications"
        )
        .await,
        0
    );
}
