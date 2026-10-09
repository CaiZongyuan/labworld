mod cleanup;
use crate::http::{RequestId, public_error};
use axum::{http::StatusCode, response::Response};
use base64::{Engine, engine::general_purpose::STANDARD};
use chrono::{DateTime, Utc};
pub use cleanup::{cleanup_handler, cleanup_maintenance, mark_deleting, rescan_handler};
use labos_threejs_platform::{
    config::FileLimits,
    object_storage::{
        ObjectLocation, ObjectStorage, S3ObjectStorage, StorageError, StorageSettings,
        UploadHeaders,
    },
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::PgConnection;
use std::{collections::BTreeMap, sync::Arc, time::Duration};
use tokio::sync::Semaphore;
use utoipa::ToSchema;

#[derive(Clone)]
pub struct FilePolicy {
    pub max_bytes: i64,
    pub upload_secs: u32,
    pub download_secs: u32,
}
impl Default for FilePolicy {
    fn default() -> Self {
        Self {
            max_bytes: 20 * 1024 * 1024,
            upload_secs: 900,
            download_secs: 60,
        }
    }
}

#[derive(Clone)]
pub struct FileService {
    storage: Arc<dyn ObjectStorage>,
    bucket: String,
    pub policy: FilePolicy,
    verification_slots: Arc<Semaphore>,
}

#[derive(Clone, Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct UploadInput {
    pub file_name: String,
    pub content_type: String,
    #[schema(minimum = 0)]
    pub size: i64,
    pub sha256: String,
}

#[derive(Clone, sqlx::FromRow)]
pub struct Upload {
    pub id: String,
    file_name: String,
    content_type: String,
    declared_size: i64,
    sha256: Vec<u8>,
    state: String,
    bucket: String,
    staging_key: String,
    ready_key: Option<String>,
    actual_size: Option<i64>,
    expires_at: DateTime<Utc>,
    created_at: DateTime<Utc>,
}

#[derive(Serialize, ToSchema)]
pub struct ObjectCapability {
    pub url: String,
    pub method: String,
    pub headers: BTreeMap<String, String>,
    pub expires_at: DateTime<Utc>,
}
#[derive(Serialize, ToSchema)]
pub struct UploadCapability {
    pub upload_id: String,
    pub state: String,
    pub upload: Option<ObjectCapability>,
}
#[derive(Serialize, ToSchema, sqlx::FromRow)]
pub struct FileInfo {
    pub id: String,
    pub file_name: String,
    pub content_type: String,
    pub size: i64,
    pub sha256: String,
    pub created_at: DateTime<Utc>,
    pub previewable: bool,
}

#[derive(Serialize, ToSchema)]
pub struct DownloadCapability {
    #[serde(flatten)]
    pub request: ObjectCapability,
    pub file: FileInfo,
}

#[derive(Debug)]
pub enum Error {
    InvalidInput,
    TooLarge,
    NotFound,
    Expired,
    Rejected,
    ObjectMissing,
    ObjectChanged,
    Unavailable,
}
impl From<sqlx::Error> for Error {
    fn from(_: sqlx::Error) -> Self {
        Self::Unavailable
    }
}
impl From<StorageError> for Error {
    fn from(error: StorageError) -> Self {
        match error {
            StorageError::Expired => Self::Expired,
            StorageError::TooLarge => Self::TooLarge,
            StorageError::NotFound => Self::ObjectMissing,
            StorageError::PreconditionFailed => Self::ObjectChanged,
            _ => Self::Unavailable,
        }
    }
}
impl Error {
    pub fn response(self, id: RequestId) -> Response {
        let (status, code, message) = match self {
            Self::InvalidInput => (
                StatusCode::BAD_REQUEST,
                "files.invalid_input",
                "Use a valid filename, media type, size and SHA-256",
            ),
            Self::TooLarge => (
                StatusCode::PAYLOAD_TOO_LARGE,
                "files.too_large",
                "File exceeds the allowed size",
            ),
            Self::NotFound => (StatusCode::NOT_FOUND, "files.not_found", "File not found"),
            Self::Expired => (
                StatusCode::GONE,
                "files.upload_expired",
                "Upload expired; start a new upload",
            ),
            Self::Rejected => (
                StatusCode::UNPROCESSABLE_ENTITY,
                "files.upload_rejected",
                "Upload was rejected; start a new upload",
            ),
            Self::ObjectMissing => (
                StatusCode::CONFLICT,
                "files.upload_missing",
                "Upload the file bytes before completing",
            ),
            Self::ObjectChanged => (
                StatusCode::CONFLICT,
                "files.upload_changed",
                "Staging content changed; retry completion",
            ),
            Self::Unavailable => (
                StatusCode::SERVICE_UNAVAILABLE,
                "files.unavailable",
                "File storage is temporarily unavailable",
            ),
        };
        public_error(status, code, message, id)
    }
}

