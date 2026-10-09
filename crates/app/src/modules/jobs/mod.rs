mod maintenance;
pub use maintenance::{Maintenance, run_maintenance};
mod administration;
mod management;
pub use management::{openapi, router};
mod worker;
use crate::modules::notifications::{self, Outcome};
use serde::Serialize;
use serde_json::Value;
use sqlx::PgConnection;
pub use worker::{FIELDS, Handler, Worker, WorkerPolicy, worker_bind};

pub struct NewJob<'a> {
    pub kind: &'a str,
    pub schema_version: i32,
    pub max_attempts: i32,
    pub payload: Value,
    pub correlation_id: &'a str,
}

/// Enqueue in the business transaction; workers only observe committed work.
pub async fn enqueue(
    connection: &mut PgConnection,
    job: NewJob<'_>,
) -> Result<String, sqlx::Error> {
    let id = uuid::Uuid::now_v7().to_string();
    let context = labos_threejs_platform::telemetry::correlation();
    let parent = labos_threejs_platform::telemetry::current_traceparent();
    let causation = context.job_id.as_ref().or(context.request_id.as_ref());
    sqlx::query("INSERT INTO labos_threejs_core.jobs (id, kind, schema_version, payload, correlation_id, max_attempts, request_id, actor_id, traceparent, causation_id) VALUES ($1::uuid, $2, $3, $4, $5, $6, $7, $8::uuid, $9, $10)")
        .bind(&id).bind(job.kind).bind(job.schema_version).bind(job.payload).bind(job.correlation_id).bind(job.max_attempts)
        .bind(&context.request_id).bind(&context.actor_id).bind(parent).bind(causation).execute(&mut *connection).await?;
    sqlx::query("INSERT INTO labos_threejs_core.job_batches (job_id, number, max_attempts, status) SELECT id, 1, max_attempts, 'queued' FROM labos_threejs_core.jobs WHERE id = $1::uuid").bind(&id).execute(connection).await?;
    Ok(id)
}

#[derive(Serialize, sqlx::FromRow)]
pub struct JobStatus {
    pub id: String,
    pub status: String,
    pub last_error: Option<String>,
}

pub async fn statuses(
    connection: &mut PgConnection,
    ids: &[String],
) -> Result<Vec<JobStatus>, sqlx::Error> {
    sqlx::query_as("SELECT id::text, status, last_error FROM labos_threejs_core.jobs WHERE id = ANY($1::text[]::uuid[])")
        .bind(ids).fetch_all(connection).await
}

#[derive(Clone, sqlx::FromRow)]
pub struct Lease {
    pub id: String,
    pub kind: String,
    pub schema_version: i32,
    pub payload: Value,
    pub lease_token: String,
    pub correlation_id: String,
    pub causation_id: Option<String>,
    pub request_id: Option<String>,
    pub actor_id: Option<String>,
    pub traceparent: Option<String>,
    pub batch: i32,
    pub attempt: i32,
}

