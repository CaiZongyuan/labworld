use super::{NotificationTarget, Outcome};
use chrono::{DateTime, Utc};
use serde::Serialize;
use sqlx::PgPool;
use utoipa::ToSchema;

#[derive(Serialize, ToSchema, sqlx::FromRow)]
pub(super) struct Notification {
    id: String,
    subject: String,
    outcome: Outcome,
    #[sqlx(json)]
    target: NotificationTarget,
    created_at: DateTime<Utc>,
    read_at: Option<DateTime<Utc>>,
}
const COLUMNS: &str = "id::text, subject, outcome, target, created_at, read_at";
#[derive(Serialize, ToSchema)]
pub(super) struct NotificationPage {
    data: Vec<Notification>,
    unread_count: i64,
    next_cursor: Option<String>,
    has_more: bool,
}
pub(super) enum Error {
    InvalidPage,
    Unavailable,
}
impl From<sqlx::Error> for Error {
    fn from(_: sqlx::Error) -> Self {
        Self::Unavailable
    }
}
#[derive(serde::Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in=Query)]
pub(super) struct InboxQuery {
    #[param(minimum = 1, maximum = 100, default = 50)]
    limit: Option<u32>,
    #[param(max_length = 512)]
    cursor: Option<String>,
    #[serde(default)]
    unread_only: bool,
}
pub(super) async fn list(
    pool: &PgPool,
    actor: &str,
    query: InboxQuery,
) -> Result<NotificationPage, Error> {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    let limit = query.limit.unwrap_or(50);
    if !(1..=100).contains(&limit) {
        return Err(Error::InvalidPage);
    }
    let cursor = if let Some(cursor) = query.cursor {
        if cursor.len() > 512 {
            return Err(Error::InvalidPage);
        }
        let bytes = URL_SAFE_NO_PAD
            .decode(cursor)
            .map_err(|_| Error::InvalidPage)?;
        let (subject, unread, time, id): (String, bool, DateTime<Utc>, String) =
            serde_json::from_slice(&bytes).map_err(|_| Error::InvalidPage)?;
        if subject != actor || unread != query.unread_only {
            return Err(Error::InvalidPage);
        }
        let id = uuid::Uuid::parse_str(&id)
            .map_err(|_| Error::InvalidPage)?
            .to_string();
        Some((time, id))
    } else {
        None
    };
    let mut tx = pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY")
        .execute(&mut *tx)
        .await?;
    let mut data: Vec<Notification> = sqlx::query_as(&format!("SELECT {COLUMNS} FROM labos_threejs_core.notifications WHERE recipient_id = $1::uuid AND (NOT $2 OR read_at IS NULL) AND ($3::timestamptz IS NULL OR (created_at, id) < ($3, $4::uuid)) ORDER BY created_at DESC, id DESC LIMIT $5"))
        .bind(actor).bind(query.unread_only).bind(cursor.as_ref().map(|c| c.0)).bind(cursor.as_ref().map(|c| &c.1)).bind(i64::from(limit) + 1).fetch_all(&mut *tx).await?;
    let unread_count = sqlx::query_scalar("SELECT count(*) FROM labos_threejs_core.notifications WHERE recipient_id = $1::uuid AND read_at IS NULL").bind(actor).fetch_one(&mut *tx).await?;
    tx.commit().await?;
    let has_more = data.len() > limit as usize;
    data.truncate(limit as usize);
    let next_cursor = if has_more {
        data.last()
            .map(|n| {
                serde_json::to_vec(&(actor, query.unread_only, n.created_at, &n.id))
                    .map(|bytes| URL_SAFE_NO_PAD.encode(bytes))
                    .map_err(|_| Error::Unavailable)
            })
            .transpose()?
    } else {
        None
    };
    Ok(NotificationPage {
        data,
        unread_count,
        next_cursor,
        has_more,
    })
}
pub(super) async fn read(
    pool: &PgPool,
    actor: &str,
    id: uuid::Uuid,
) -> Result<Option<Notification>, sqlx::Error> {
    sqlx::query_as(&format!("UPDATE labos_threejs_core.notifications SET read_at = COALESCE(read_at, clock_timestamp()) WHERE id = $1::uuid AND recipient_id = $2::uuid RETURNING {COLUMNS}"))
        .bind(id.to_string()).bind(actor).fetch_optional(pool).await
}