const UPLOAD_COLUMNS: &str = "id::text, file_name, content_type, declared_size, sha256, state, bucket, staging_key, ready_key, actual_size, expires_at, created_at";
impl FileService {
    /// Wire the validated deployment settings identically in API and Worker.
    pub fn from_settings(storage: &StorageSettings, limits: &FileLimits) -> Self {
        Self::new(
            Arc::new(S3ObjectStorage::new(storage)),
            storage.bucket.clone(),
            FilePolicy {
                max_bytes: limits.max_bytes,
                upload_secs: limits.upload_secs,
                download_secs: limits.download_secs,
            },
        )
    }

    pub fn new(storage: Arc<dyn ObjectStorage>, bucket: String, policy: FilePolicy) -> Self {
        Self {
            storage,
            bucket,
            policy,
            verification_slots: Arc::new(Semaphore::new(4)),
        }
    }

    pub fn validate(&self, input: &mut UploadInput) -> Result<(), Error> {
        if input.size > self.policy.max_bytes {
            return Err(Error::TooLarge);
        }
        if input.size < 0
            || input.file_name.trim().is_empty()
            || input.file_name.chars().count() > 255
            || input.file_name.chars().any(char::is_control)
            || input.file_name.contains(['/', '\\'])
            || matches!(input.file_name.as_str(), "." | "..")
        {
            return Err(Error::InvalidInput);
        }
        let content_type: mime::Mime = input
            .content_type
            .parse()
            .map_err(|_| Error::InvalidInput)?;
        if content_type.type_() == mime::STAR
            || content_type.subtype() == mime::STAR
            || input.content_type.len() > 127
        {
            return Err(Error::InvalidInput);
        }
        input.content_type = content_type.essence_str().to_owned();
        if !hex::decode(&input.sha256).is_ok_and(|bytes| bytes.len() == 32) {
            return Err(Error::InvalidInput);
        }
        input.sha256.make_ascii_lowercase();
        input.content_type.make_ascii_lowercase();
        Ok(())
    }

    pub async fn start(
        &self,
        connection: &mut PgConnection,
        actor_id: &str,
        input: &UploadInput,
    ) -> Result<Upload, Error> {
        let mut normalized = input.clone();
        self.validate(&mut normalized)?;
        let input = &normalized;
        let id = uuid::Uuid::now_v7().to_string();
        sqlx::query_as(&format!("INSERT INTO labos_threejs_core.files (id, created_by, file_name, content_type, declared_size, sha256, bucket, staging_key, expires_at) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, clock_timestamp() + make_interval(secs => $9)) RETURNING {UPLOAD_COLUMNS}"))
            .bind(&id).bind(actor_id).bind(&input.file_name).bind(&input.content_type).bind(input.size).bind(hex::decode(&input.sha256).map_err(|_| Error::InvalidInput)?)
            .bind(&self.bucket).bind(format!("uploads/{id}/staging")).bind(f64::from(self.policy.upload_secs)).fetch_one(connection).await.map_err(Into::into)
    }

    pub async fn load(&self, connection: &mut PgConnection, id: &str) -> Result<Upload, Error> {
        sqlx::query_as(&format!(
            "SELECT {UPLOAD_COLUMNS} FROM labos_threejs_core.files WHERE id = $1::uuid"
        ))
        .bind(id)
        .fetch_optional(connection)
        .await?
        .ok_or(Error::NotFound)
    }

