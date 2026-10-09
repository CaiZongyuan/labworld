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
use labos_threejs_platform::{cache::Cache, config::AuthSettings};
use sqlx::PgPool;
use utoipa::{OpenApi, ToSchema};

#[derive(Clone, Default, serde::Serialize, ToSchema)]
pub struct CacheMetrics {
    pub enabled: bool,
    pub hits: u64,
    pub misses: u64,
    pub fallbacks: u64,
    pub writes: u64,
    pub write_failures: u64,
    pub invalidations: u64,
    pub invalidation_failures: u64,
}
#[derive(Clone)]
struct CacheStatus {
    pool: PgPool,
    auth: AuthSettings,
    cache: Cache,
}
pub fn router(pool: PgPool, auth: AuthSettings, cache: Cache) -> Router {
    Router::new()
        .route("/api/v1/system/cache", get(cache_status))
        .with_state(CacheStatus { pool, auth, cache })
}
#[derive(OpenApi)]
#[openapi(paths(cache_status))]
struct CacheApi;
pub fn openapi() -> utoipa::openapi::OpenApi {
    CacheApi::openapi()
}
#[utoipa::path(get,path="/api/v1/system/cache",operation_id="getCacheStatus",tag="System",responses((status=200,body=CacheMetrics),(status=401,body=crate::http::ApiErrorResponse),(status=403,body=crate::http::ApiErrorResponse),(status=503,body=crate::http::ApiErrorResponse)))]
async fn cache_status(
    State(state): State<CacheStatus>,
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
    let current = state.cache.snapshot();
    Json(CacheMetrics {
        enabled: current.enabled,
        hits: current.hits,
        misses: current.misses,
        fallbacks: current.fallbacks,
        writes: current.writes,
        write_failures: current.write_failures,
        invalidations: current.invalidations,
        invalidation_failures: current.invalidation_failures,
    })
    .into_response()
}
