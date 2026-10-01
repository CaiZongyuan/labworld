use axum::{
    Extension, Json, Router, http::StatusCode, middleware, response::IntoResponse, routing::get,
};
use labos_threejs_app::{
    http,
    modules::{
        files::{self, FileService},
        jobs::{self, Handler, Maintenance, Worker, WorkerPolicy},
        system,
    },
};
use labos_threejs_platform::{config::Settings, postgres, telemetry};
use std::{future::IntoFuture, sync::Arc, time::Duration};

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    let result = runtime.block_on(run());
    runtime.shutdown_timeout(Duration::from_secs(1));
    result
}

async fn run() -> Result<(), Box<dyn std::error::Error>> {
    let settings = Settings::from_env()?;
    let policy = WorkerPolicy::from_env()?;
    let bind = jobs::worker_bind()?;
    let telemetry = telemetry::init(settings.log_filter, "labos-threejs-worker").await?;
    let pool = postgres::connect_lazy(settings.database);
    let _files = settings
        .storage
        .as_ref()
        .map(|storage| FileService::from_settings(storage, &settings.file_limits));
    let mut handlers: Vec<Arc<dyn Handler>> = Vec::new();
    let maintenance: Vec<Arc<dyn Maintenance>> = vec![
        files::cleanup_maintenance(pool.clone()),
        labos_threejs_app::modules::identity::password_reset_maintenance(pool.clone()),
    ];
    if let Some(reset) = labos_threejs_app::modules::identity::PasswordReset::from_env()? {
        handlers.push(reset.handler(pool.clone()));
    }
    if let Some(files) = &_files {
        handlers.push(files::cleanup_handler(pool.clone(), files.clone()));
        handlers.push(files::rescan_handler(pool.clone(), files.clone()));
    }
    let maintenance_period = Duration::from_secs(u64::from(policy.maintenance_secs));
    // example:knowledge:worker:start
    let export_policy = labos_threejs_app::modules::knowledge::ExportPolicy::from_env()?;
    let mut maintenance = maintenance;
    handlers.push(labos_threejs_app::modules::knowledge::document_cleanup_handler(pool.clone()));
    handlers.push(labos_threejs_app::modules::knowledge::base_cleanup_handler(
        pool.clone(),
    ));
    maintenance.push(labos_threejs_app::modules::knowledge::export_maintenance(
        pool.clone(),
    ));
    if let Some(files) = _files {
        handlers.push(labos_threejs_app::modules::knowledge::export_handler(
            pool.clone(),
            files,
            settings.auth,
            export_policy,
        ));
    }
    // example:knowledge:worker:end
    let worker = Arc::new(Worker::new(pool.clone(), handlers, policy));
    let ready_worker = worker.clone();
    let ready_pool = pool.clone();
    let app = Router::new()
        .route(
            "/health/live",
            get(|| async { Json(serde_json::json!({"status":"ok"})) }),
        )
        .route(
            "/health/ready",
            get(move |Extension(id): Extension<http::RequestId>| {
                let worker = ready_worker.clone();
                let pool = ready_pool.clone();
                async move {
                    if worker.is_running() && system::schema_version(&pool).await.is_some() {
                        Json(serde_json::json!({"status":"ok"})).into_response()
                    } else {
                        http::public_error(
                            StatusCode::SERVICE_UNAVAILABLE,
                            "worker.unavailable",
                            "Worker is not ready",
                            id,
                        )
                    }
                }
            }),
        )
        .fallback(http::not_found)
        .method_not_allowed_fallback(http::method_not_allowed)
        .layer(middleware::from_fn(http::request_context));
    let listener = tokio::net::TcpListener::bind(bind).await?;
    tracing::info!(address = %listener.local_addr()?, "Worker health listener ready");
    let (stop_tx, mut stop_rx) = tokio::sync::watch::channel(false);
    let worker_stop = stop_rx.clone();
    let mut maintenance_stop = stop_rx.clone();
    let maintain = jobs::run_maintenance(maintenance, maintenance_period, async move {
        let _ = maintenance_stop.changed().await;
    });
    let run_worker = worker.run_until(async move {
        let mut receiver = worker_stop;
        let _ = receiver.changed().await;
    });
    let server = axum::serve(listener, app)
        .with_graceful_shutdown(async move {
            let _ = stop_rx.changed().await;
        })
        .into_future();
    tokio::pin!(run_worker, maintain, server);
    let (worker_finished, maintenance_finished, server_finished) = tokio::select! {
        _ = shutdown_signal() => (false, false, false),
        _ = &mut run_worker => (true, false, false),
        _ = &mut maintain => (false, true, false),
        result = &mut server => { result?; (false, false, true) },
    };
    let _ = stop_tx.send(true);
    if !worker_finished {
        run_worker.await;
    }
    if !maintenance_finished {
        maintain.await;
    }
    if !server_finished {
        let _ = tokio::time::timeout(Duration::from_secs(1), server).await;
    }
    let _ = tokio::time::timeout(Duration::from_secs(1), pool.close()).await;
    let _ = tokio::task::spawn_blocking(move || telemetry.shutdown()).await;
    Ok(())
}
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("install SIGTERM handler");
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {} }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
    tracing::info!("stopping worker claims and draining current work");
}
