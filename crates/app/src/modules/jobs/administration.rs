use crate::{
    http::{RequestId, public_error},
    modules::{
        audit, idempotency,
        organization::{self, MemberRole},
    },
};
use axum::{http::StatusCode, response::Response};
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::{PgConnection, PgPool};
use utoipa::ToSchema;

pub(super) enum Error {
    Forbidden,
    NotFound,
    NotFailed,
    InvalidKey,
    KeyConflict,
    InvalidPage,
    Unavailable,
}
impl From<sqlx::Error> for Error {
    fn from(_: sqlx::Error) -> Self {
        Self::Unavailable
    }
}
impl From<idempotency::Error> for Error {
    fn from(value: idempotency::Error) -> Self {
        match value {
            idempotency::Error::InvalidKey => Self::InvalidKey,
            idempotency::Error::Conflict => Self::KeyConflict,
            idempotency::Error::Unavailable => Self::Unavailable,
        }
    }
}
impl Error {
    pub fn response(self, id: RequestId) -> Response {
        let (status, code, message) = match self {
            Self::Forbidden => (
                StatusCode::FORBIDDEN,
                "jobs.forbidden",
                "Only an active Owner or Admin can administer jobs",
            ),
            Self::NotFound => (StatusCode::NOT_FOUND, "jobs.not_found", "Job not found"),
            Self::NotFailed => (
                StatusCode::CONFLICT,
                "jobs.not_failed",
                "Only a failed job can start a new execution batch",
            ),
            Self::InvalidKey => (
                StatusCode::BAD_REQUEST,
                "idempotency.invalid_key",
                "Provide a valid Idempotency-Key",
            ),
            Self::KeyConflict => (
                StatusCode::CONFLICT,
                "idempotency.conflict",
                "Idempotency-Key belongs to a different request",
            ),
            Self::InvalidPage => (
                StatusCode::BAD_REQUEST,
                "jobs.invalid_page",
                "Use a valid page cursor and filter",
            ),
            Self::Unavailable => (
                StatusCode::SERVICE_UNAVAILABLE,
                "jobs.unavailable",
                "Job administration is temporarily unavailable",
            ),
        };
        public_error(status, code, message, id)
    }
}

#[derive(Serialize, ToSchema, sqlx::FromRow)]
pub(super) struct JobInfo {
    pub id: String,
    pub kind: String,
    pub schema_version: i32,
    pub status: String,
    pub batch: i32,
    pub attempts: i32,
    pub max_attempts: i32,
    pub scheduled_at: DateTime<Utc>,
    pub lease_expires_at: Option<DateTime<Utc>>,
    pub last_error: Option<String>,
    pub correlation_id: String,
    pub causation_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub can_retry: bool,
}
pub(super) const COLUMNS: &str = "id::text, kind, schema_version, status, batch, attempts, max_attempts, scheduled_at, lease_expires_at, last_error, correlation_id, causation_id, created_at, updated_at, (status = 'failed') AS can_retry";

pub(super) async fn authorize(connection: &mut PgConnection, actor: &str) -> Result<(), Error> {
    match organization::active_role_in(connection, actor).await? {
        Some(MemberRole::Owner | MemberRole::Admin) => Ok(()),
        _ => Err(Error::Forbidden),
    }
}
pub(super) async fn load(connection: &mut PgConnection, id: &str) -> Result<JobInfo, Error> {
    sqlx::query_as(&format!(
        "SELECT {COLUMNS} FROM labos_threejs_core.jobs WHERE id = $1::uuid"
    ))
    .bind(id)
    .fetch_optional(connection)
    .await?
    .ok_or(Error::NotFound)
}

