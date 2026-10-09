mod inbox;
mod management;
pub use management::{openapi, router};

use serde::{Deserialize, Serialize};
use sqlx::PgConnection;
use std::collections::BTreeMap;
use utoipa::ToSchema;

/// A navigation hint, never an authorization capability or a signed URL.
/// The application shell resolves known kinds; the destination checks current access.
#[derive(Clone, Deserialize, Serialize, ToSchema)]
pub struct NotificationTarget {
    pub kind: String,
    pub resource_id: String,
    pub context: BTreeMap<String, String>,
}

pub struct JobNotification<'a> {
    pub recipient_id: &'a str,
    pub event_key: &'a str,
    /// Keep this generic: it remains visible if source access is later revoked.
    pub subject: &'a str,
    pub target: NotificationTarget,
}

/// Register with the business request and enqueue transaction. No message is visible yet.
pub async fn on_job_outcome(
    connection: &mut PgConnection,
    job_id: &str,
    notification: JobNotification<'_>,
) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT INTO labos_threejs_core.job_notifications (job_id, recipient_id, event_key, subject, target) VALUES ($1::uuid, $2::uuid, $3, $4, $5)")
        .bind(job_id).bind(notification.recipient_id).bind(notification.event_key).bind(notification.subject).bind(sqlx::types::Json(notification.target)).execute(connection).await?;
    Ok(())
}

#[derive(Clone, Copy, Serialize, ToSchema, sqlx::Type)]
#[sqlx(type_name = "text", rename_all = "snake_case")]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    Succeeded,
    Failed,
}
impl Outcome {
    fn as_str(self) -> &'static str {
        match self {
            Self::Succeeded => "succeeded",
            Self::Failed => "failed",
        }
    }
}

/// Called by Jobs within the fenced terminal-state transaction. A repeated event
/// preserves the original notification and its read state. Jobs without intent emit nothing.
pub(crate) async fn publish_job_outcome(
    connection: &mut PgConnection,
    job_id: &str,
    outcome: Outcome,
) -> Result<(), sqlx::Error> {
    sqlx::query("INSERT INTO labos_threejs_core.notifications (id, recipient_id, event_key, subject, target, outcome) SELECT $1::uuid, recipient_id, event_key, subject, target, $3 FROM labos_threejs_core.job_notifications WHERE job_id = $2::uuid ON CONFLICT (recipient_id, event_key, outcome) DO NOTHING")
        .bind(uuid::Uuid::now_v7().to_string()).bind(job_id).bind(outcome.as_str()).execute(connection).await?;
    Ok(())
}
