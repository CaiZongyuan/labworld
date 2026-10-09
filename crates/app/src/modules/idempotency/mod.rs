use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use sqlx::PgConnection;

pub struct Attempt<'a> {
    pub actor_id: &'a str,
    pub scope: &'a str,
    pub key: &'a str,
    pub fingerprint: &'a [u8],
}

pub enum Error {
    InvalidKey,
    Conflict,
    Unavailable,
}
impl From<sqlx::Error> for Error {
    fn from(_: sqlx::Error) -> Self {
        Self::Unavailable
    }
}

pub fn fingerprint(payload: &impl Serialize) -> Result<Vec<u8>, Error> {
    serde_json::to_vec(payload)
        .map(|bytes| Sha256::digest(bytes).to_vec())
        .map_err(|_| Error::Unavailable)
}

/// Caller authorizes before claiming, and completes the record before committing.
pub async fn claim(
    connection: &mut PgConnection,
    attempt: &Attempt<'_>,
) -> Result<Option<Value>, Error> {
    if attempt.key.is_empty()
        || attempt.key.len() > 128
        || !attempt.key.bytes().all(|byte| (33..=126).contains(&byte))
    {
        return Err(Error::InvalidKey);
    }
    // Bound reclamation work; concurrent callers skip one another's cleanup locks.
    sqlx::query("DELETE FROM labos_threejs_core.idempotency_records WHERE (actor_id, scope, request_key) IN (SELECT actor_id, scope, request_key FROM labos_threejs_core.idempotency_records WHERE expires_at <= now() ORDER BY expires_at LIMIT 25 FOR UPDATE SKIP LOCKED)")
        .execute(&mut *connection).await?;
    let (stored, response): (Vec<u8>, Option<Value>) = sqlx::query_as("INSERT INTO labos_threejs_core.idempotency_records AS old (actor_id, scope, request_key, fingerprint) VALUES ($1::uuid, $2, $3, $4) ON CONFLICT (actor_id, scope, request_key) DO UPDATE SET fingerprint = CASE WHEN old.expires_at <= now() THEN excluded.fingerprint ELSE old.fingerprint END, response = CASE WHEN old.expires_at <= now() THEN NULL ELSE old.response END, expires_at = CASE WHEN old.expires_at <= now() THEN excluded.expires_at ELSE old.expires_at END RETURNING fingerprint, response")
        .bind(attempt.actor_id).bind(attempt.scope).bind(attempt.key).bind(attempt.fingerprint).fetch_one(connection).await?;
    if stored != attempt.fingerprint {
        return Err(Error::Conflict);
    }
    Ok(response)
}

pub async fn complete(
    connection: &mut PgConnection,
    attempt: &Attempt<'_>,
    response: Value,
) -> Result<(), Error> {
    let updated = sqlx::query("UPDATE labos_threejs_core.idempotency_records SET response = $4 WHERE actor_id = $1::uuid AND scope = $2 AND request_key = $3")
        .bind(attempt.actor_id).bind(attempt.scope).bind(attempt.key).bind(response).execute(connection).await?;
    if updated.rows_affected() != 1 {
        return Err(Error::Unavailable);
    }
    Ok(())
}
