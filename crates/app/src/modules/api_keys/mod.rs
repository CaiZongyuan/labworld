mod authentication;
pub use authentication::{ReadActor, require_read};
mod management;
pub use management::{openapi, router};

use chrono::{DateTime, Utc};
use serde::Serialize;
use utoipa::ToSchema;

#[derive(Clone, Serialize, ToSchema)]
pub struct KeyScope {
    pub id: String,
    pub label: String,
}
/// Core's own read capability survives removal of every reference module.
pub fn core_scopes() -> Vec<KeyScope> {
    vec![KeyScope {
        id: "profile:read".into(),
        label: "读取自己的基本资料".into(),
    }]
}
#[derive(Serialize, ToSchema, sqlx::FromRow)]
pub(super) struct KeyInfo {
    id: String,
    user_id: String,
    name: String,
    prefix: String,
    scopes: Vec<String>,
    created_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
    revoked_at: Option<DateTime<Utc>>,
    last_used_at: Option<DateTime<Utc>>,
}
pub(super) const COLUMNS: &str = "id::text, user_id::text, name, prefix, scopes, created_at, expires_at, revoked_at, last_used_at";