#[derive(Debug)]
pub enum JobError {
    Permanent(&'static str),
    Transient(&'static str),
    LostLease,
}
impl From<sqlx::Error> for JobError {
    fn from(_: sqlx::Error) -> Self {
        Self::Transient("jobs.database_unavailable")
    }
}

pub async fn claim(
    pool: &sqlx::PgPool,
    kinds: &[&str],
    worker: &str,
    lease_secs: u32,
) -> Result<Option<Lease>, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let exhausted: Vec<(String, String)> = sqlx::query_as("UPDATE labos_threejs_core.jobs SET status = 'failed', last_error = 'jobs.attempts_exhausted', updated_at = now() WHERE id IN (SELECT id FROM labos_threejs_core.jobs WHERE status = 'running' AND lease_expires_at <= clock_timestamp() AND attempts >= max_attempts AND kind = ANY($1) ORDER BY lease_expires_at, id FOR UPDATE SKIP LOCKED LIMIT 25) RETURNING id::text, lease_token::text")
        .bind(kinds).fetch_all(&mut *tx).await?;
    for (id, token) in exhausted {
        sqlx::query("UPDATE labos_threejs_core.job_attempts SET status = 'lease_expired', last_error = 'jobs.lease_expired', ended_at = clock_timestamp() WHERE lease_token = $1::uuid AND status = 'running'").bind(token).execute(&mut *tx).await?;
        sqlx::query("UPDATE labos_threejs_core.job_batches b SET status = 'failed', last_error = 'jobs.attempts_exhausted', ended_at = clock_timestamp() FROM labos_threejs_core.jobs j WHERE j.id = $1::uuid AND b.job_id = j.id AND b.number = j.batch").bind(&id).execute(&mut *tx).await?;
        notifications::publish_job_outcome(&mut tx, &id, Outcome::Failed).await?;
    }
    let lease: Option<Lease> = sqlx::query_as("WITH candidate AS (SELECT id FROM labos_threejs_core.jobs WHERE kind = ANY($1) AND attempts < max_attempts AND ((status IN ('queued', 'retry_wait') AND scheduled_at <= clock_timestamp()) OR (status = 'running' AND lease_expires_at <= clock_timestamp())) ORDER BY scheduled_at, id FOR UPDATE SKIP LOCKED LIMIT 1) UPDATE labos_threejs_core.jobs j SET status = 'running', lease_token = $2::uuid, locked_by = $3, lease_expires_at = clock_timestamp() + make_interval(secs => $4), attempts = attempts + 1, updated_at = now() FROM candidate c WHERE j.id = c.id RETURNING j.id::text, j.kind, j.schema_version, j.payload, j.lease_token::text, j.correlation_id, j.causation_id, j.request_id, j.actor_id::text, j.traceparent, j.batch, j.attempts AS attempt")
        .bind(kinds).bind(uuid::Uuid::now_v7().to_string()).bind(worker).bind(f64::from(lease_secs)).fetch_optional(&mut *tx).await?;
    if let Some(lease) = &lease {
        sqlx::query("UPDATE labos_threejs_core.job_attempts SET status = 'lease_expired', last_error = 'jobs.lease_expired', ended_at = clock_timestamp() WHERE job_id = $1::uuid AND status = 'running'").bind(&lease.id).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO labos_threejs_core.job_attempts (job_id, batch, number, lease_token, worker_id, status, lease_expires_at) SELECT id, batch, attempts, lease_token, locked_by, 'running', lease_expires_at FROM labos_threejs_core.jobs WHERE id = $1::uuid").bind(&lease.id).execute(&mut *tx).await?;
        sqlx::query("UPDATE labos_threejs_core.job_batches SET status = 'running', attempts = $3, last_error = NULL WHERE job_id = $1::uuid AND number = $2").bind(&lease.id).bind(lease.batch).bind(lease.attempt).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(lease)
}

impl Lease {
    /// Fence before changing business results; keep this lock through their commit.
    pub async fn lock_current(&self, connection: &mut PgConnection) -> Result<(), JobError> {
        let present: Option<String> = sqlx::query_scalar("SELECT id::text FROM labos_threejs_core.jobs WHERE id = $1::uuid AND status = 'running' AND lease_token = $2::uuid AND lease_expires_at > clock_timestamp() FOR UPDATE")
            .bind(&self.id).bind(&self.lease_token).fetch_optional(connection).await?;
        present.map(|_| ()).ok_or(JobError::LostLease)
    }
    pub async fn succeed(&self, connection: &mut PgConnection) -> Result<(), JobError> {
        let done = sqlx::query("UPDATE labos_threejs_core.jobs SET status = 'succeeded', last_error = NULL, updated_at = now() WHERE id = $1::uuid AND status = 'running' AND lease_token = $2::uuid AND lease_expires_at > clock_timestamp()")
            .bind(&self.id).bind(&self.lease_token).execute(&mut *connection).await?;
        if done.rows_affected() != 1 {
            return Err(JobError::LostLease);
        }
        self.record_outcome(connection, "succeeded", None).await?;
        notifications::publish_job_outcome(connection, &self.id, Outcome::Succeeded).await?;
        Ok(())
    }
    async fn record_outcome(
        &self,
        connection: &mut PgConnection,
        status: &str,
        error: Option<&str>,
    ) -> Result<(), sqlx::Error> {
        sqlx::query("UPDATE labos_threejs_core.job_attempts SET status = $2, last_error = $3, ended_at = clock_timestamp() WHERE lease_token = $1::uuid AND status = 'running'")
            .bind(&self.lease_token).bind(status).bind(error).execute(&mut *connection).await?;
        sqlx::query("UPDATE labos_threejs_core.job_batches SET status = $3, last_error = $4, ended_at = CASE WHEN $3 IN ('succeeded', 'failed') THEN clock_timestamp() ELSE NULL END WHERE job_id = $1::uuid AND number = $2")
            .bind(&self.id).bind(self.batch).bind(status).bind(error).execute(connection).await?;
        Ok(())
    }
    pub async fn heartbeat(&self, pool: &sqlx::PgPool, lease_secs: u32) -> Result<(), JobError> {
        let mut tx = pool.begin().await?;
        let renewed = sqlx::query("UPDATE labos_threejs_core.jobs SET lease_expires_at = clock_timestamp() + make_interval(secs => $3), updated_at = now() WHERE id = $1::uuid AND status = 'running' AND lease_token = $2::uuid AND lease_expires_at > clock_timestamp()")
            .bind(&self.id).bind(&self.lease_token).bind(f64::from(lease_secs)).execute(&mut *tx).await?;
        if renewed.rows_affected() != 1 {
            return Err(JobError::LostLease);
        }
        sqlx::query("UPDATE labos_threejs_core.job_attempts a SET lease_expires_at = j.lease_expires_at FROM labos_threejs_core.jobs j WHERE j.id = $1::uuid AND a.lease_token = j.lease_token")
            .bind(&self.id).execute(&mut *tx).await?;
        tx.commit().await?;
        Ok(())
    }
    /// Only safe, static codes enter the persisted error summary.
    pub async fn fail(&self, pool: &sqlx::PgPool, error: &JobError) -> Result<(), sqlx::Error> {
        let (code, transient) = match error {
            JobError::Permanent(code) => (*code, false),
            JobError::Transient(code) => (*code, true),
            JobError::LostLease => return Ok(()),
        };
        let mut tx = pool.begin().await?;
        let status: Option<String> = sqlx::query_scalar("UPDATE labos_threejs_core.jobs SET status = CASE WHEN $4 AND attempts < max_attempts THEN 'retry_wait' ELSE 'failed' END, scheduled_at = clock_timestamp() + make_interval(secs => random() * LEAST(900.0, power(2.0, attempts))), last_error = $3, updated_at = now() WHERE id = $1::uuid AND status = 'running' AND lease_token = $2::uuid AND lease_expires_at > clock_timestamp() RETURNING status")
            .bind(&self.id).bind(&self.lease_token).bind(code).bind(transient).fetch_optional(&mut *tx).await?;
        if let Some(status) = status {
            self.record_outcome(&mut tx, &status, Some(code)).await?;
            if status == "failed" {
                notifications::publish_job_outcome(&mut tx, &self.id, Outcome::Failed).await?;
            }
        }
        tx.commit().await?;
        Ok(())
    }
}
