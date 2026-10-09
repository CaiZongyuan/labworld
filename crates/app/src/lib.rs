pub mod http;
pub mod modules;
mod secrets;

use axum::{
    Extension, Json, Router, extract::State, http::StatusCode, middleware, response::Response,
    routing::get,
};
use serde::Serialize;
use sqlx::PgPool;
use utoipa::{OpenApi, ToSchema};

#[derive(Serialize, ToSchema)]
pub struct HealthResponse {
    status: &'static str,
}

#[utoipa::path(get, path = "/health/live", operation_id = "getLiveness", tag = "System", responses((status = 200, body = HealthResponse, description = "Process is alive")))]
async fn live() -> Json<HealthResponse> {
    Json(HealthResponse { status: "ok" })
}

#[utoipa::path(get, path = "/health/ready", operation_id = "getReadiness", tag = "System", responses((status = 200, body = HealthResponse, description = "Database migrations are available"), (status = 503, body = http::ApiErrorResponse, description = "Database is not ready")))]
async fn ready(
    State(pool): State<PgPool>,
    Extension(id): Extension<http::RequestId>,
) -> Result<Json<HealthResponse>, Response> {
    modules::system::schema_version(&pool)
        .await
        .ok_or_else(|| {
            http::public_error(
                StatusCode::SERVICE_UNAVAILABLE,
                "database.unavailable",
                "Database is not ready",
                id,
            )
        })?;
    Ok(Json(HealthResponse { status: "ok" }))
}

pub fn router(pool: PgPool) -> Router {
    router_with_auth(
        pool,
        labos_threejs_platform::config::AuthSettings::default(),
    )
}

pub fn router_with_auth(
    pool: PgPool,
    auth: labos_threejs_platform::config::AuthSettings,
) -> Router {
    compose_routes(pool, auth, Router::new(), openapi())
}

/// Application shells supply optional domain routes and the combined contract.
pub fn compose_routes(
    pool: PgPool,
    auth: labos_threejs_platform::config::AuthSettings,
    domain_routes: Router,
    document: utoipa::openapi::OpenApi,
) -> Router {
    compose_routes_with_options(pool, auth, domain_routes, document, CoreOptions::default())
}

pub struct CoreOptions {
    pub api_key_scopes: Vec<modules::api_keys::KeyScope>,
    pub cache: labos_threejs_platform::cache::Cache,
    pub limiter: modules::rate_limit::RateLimiter,
    pub password_reset: Option<modules::identity::PasswordReset>,
}
impl Default for CoreOptions {
    fn default() -> Self {
        Self {
            api_key_scopes: modules::api_keys::core_scopes(),
            cache: Default::default(),
            limiter: Default::default(),
            password_reset: None,
        }
    }
}
/// Application shells share optional infrastructure with Core and reference routes.
pub fn compose_routes_with_options(
    pool: PgPool,
    auth: labos_threejs_platform::config::AuthSettings,
    domain_routes: Router,
    document: utoipa::openapi::OpenApi,
    options: CoreOptions,
) -> Router {
    Router::new()
        .route("/health/live", get(live))
        .route("/health/ready", get(ready))
        .route("/api/v1/system/status", get(modules::system::status))
        .route(
            "/api/openapi.json",
            get(move || std::future::ready(Json(document.clone()))),
        )
        .with_state(pool.clone())
        .merge(modules::identity::router_with_reset(
            pool.clone(),
            auth.clone(),
            options.password_reset,
        ))
        .merge(modules::organization::router(pool.clone(), auth.clone()))
        .merge(modules::jobs::router(pool.clone(), auth.clone()))
        .merge(modules::notifications::router(pool.clone(), auth.clone()))
        .merge(modules::audit::router(pool.clone(), auth.clone()))
        .merge(modules::api_keys::router(
            pool.clone(),
            auth.clone(),
            options.api_key_scopes,
        ))
        .merge(modules::rate_limit::router(
            pool.clone(),
            auth.clone(),
            options.limiter.clone(),
        ))
        .merge(modules::system::cache::router(pool, auth, options.cache))
        .merge(domain_routes)
        .fallback(http::not_found)
        .method_not_allowed_fallback(http::method_not_allowed)
        .layer(middleware::from_fn_with_state(
            options.limiter,
            modules::rate_limit::enforce,
        ))
        .layer(middleware::from_fn(http::request_context))
}

#[derive(OpenApi)]
#[openapi(
    info(title = "Lab Word API", version = "0.1.0"),
    paths(
        live,
        ready,
        modules::system::status,
        modules::identity::register,
        modules::identity::login,
        modules::identity::logout,
        modules::identity::current_session
    ),
    components(schemas(
        HealthResponse,
        http::ApiErrorResponse,
        http::ApiError,
        modules::system::SystemStatus
    ))
)]
struct ApiDoc;

pub fn openapi() -> utoipa::openapi::OpenApi {
    let mut document = ApiDoc::openapi();
    document.merge(modules::organization::openapi());
    document.merge(modules::identity::password_reset_openapi());
    document.merge(modules::jobs::openapi());
    document.merge(modules::notifications::openapi());
    document.merge(modules::audit::openapi());
    document.merge(modules::api_keys::openapi());
    document.merge(modules::system::cache::openapi());
    document.merge(modules::rate_limit::openapi());
    modules::rate_limit::describe(document)
}
