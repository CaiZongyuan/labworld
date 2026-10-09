#[path = "../../../tests/support/redis_gate.rs"]
mod redis_gate;
use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
    response::Response,
};
use http_body_util::BodyExt;
use labos_threejs_platform::cache::{Cache, CacheSettings};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

#[derive(Clone)]
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

async fn observe_cache_hit(app: &Router, actor: &Browser, path: &str, markdown: &str) -> Value {
    for _ in 0..8 {
        let response = request(app, actor, "GET", path, json!(null)).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(data(response).await["markdown"], markdown);
        let metrics =
            data(request(app, actor, "GET", "/api/v1/system/cache", json!(null)).await).await;
        if metrics["hits"].as_u64().unwrap() > 0 {
            return metrics;
        }
    }
    panic!("responsive Redis did not produce a cache hit within bounded reads");
}

#[sqlx::test(migrations = "../../migrations")]
async fn authorized_document_reads_miss_then_hit_real_redis_and_writes_use_a_new_version(
    pool: PgPool,
) {
    let cache = Cache::new(CacheSettings {
        url: std::env::var("REDIS_URL").expect("run scripts/test-backend.mjs"),
        prefix: format!("test:{}", uuid::Uuid::now_v7()),
        // The miss→hit contract is what this test pins; the read-through SET
        // shares the request budget, so a slow runner must not decide whether
        // the second read can hit. 1s is the validation ceiling.
        budget: std::time::Duration::from_secs(1),
        ..Default::default()
    })
    .unwrap();
    let app = labos_threejs_api::router_with_cache(pool, Default::default(), None, cache);
    let actor = register(&app, "cached-document@example.com").await;
    let doc = data(
        request(
            &app,
            &actor,
            "POST",
            "/api/v1/knowledge/documents",
            json!({"title":"Cache", "markdown":"version one"}),
        )
        .await,
    )
    .await;
    let path = format!(
        "/api/v1/knowledge/documents/{}",
        doc["id"].as_str().unwrap()
    );
    let first = data(request(&app, &actor, "GET", &path, json!(null)).await).await;
    assert_eq!(first["markdown"], "version one");
    let metrics =
        data(request(&app, &actor, "GET", "/api/v1/system/cache", json!(null)).await).await;
    assert_eq!(metrics["enabled"], true);
    assert_eq!(metrics["misses"], 1);
    assert_eq!(metrics["hits"], 0);
    let second = data(request(&app, &actor, "GET", &path, json!(null)).await).await;
    assert_eq!(second, first);
    let metrics =
        data(request(&app, &actor, "GET", "/api/v1/system/cache", json!(null)).await).await;
    assert_eq!(metrics["hits"], 1);
    assert_eq!(
        request(
            &app,
            &actor,
            "PUT",
            &path,
            json!({"title":"Cache", "markdown":"version two", "version":1})
        )
        .await
        .status(),
        StatusCode::OK
    );
    let current = data(request(&app, &actor, "GET", &path, json!(null)).await).await;
    assert_eq!(current["markdown"], "version two");
    assert_eq!(current["version"], 2);
    let metrics =
        data(request(&app, &actor, "GET", "/api/v1/system/cache", json!(null)).await).await;
    assert_eq!(metrics["misses"], 2);
    assert_eq!(metrics["invalidations"], 1);
}

