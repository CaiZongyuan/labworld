use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use tower::ServiceExt;
use tracing::{
    Event, Metadata, Subscriber,
    span::{Attributes, Id, Record},
    subscriber::Interest,
};
use tracing_core::span::Current;

static MEASURING: AtomicBool = AtomicBool::new(false);
static STATEMENTS: AtomicUsize = AtomicUsize::new(0);
struct StatementCounter;
impl Subscriber for StatementCounter {
    fn enabled(&self, _: &Metadata<'_>) -> bool {
        true
    }
    fn register_callsite(&self, _: &'static Metadata<'static>) -> Interest {
        Interest::sometimes()
    }
    fn max_level_hint(&self) -> Option<tracing::level_filters::LevelFilter> {
        Some(tracing::level_filters::LevelFilter::TRACE)
    }
    fn event(&self, event: &Event<'_>) {
        if MEASURING.load(Ordering::Relaxed) && event.metadata().target() == "sqlx::query" {
            STATEMENTS.fetch_add(1, Ordering::Relaxed);
        }
    }
    fn new_span(&self, _: &Attributes<'_>) -> Id {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        Id::from_u64(NEXT.fetch_add(1, Ordering::Relaxed))
    }
    fn record(&self, _: &Id, _: &Record<'_>) {}
    fn record_follows_from(&self, _: &Id, _: &Id) {}
    fn enter(&self, _: &Id) {}
    fn exit(&self, _: &Id) {}
    fn current_span(&self) -> Current {
        Current::none()
    }
}

async fn call(
    app: &Router,
    cookie: &str,
    csrf: &str,
    method: &str,
    path: &str,
    input: Value,
    expected: StatusCode,
) -> (Value, usize) {
    let response = app
        .clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("origin", "http://127.0.0.1:5173")
                .header("content-type", "application/json")
                .header("cookie", cookie)
                .header("x-csrf-token", csrf)
                .body(Body::from(input.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), expected);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (serde_json::from_slice(&bytes).unwrap(), bytes.len())
}

// One isolated test owns the global counter. No device runtime runs in this Router.
#[sqlx::test(migrations = "../../migrations")]
async fn world_snapshot_and_pages_have_fixed_budgets_at_one_and_one_hundred_entities(pool: PgPool) {
    tracing::subscriber::set_global_default(StatementCounter).unwrap();
    let app = labos_threejs_api::router(pool, Default::default());
    call(
        &app,
        "",
        "",
        "POST",
        "/api/v1/auth/register",
        json!({"email":"lab-budget-owner@example.test","password":"lab-budget-owner-password"}),
        StatusCode::CREATED,
    )
    .await;
    let response = app
        .clone()
        .oneshot(
            Request::post("/api/v1/auth/register")
                .header("origin", "http://127.0.0.1:5173")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"email":"lab-budget@example.test","password":"lab-budget-password"})
                        .to_string(),
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
    let session: Value =
        serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap();
    assert_eq!(session["user"]["role"], "member");
    let csrf = session["csrf_token"].as_str().unwrap();
    let (lab, _) = call(
        &app,
        &cookie,
        csrf,
        "POST",
        "/api/v1/lab/labs",
        json!({"name":"Reference Lab"}),
        StatusCode::CREATED,
    )
    .await;
    let path = format!("/api/v1/lab/labs/{}", lab["id"].as_str().unwrap());
    let budgets: Value =
        serde_json::from_str(include_str!("../../../scripts/perf/baselines.json")).unwrap();
    let budgets = &budgets["budgets"]["lab"];
    let mut samples = Vec::new();
    for index in 0..100 {
        call(&app, &cookie, csrf, "POST", &format!("{path}/entities"), json!({
            "name":format!("Entity {index}"),"definition_id":if index<20 {"sensor"} else {"labware"},
            "definition_version":"1.0","reality":"simulated","configuration":{},"representation_id":null
        }), StatusCode::CREATED).await;
        if index == 0 || index == 99 {
            STATEMENTS.store(0, Ordering::Relaxed);
            MEASURING.store(true, Ordering::Relaxed);
            let (world, bytes) = call(
                &app,
                &cookie,
                csrf,
                "GET",
                &format!("{path}/world"),
                Value::Null,
                StatusCode::OK,
            )
            .await;
            MEASURING.store(false, Ordering::Relaxed);
            let statements = STATEMENTS.load(Ordering::Relaxed);
            assert!(statements > 0, "sqlx query measurement must be active");
            assert!(
                statements <= budgets["snapshotSqlStatements"].as_u64().unwrap() as usize,
                "snapshot statements: {statements}"
            );
            assert!(bytes <= budgets["eventBytes"].as_u64().unwrap() as usize);
            assert_eq!(world["entities"].as_array().unwrap().len(), index + 1);
            assert_eq!(world["nodes"].as_array().unwrap().len(), index + 1);
            assert!(world["assets"].as_array().unwrap().is_empty());
            samples.push(json!({"entities":index+1,"statements":statements,"bytes":bytes}));
        }
    }
    assert_eq!(
        samples[0]["statements"], samples[1]["statements"],
        "Entity count must not add database round trips"
    );
    for index in 0..2 {
        call(
            &app,
            &cookie,
            csrf,
            "POST",
            "/api/v1/lab/labs",
            json!({"name":format!("Page {index}")}),
            StatusCode::CREATED,
        )
        .await;
    }
    let (first, _) = call(
        &app,
        &cookie,
        csrf,
        "GET",
        "/api/v1/lab/labs?limit=2",
        Value::Null,
        StatusCode::OK,
    )
    .await;
    assert_eq!(first["data"].as_array().unwrap().len(), 2);
    assert_eq!(first["has_more"], true);
    let (last, _) = call(
        &app,
        &cookie,
        csrf,
        "GET",
        &format!(
            "/api/v1/lab/labs?limit=2&cursor={}",
            first["next_cursor"].as_str().unwrap()
        ),
        Value::Null,
        StatusCode::OK,
    )
    .await;
    assert_eq!(last["data"].as_array().unwrap().len(), 1);
    assert_eq!(last["has_more"], false);
    assert!(
        first["data"]
            .as_array()
            .unwrap()
            .iter()
            .all(|item| item["id"] != last["data"][0]["id"])
    );
    call(
        &app,
        &cookie,
        csrf,
        "GET",
        "/api/v1/lab/labs?limit=101",
        Value::Null,
        StatusCode::BAD_REQUEST,
    )
    .await;
    println!("Lab snapshot budget evidence: {}", json!(samples));
}
