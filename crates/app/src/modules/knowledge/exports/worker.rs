use super::{ExportPayload, ExportPolicy, Snapshot, archive};
use crate::modules::{
    audit,
    files::{self, FileService, UploadInput},
    identity::{self, CredentialRef},
    jobs::{JobError, Lease},
};
use chrono::{DateTime, Utc};
use labos_threejs_platform::config::AuthSettings;
use sqlx::{PgConnection, PgPool};
use std::{
    sync::{
        Arc, LazyLock,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tokio::sync::Semaphore;

static SLOTS: LazyLock<Arc<Semaphore>> = LazyLock::new(|| Arc::new(Semaphore::new(1)));
struct Cancel(Arc<AtomicBool>);
impl Drop for Cancel {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

#[derive(sqlx::FromRow)]
struct Work {
    document_id: String,
    requested_by: String,
    credential: serde_json::Value,
    snapshot: Option<serde_json::Value>,
    expires_at: DateTime<Utc>,
}

fn file_error(error: files::Error) -> JobError {
    match error {
        files::Error::NotFound | files::Error::ObjectMissing => {
            JobError::Permanent("knowledge.export_input_missing")
        }
        files::Error::Expired => JobError::Permanent("knowledge.export_expired"),
        files::Error::Rejected | files::Error::InvalidInput | files::Error::TooLarge => {
            JobError::Permanent("knowledge.export_input_invalid")
        }
        _ => JobError::Transient("knowledge.export_storage_unavailable"),
    }
}
fn access_error(error: super::Failure) -> JobError {
    match error {
        super::Failure::Unavailable => JobError::Transient("knowledge.export_database_unavailable"),
        _ => JobError::Permanent("knowledge.export_access_revoked"),
    }
}

async fn authorize(
    connection: &mut PgConnection,
    auth: &AuthSettings,
    work: &Work,
    snapshot: &Snapshot,
) -> Result<(), JobError> {
    if work.expires_at <= Utc::now() {
        return Err(JobError::Permanent("knowledge.export_expired"));
    }
    let document = uuid::Uuid::parse_str(&work.document_id)
        .map_err(|_| JobError::Permanent("knowledge.export_invalid_snapshot"))?;
    super::application::lock_document(connection, &work.requested_by, document, false)
        .await
        .map_err(access_error)?;
    let credential: CredentialRef = serde_json::from_value(work.credential.clone())
        .map_err(|_| JobError::Permanent("knowledge.export_invalid_snapshot"))?;
    if !identity::credential_is_current(connection, auth, &work.requested_by, &credential).await? {
        return Err(JobError::Permanent("knowledge.export_credential_revoked"));
    }
    let ids = snapshot
        .attachments
        .iter()
        .map(|file| file.id.clone())
        .collect::<Vec<_>>();
    let current = files::snapshots(connection, &ids)
        .await
        .map_err(file_error)?;
    for (current, saved) in current.iter().zip(snapshot.attachments.iter()) {
        if current.id != saved.id
            || current.bucket != saved.bucket
            || current.object_key != saved.object_key
            || current.size != saved.size
            || current.sha256 != saved.sha256
        {
            return Err(JobError::Permanent("knowledge.export_input_changed"));
        }
    }
    Ok(())
}

/// Public handler: every side effect follows the captured snapshot and a current lease.
pub async fn process_export(
    pool: &PgPool,
    files: &FileService,
    auth: &AuthSettings,
    policy: &ExportPolicy,
    lease: &Lease,
) -> Result<(), JobError> {
    let cancelled = Arc::new(AtomicBool::new(false));
    let _cancel = Cancel(cancelled.clone());
    let deadline = Instant::now() + Duration::from_secs(u64::from(policy.timeout_secs));
    let run = async {
        if lease.kind != "knowledge.export" || lease.schema_version != 1 {
            return Err(JobError::Permanent("knowledge.export_unknown_payload"));
        }
        let payload: ExportPayload = serde_json::from_value(lease.payload.clone())
            .map_err(|_| JobError::Permanent("knowledge.export_unknown_payload"))?;
        let export_id = uuid::Uuid::parse_str(&payload.export_id)
            .map_err(|_| JobError::Permanent("knowledge.export_unknown_payload"))?
            .to_string();
        let mut tx = pool.begin().await?;
        let work: Work = sqlx::query_as("SELECT document_id::text, requested_by::text, credential, snapshot, expires_at FROM knowledge.exports WHERE id = $1::uuid AND job_id = $2::uuid")
            .bind(&export_id).bind(&lease.id).fetch_optional(&mut *tx).await?.ok_or(JobError::Permanent("knowledge.export_source_missing"))?;
        let snapshot: Snapshot = serde_json::from_value(
            work.snapshot
                .clone()
                .ok_or(JobError::Permanent("knowledge.export_expired"))?,
        )
        .map_err(|_| JobError::Permanent("knowledge.export_invalid_snapshot"))?;
        let total = snapshot
            .attachments
            .iter()
            .try_fold(snapshot.markdown.len() as i64, |size, file| {
                size.checked_add(file.size)
            })
            .ok_or(JobError::Permanent("knowledge.export_limit"))?;
        if snapshot.attachments.len() > policy.max_attachments as usize
            || total > policy.max_input_bytes
        {
            return Err(JobError::Permanent("knowledge.export_limit"));
        }
        authorize(&mut tx, auth, &work, &snapshot).await?;
        lease.lock_current(&mut tx).await?;
        tx.commit().await?;
        let permit = SLOTS
            .clone()
            .acquire_owned()
            .await
            .map_err(|_| JobError::Transient("knowledge.export_busy"))?;
        let mut builder = tempfile::Builder::new();
        builder.prefix("labos-threejs-export-");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            builder.permissions(std::fs::Permissions::from_mode(0o700));
        }
        let directory = builder
            .tempdir()
            .map_err(|_| JobError::Transient("knowledge.export_disk_unavailable"))?;
        for file in &snapshot.attachments {
            files
                .download_snapshot(file, &directory.path().join(&file.id))
                .await
                .map_err(file_error)?;
        }
        let policy_copy = policy.clone();
        let archive_snapshot = Snapshot {
            title: snapshot.title.clone(),
            markdown: snapshot.markdown.clone(),
            attachments: snapshot.attachments.clone(),
        };
        // The blocking closure owns the permit and directory until it actually exits.
        let artifact = tokio::task::spawn_blocking(move || {
            archive::build(
                archive_snapshot,
                directory,
                policy_copy,
                deadline,
                cancelled,
                permit,
            )
        })
        .await
        .map_err(|_| JobError::Transient("knowledge.export_archive_failed"))??;
        let publish = async {
            let mut tx = pool.begin().await?;
            authorize(&mut tx, auth, &work, &snapshot).await?;
            lease.lock_current(&mut tx).await?;
            let attempt = files.prepare_generated(&mut tx, &work.requested_by, &UploadInput { file_name: format!("document-{export_id}.zip"), content_type: "application/zip".into(), size: artifact.size, sha256: artifact.sha256.clone() }, policy.max_output_bytes as i64, policy.retention_secs).await.map_err(file_error)?;
            tx.commit().await?;
            let verified = files.write_generated(&attempt, &artifact.path).await.map_err(file_error)?;
            let mut tx = pool.begin().await?;
            authorize(&mut tx, auth, &work, &snapshot).await?;
            lease.lock_current(&mut tx).await?;
            let present: Option<String> = sqlx::query_scalar("SELECT id::text FROM knowledge.exports WHERE id = $1::uuid AND job_id = $2::uuid AND file_id IS NULL AND expires_at > clock_timestamp() FOR UPDATE")
                .bind(&export_id).bind(&lease.id).fetch_optional(&mut *tx).await?;
            if present.is_none() { return Err(JobError::Permanent("knowledge.export_expired")); }
            let file = match files.publish(&mut tx, &verified).await.map_err(file_error)? {
                files::Publication::Adopted(info) => info,
                _ => return Err(JobError::Permanent("knowledge.export_publication_conflict")),
            };
            sqlx::query("UPDATE knowledge.exports SET file_id = $2::uuid, updated_at = now() WHERE id = $1::uuid").bind(&export_id).bind(&file.id).execute(&mut *tx).await?;
            audit::append(&mut tx, audit::Event { actor_id: &work.requested_by, action: "knowledge.export.complete", resource_type: "knowledge.export", resource_id: &export_id, source: audit::Source::Job { id: &lease.id, correlation_id: &lease.correlation_id }, subject_user_id: None }).await?;
            lease.succeed(&mut tx).await?;
            tx.commit().await?;
            Ok::<_, JobError>(())
        }.await;
        if artifact.directory.close().is_err() {
            tracing::warn!("export temporary directory cleanup failed");
        }
        publish
    };
    tokio::time::timeout(Duration::from_secs(u64::from(policy.timeout_secs)), run)
        .await
        .map_err(|_| JobError::Transient("knowledge.export_timeout"))?
}

struct ExportHandler {
    pool: PgPool,
    files: FileService,
    auth: AuthSettings,
    policy: ExportPolicy,
}
#[async_trait::async_trait]
impl crate::modules::jobs::Handler for ExportHandler {
    fn kind(&self) -> &'static str {
        "knowledge.export"
    }
    async fn run(&self, lease: &Lease) -> Result<(), JobError> {
        process_export(&self.pool, &self.files, &self.auth, &self.policy, lease).await
    }
}
pub fn export_handler(
    pool: PgPool,
    files: FileService,
    auth: AuthSettings,
    policy: ExportPolicy,
) -> Arc<dyn crate::modules::jobs::Handler> {
    Arc::new(ExportHandler {
        pool,
        files,
        auth,
        policy,
    })
}
