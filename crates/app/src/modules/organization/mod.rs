pub mod domain;
mod management;
pub use management::{openapi, router};

use serde::{Deserialize, Serialize};
use sqlx::{PgConnection, PgPool};
use utoipa::ToSchema;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize, ToSchema, sqlx::Type)]
#[serde(rename_all = "lowercase")]
#[sqlx(type_name = "text", rename_all = "lowercase")]
pub enum MemberRole {
    Owner,
    Admin,
    Member,
}

/// The singleton organization row serializes initialization in the caller's transaction.
pub async fn enroll(
    connection: &mut PgConnection,
    user_id: &str,
) -> Result<MemberRole, sqlx::Error> {
    let initialized: bool = sqlx::query_scalar("INSERT INTO labos_threejs_core.organizations (id, name) VALUES (1, 'My Organization') ON CONFLICT (id) DO UPDATE SET id = 1 RETURNING owner_initialized")
        .fetch_one(&mut *connection).await?;
    let role = if initialized {
        MemberRole::Member
    } else {
        MemberRole::Owner
    };
    sqlx::query("INSERT INTO labos_threejs_core.memberships (user_id, organization_id, role) VALUES ($1::uuid, 1, $2)")
        .bind(user_id).bind(role).execute(&mut *connection).await?;
    sqlx::query(
        "UPDATE labos_threejs_core.organizations SET owner_initialized = true WHERE id = 1",
    )
    .execute(connection)
    .await?;
    Ok(role)
}

pub async fn active_role(pool: &PgPool, user_id: &str) -> Result<Option<MemberRole>, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT role FROM labos_threejs_core.memberships WHERE user_id = $1::uuid AND active",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await
}

/// Hold membership stable for a caller's mutation; disabling/changing roles waits.
pub async fn active_role_in(
    connection: &mut PgConnection,
    user_id: &str,
) -> Result<Option<MemberRole>, sqlx::Error> {
    sqlx::query_scalar(
        "SELECT role FROM labos_threejs_core.memberships WHERE user_id = $1::uuid AND active FOR SHARE",
    )
    .bind(user_id)
    .fetch_optional(connection)
    .await
}

#[derive(sqlx::FromRow)]
pub struct MembershipAccess {
    pub user_id: String,
    pub role: MemberRole,
    pub active: bool,
}

/// Hold all affected memberships stable in the same ID order as member administration.
/// Acquire these before resource locks; do not acquire another membership out of order.
pub async fn lock_memberships(
    connection: &mut PgConnection,
    user_ids: &[String],
) -> Result<Vec<MembershipAccess>, sqlx::Error> {
    sqlx::query_as("SELECT user_id::text, role, active FROM labos_threejs_core.memberships WHERE user_id = ANY($1::text[]::uuid[]) ORDER BY user_id FOR SHARE")
        .bind(user_ids).fetch_all(connection).await
}