    pub async fn upload_capability(&self, upload: &Upload) -> Result<UploadCapability, Error> {
        if upload.state == "ready" {
            return Ok(UploadCapability {
                upload_id: upload.id.clone(),
                state: "ready".into(),
                upload: None,
            });
        }
        if upload.state == "rejected" {
            return Err(Error::Rejected);
        }
        if matches!(upload.state.as_str(), "deleting" | "deleted") {
            return Err(Error::NotFound);
        }
        if upload.declared_size > self.policy.max_bytes {
            return Err(Error::TooLarge);
        }
        if upload.state != "pending_upload" || upload.expires_at <= Utc::now() {
            return Err(Error::Expired);
        }
        let deadline = upload
            .expires_at
            .min(Utc::now() + chrono::Duration::seconds(self.policy.upload_secs.into()));
        let signed = self
            .storage
            .presign_upload(
                &ObjectLocation {
                    bucket: upload.bucket.clone(),
                    key: upload.staging_key.clone(),
                },
                &UploadHeaders {
                    content_type: upload.content_type.clone(),
                    upload_id: upload.id.clone(),
                    checksum_sha256: STANDARD.encode(&upload.sha256),
                },
                deadline.into(),
            )
            .await?;
        Ok(UploadCapability {
            upload_id: upload.id.clone(),
            state: "pending_upload".into(),
            upload: Some(ObjectCapability {
                url: signed.url,
                method: signed.method,
                headers: signed.headers,
                expires_at: signed.expires_at.into(),
            }),
        })
    }
}

pub async fn ready_info(
    connection: &mut PgConnection,
    ids: &[String],
) -> Result<Vec<FileInfo>, Error> {
    sqlx::query_as("SELECT id::text, file_name, content_type, actual_size AS size, encode(sha256, 'hex') AS sha256, created_at, content_type IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp') AS previewable FROM labos_threejs_core.files WHERE id = ANY($1::text[]::uuid[]) AND state = 'ready' ORDER BY id")
        .bind(ids).fetch_all(connection).await.map_err(Into::into)
}

pub enum CompletionPlan {
    Ready(FileInfo),
    Attempt(CompletionAttempt),
    Expired,
    Rejected,
}
pub enum Publication {
    Adopted(FileInfo),
    Existing(FileInfo),
    Expired,
}
#[derive(Clone)]
pub struct CompletionAttempt {
    upload: Upload,
    candidate_id: String,
    target: ObjectLocation,
}
pub struct VerifiedCandidate {
    attempt: CompletionAttempt,
    size: i64,
}

impl Upload {
    fn info(&self) -> Result<FileInfo, Error> {
        if self.state != "ready" {
            return Err(Error::NotFound);
        }
        Ok(FileInfo {
            id: self.id.clone(),
            file_name: self.file_name.clone(),
            content_type: self.content_type.clone(),
            size: self.actual_size.ok_or(Error::Unavailable)?,
            sha256: hex::encode(&self.sha256),
            created_at: self.created_at,
            previewable: matches!(
                self.content_type.as_str(),
                "image/png" | "image/jpeg" | "image/gif" | "image/webp"
            ),
        })
    }
}

