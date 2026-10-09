use crate::modules::{audit, organization};
use sqlx::{PgConnection, PgPool};

pub(super) enum Error {
    Invalid,
    Unavailable,
}
impl From<sqlx::Error> for Error {
    fn from(_: sqlx::Error) -> Self {
        Self::Unavailable
    }
}
pub(super) async fn eligible(pool: &PgPool, hash: &[u8]) -> Result<String, Error> {
    let user:Option<String>=sqlx::query_scalar("SELECT user_id::text FROM labos_threejs_core.password_resets WHERE token_hash=$1 AND used_at IS NULL AND revoked_at IS NULL AND expires_at > clock_timestamp()").bind(hash).fetch_optional(pool).await?;
    let user = user.ok_or(Error::Invalid)?;
    if organization::active_role(pool, &user).await?.is_none() {
        return Err(Error::Invalid);
    }
    Ok(user)
}
pub(super) async fn change(
    pool: &PgPool,
    user: &str,
    token_hash: &[u8],
    password_hash: String,
    request: &str,
) -> Result<(), Error> {
    let mut tx = pool.begin().await?;
    if organization::active_role_in(&mut tx, user).await?.is_none() {
        return Err(Error::Invalid);
    }
    let credential: Option<String> = sqlx::query_scalar(
        "SELECT user_id::text FROM labos_threejs_core.credentials WHERE user_id=$1::uuid FOR UPDATE",
    )
    .bind(user)
    .fetch_optional(&mut *tx)
    .await?;
    if credential.is_none() {
        return Err(Error::Invalid);
    }
    let reset:Option<String>=sqlx::query_scalar("SELECT id::text FROM labos_threejs_core.password_resets WHERE token_hash=$1 AND user_id=$2::uuid AND used_at IS NULL AND revoked_at IS NULL AND expires_at > clock_timestamp() FOR UPDATE").bind(token_hash).bind(user).fetch_optional(&mut *tx).await?;
    let reset = reset.ok_or(Error::Invalid)?;
    sqlx::query(
        "UPDATE labos_threejs_core.credentials SET password_hash=$2 WHERE user_id=$1::uuid",
    )
    .bind(user)
    .bind(password_hash)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE labos_threejs_core.password_resets SET used_at=clock_timestamp() WHERE id=$1::uuid",
    )
    .bind(reset)
    .execute(&mut *tx)
    .await?;
    super::super::revoke_user_sessions(&mut tx, user).await?;
    revoke(&mut tx, user).await?;
    audit::append(
        &mut tx,
        audit::Event {
            actor_id: user,
            action: "identity.password.reset",
            resource_type: "identity.user",
            resource_id: user,
            source: audit::Source::Request(request),
            subject_user_id: None,
        },
    )
    .await?;
    tx.commit().await?;
    Ok(())
}
/// Caller holds the membership lock; disabling an account must invalidate old reset links too.
pub async fn revoke(connection: &mut PgConnection, user: &str) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE labos_threejs_core.password_resets SET revoked_at=clock_timestamp() WHERE user_id=$1::uuid AND used_at IS NULL AND revoked_at IS NULL").bind(user).execute(&mut *connection).await?;
    sqlx::query("DELETE FROM labos_threejs_core.password_reset_mail m USING labos_threejs_core.password_resets r WHERE m.reset_id=r.id AND r.user_id=$1::uuid").bind(user).execute(connection).await?;
    Ok(())
}
