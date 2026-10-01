use super::SECRET_PREFIX;
use crate::{
    http::{RequestId, public_error},
    modules::{
        identity::{self, CurrentUser},
        organization,
    },
};
use axum::{
    http::{HeaderMap, StatusCode},
    response::Response,
};
use labos_threejs_platform::config::AuthSettings;
use sqlx::PgPool;

pub struct ReadActor {
    pub user: CurrentUser,
    pub is_api_key: bool,
}
enum Failure {
    Unauthorized,
    Scope,
    Unavailable,
}
impl From<sqlx::Error> for Failure {
    fn from(_: sqlx::Error) -> Self {
        Self::Unavailable
    }
}
impl Failure {
    fn response(self, id: RequestId) -> Response {
        let (status, code, message) = match self {
            Self::Unauthorized => (
                StatusCode::UNAUTHORIZED,
                "auth.unauthorized",
                "Provide an active credential",
            ),
            Self::Scope => (
                StatusCode::FORBIDDEN,
                "api_keys.scope_forbidden",
                "API key does not permit this operation",
            ),
            Self::Unavailable => (
                StatusCode::SERVICE_UNAVAILABLE,
                "auth.unavailable",
                "Authentication is temporarily unavailable",
            ),
        };
        public_error(status, code, message, id)
    }
}
/// An explicit Authorization header always wins; an invalid key never falls back to Cookie.
/// Resource owners still check their current grants after this authentication step.
pub async fn require_read(
    pool: &PgPool,
    auth: &AuthSettings,
    headers: &HeaderMap,
    id: &RequestId,
    scope: &str,
) -> Result<ReadActor, Response> {
    if !headers.contains_key("authorization") {
        return identity::require_session(pool, auth, headers, id, false)
            .await
            .map(|session| ReadActor {
                user: session.user,
                is_api_key: false,
            });
    }
    let token = (|| {
        if headers.get_all("authorization").iter().count() != 1 {
            return None;
        }
        let mut parts = headers
            .get("authorization")?
            .to_str()
            .ok()?
            .split_ascii_whitespace();
        if !parts.next()?.eq_ignore_ascii_case("bearer") {
            return None;
        }
        let token = parts.next()?;
        let random = token.strip_prefix(SECRET_PREFIX)?;
        if parts.next().is_some()
            || random.len() != 64
            || !random.bytes().all(|b| b.is_ascii_hexdigit())
        {
            return None;
        }
        Some(token)
    })()
    .ok_or_else(|| Failure::Unauthorized.response(id.clone()))?;
    match tokio::time::timeout(
        std::time::Duration::from_secs(3),
        authenticate(pool, token, scope),
    )
    .await
    {
        Ok(Ok(user)) => {
            labos_threejs_platform::telemetry::record_actor(&user.id);
            Ok(ReadActor {
                user,
                is_api_key: true,
            })
        }
        Ok(Err(error)) => Err(error.response(id.clone())),
        Err(_) => Err(Failure::Unavailable.response(id.clone())),
    }
}
async fn authenticate(pool: &PgPool, token: &str, scope: &str) -> Result<CurrentUser, Failure> {
    let hash = crate::secrets::secret_hash(token);
    let mut tx = pool.begin().await?;
    let user: String = sqlx::query_scalar("SELECT user_id::text FROM labos_threejs_core.api_keys WHERE secret_hash = $1 AND revoked_at IS NULL AND expires_at > clock_timestamp()")
        .bind(&hash).fetch_optional(&mut *tx).await?.ok_or(Failure::Unauthorized)?;
    // Membership before credential: the same lock order as creation/revocation.
    let role = organization::active_role_in(&mut tx, &user)
        .await?
        .ok_or(Failure::Unauthorized)?;
    let scopes: Vec<String> = sqlx::query_scalar("UPDATE labos_threejs_core.api_keys SET last_used_at = clock_timestamp() WHERE user_id = $1::uuid AND secret_hash = $2 AND revoked_at IS NULL AND expires_at > clock_timestamp() RETURNING scopes")
        .bind(&user).bind(hash).fetch_optional(&mut *tx).await?.ok_or(Failure::Unauthorized)?;
    if !scopes.iter().any(|value| value == scope) {
        return Err(Failure::Scope);
    }
    let profile = identity::profiles(&mut tx, &[user])
        .await?
        .pop()
        .ok_or(Failure::Unauthorized)?;
    tx.commit().await?;
    Ok(CurrentUser {
        id: profile.id,
        email: profile.email,
        display_name: profile.display_name,
        role,
    })
}