impl FileService {
    pub async fn plan_completion(
        &self,
        connection: &mut PgConnection,
        id: &str,
    ) -> Result<CompletionPlan, Error> {
        let upload: Upload = sqlx::query_as(&format!(
            "SELECT {UPLOAD_COLUMNS} FROM labos_threejs_core.files WHERE id = $1::uuid FOR UPDATE"
        ))
        .bind(id)
        .fetch_optional(&mut *connection)
        .await?
        .ok_or(Error::NotFound)?;
        if upload.state == "ready" {
            return Ok(CompletionPlan::Ready(upload.info()?));
        }
        if upload.state == "rejected" {
            return Ok(CompletionPlan::Rejected);
        }
        if matches!(upload.state.as_str(), "deleting" | "deleted") {
            return Err(Error::NotFound);
        }
        if upload.state == "expired" || upload.expires_at <= Utc::now() {
            sqlx::query("UPDATE labos_threejs_core.files SET state = 'expired', updated_at = now() WHERE id = $1::uuid AND state = 'pending_upload'").bind(id).execute(&mut *connection).await?;
            return Ok(CompletionPlan::Expired);
        }
        if upload.state != "pending_upload" {
            return Err(Error::NotFound);
        }
        let candidate_id = uuid::Uuid::now_v7().to_string();
        let target = ObjectLocation {
            bucket: upload.bucket.clone(),
            key: format!("objects/{id}/{candidate_id}"),
        };
        sqlx::query("INSERT INTO labos_threejs_core.file_candidates (id, file_id, bucket, object_key) VALUES ($1::uuid, $2::uuid, $3, $4)")
            .bind(&candidate_id).bind(id).bind(&target.bucket).bind(&target.key).execute(connection).await?;
        Ok(CompletionPlan::Attempt(CompletionAttempt {
            upload,
            candidate_id,
            target,
        }))
    }

    pub async fn verify_candidate(
        &self,
        attempt: &CompletionAttempt,
    ) -> Result<VerifiedCandidate, Error> {
        self.verify_candidate_with(attempt, |_| true).await
    }

    /// Business validation runs on the exact immutable bytes whose hash is verified.
    pub async fn verify_candidate_with(
        &self,
        attempt: &CompletionAttempt,
        validate: fn(&[u8]) -> bool,
    ) -> Result<VerifiedCandidate, Error> {
        let permit = self
            .verification_slots
            .clone()
            .try_acquire_owned()
            .map_err(|_| Error::Unavailable)?;
        let verify = async {
            let source = ObjectLocation {
                bucket: attempt.upload.bucket.clone(),
                key: attempt.upload.staging_key.clone(),
            };
            let staged = self.storage.head(&source).await?;
            if staged.size > self.policy.max_bytes as u64 {
                return Err(Error::TooLarge);
            }
            self.storage
                .copy_if_absent(&source, &staged.etag, &attempt.target)
                .await?;
            let actual = self.storage.head(&attempt.target).await?;
            if actual.size != attempt.upload.declared_size as u64
                || actual.content_type != attempt.upload.content_type
                || actual.metadata.get("upload-id") != Some(&attempt.upload.id)
            {
                return Err(Error::Rejected);
            }
            let bytes = self
                .storage
                .read(&attempt.target, self.policy.max_bytes as u64)
                .await?;
            if bytes.len() as i64 != attempt.upload.declared_size {
                return Err(Error::Rejected);
            }
            let expected = attempt.upload.sha256.clone();
            let content_type = attempt.upload.content_type.clone();
            let valid = tokio::task::spawn_blocking(move || {
                let _permit = permit;
                Sha256::digest(&bytes).as_slice() == expected
                    && valid_contents(&content_type, &bytes)
                    && validate(&bytes)
            })
            .await
            .map_err(|_| Error::Unavailable)?;
            if !valid {
                return Err(Error::Rejected);
            }
            Ok(VerifiedCandidate {
                attempt: attempt.clone(),
                size: actual.size as i64,
            })
        };
        tokio::time::timeout(Duration::from_secs(30), verify)
            .await
            .map_err(|_| Error::Unavailable)?
    }

    pub async fn abandon(
        &self,
        connection: &mut PgConnection,
        attempt: &CompletionAttempt,
        rejected: bool,
    ) -> Result<(), Error> {
        // Publication and cleanup take file before candidate, including failure transitions.
        sqlx::query("SELECT id FROM labos_threejs_core.files WHERE id = $1::uuid FOR UPDATE")
            .bind(&attempt.upload.id)
            .execute(&mut *connection)
            .await?;
        sqlx::query("UPDATE labos_threejs_core.file_candidates SET state = 'abandoned', last_error = 'completion_failed', updated_at = now() WHERE id = $1::uuid AND state = 'copying'")
            .bind(&attempt.candidate_id).execute(&mut *connection).await?;
        if rejected {
            sqlx::query("UPDATE labos_threejs_core.files SET state = 'rejected', last_error = 'content_mismatch', updated_at = now() WHERE id = $1::uuid AND state = 'pending_upload'").bind(&attempt.upload.id).execute(connection).await?;
        }
        Ok(())
    }

