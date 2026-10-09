use super::{Kind, RateLimiter};
use crate::{
    http::{RequestId, public_error},
    modules::{identity, organization::MemberRole},
};
use axum::{
    Extension, Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
};
use labos_threejs_platform::config::AuthSettings;
use sqlx::PgPool;
use std::sync::atomic::Ordering;
use utoipa::{OpenApi, ToSchema};
#[derive(serde::Serialize, ToSchema)]
struct PolicyMetrics {
    policy: &'static str,
    limit: u32,
    fallback_limit: u32,
    redis_allowed: u64,
    redis_denied: u64,
    local_allowed: u64,
    local_denied: u64,
    fallbacks: u64,
}
#[derive(serde::Serialize, ToSchema)]
struct RateLimitMetrics {
    enabled: bool,
    redis_configured: bool,
    window_secs: u32,
    local_entries: usize,
    local_capacity: usize,
    policies: Vec<PolicyMetrics>,
}
#[derive(Clone)]
struct Administration {
    pool: PgPool,
    auth: AuthSettings,
    limiter: RateLimiter,
}
pub fn router(pool: PgPool, auth: AuthSettings, limiter: RateLimiter) -> Router {
    Router::new()
        .route("/api/v1/system/rate-limits", get(status))
        .with_state(Administration {
            pool,
            auth,
            limiter,
        })
}
#[derive(OpenApi)]
#[openapi(paths(status))]
struct RateApi;
pub fn openapi() -> utoipa::openapi::OpenApi {
    RateApi::openapi()
}
#[utoipa::path(get,path="/api/v1/system/rate-limits",operation_id="getRateLimitStatus",tag="System",responses((status=200,body=RateLimitMetrics),(status=401,body=crate::http::ApiErrorResponse),(status=403,body=crate::http::ApiErrorResponse),(status=503,body=crate::http::ApiErrorResponse)))]
async fn status(
    State(state): State<Administration>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
) -> Response {
    let actor =
        match identity::require_session(&state.pool, &state.auth, &headers, &id, false).await {
            Ok(session) => session.user,
            Err(response) => return response,
        };
    if !matches!(actor.role, MemberRole::Owner | MemberRole::Admin) {
        return public_error(
            StatusCode::FORBIDDEN,
            "system.forbidden",
            "Only an administrator can inspect runtime counters",
            id,
        );
    }
    let Some(inner) = state.limiter.0 else {
        return Json(RateLimitMetrics {
            enabled: false,
            redis_configured: false,
            window_secs: 0,
            local_entries: 0,
            local_capacity: 0,
            policies: vec![],
        })
        .into_response();
    };
    let policies = [Kind::Registration, Kind::Authentication, Kind::Resource]
        .into_iter()
        .map(|kind| {
            let counter = &inner.totals[kind.index()];
            let policy = kind.policy(&inner.limits);
            PolicyMetrics {
                policy: kind.name(),
                limit: policy.limit,
                fallback_limit: policy.fallback_limit,
                redis_allowed: counter.redis_allowed.load(Ordering::Relaxed),
                redis_denied: counter.redis_denied.load(Ordering::Relaxed),
                local_allowed: counter.local_allowed.load(Ordering::Relaxed),
                local_denied: counter.local_denied.load(Ordering::Relaxed),
                fallbacks: counter.fallbacks.load(Ordering::Relaxed),
            }
        })
        .collect();
    let local_entries = inner
        .local
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .entries
        .len();
    Json(RateLimitMetrics {
        enabled: true,
        redis_configured: inner.remote.is_some(),
        window_secs: inner.limits.window_secs,
        local_entries,
        local_capacity: inner.limits.max_local_entries,
        policies,
    })
    .into_response()
}