pub(super) async fn retry(
    pool: &PgPool,
    actor: &str,
    id: &str,
    key: &str,
    request_id: &str,
) -> Result<JobInfo, Error> {
    let mut tx = pool.begin().await?;
    authorize(&mut tx, actor).await?;
    let scope = format!("POST /api/v1/jobs/{id}/retry");
    let fingerprint = idempotency::fingerprint(&())?;
    let command = idempotency::Attempt {
        actor_id: actor,
        scope: &scope,
        key,
        fingerprint: &fingerprint,
    };
    let replay = idempotency::claim(&mut tx, &command).await?;
    let job: JobInfo = sqlx::query_as(&format!(
        "SELECT {COLUMNS} FROM labos_threejs_core.jobs WHERE id = $1::uuid FOR UPDATE"
    ))
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(Error::NotFound)?;
    if replay.is_none() {
        if job.status != "failed" {
            return Err(Error::NotFailed);
        }
        let next = job.batch.checked_add(1).ok_or(Error::Unavailable)?;
        sqlx::query("INSERT INTO labos_threejs_core.job_batches (job_id, number, max_attempts, status, requested_by) VALUES ($1::uuid, $2, $3, 'queued', $4::uuid)").bind(id).bind(next).bind(job.max_attempts).bind(actor).execute(&mut *tx).await?;
        sqlx::query("UPDATE labos_threejs_core.jobs SET status = 'queued', batch = $2, attempts = 0, scheduled_at = clock_timestamp(), lease_token = NULL, locked_by = NULL, lease_expires_at = NULL, last_error = NULL, causation_id = $3, traceparent = $4, updated_at = now() WHERE id = $1::uuid")
            .bind(id).bind(next).bind(request_id).bind(labos_threejs_platform::telemetry::current_traceparent()).execute(&mut *tx).await?;
        audit::append(
            &mut tx,
            audit::Event {
                actor_id: actor,
                action: "jobs.retry",
                resource_type: "jobs.job",
                resource_id: id,
                source: audit::Source::Request(request_id),
                subject_user_id: None,
            },
        )
        .await?;
        idempotency::complete(
            &mut tx,
            &command,
            serde_json::json!({"job_id":id,"batch":next}),
        )
        .await?;
    }
    let current = load(&mut tx, id).await?;
    tx.commit().await?;
    Ok(current)
}

#[derive(Serialize, ToSchema, sqlx::FromRow)]
pub(super) struct JobBatch {
    number: i32,
    max_attempts: i32,
    attempts: i32,
    legacy_attempts: i32,
    status: String,
    requested_by: Option<String>,
    last_error: Option<String>,
    created_at: DateTime<Utc>,
    ended_at: Option<DateTime<Utc>>,
}
#[derive(Serialize, ToSchema, sqlx::FromRow)]
pub(super) struct JobAttempt {
    batch: i32,
    number: i32,
    worker_id: String,
    status: String,
    last_error: Option<String>,
    started_at: DateTime<Utc>,
    lease_expires_at: DateTime<Utc>,
    ended_at: Option<DateTime<Utc>>,
}
#[derive(Serialize, ToSchema)]
pub(super) struct JobDetails {
    pub job: JobInfo,
    pub batches: Vec<JobBatch>,
    pub attempts: Vec<JobAttempt>,
    pub next_before_batch: Option<i32>,
}
pub(super) async fn details(
    pool: &PgPool,
    actor: &str,
    id: &str,
    before: Option<i32>,
) -> Result<JobDetails, Error> {
    if before.is_some_and(|value| value <= 0) {
        return Err(Error::InvalidPage);
    }
    let mut tx = pool.begin().await?;
    authorize(&mut tx, actor).await?;
    // One stable job version keeps its summary, batch and attempt rows consistent.
    let job: JobInfo = sqlx::query_as(&format!(
        "SELECT {COLUMNS} FROM labos_threejs_core.jobs WHERE id = $1::uuid FOR SHARE"
    ))
    .bind(id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or(Error::NotFound)?;
    let mut batches:Vec<JobBatch> = sqlx::query_as("SELECT number, max_attempts, attempts, legacy_attempts, status, requested_by::text, last_error, created_at, ended_at FROM labos_threejs_core.job_batches WHERE job_id = $1::uuid AND ($2::integer IS NULL OR number < $2) ORDER BY number DESC LIMIT 11")
        .bind(id).bind(before).fetch_all(&mut *tx).await?;
    let has_more = batches.len() > 10;
    batches.truncate(10);
    let numbers = batches.iter().map(|batch| batch.number).collect::<Vec<_>>();
    let attempts = sqlx::query_as("SELECT batch, number, worker_id, status, last_error, started_at, lease_expires_at, ended_at FROM labos_threejs_core.job_attempts WHERE job_id = $1::uuid AND batch = ANY($2) ORDER BY batch DESC, number DESC")
        .bind(id).bind(&numbers).fetch_all(&mut *tx).await?;
    let next_before_batch = if has_more {
        numbers.last().copied()
    } else {
        None
    };
    tx.commit().await?;
    Ok(JobDetails {
        job,
        batches,
        attempts,
        next_before_batch,
    })
}

#[derive(Clone, serde::Deserialize, Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub(super) enum StatusFilter {
    Queued,
    Running,
    RetryWait,
    Succeeded,
    Failed,
}
impl StatusFilter {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::RetryWait => "retry_wait",
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
        }
    }
}
#[derive(serde::Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in=Query)]
pub(super) struct JobsQuery {
    pub status: Option<StatusFilter>,
    #[param(minimum = 1, maximum = 100, default = 50)]
    pub limit: Option<u32>,
    #[param(max_length = 512)]
    pub cursor: Option<String>,
}
#[derive(Serialize, ToSchema)]
pub(super) struct JobPage {
    data: Vec<JobInfo>,
    next_cursor: Option<String>,
    has_more: bool,
}

