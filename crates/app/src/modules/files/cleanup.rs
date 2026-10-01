use super::{Error, FileService};
use crate::modules::jobs::{self, Handler, JobError, Lease, NewJob};
use labos_threejs_platform::object_storage::ObjectLocation;
use serde::{Deserialize, Serialize};
use sqlx::{PgConnection, PgPool};
use std::{sync::Arc, time::Duration};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct CleanupPayload {
    file_id: String,
}

/// Register immutable locations before any object deletion; caller owns the transaction.
async fn register_locations(connection: &mut PgConnection, id: &str) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT INTO labos_threejs_core.object_cleanup (bucket, object_key, file_id) SELECT bucket, staging_key, id FROM labos_threejs_core.files WHERE id = $1::uuid AND (state IN ('deleting', 'deleted', 'expired', 'rejected') OR (state = 'ready' AND expires_at <= clock_timestamp())) ON CONFLICT DO NOTHING")
        .bind(id).execute(&mut *connection).await?;
    sqlx::query("INSERT INTO labos_threejs_core.object_cleanup (bucket, object_key, file_id, candidate_id) SELECT c.bucket, c.object_key, c.file_id, c.id FROM labos_threejs_core.file_candidates c JOIN labos_threejs_core.files f ON f.id = c.file_id WHERE f.id = $1::uuid AND (f.state IN ('deleting', 'deleted', 'expired', 'rejected') OR (c.state IN ('abandoned', 'deleted') AND c.id IS DISTINCT FROM f.ready_candidate_id)) AND NOT EXISTS (SELECT 1 FROM labos_threejs_core.object_cleanup g WHERE g.bucket = c.bucket AND g.object_key = c.object_key) ORDER BY c.id LIMIT 100 ON CONFLICT DO NOTHING")
        .bind(id).execute(connection).await?;
    Ok(())
}

pub async fn mark_deleting(
    connection: &mut PgConnection,
    id: &str,
    correlation_id: &str,
) -> Result<(), Error> {
    let state: Option<String> =
        sqlx::query_scalar("SELECT state FROM labos_threejs_core.files WHERE id = $1::uuid FOR UPDATE")
            .bind(id)
            .fetch_optional(&mut *connection)
            .await?;
    let state = state.ok_or(Error::NotFound)?;
    if matches!(state.as_str(), "deleting" | "deleted") {
        return Ok(());
    }
    sqlx::query(
        "UPDATE labos_threejs_core.files SET state = 'deleting', updated_at = now() WHERE id = $1::uuid",
    )
    .bind(id)
    .execute(&mut *connection)
    .await?;
    register_locations(connection, id).await?;
    let job = jobs::enqueue(
        connection,
        NewJob {
            kind: "files.cleanup",
            schema_version: 1,
            max_attempts: 5,
            payload: serde_json::to_value(CleanupPayload { file_id: id.into() })
                .map_err(|_| Error::Unavailable)?,
            correlation_id,
        },
    )
    .await?;
    sqlx::query("UPDATE labos_threejs_core.files SET cleanup_job_id = $2::uuid WHERE id = $1::uuid")
        .bind(id)
        .bind(job)
        .execute(connection)
        .await?;
    Ok(())
}

#[derive(sqlx::FromRow)]
struct Target {
    bucket: String,
    object_key: String,
    candidate_id: Option<String>,
}
struct Cleanup {
    pool: PgPool,
    files: FileService,
}
#[async_trait::async_trait]
impl Handler for Cleanup {
    fn kind(&self) -> &'static str {
        "files.cleanup"
    }
    async fn run(&self, lease: &Lease) -> Result<(), JobError> {
        let work = async {
            if lease.schema_version != 1 {
                return Err(JobError::Permanent("files.cleanup_payload"));
            }
            let payload: CleanupPayload = serde_json::from_value(lease.payload.clone())
                .map_err(|_| JobError::Permanent("files.cleanup_payload"))?;
            let id = uuid::Uuid::parse_str(&payload.file_id)
                .map_err(|_| JobError::Permanent("files.cleanup_payload"))?
                .to_string();
            loop {
                let mut tx = self.pool.begin().await?;
                lease.lock_current(&mut tx).await?;
                let state: Option<String> = sqlx::query_scalar(
                    "SELECT state FROM labos_threejs_core.files WHERE id = $1::uuid FOR UPDATE",
                )
                .bind(&id)
                .fetch_optional(&mut *tx)
                .await?;
                if state.is_none() {
                    return Err(JobError::Permanent("files.cleanup_metadata_missing"));
                }
                register_locations(&mut tx, &id).await?;
                let targets:Vec<Target>=sqlx::query_as("SELECT bucket, object_key, candidate_id::text FROM labos_threejs_core.object_cleanup WHERE file_id = $1::uuid AND first_deleted_at IS NULL ORDER BY bucket, object_key LIMIT 100")
                    .bind(&id).fetch_all(&mut *tx).await?;
                if targets.is_empty() {
                    sqlx::query("UPDATE labos_threejs_core.files SET state = 'deleted', updated_at = now() WHERE id = $1::uuid AND state = 'deleting'").bind(&id).execute(&mut *tx).await?;
                    lease.succeed(&mut tx).await?;
                    tx.commit().await?;
                    return Ok(());
                }
                tx.commit().await?;
                for target in targets {
                    let location = ObjectLocation {
                        bucket: target.bucket.clone(),
                        key: target.object_key.clone(),
                    };
                    self.files
                        .storage
                        .delete(&location)
                        .await
                        .map_err(|_| JobError::Transient("files.cleanup_storage_unavailable"))?;
                    let mut tx = self.pool.begin().await?;
                    lease.lock_current(&mut tx).await?;
                    sqlx::query("UPDATE labos_threejs_core.object_cleanup SET first_deleted_at = COALESCE(first_deleted_at, clock_timestamp()), last_checked_at = clock_timestamp(), next_probe_at = clock_timestamp() + interval '1 hour', last_error = NULL WHERE bucket = $1 AND object_key = $2 AND file_id = $3::uuid")
                        .bind(&target.bucket).bind(&target.object_key).bind(&id).execute(&mut *tx).await?;
                    if let Some(candidate) = target.candidate_id {
                        sqlx::query("UPDATE labos_threejs_core.file_candidates SET state = 'deleted', updated_at = now() WHERE id = $1::uuid").bind(candidate).execute(&mut *tx).await?;
                    }
                    tx.commit().await?;
                }
            }
        };
        tokio::time::timeout(Duration::from_secs(120), work)
            .await
            .map_err(|_| JobError::Transient("files.cleanup_timeout"))?
    }
}
pub fn cleanup_handler(pool: PgPool, files: FileService) -> Arc<dyn Handler> {
    Arc::new(Cleanup { pool, files })
}