#[sqlx::test(migrations = "../../migrations")]
async fn cached_bodies_never_cache_permissions_or_survive_revocation_and_deletion(pool: PgPool) {
    let cache = Cache::new(CacheSettings {
        url: std::env::var("REDIS_URL").unwrap(),
        prefix: format!("access:{}", uuid::Uuid::now_v7()),
        ..Default::default()
    })
    .unwrap();
    let app = labos_threejs_api::router_with_cache(pool, Default::default(), None, cache);
    let owner = register(&app, "cache-access-owner@example.com").await;
    let reader = register(&app, "cache-access-reader@example.com").await;
    let doc = data(
        request(
            &app,
            &owner,
            "POST",
            "/api/v1/knowledge/documents",
            json!({"title":"Private cache", "markdown":"private body"}),
        )
        .await,
    )
    .await;
    let path = format!(
        "/api/v1/knowledge/documents/{}",
        doc["id"].as_str().unwrap()
    );
    assert_eq!(
        request(&app, &owner, "GET", &path, json!(null))
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        request(&app, &reader, "GET", &path, json!(null))
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    let grant = format!(
        "/api/v1/knowledge/bases/{}/grants/{}",
        doc["knowledge_base_id"].as_str().unwrap(),
        reader.id
    );
    assert_eq!(
        request(&app, &owner, "PUT", &grant, json!({"access":"reader"}))
            .await
            .status(),
        StatusCode::OK
    );
    let readable = data(request(&app, &reader, "GET", &path, json!(null)).await).await;
    assert_eq!(readable["markdown"], "private body");
    assert_eq!(readable["can_edit"], false);
    assert_eq!(
        request(&app, &owner, "PUT", &grant, json!({"access":"editor"}))
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        data(request(&app, &reader, "GET", &path, json!(null)).await).await["can_edit"],
        true
    );
    let before =
        data(request(&app, &owner, "GET", "/api/v1/system/cache", json!(null)).await).await;
    assert_eq!(before["hits"], 2);
    assert_eq!(
        request(&app, &owner, "DELETE", &grant, json!(null))
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        request(&app, &reader, "GET", &path, json!(null))
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request(&app, &owner, "DELETE", &path, json!(null))
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        request(&app, &owner, "GET", &path, json!(null))
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    let after = data(request(&app, &owner, "GET", "/api/v1/system/cache", json!(null)).await).await;
    assert_eq!(after["hits"], before["hits"]);
    assert_eq!(after["misses"], before["misses"]);
}

#[sqlx::test(migrations = "../../migrations")]
async fn a_version_change_during_a_cache_miss_reauthorizes_and_does_not_cache_new_body_under_old_version(
    pool: PgPool,
) {
    let gate = redis_gate::RedisGate::new(b"GET").await;
    let prefix = format!("race:{}", uuid::Uuid::now_v7());
    let cache = Cache::new(CacheSettings {
        url: gate.url.clone(),
        prefix: prefix.clone(),
        budget: std::time::Duration::from_secs(1),
        ..Default::default()
    })
    .unwrap();
    let app = labos_threejs_api::router_with_cache(pool, Default::default(), None, cache);
    let actor = register(&app, "cache-race@example.com").await;
    let doc = data(
        request(
            &app,
            &actor,
            "POST",
            "/api/v1/knowledge/documents",
            json!({"title":"Race", "markdown":"old body"}),
        )
        .await,
    )
    .await;
    let document_id = doc["id"].as_str().unwrap();
    let path = format!("/api/v1/knowledge/documents/{document_id}");
    let read = {
        let app = app.clone();
        let actor = actor.clone();
        let path = path.clone();
        tokio::spawn(async move { request(&app, &actor, "GET", &path, json!(null)).await })
    };
    gate.wait_for_command().await;
    assert_eq!(
        request(
            &app,
            &actor,
            "PUT",
            &path,
            json!({"title":"Race", "markdown":"new body", "version":1})
        )
        .await
        .status(),
        StatusCode::OK
    );
    gate.release();
    let result = data(read.await.unwrap()).await;
    assert_eq!(result["version"], 2);
    assert_eq!(result["markdown"], "new body");
    // Observe the documented version-key contract through the public cache adapter.
    let direct = Cache::new(CacheSettings {
        url: std::env::var("REDIS_URL").unwrap(),
        prefix,
        ..Default::default()
    })
    .unwrap();
    assert!(matches!(
        direct
            .get(
                &format!("knowledge:body:v1:{document_id}:1"),
                direct.deadline()
            )
            .await,
        labos_threejs_platform::cache::Lookup::Miss
    ));
    let next = data(request(&app, &actor, "GET", &path, json!(null)).await).await;
    assert_eq!(next["markdown"], "new body");
    let metrics =
        data(request(&app, &actor, "GET", "/api/v1/system/cache", json!(null)).await).await;
    assert_eq!(metrics["hits"], 1);
    assert_eq!(metrics["misses"], 2);
}

#[sqlx::test(migrations = "../../migrations")]
async fn a_live_but_unresponsive_redis_is_bounded_and_recovers_with_fresh_connections(
    pool: PgPool,
) {
    let gate = redis_gate::RedisGate::new(b"GET").await;
    let cache = Cache::new(CacheSettings {
        url: gate.url.clone(),
        prefix: format!("timeout:{}", uuid::Uuid::now_v7()),
        budget: std::time::Duration::from_millis(200),
        ..Default::default()
    })
    .unwrap();
    let app = labos_threejs_api::router_with_cache(pool, Default::default(), None, cache);
    let actor = register(&app, "cache-timeout@example.com").await;
    let doc = data(
        request(
            &app,
            &actor,
            "POST",
            "/api/v1/knowledge/documents",
            json!({"title":"Fallback", "markdown":"from PostgreSQL"}),
        )
        .await,
    )
    .await;
    let path = format!(
        "/api/v1/knowledge/documents/{}",
        doc["id"].as_str().unwrap()
    );
    let began = std::time::Instant::now();
    let read = {
        let app = app.clone();
        let actor = actor.clone();
        let path = path.clone();
        tokio::spawn(async move { request(&app, &actor, "GET", &path, json!(null)).await })
    };
    gate.wait_for_command().await;
    let response = tokio::time::timeout(std::time::Duration::from_secs(1), read)
        .await
        .expect("cache fallback must not wait indefinitely")
        .unwrap();
    assert!(began.elapsed() < std::time::Duration::from_secs(1));
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(data(response).await["markdown"], "from PostgreSQL");
    gate.release();
    let metrics =
        data(request(&app, &actor, "GET", "/api/v1/system/cache", json!(null)).await).await;
    assert_eq!(metrics["fallbacks"], 1);
    // A best-effort fill may miss its budget even after Redis becomes responsive.
    let metrics = observe_cache_hit(&app, &actor, &path, "from PostgreSQL").await;
    assert!(metrics["misses"].as_u64().unwrap() >= 1);
    assert_eq!(metrics["hits"], 1);
}

#[sqlx::test(migrations = "../../migrations")]
async fn disconnecting_redis_after_a_hit_still_returns_the_current_database_body(pool: PgPool) {
    let mut gate = redis_gate::RedisGate::new(b"GET").await;
    gate.release();
    let cache = Cache::new(CacheSettings {
        url: gate.url.clone(),
        prefix: format!("disconnect:{}", uuid::Uuid::now_v7()),
        // Establish a hit before disconnecting; lookup and fill share the request budget.
        budget: std::time::Duration::from_secs(1),
        ..Default::default()
    })
    .unwrap();
    let app = labos_threejs_api::router_with_cache(pool, Default::default(), None, cache);
    let actor = register(&app, "cache-disconnect@example.com").await;
    let doc = data(
        request(
            &app,
            &actor,
            "POST",
            "/api/v1/knowledge/documents",
            json!({"title":"Available", "markdown":"still available"}),
        )
        .await,
    )
    .await;
    let path = format!(
        "/api/v1/knowledge/documents/{}",
        doc["id"].as_str().unwrap()
    );
    let warmup = observe_cache_hit(&app, &actor, &path, "still available").await;
    assert_eq!(warmup["hits"], 1);
    gate.stop().await;
    let response = request(&app, &actor, "GET", &path, json!(null)).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(data(response).await["markdown"], "still available");
    let metrics =
        data(request(&app, &actor, "GET", "/api/v1/system/cache", json!(null)).await).await;
    assert_eq!(metrics["hits"], 1);
    assert_eq!(metrics["fallbacks"], 1);
}