pub(super) async fn list(pool: &PgPool, actor: &str, query: JobsQuery) -> Result<JobPage, Error> {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    let limit = query.limit.unwrap_or(50);
    if !(1..=100).contains(&limit) {
        return Err(Error::InvalidPage);
    }
    let filter = query.status.as_ref().map(StatusFilter::as_str);
    let scope = format!("jobs:id-desc:{}", filter.unwrap_or("all"));
    let cursor = if let Some(cursor) = query.cursor {
        if cursor.len() > 512 {
            return Err(Error::InvalidPage);
        }
        let bytes = URL_SAFE_NO_PAD
            .decode(cursor)
            .map_err(|_| Error::InvalidPage)?;
        let (subject, saved_scope, id): (String, String, String) =
            serde_json::from_slice(&bytes).map_err(|_| Error::InvalidPage)?;
        if subject != actor || saved_scope != scope {
            return Err(Error::InvalidPage);
        }
        Some(
            uuid::Uuid::parse_str(&id)
                .map_err(|_| Error::InvalidPage)?
                .to_string(),
        )
    } else {
        None
    };
    let mut tx = pool.begin().await?;
    authorize(&mut tx, actor).await?;
    let mut data:Vec<JobInfo>=sqlx::query_as(&format!("SELECT {COLUMNS} FROM labos_threejs_core.jobs WHERE ($1::text IS NULL OR status = $1) AND ($2::uuid IS NULL OR id < $2::uuid) ORDER BY id DESC LIMIT $3"))
        .bind(filter).bind(cursor).bind(i64::from(limit)+1).fetch_all(&mut *tx).await?;
    let has_more = data.len() > limit as usize;
    data.truncate(limit as usize);
    let next_cursor = if has_more {
        data.last()
            .map(|job| {
                serde_json::to_vec(&(actor, &scope, &job.id))
                    .map(|bytes| URL_SAFE_NO_PAD.encode(bytes))
                    .map_err(|_| Error::Unavailable)
            })
            .transpose()?
    } else {
        None
    };
    tx.commit().await?;
    Ok(JobPage {
        data,
        next_cursor,
        has_more,
    })
}