struct CleanupMaintenance {
    pool: PgPool,
}
#[derive(sqlx::FromRow)]
struct FileCheck {
    id: String,
    state: String,
    cleanup_job_id: Option<String>,
}
#[async_trait::async_trait]
impl jobs::Maintenance for CleanupMaintenance {
    fn name(&self) -> &'static str {
        "files.cleanup"
    }
    async fn schedule(&self) -> Result<(), JobError> {
        let mut tx = self.pool.begin().await?;
        let files:Vec<FileCheck>=sqlx::query_as("SELECT f.id::text, f.state, f.cleanup_job_id::text FROM labos_threejs_core.files f WHERE f.next_cleanup_check_at <= clock_timestamp() AND ((f.state = 'pending_upload' AND f.expires_at <= clock_timestamp()) OR ((f.state IN ('expired', 'rejected', 'deleting', 'deleted') OR (f.state = 'ready' AND f.expires_at <= clock_timestamp())) AND NOT EXISTS (SELECT 1 FROM labos_threejs_core.object_cleanup g WHERE g.bucket = f.bucket AND g.object_key = f.staging_key)) OR EXISTS (SELECT 1 FROM labos_threejs_core.object_cleanup g WHERE g.file_id = f.id AND g.first_deleted_at IS NULL) OR EXISTS (SELECT 1 FROM labos_threejs_core.file_candidates c WHERE c.file_id = f.id AND c.state IN ('abandoned', 'deleted') AND c.id IS DISTINCT FROM f.ready_candidate_id AND NOT EXISTS (SELECT 1 FROM labos_threejs_core.object_cleanup g WHERE g.bucket = c.bucket AND g.object_key = c.object_key))) ORDER BY f.next_cleanup_check_at, f.id LIMIT 50 FOR UPDATE SKIP LOCKED")
            .fetch_all(&mut *tx).await?;
        let job_ids = files
            .iter()
            .filter_map(|file| file.cleanup_job_id.clone())
            .collect::<Vec<_>>();
        let statuses = jobs::statuses(&mut tx, &job_ids)
            .await?
            .into_iter()
            .map(|job| (job.id, job.status))
            .collect::<std::collections::HashMap<_, _>>();
        for file in files {
            sqlx::query("UPDATE labos_threejs_core.files SET next_cleanup_check_at = clock_timestamp() + interval '5 minutes' WHERE id = $1::uuid").bind(&file.id).execute(&mut *tx).await?;
            if file.state == "pending_upload" {
                sqlx::query("UPDATE labos_threejs_core.files SET state = 'expired', updated_at = now() WHERE id = $1::uuid AND state = 'pending_upload' AND expires_at <= clock_timestamp()").bind(&file.id).execute(&mut *tx).await?;
            }
            register_locations(&mut tx, &file.id).await?;
            let pending:bool=sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM labos_threejs_core.object_cleanup WHERE file_id = $1::uuid AND first_deleted_at IS NULL)").bind(&file.id).fetch_one(&mut *tx).await?;
            let previous = file.cleanup_job_id.as_ref().and_then(|id| statuses.get(id));
            if pending
                && (file.cleanup_job_id.is_none()
                    || previous.is_some_and(|state| state == "succeeded"))
            {
                let correlation = uuid::Uuid::now_v7().to_string();
                let job = jobs::enqueue(
                    &mut tx,
                    NewJob {
                        kind: "files.cleanup",
                        schema_version: 1,
                        max_attempts: 5,
                        payload: serde_json::to_value(CleanupPayload {
                            file_id: file.id.clone(),
                        })
                        .map_err(|_| JobError::Permanent("files.cleanup_payload"))?,
                        correlation_id: &correlation,
                    },
                )
                .await?;
                sqlx::query(
                    "UPDATE labos_threejs_core.files SET cleanup_job_id = $2::uuid WHERE id = $1::uuid",
                )
                .bind(&file.id)
                .bind(job)
                .execute(&mut *tx)
                .await?;
            }
        }
        tx.commit().await?;
        let mut tx = self.pool.begin().await?;
        let job:Option<String>=sqlx::query_scalar("SELECT rescan_job_id::text FROM labos_threejs_core.file_cleanup_control WHERE id = 1 FOR UPDATE").fetch_one(&mut *tx).await?;
        let previous = if let Some(id) = job.as_ref() {
            jobs::statuses(&mut tx, std::slice::from_ref(id))
                .await?
                .pop()
                .map(|job| job.status)
        } else {
            None
        };
        let due:bool=sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM labos_threejs_core.object_cleanup WHERE first_deleted_at IS NOT NULL AND next_probe_at <= clock_timestamp())").fetch_one(&mut *tx).await?;
        if due && (job.is_none() || previous.as_deref() == Some("succeeded")) {
            let correlation = uuid::Uuid::now_v7().to_string();
            let job = jobs::enqueue(
                &mut tx,
                NewJob {
                    kind: "files.rescan",
                    schema_version: 1,
                    max_attempts: 5,
                    payload: serde_json::json!({}),
                    correlation_id: &correlation,
                },
            )
            .await?;
            sqlx::query(
                "UPDATE labos_threejs_core.file_cleanup_control SET rescan_job_id = $1::uuid WHERE id = 1",
            )
            .bind(job)
            .execute(&mut *tx)
            .await?;
        }
        tx.commit().await?;
        Ok(())
    }
}
pub fn cleanup_maintenance(pool: PgPool) -> Arc<dyn jobs::Maintenance> {
    Arc::new(CleanupMaintenance { pool })
}