    pub async fn publish(
        &self,
        connection: &mut PgConnection,
        verified: &VerifiedCandidate,
    ) -> Result<Publication, Error> {
        let attempt = &verified.attempt;
        let upload: Upload = sqlx::query_as(&format!(
            "SELECT {UPLOAD_COLUMNS} FROM labos_threejs_core.files WHERE id = $1::uuid FOR UPDATE"
        ))
        .bind(&attempt.upload.id)
        .fetch_optional(&mut *connection)
        .await?
        .ok_or(Error::NotFound)?;
        if upload.state == "ready" {
            self.abandon(connection, attempt, false).await?;
            return Ok(Publication::Existing(upload.info()?));
        }
        if upload.state != "pending_upload" {
            return Err(match upload.state.as_str() {
                "rejected" => Error::Rejected,
                "expired" => Error::Expired,
                _ => Error::NotFound,
            });
        }
        let candidate = sqlx::query("UPDATE labos_threejs_core.file_candidates SET state = 'adopted', updated_at = now() WHERE id = $1::uuid AND file_id = $2::uuid AND state = 'copying'")
            .bind(&attempt.candidate_id).bind(&upload.id).execute(&mut *connection).await?;
        if candidate.rows_affected() != 1 {
            return Err(Error::Unavailable);
        }
        let published: Option<Upload> = sqlx::query_as(&format!("UPDATE labos_threejs_core.files SET state = 'ready', ready_key = $1, ready_candidate_id = $2::uuid, actual_size = $3, updated_at = now() WHERE id = $4::uuid AND state = 'pending_upload' AND expires_at > clock_timestamp() RETURNING {UPLOAD_COLUMNS}"))
            .bind(&attempt.target.key).bind(&attempt.candidate_id).bind(verified.size).bind(&upload.id).fetch_optional(&mut *connection).await?;
        let Some(published) = published else {
            sqlx::query(
                "UPDATE labos_threejs_core.file_candidates SET state = 'abandoned' WHERE id = $1::uuid",
            )
            .bind(&attempt.candidate_id)
            .execute(&mut *connection)
            .await?;
            sqlx::query("UPDATE labos_threejs_core.files SET state = 'expired', updated_at = now() WHERE id = $1::uuid AND state = 'pending_upload'").bind(&upload.id).execute(connection).await?;
            return Ok(Publication::Expired);
        };
        sqlx::query("UPDATE labos_threejs_core.file_candidates SET state = 'abandoned', updated_at = now() WHERE file_id = $1::uuid AND id <> $2::uuid AND state = 'copying'")
            .bind(&upload.id).bind(&attempt.candidate_id).execute(connection).await?;
        Ok(Publication::Adopted(published.info()?))
    }

    pub async fn download(
        &self,
        connection: &mut PgConnection,
        id: &str,
        inline: bool,
    ) -> Result<DownloadCapability, Error> {
        let upload: Upload = sqlx::query_as(&format!(
            "SELECT {UPLOAD_COLUMNS} FROM labos_threejs_core.files WHERE id = $1::uuid FOR SHARE"
        ))
        .bind(id)
        .fetch_optional(connection)
        .await?
        .ok_or(Error::NotFound)?;
        let info = upload.info()?;
        if inline && !info.previewable {
            return Err(Error::InvalidInput);
        }
        let disposition = format!(
            "{}; filename=\"download\"; filename*=UTF-8''{}",
            if inline { "inline" } else { "attachment" },
            percent_encoding::utf8_percent_encode(
                &info.file_name,
                percent_encoding::NON_ALPHANUMERIC
            )
        );
        let signed = self
            .storage
            .presign_download(
                &ObjectLocation {
                    bucket: upload.bucket,
                    key: upload.ready_key.ok_or(Error::NotFound)?,
                },
                &disposition,
                &info.content_type,
                Duration::from_secs(self.policy.download_secs.into()),
            )
            .await?;
        Ok(DownloadCapability {
            file: info,
            request: ObjectCapability {
                url: signed.url,
                method: signed.method,
                headers: signed.headers,
                expires_at: signed.expires_at.into(),
            },
        })
    }
}

