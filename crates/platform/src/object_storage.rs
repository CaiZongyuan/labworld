use async_trait::async_trait;
use aws_sdk_s3::{
    Client, Config,
    config::{BehaviorVersion, Credentials, Region, retry::RetryConfig, timeout::TimeoutConfig},
    presigning::PresigningConfig,
    types::{CorsConfiguration, CorsRule},
};
use std::{
    collections::BTreeMap,
    path::Path,
    time::{Duration, SystemTime},
};

#[derive(Clone)]
pub struct StorageSettings {
    pub endpoint: String,
    pub public_endpoint: String,
    pub region: String,
    pub bucket: String,
    pub access_key: String,
    pub secret_key: String,
}

#[derive(Clone)]
pub struct ObjectLocation {
    pub bucket: String,
    pub key: String,
}

pub struct UploadHeaders {
    pub content_type: String,
    pub upload_id: String,
    pub checksum_sha256: String,
}

pub struct SignedRequest {
    pub url: String,
    pub method: String,
    pub headers: BTreeMap<String, String>,
    pub expires_at: SystemTime,
}

pub struct ObjectInfo {
    pub size: u64,
    pub content_type: String,
    pub etag: String,
    pub metadata: BTreeMap<String, String>,
}

pub struct FileDigest {
    pub size: u64,
    pub sha256: String,
}

#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error("The signing deadline has expired")]
    Expired,
    #[error("Object storage is unavailable")]
    Unavailable,
    #[error("Object not found")]
    NotFound,
    #[error("Object write precondition failed")]
    PreconditionFailed,
    #[error("Object exceeds the read limit")]
    TooLarge,
    #[error("Object storage returned an invalid response")]
    InvalidResponse,
}

#[async_trait]
pub trait ObjectStorage: Send + Sync {
    async fn presign_upload(
        &self,
        location: &ObjectLocation,
        headers: &UploadHeaders,
        deadline: SystemTime,
    ) -> Result<SignedRequest, StorageError>;
    async fn delete(&self, location: &ObjectLocation) -> Result<(), StorageError>;
    async fn head(&self, location: &ObjectLocation) -> Result<ObjectInfo, StorageError>;
    async fn copy_if_absent(
        &self,
        source: &ObjectLocation,
        source_etag: &str,
        target: &ObjectLocation,
    ) -> Result<(), StorageError>;
    async fn read(&self, location: &ObjectLocation, limit: u64) -> Result<Vec<u8>, StorageError>;
    async fn download_to(
        &self,
        location: &ObjectLocation,
        path: &Path,
        limit: u64,
    ) -> Result<FileDigest, StorageError>;
    async fn put_file_if_absent(
        &self,
        location: &ObjectLocation,
        path: &Path,
        headers: &UploadHeaders,
    ) -> Result<(), StorageError>;
    async fn presign_download(
        &self,
        location: &ObjectLocation,
        disposition: &str,
        content_type: &str,
        ttl: Duration,
    ) -> Result<SignedRequest, StorageError>;
}

pub struct S3ObjectStorage {
    internal: Client,
    public: Client,
}

fn failure(status: Option<u16>) -> StorageError {
    match status {
        Some(404) => StorageError::NotFound,
        Some(412) => StorageError::PreconditionFailed,
        _ => StorageError::Unavailable,
    }
}

impl S3ObjectStorage {
    pub fn new(settings: &StorageSettings) -> Self {
        let client = |endpoint: &str| {
            Client::from_conf(
                Config::builder()
                    .behavior_version(BehaviorVersion::v2026_01_12())
                    .credentials_provider(Credentials::new(
                        &settings.access_key,
                        &settings.secret_key,
                        None,
                        None,
                        "application-config",
                    ))
                    .region(Region::new(settings.region.clone()))
                    .endpoint_url(endpoint)
                    .force_path_style(true)
                    .retry_config(RetryConfig::standard().with_max_attempts(1))
                    .timeout_config(
                        TimeoutConfig::builder()
                            .connect_timeout(Duration::from_secs(3))
                            .operation_timeout(Duration::from_secs(20))
                            .build(),
                    )
                    .build(),
            )
        };
        Self {
            internal: client(&settings.endpoint),
            public: client(&settings.public_endpoint),
        }
    }