struct Rescan {
    pool: PgPool,
    files: FileService,
}
#[derive(sqlx::FromRow)]
struct Probe {
    file_id: String,
    bucket: String,
    object_key: String,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RescanPayload {}
#[async_trait::async_trait]
impl Handler for Rescan {
    fn kind(&self) -> &'static str {
        "files.rescan"
    }
    async fn run(&self, lease: &Lease) -> Result<(), JobError> {
        let work = async {
            if lease.schema_version != 1
                || serde_json::from_value::<RescanPayload>(lease.payload.clone()).is_err()
            {
                return Err(JobError::Permanent("files.cleanup_payload"));
            }
            let mut tx = self.pool.begin().await?;
            lease.lock_current(&mut tx).await?;
            let targets:Vec<Probe>=sqlx::query_as("SELECT g.file_id::text, g.bucket, g.object_key FROM labos_threejs_core.object_cleanup g JOIN labos_threejs_core.files f ON f.id = g.file_id WHERE g.first_deleted_at IS NOT NULL AND g.next_probe_at <= clock_timestamp() AND NOT (f.state = 'ready' AND f.ready_key = g.object_key AND f.bucket = g.bucket) ORDER BY g.next_probe_at, g.bucket, g.object_key LIMIT 100")
                .fetch_all(&mut *tx).await?;
            tx.commit().await?;
            for target in targets {
                self.files
                    .storage
                    .delete(&ObjectLocation {
                        bucket: target.bucket.clone(),
                        key: target.object_key.clone(),
                    })
                    .await
                    .map_err(|_| JobError::Transient("files.cleanup_storage_unavailable"))?;
                let mut tx = self.pool.begin().await?;
                lease.lock_current(&mut tx).await?;
                sqlx::query("UPDATE labos_threejs_core.object_cleanup SET last_checked_at = clock_timestamp(), next_probe_at = clock_timestamp() + interval '1 hour', last_error = NULL WHERE file_id = $1::uuid AND bucket = $2 AND object_key = $3 AND first_deleted_at IS NOT NULL")
                    .bind(&target.file_id).bind(&target.bucket).bind(&target.object_key).execute(&mut *tx).await?;
                tx.commit().await?;
            }
            let mut tx = self.pool.begin().await?;
            lease.succeed(&mut tx).await?;
            tx.commit().await?;
            Ok(())
        };
        tokio::time::timeout(Duration::from_secs(120), work)
            .await
            .map_err(|_| JobError::Transient("files.cleanup_timeout"))?
    }
}
pub fn rescan_handler(pool: PgPool, files: FileService) -> Arc<dyn Handler> {
    Arc::new(Rescan { pool, files })
}
