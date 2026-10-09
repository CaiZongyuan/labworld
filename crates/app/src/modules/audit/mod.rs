mod management;
pub use management::{openapi, router};

use sqlx::PgConnection;

pub enum Source<'a> {
    Request(&'a str),
    Job {
        id: &'a str,
        correlation_id: &'a str,
    },
}

pub struct Event<'a> {
    /// The user who initiated the operation, including background work.
    pub actor_id: &'a str,
    pub action: &'a str,
    pub resource_type: &'a str,
    pub resource_id: &'a str,
    pub source: Source<'a>,
    /// Optional affected user, for operations on a shared resource such as a grant.
    /// Metadata deliberately has no arbitrary JSON or request-body input.
    pub subject_user_id: Option<&'a str>,
}
#[derive(serde::Serialize, serde::Deserialize, utoipa::ToSchema)]
pub(super) struct Metadata {
    #[serde(skip_serializing_if = "Option::is_none")]
    subject_user_id: Option<String>,
}

/// The caller owns the transaction: audit failure rolls back the business mutation.
pub async fn append(connection: &mut PgConnection, event: Event<'_>) -> Result<(), sqlx::Error> {
    let (request, correlation, job) = match event.source {
        Source::Request(id) => (Some(id), id, None),
        Source::Job { id, correlation_id } => (None, correlation_id, Some(id)),
    };
    let metadata = Metadata {
        subject_user_id: event.subject_user_id.map(str::to_owned),
    };
    sqlx::query("INSERT INTO labos_threejs_core.audit_events (id, actor_id, action, resource_type, resource_id, request_id, correlation_id, job_id, metadata, trace_id) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8::uuid, $9, $10)")
        .bind(uuid::Uuid::now_v7().to_string()).bind(event.actor_id).bind(event.action).bind(event.resource_type).bind(event.resource_id).bind(request).bind(correlation).bind(job).bind(sqlx::types::Json(metadata)).bind(labos_threejs_platform::telemetry::trace_id(&tracing::Span::current())).execute(connection).await?;
    Ok(())
}
