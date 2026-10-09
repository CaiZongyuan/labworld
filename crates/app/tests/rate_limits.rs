#[path = "../../../tests/support/redis_gate.rs"]
mod redis_gate;
use axum::{
    Router,
    body::Body,
    extract::ConnectInfo,
    http::{Request, StatusCode},
    response::Response,
};
use http_body_util::BodyExt;
use labos_threejs_app::modules::rate_limit::{Clock, Limits, Policy, RateLimiter};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::{
    Arc,
    atomic::{AtomicU64, Ordering},
};
use tower::ServiceExt;
struct ManualClock(AtomicU64);
impl Clock for ManualClock {
    fn now_millis(&self) -> u64 {
        self.0.load(Ordering::SeqCst)
    }
}
async fn data(response: Response) -> Value {
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}
async fn register(app: &Router, ip: &str, email: &str) -> Response {
    let mut request = Request::post("/api/v1/auth/register")
        .header("origin", "http://127.0.0.1:5173")
        .header("content-type", "application/json")
        .body(Body::from(
            json!({"email":email,"password":"a-long-test-password"}).to_string(),
        ))
        .unwrap();
    request.extensions_mut().insert(ConnectInfo(
        format!("{ip}:12345")
            .parse::<std::net::SocketAddr>()
            .unwrap(),
    ));
    app.clone().oneshot(request).await.unwrap()
}
#[sqlx::test(migrations = "../../migrations")]
async fn registration_has_a_finite_per_client_window_and_recovery_with_retry_after(pool: PgPool) {
    let clock = Arc::new(ManualClock(AtomicU64::new(120_000)));
    let limiter = RateLimiter::local(
        Limits {
            registration: Policy {
                limit: 2,
                fallback_limit: 1,
            },
            ..Default::default()
        },
        clock.clone(),
    )
    .unwrap();
    let app = labos_threejs_app::compose_routes_with_options(
        pool,
        Default::default(),
        Router::new(),
        labos_threejs_app::openapi(),
        labos_threejs_app::CoreOptions {
            limiter,
            ..Default::default()
        },
    );
    assert_eq!(
        register(&app, "192.0.2.1", "limited-first@example.com")
            .await
            .status(),
        StatusCode::CREATED
    );
    let rejected = register(&app, "192.0.2.1", "limited-second@example.com").await;
    assert_eq!(rejected.status(), StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(rejected.headers()["retry-after"], "60");
    assert!(rejected.headers().contains_key("x-request-id"));
    let body = data(rejected).await;
    assert_eq!(body["error"]["code"], "rate_limit.exceeded");
    assert_eq!(body["error"]["details"]["retry_after_seconds"], "60");
    assert_eq!(
        register(&app, "192.0.2.2", "limited-other@example.com")
            .await
            .status(),
        StatusCode::CREATED
    );
    clock.0.store(180_000, Ordering::SeqCst);
    assert_eq!(
        register(&app, "192.0.2.1", "limited-second@example.com")
            .await
            .status(),
        StatusCode::CREATED
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn real_redis_shares_policy_windows_across_api_instances(pool: PgPool) {
    use labos_threejs_platform::rate_limit::CounterSettings;
    let clock = Arc::new(ManualClock(AtomicU64::new(120_000)));
    let settings = CounterSettings {
        url: std::env::var("REDIS_URL").unwrap(),
        prefix: format!("rate:{}", uuid::Uuid::now_v7()),
        ..Default::default()
    };
    let limits = Limits {
        registration: Policy {
            limit: 2,
            fallback_limit: 1,
        },
        ..Default::default()
    };
    let first = RateLimiter::redis(limits.clone(), clock.clone(), settings.clone()).unwrap();
    let second = RateLimiter::redis(limits, clock.clone(), settings).unwrap();
    let first = labos_threejs_app::compose_routes_with_options(
        pool.clone(),
        Default::default(),
        Router::new(),
        labos_threejs_app::openapi(),
        labos_threejs_app::CoreOptions {
            limiter: first,
            ..Default::default()
        },
    );
    let second = labos_threejs_app::compose_routes_with_options(
        pool,
        Default::default(),
        Router::new(),
        labos_threejs_app::openapi(),
        labos_threejs_app::CoreOptions {
            limiter: second,
            ..Default::default()
        },
    );
    assert_eq!(
        register(&first, "192.0.2.3", "redis-first@example.com")
            .await
            .status(),
        StatusCode::CREATED
    );
    assert_eq!(
        register(&first, "192.0.2.3", "redis-second@example.com")
            .await
            .status(),
        StatusCode::CREATED
    );
    assert_eq!(
        register(&second, "192.0.2.3", "redis-third@example.com")
            .await
            .status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    clock.0.store(180_000, Ordering::SeqCst);
    assert_eq!(
        register(&second, "192.0.2.3", "redis-third@example.com")
            .await
            .status(),
        StatusCode::CREATED
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn full_local_bookkeeping_uses_a_shared_conservative_overflow_window(pool: PgPool) {
    let clock = Arc::new(ManualClock(AtomicU64::new(120_000)));
    let limiter = RateLimiter::local(
        Limits {
            registration: Policy {
                limit: 2,
                fallback_limit: 1,
            },
            max_local_entries: 1,
            ..Default::default()
        },
        clock.clone(),
    )
    .unwrap();
    let app = labos_threejs_app::compose_routes_with_options(
        pool,
        Default::default(),
        Router::new(),
        labos_threejs_app::openapi(),
        labos_threejs_app::CoreOptions {
            limiter,
            ..Default::default()
        },
    );
    assert_eq!(
        register(&app, "192.0.2.10", "bounded-one@example.com")
            .await
            .status(),
        StatusCode::CREATED
    );
    assert_eq!(
        register(&app, "192.0.2.11", "bounded-two@example.com")
            .await
            .status(),
        StatusCode::CREATED
    );
    assert_eq!(
        register(&app, "192.0.2.12", "bounded-three@example.com")
            .await
            .status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    clock.0.store(180_000, Ordering::SeqCst);
    assert_eq!(
        register(&app, "192.0.2.12", "bounded-three@example.com")
            .await
            .status(),
        StatusCode::CREATED
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn policy_classes_are_independent_do_not_trust_forwarded_headers_and_never_replace_authentication(
    pool: PgPool,
) {
    let clock = Arc::new(ManualClock(AtomicU64::new(120_000)));
    let limiter = RateLimiter::local(
        Limits {
            registration: Policy {
                limit: 1,
                fallback_limit: 1,
            },
            authentication: Policy {
                limit: 1,
                fallback_limit: 1,
            },
            resource: Policy {
                limit: 2,
                fallback_limit: 2,
            },
            ..Default::default()
        },
        clock.clone(),
    )
    .unwrap();
    let app = labos_threejs_app::compose_routes_with_options(
        pool,
        Default::default(),
        Router::new(),
        labos_threejs_app::openapi(),
        labos_threejs_app::CoreOptions {
            limiter,
            ..Default::default()
        },
    );
    assert_eq!(
        register(&app, "192.0.2.20", "classes@example.com")
            .await
            .status(),
        StatusCode::CREATED
    );
    let make = |method: &str, path: &str, body: Value| {
        let mut request = Request::builder()
            .method(method)
            .uri(path)
            .header("origin", "http://127.0.0.1:5173")
            .header("content-type", "application/json")
            .header("x-forwarded-for", "203.0.113.250")
            .body(Body::from(body.to_string()))
            .unwrap();
        request.extensions_mut().insert(ConnectInfo(
            "192.0.2.20:12345".parse::<std::net::SocketAddr>().unwrap(),
        ));
        request
    };
    assert_eq!(
        app.clone()
            .oneshot(make(
                "POST",
                "/api/v1/auth/register",
                json!({"email":"spoof@example.com","password":"a-long-test-password"})
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(
        app.clone()
            .oneshot(make(
                "POST",
                "/api/v1/auth/login",
                json!({"email":"classes@example.com","password":"wrong-password"})
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        app.clone()
            .oneshot(make(
                "POST",
                "/api/v1/auth/login",
                json!({"email":"classes@example.com","password":"wrong-password"})
            ))
            .await
            .unwrap()
            .status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    for _ in 0..2 {
        assert_eq!(
            app.clone()
                .oneshot(make("GET", "/api/v1/profile", json!(null)))
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(
        app.clone()
            .oneshot(make("GET", "/api/v1/profile", json!(null)))
            .await
            .unwrap()
            .status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    assert_eq!(
        app.clone()
            .oneshot(make("GET", "/health/live", json!(null)))
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    clock.0.store(180_000, Ordering::SeqCst);
    assert_eq!(
        app.oneshot(make("GET", "/api/v1/profile", json!(null)))
            .await
            .unwrap()
            .status(),
        StatusCode::UNAUTHORIZED
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn redis_disconnection_keeps_shadow_consumption_and_fallback_stays_finite(pool: PgPool) {
    let mut gate = redis_gate::RedisGate::new(b"EVAL").await;
    let clock = Arc::new(ManualClock(AtomicU64::new(120_000)));
    let limiter = RateLimiter::redis(
        Limits {
            registration: Policy {
                limit: 2,
                fallback_limit: 1,
            },
            ..Default::default()
        },
        clock.clone(),
        labos_threejs_platform::rate_limit::CounterSettings {
            url: gate.url.clone(),
            prefix: format!("fallback:{}", uuid::Uuid::now_v7()),
            budget: std::time::Duration::from_secs(1),
        },
    )
    .unwrap();
    let app = labos_threejs_app::compose_routes_with_options(
        pool,
        Default::default(),
        Router::new(),
        labos_threejs_app::openapi(),
        labos_threejs_app::CoreOptions {
            limiter,
            ..Default::default()
        },
    );
    let pending = {
        let app = app.clone();
        tokio::spawn(async move { register(&app, "192.0.2.30", "shadow-one@example.com").await })
    };
    gate.wait_for_command().await;
    gate.release();
    assert_eq!(pending.await.unwrap().status(), StatusCode::CREATED);
    assert_eq!(
        register(&app, "192.0.2.30", "shadow-two@example.com")
            .await
            .status(),
        StatusCode::CREATED
    );
    gate.stop().await;
    assert_eq!(
        register(&app, "192.0.2.30", "shadow-three@example.com")
            .await
            .status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    clock.0.store(180_000, Ordering::SeqCst);
    assert_eq!(
        register(&app, "192.0.2.30", "shadow-three@example.com")
            .await
            .status(),
        StatusCode::CREATED
    );
    assert_eq!(
        register(&app, "192.0.2.30", "shadow-four@example.com")
            .await
            .status(),
        StatusCode::TOO_MANY_REQUESTS
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn administrators_observe_fixed_policy_totals_without_sensitive_bucket_identifiers(
    pool: PgPool,
) {
    let clock = Arc::new(ManualClock(AtomicU64::new(120_000)));
    let limiter = RateLimiter::local(
        Limits {
            registration: Policy {
                limit: 2,
                fallback_limit: 1,
            },
            ..Default::default()
        },
        clock,
    )
    .unwrap();
    let app = labos_threejs_app::compose_routes_with_options(
        pool,
        Default::default(),
        Router::new(),
        labos_threejs_app::openapi(),
        labos_threejs_app::CoreOptions {
            limiter,
            ..Default::default()
        },
    );
    let created = register(&app, "192.0.2.40", "metrics@example.com").await;
    assert_eq!(created.status(), StatusCode::CREATED);
    let cookie = created.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    assert_eq!(
        register(&app, "192.0.2.40", "metrics-again@example.com")
            .await
            .status(),
        StatusCode::TOO_MANY_REQUESTS
    );
    let response = app
        .clone()
        .oneshot(
            Request::get("/api/v1/system/rate-limits")
                .header("cookie", cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let snapshot = data(response).await;
    assert_eq!(snapshot["enabled"], true);
    let registration = snapshot["policies"]
        .as_array()
        .unwrap()
        .iter()
        .find(|p| p["policy"] == "registration")
        .unwrap();
    assert_eq!(registration["local_allowed"], 1);
    assert_eq!(registration["local_denied"], 1);
    assert!(!snapshot.to_string().contains("192.0.2.40"));
    assert!(!snapshot.to_string().contains("metrics@example.com"));
    assert_eq!(
        app.oneshot(
            Request::get("/api/v1/system/rate-limits")
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
async fn the_generated_contract_describes_the_common_wait_response(pool: PgPool) {
    let app = labos_threejs_app::router(pool);
    let contract = data(
        app.oneshot(
            Request::get("/api/openapi.json")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap(),
    )
    .await;
    let response = &contract["paths"]["/api/v1/auth/register"]["post"]["responses"]["429"];
    assert_eq!(
        response["headers"]["Retry-After"]["schema"]["type"],
        "integer"
    );
    assert_eq!(
        response["content"]["application/json"]["schema"]["$ref"],
        "#/components/schemas/ApiErrorResponse"
    );
    assert!(
        contract["paths"]["/health/live"]["get"]["responses"]
            .get("429")
            .is_none()
    );
}
