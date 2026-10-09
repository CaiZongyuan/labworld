use labos_threejs_platform::{config::Settings, postgres};
use std::{io, time::Duration};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let settings = Settings::from_env()?;
    let pool = postgres::connect_lazy(settings.database);
    match tokio::time::timeout(settings.migration_timeout, postgres::MIGRATOR.run(&pool)).await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => {
            eprintln!("migration error: {error}");
            return Err(io::Error::other(
                "Migration failed; check database availability and migration history",
            )
            .into());
        }
        Err(_) => {
            return Err(io::Error::new(
                io::ErrorKind::TimedOut,
                "Migration timed out; check for a competing migration or blocked database",
            )
            .into());
        }
    }
    let _ = tokio::time::timeout(Duration::from_secs(1), pool.close()).await;
    println!("Application migrations applied");
    Ok(())
}
