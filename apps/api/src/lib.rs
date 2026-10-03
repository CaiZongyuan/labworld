use axum::Router;
use labos_threejs_platform::config::AuthSettings;
use sqlx::PgPool;

pub fn router(pool: PgPool, auth: AuthSettings) -> Router {
    router_with_files(pool, auth, None)
}

pub fn router_with_files(
    pool: PgPool,
    auth: AuthSettings,
    _files: Option<labos_threejs_app::modules::files::FileService>,
) -> Router {
    router_with_cache(pool, auth, _files, Default::default())
}

pub fn router_with_cache(
    pool: PgPool,
    auth: AuthSettings,
    _files: Option<labos_threejs_app::modules::files::FileService>,
    cache: labos_threejs_platform::cache::Cache,
) -> Router {
    let key_scopes = labos_threejs_app::modules::api_keys::core_scopes();
    let domain_routes = Router::new();
    // example:knowledge:routes:start
    let mut key_scopes = key_scopes;
    key_scopes.push(labos_threejs_app::modules::knowledge::api_key_scope());
    let domain_routes =
        domain_routes.merge(labos_threejs_app::modules::knowledge::router_with_cache(
            pool.clone(),
            auth.clone(),
            _files.clone(),
            Default::default(),
            cache.clone(),
        ));
    // example:knowledge:routes:end
    key_scopes.push(labos_threejs_app::modules::lab::api_key_scope());
    let domain_routes = domain_routes.merge(labos_threejs_app::modules::lab::router(
        pool.clone(),
        auth.clone(),
        _files,
    ));
    labos_threejs_app::compose_routes_with_options(
        pool,
        auth,
        domain_routes,
        openapi(),
        labos_threejs_app::CoreOptions {
            api_key_scopes: key_scopes,
            cache,
            ..Default::default()
        },
    )
}

pub fn openapi() -> utoipa::openapi::OpenApi {
    let document = labos_threejs_app::openapi();
    // example:knowledge:openapi:start
    let mut document = document;
    document.merge(labos_threejs_app::modules::knowledge::openapi());
    // example:knowledge:openapi:end
    document.merge(labos_threejs_app::modules::lab::openapi());
    labos_threejs_app::modules::rate_limit::describe(document)
}

pub fn configured_router(
    pool: PgPool,
    auth: AuthSettings,
    _files: Option<labos_threejs_app::modules::files::FileService>,
    runtime: labos_threejs_app::modules::lab::RuntimeAvailability,
) -> Result<Router, labos_threejs_platform::config::ConfigError> {
    let password_reset = labos_threejs_app::modules::identity::PasswordReset::from_env()?;
    let limiter = labos_threejs_app::modules::rate_limit::RateLimiter::from_env()?;
    let cache = labos_threejs_platform::cache::Cache::from_env()?;
    let key_scopes = labos_threejs_app::modules::api_keys::core_scopes();
    let routes = Router::new();
    // example:knowledge:configured-routes:start
    let mut key_scopes = key_scopes;
    key_scopes.push(labos_threejs_app::modules::knowledge::api_key_scope());
    let policy = labos_threejs_app::modules::knowledge::ExportPolicy::from_env()?;
    let routes = routes.merge(labos_threejs_app::modules::knowledge::router_with_cache(
        pool.clone(),
        auth.clone(),
        _files.clone(),
        policy,
        cache.clone(),
    ));
    // example:knowledge:configured-routes:end
    key_scopes.push(labos_threejs_app::modules::lab::api_key_scope());
    let routes = routes.merge(labos_threejs_app::modules::lab::router_with_retention(
        pool.clone(),
        auth.clone(),
        _files,
        Some(runtime),
        labos_threejs_app::modules::lab::RetentionPolicy::from_env()?,
    ));
    Ok(labos_threejs_app::compose_routes_with_options(
        pool,
        auth,
        routes,
        openapi(),
        labos_threejs_app::CoreOptions {
            api_key_scopes: key_scopes,
            cache,
            limiter,
            password_reset,
        },
    ))
}
