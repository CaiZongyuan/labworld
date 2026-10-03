mod assets;
mod definitions;
mod glb;

use crate::{
    http::{RequestId, public_error},
    modules::{api_keys, files, organization},
};
use axum::{
    Router,
    http::{HeaderMap, StatusCode},
    response::Response,
};
use labos_threejs_platform::config::AuthSettings;
use sqlx::{PgConnection, PgPool};

#[derive(Clone)]
struct Lab {
    pool: PgPool,
    auth: AuthSettings,
    files: Option<files::FileService>,
}
const KEY_SCOPE: &str = "lab:full";

pub fn router(pool: PgPool, auth: AuthSettings, files: Option<files::FileService>) -> Router {
    assets::routes()
        .merge(definitions::routes())
        .with_state(Lab { pool, auth, files })
}

pub fn openapi() -> utoipa::openapi::OpenApi {
    let mut document = assets::openapi();
    document.merge(definitions::openapi());
    document
}

pub fn api_key_scope() -> api_keys::KeyScope {
    api_keys::KeyScope {
        id: KEY_SCOPE.into(),
        label: "Lab full access / 实验室完整访问".into(),
    }
}

enum Failure {
    File(files::Error),
    InvalidInput,
    NotFound,
    Unauthorized,
    InUse,
    Unavailable,
    Idempotency(crate::modules::idempotency::Error),
}
impl From<crate::modules::idempotency::Error> for Failure {
    fn from(error: crate::modules::idempotency::Error) -> Self {
        Self::Idempotency(error)
    }
}
impl From<files::Error> for Failure {
    fn from(error: files::Error) -> Self {
        Self::File(error)
    }
}
impl From<sqlx::Error> for Failure {
    fn from(error: sqlx::Error) -> Self {
        match error {
            sqlx::Error::RowNotFound => Self::NotFound,
            sqlx::Error::Database(ref error) if error.code().as_deref() == Some("23503") => {
                Self::InUse
            }
            _ => Self::Unavailable,
        }
    }
}
impl Failure {
    fn response(self, id: RequestId) -> Response {
        let (status, code, message) = match self {
            Self::File(error) => return error.response(id),
            Self::Idempotency(crate::modules::idempotency::Error::InvalidKey) => (
                StatusCode::BAD_REQUEST,
                "idempotency.invalid_key",
                "Provide an Idempotency-Key with 1-128 visible ASCII characters",
            ),
            Self::Idempotency(crate::modules::idempotency::Error::Conflict) => (
                StatusCode::CONFLICT,
                "idempotency.conflict",
                "This Idempotency-Key was used with a different request",
            ),
            Self::Idempotency(crate::modules::idempotency::Error::Unavailable) => (
                StatusCode::SERVICE_UNAVAILABLE,
                "lab.unavailable",
                "Lab is temporarily unavailable",
            ),
            Self::InvalidInput => (
                StatusCode::BAD_REQUEST,
                "lab.invalid_input",
                "Use valid asset metadata and pagination",
            ),
            Self::NotFound => (
                StatusCode::NOT_FOUND,
                "lab.asset_not_found",
                "Asset not found",
            ),
            Self::Unauthorized => (
                StatusCode::UNAUTHORIZED,
                "auth.unauthorized",
                "Provide an active credential",
            ),
            Self::InUse => (
                StatusCode::CONFLICT,
                "lab.asset_in_use",
                "This asset is referenced and cannot be deleted",
            ),
            Self::Unavailable => (
                StatusCode::SERVICE_UNAVAILABLE,
                "lab.unavailable",
                "Lab is temporarily unavailable",
            ),
        };
        public_error(status, code, message, id)
    }
}

impl Lab {
    async fn actor(
        &self,
        headers: &HeaderMap,
        id: &RequestId,
        mutation: bool,
    ) -> Result<String, Response> {
        api_keys::require_access(&self.pool, &self.auth, headers, id, KEY_SCOPE, mutation)
            .await
            .map(|actor| actor.user.id)
    }

    async fn authorize(
        &self,
        connection: &mut PgConnection,
        headers: &HeaderMap,
        actor_id: &str,
    ) -> Result<(), Failure> {
        if organization::active_role_in(connection, actor_id)
            .await?
            .is_none()
            || !api_keys::credential_is_current(
                connection, &self.auth, headers, actor_id, KEY_SCOPE,
            )
            .await?
        {
            return Err(Failure::Unauthorized);
        }
        Ok(())
    }
}
