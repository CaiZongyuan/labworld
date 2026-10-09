use labos_threejs_platform::{config::Settings, object_storage::S3ObjectStorage};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let settings = Settings::from_env()?;
    if let Some(storage) = settings.storage {
        S3ObjectStorage::new(&storage)
            .bootstrap(&storage.bucket, &settings.auth.origin)
            .await?;
        println!("Dedicated storage bucket and browser CORS are ready.");
    } else {
        println!("Object storage is disabled; no bucket changes.");
    }
    Ok(())
}