    /// Initialize only the dedicated application bucket; credentials and other failures are not absence.
    pub async fn bootstrap(&self, bucket: &str, origin: &str) -> Result<(), StorageError> {
        // Bootstrap operations are idempotent. S3 can throttle parallel bucket creation.
        // Keep object copy's one-attempt policy on the separate internal client.
        let client = Client::from_conf(
            self.internal
                .config()
                .to_builder()
                .retry_config(RetryConfig::standard().with_max_attempts(5))
                .build(),
        );
        if let Err(error) = client.head_bucket().bucket(bucket).send().await {
            if error.raw_response().map(|r| r.status().as_u16()) != Some(404) {
                return Err(StorageError::Unavailable);
            }
            if let Err(error) = client.create_bucket().bucket(bucket).send().await
                && !error
                    .as_service_error()
                    .is_some_and(|error| error.is_bucket_already_owned_by_you())
            {
                return Err(StorageError::Unavailable);
            }
            client
                .head_bucket()
                .bucket(bucket)
                .send()
                .await
                .map_err(|_| StorageError::Unavailable)?;
        }
        let rule = CorsRule::builder()
            .allowed_origins(origin)
            .allowed_methods("PUT")
            .allowed_methods("GET")
            .allowed_methods("HEAD")
            .allowed_headers("content-type")
            .allowed_headers("content-encoding")
            .allowed_headers("x-amz-meta-upload-id")
            .allowed_headers("x-amz-checksum-sha256")
            .expose_headers("ETag")
            .expose_headers("Content-Length")
            .expose_headers("Content-Type")
            .expose_headers("Content-Disposition")
            .max_age_seconds(300)
            .build()
            .map_err(|_| StorageError::InvalidResponse)?;
        let cors = CorsConfiguration::builder()
            .cors_rules(rule)
            .build()
            .map_err(|_| StorageError::InvalidResponse)?;
        client
            .put_bucket_cors()
            .bucket(bucket)
            .cors_configuration(cors)
            .send()
            .await
            .map_err(|_| StorageError::Unavailable)?;
        Ok(())
    }
}

fn signed(
    request: aws_sdk_s3::presigning::PresignedRequest,
    expires_at: SystemTime,
) -> Result<SignedRequest, StorageError> {
    // Host is derived from the signed URL. Browser uploads must not require Content-Length.
    if request
        .headers()
        .any(|(name, _)| name.eq_ignore_ascii_case("content-length"))
    {
        return Err(StorageError::InvalidResponse);
    }
    Ok(SignedRequest {
        expires_at,
        url: request.uri().into(),
        method: request.method().into(),
        headers: request
            .headers()
            .filter(|(name, _)| !name.eq_ignore_ascii_case("host"))
            .map(|(name, value)| (name.to_owned(), value.to_owned()))
            .collect(),
    })
}

#[async_trait]
impl ObjectStorage for S3ObjectStorage {
    async fn presign_upload(
        &self,
        location: &ObjectLocation,
        headers: &UploadHeaders,
        deadline: SystemTime,
    ) -> Result<SignedRequest, StorageError> {
        crate::telemetry::observe_storage("presign_upload", async {
            let (config, expires_at) = signing_config(deadline)?;
            let request = self
                .public
                .put_object()
                .bucket(&location.bucket)
                .key(&location.key)
                .content_type(&headers.content_type)
                .content_encoding("identity")
                .metadata("upload-id", &headers.upload_id)
                .checksum_sha256(&headers.checksum_sha256)
                .presigned(config)
                .await
                .map_err(|_| StorageError::Unavailable)?;
            signed(request, expires_at)
        })
        .await
    }

    async fn delete(&self, location: &ObjectLocation) -> Result<(), StorageError> {
        crate::telemetry::observe_storage("delete", async {
            match self
                .internal
                .delete_object()
                .bucket(&location.bucket)
                .key(&location.key)
                .send()
                .await
            {
                Ok(_) => Ok(()),
                Err(error) => match failure(error.raw_response().map(|r| r.status().as_u16())) {
                    StorageError::NotFound => Ok(()),
                    other => Err(other),
                },
            }
        })
        .await
    }

    async fn head(&self, location: &ObjectLocation) -> Result<ObjectInfo, StorageError> {
        crate::telemetry::observe_storage("head", async {
            let object = self
                .internal
                .head_object()
                .bucket(&location.bucket)
                .key(&location.key)
                .send()
                .await
                .map_err(|error| failure(error.raw_response().map(|r| r.status().as_u16())))?;
            Ok(ObjectInfo {
                size: object
                    .content_length()
                    .and_then(|size| u64::try_from(size).ok())
                    .ok_or(StorageError::InvalidResponse)?,
                content_type: object
                    .content_type()
                    .unwrap_or("application/octet-stream")
                    .to_owned(),
                etag: object
                    .e_tag()
                    .ok_or(StorageError::InvalidResponse)?
                    .to_owned(),
                metadata: object
                    .metadata()
                    .cloned()
                    .unwrap_or_default()
                    .into_iter()
                    .collect(),
            })
        })
        .await
    }

    async fn copy_if_absent(
        &self,
        source: &ObjectLocation,
        source_etag: &str,
        target: &ObjectLocation,
    ) -> Result<(), StorageError> {
        crate::telemetry::observe_storage("copy_if_absent", async {
            let key = percent_encoding::utf8_percent_encode(
                &source.key,
                percent_encoding::NON_ALPHANUMERIC,
            );
            self.internal
                .copy_object()
                .bucket(&target.bucket)
                .key(&target.key)
                .copy_source(format!("{}/{key}", source.bucket))
                .copy_source_if_match(source_etag)
                .if_none_match("*")
                .send()
                .await
                .map_err(|error| failure(error.raw_response().map(|r| r.status().as_u16())))?;
            Ok(())
        })
        .await
    }