fn valid_contents(content_type: &str, bytes: &[u8]) -> bool {
    match content_type {
        "image/png" => bytes.starts_with(b"\x89PNG\r\n\x1a\n"),
        "image/jpeg" => bytes.starts_with(&[0xff, 0xd8, 0xff]),
        "image/gif" => bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a"),
        "image/webp" => bytes.starts_with(b"RIFF") && bytes.get(8..12) == Some(b"WEBP"),
        "application/pdf" => bytes.starts_with(b"%PDF-"),
        _ => true,
    }
}

/// Immutable object identity recorded in an authorized business snapshot.
#[derive(Clone, Serialize, Deserialize, sqlx::FromRow)]
pub struct FileSnapshot {
    pub id: String,
    pub file_name: String,
    pub content_type: String,
    pub size: i64,
    pub sha256: String,
    pub bucket: String,
    pub object_key: String,
}

pub async fn snapshots(
    connection: &mut PgConnection,
    ids: &[String],
) -> Result<Vec<FileSnapshot>, Error> {
    let files: Vec<FileSnapshot> = sqlx::query_as("SELECT id::text, file_name, content_type, actual_size AS size, encode(sha256, 'hex') AS sha256, bucket, ready_key AS object_key FROM labos_threejs_core.files WHERE id = ANY($1::text[]::uuid[]) AND state = 'ready' ORDER BY id FOR SHARE")
        .bind(ids).fetch_all(connection).await?;
    if files.len() != ids.len() {
        return Err(Error::NotFound);
    }
    Ok(files)
}

impl FileService {
    /// Only business code supplies this policy; HTTP upload limits stay separate.
    pub async fn prepare_generated(
        &self,
        connection: &mut PgConnection,
        actor_id: &str,
        input: &UploadInput,
        max_bytes: i64,
        retention_secs: u32,
    ) -> Result<CompletionAttempt, Error> {
        let service = Self {
            policy: FilePolicy {
                max_bytes,
                upload_secs: retention_secs,
                download_secs: self.policy.download_secs,
            },
            ..self.clone()
        };
        let upload = service.start(connection, actor_id, input).await?;
        match service.plan_completion(connection, &upload.id).await? {
            CompletionPlan::Attempt(attempt) => Ok(attempt),
            _ => Err(Error::Unavailable),
        }
    }

    pub async fn download_snapshot(
        &self,
        snapshot: &FileSnapshot,
        path: &std::path::Path,
    ) -> Result<(), Error> {
        let digest = self
            .storage
            .download_to(
                &ObjectLocation {
                    bucket: snapshot.bucket.clone(),
                    key: snapshot.object_key.clone(),
                },
                path,
                snapshot.size as u64,
            )
            .await?;
        if digest.size != snapshot.size as u64 || digest.sha256 != snapshot.sha256 {
            return Err(Error::Rejected);
        }
        Ok(())
    }

    /// The private artifact is complete and immutable before this conditional write begins.
    pub async fn write_generated(
        &self,
        attempt: &CompletionAttempt,
        path: &std::path::Path,
    ) -> Result<VerifiedCandidate, Error> {
        self.storage
            .put_file_if_absent(
                &attempt.target,
                path,
                &UploadHeaders {
                    content_type: attempt.upload.content_type.clone(),
                    upload_id: attempt.upload.id.clone(),
                    checksum_sha256: STANDARD.encode(&attempt.upload.sha256),
                },
            )
            .await?;
        let actual = self.storage.head(&attempt.target).await?;
        if actual.size != attempt.upload.declared_size as u64
            || actual.content_type != attempt.upload.content_type
            || actual.metadata.get("upload-id") != Some(&attempt.upload.id)
        {
            return Err(Error::Rejected);
        }
        Ok(VerifiedCandidate {
            attempt: attempt.clone(),
            size: actual.size as i64,
        })
    }
}
