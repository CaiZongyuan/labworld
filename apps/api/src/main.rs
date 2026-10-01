use labos_threejs_app::modules::files::FileService;
use labos_threejs_platform::{config::Settings, postgres, telemetry};
use std::{future::IntoFuture, time::Duration};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let settings = Settings::from_env()?;
    let telemetry = telemetry::init(settings.log_filter, "labos-threejs-api").await?;
    let pool = postgres::connect_lazy(settings.database);
    let files = settings
        .storage
        .as_ref()
        .map(|storage| FileService::from_settings(storage, &settings.file_limits));
    let app = labos_threejs_api::configured_router(pool.clone(), settings.auth, files)?;
    let listener = tokio::net::TcpListener::bind(settings.bind).await?;
    tracing::info!(address = %listener.local_addr()?, "API listening");
    let (shutdown_tx, shutdown_rx) = tokio::sync::oneshot::channel::<()>();
    // Reference-domain routers will be composed here without changing Core.
    let mut server = Box::pin(
        axum::serve(
            listener,
            app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
        )
        .with_graceful_shutdown(async {
            let _ = shutdown_rx.await;
        })
        .into_future(),
    );
    tokio::select! {
        result = &mut server => result?,
        _ = shutdown_signal() => {
            let _ = shutdown_tx.send(());
            match tokio::time::timeout(Duration::from_secs(3), &mut server).await {
                Ok(result) => result?,
                Err(_) => tracing::warn!("HTTP drain deadline reached"),
            }
        }
    }
    drop(server);
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
        tokio::select! { _ = tokio::signal::ctrl_c() => {}, _ = terminate.recv() => {}, }
    }
    #[cfg(not(unix))]
    tokio::signal::ctrl_c()
        .await
        .expect("install shutdown handler");
    tracing::info!("draining HTTP requests");
}