    async fn read(&self, location: &ObjectLocation, limit: u64) -> Result<Vec<u8>, StorageError> {
        crate::telemetry::observe_storage("read", async {
            let mut object = self
                .internal
                .get_object()
                .bucket(&location.bucket)
                .key(&location.key)
                .send()
                .await
                .map_err(|error| failure(error.raw_response().map(|r| r.status().as_u16())))?;
            if object
                .content_length()
                .is_some_and(|length| length < 0 || length as u64 > limit)
            {
                return Err(StorageError::TooLarge);
            }
            let mut bytes = Vec::new();
            while let Some(chunk) = object
                .body
                .try_next()
                .await
                .map_err(|_| StorageError::Unavailable)?
            {
                if bytes.len() as u64 + chunk.len() as u64 > limit {
                    return Err(StorageError::TooLarge);
                }
                bytes.extend_from_slice(&chunk);
            }
            Ok(bytes)
        })
        .await
    }

    async fn download_to(
        &self,
        location: &ObjectLocation,
        path: &Path,
        limit: u64,
    ) -> Result<FileDigest, StorageError> {
        crate::telemetry::observe_storage("download_to", async {
            use sha2::{Digest, Sha256};
            use tokio::io::AsyncWriteExt;
            let transfer = async {
                let mut object = self
                    .internal
                    .get_object()
                    .bucket(&location.bucket)
                    .key(&location.key)
                    .send()
                    .await
                    .map_err(|error| failure(error.raw_response().map(|r| r.status().as_u16())))?;
                if object
                    .content_length()
                    .is_some_and(|length| length < 0 || length as u64 > limit)
                {
                    return Err(StorageError::TooLarge);
                }
                let mut file = tokio::fs::File::create(path)
                    .await
                    .map_err(|_| StorageError::Unavailable)?;
                let mut received = 0u64;
                let mut hash = Sha256::new();
                while let Some(chunk) = object
                    .body
                    .try_next()
                    .await
                    .map_err(|_| StorageError::Unavailable)?
                {
                    received = received
                        .checked_add(chunk.len() as u64)
                        .filter(|size| *size <= limit)
                        .ok_or(StorageError::TooLarge)?;
                    hash.update(&chunk);
                    file.write_all(&chunk)
                        .await
                        .map_err(|_| StorageError::Unavailable)?;
                }
                file.flush().await.map_err(|_| StorageError::Unavailable)?;
                Ok(FileDigest {
                    size: received,
                    sha256: hex::encode(hash.finalize()),
                })
            };
            tokio::time::timeout(Duration::from_secs(120), transfer)
                .await
                .map_err(|_| StorageError::Unavailable)?
        })
        .await
    }

    async fn put_file_if_absent(
        &self,
        location: &ObjectLocation,
        path: &Path,
        headers: &UploadHeaders,
    ) -> Result<(), StorageError> {
        crate::telemetry::observe_storage("put_file_if_absent", async {
            let body = aws_sdk_s3::primitives::ByteStream::read_from()
                .path(path)
                .buffer_size(64 * 1024)
                .build()
                .await
                .map_err(|_| StorageError::Unavailable)?;
            self.internal
                .put_object()
                .bucket(&location.bucket)
                .key(&location.key)
                .if_none_match("*")
                .content_type(&headers.content_type)
                .content_encoding("identity")
                .checksum_sha256(&headers.checksum_sha256)
                .metadata("upload-id", &headers.upload_id)
                .body(body)
                .send()
                .await
                .map_err(|error| failure(error.raw_response().map(|r| r.status().as_u16())))?;
            Ok(())
        })
        .await
    }

    async fn presign_download(
        &self,
        location: &ObjectLocation,
        disposition: &str,
        content_type: &str,
        ttl: Duration,
    ) -> Result<SignedRequest, StorageError> {
        crate::telemetry::observe_storage("presign_download", async {
            let (config, expires_at) = signing_config(SystemTime::now() + ttl)?;
            let request = self
                .public
                .get_object()
                .bucket(&location.bucket)
                .key(&location.key)
                .response_content_disposition(disposition)
                .response_content_type(content_type)
                .response_content_encoding("identity")
                .response_cache_control("no-store")
                .presigned(config)
                .await
                .map_err(|_| StorageError::Unavailable)?;
            signed(request, expires_at)
        })
        .await
    }
}

fn signing_config(deadline: SystemTime) -> Result<(PresigningConfig, SystemTime), StorageError> {
    let seconds = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map_err(|_| StorageError::InvalidResponse)?
        .as_secs();
    let start = SystemTime::UNIX_EPOCH + Duration::from_secs(seconds);
    let ttl = Duration::from_secs(
        deadline
            .duration_since(start)
            .map_err(|_| StorageError::Expired)?
            .as_secs(),
    );
    if ttl.is_zero() {
        return Err(StorageError::Expired);
    }
    let config = PresigningConfig::builder()
        .start_time(start)
        .expires_in(ttl)
        .build()
        .map_err(|_| StorageError::InvalidResponse)?;
    Ok((config, start + ttl))
}
