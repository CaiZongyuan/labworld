mod assets;
mod definitions;
mod devices;
mod glb;
mod history;
mod layout;
mod lifecycle;
mod records;
mod relationships;
mod runtime;
mod sync;
mod tasks;
mod trend;
mod world;

pub use history::retention::{
    HistoryMaintenance, RETENTION_FIELDS, RetentionPolicy, run_history_maintenance,
};
pub use runtime::{
    DeviceRuntime, ObservationAcceptance, ObservationClock, ObservationReport, ObservationSink,
    RuntimeAvailability, run_device_programs,
};

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
    runtime: Option<RuntimeAvailability>,
    retention: RetentionPolicy,
}
const KEY_SCOPE: &str = "lab:full";

pub fn router(pool: PgPool, auth: AuthSettings, files: Option<files::FileService>) -> Router {
    router_with_runtime(pool, auth, files, None)
}
pub fn router_with_runtime(
    pool: PgPool,
    auth: AuthSettings,
    files: Option<files::FileService>,
    runtime: Option<RuntimeAvailability>,
) -> Router {
    router_with_retention(pool, auth, files, runtime, RetentionPolicy::default())
}
pub fn router_with_retention(
    pool: PgPool,
    auth: AuthSettings,
    files: Option<files::FileService>,
    runtime: Option<RuntimeAvailability>,
    retention: RetentionPolicy,
) -> Router {
    assets::routes()
        .merge(definitions::routes())
        .merge(world::routes())
        .merge(layout::routes())
        .merge(lifecycle::routes())
        .merge(devices::routes())
        .merge(tasks::routes())
        .merge(history::routes())
        .merge(records::routes())
        .merge(trend::routes())
        .merge(sync::routes())
        .with_state(Lab {
            pool,
            auth,
            files,
            runtime,
            retention,
        })
}

pub fn openapi() -> utoipa::openapi::OpenApi {
    let mut document = assets::openapi();
    document.merge(definitions::openapi());
    document.merge(world::openapi());
    document.merge(layout::openapi());
    document.merge(lifecycle::openapi());
    document.merge(devices::openapi());
    document.merge(tasks::openapi());
    document.merge(history::openapi());
    document.merge(records::openapi());
    document.merge(trend::openapi());
    document.merge(sync::openapi());
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
    InvalidReference,
    WorldNotFound,
    NotImplemented,
    ProgramNotRunning,
    DeviceBusy,
    EntityInUse,
    EntityArchived,
    InvalidParameters,
    CommandExpired,
    RuntimeUnavailable,
    LayoutConflict,
    SnapshotTooLarge,
    RecordsTooLarge,
    TrendBudgetExceeded,
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
            Self::RecordsTooLarge => (
                StatusCode::PAYLOAD_TOO_LARGE,
                "lab.records_too_large",
                "A record exceeds the 256 KiB page limit; narrow the record filters",
            ),
            Self::TrendBudgetExceeded => (
                StatusCode::PAYLOAD_TOO_LARGE,
                "lab.trend_budget_exceeded",
                "Trend cannot preserve its samples and gaps within the budget; reduce the time range",
            ),
            Self::EntityInUse => (
                StatusCode::CONFLICT,
                "lab.entity_in_use",
                "Finish the Task and stop the program before archiving or changing its definition",
            ),
            Self::EntityArchived => (
                StatusCode::CONFLICT,
                "lab.entity_archived",
                "This Entity is archived and does not accept new actions",
            ),
            Self::CommandExpired => (
                StatusCode::GONE,
                "lab.command_expired",
                "The original Command record expired; this request was not executed again",
            ),
            Self::DeviceBusy => (
                StatusCode::CONFLICT,
                "lab.device_busy",
                "Stop the current task and wait for idle before starting another task or stopping its program",
            ),
            Self::SnapshotTooLarge => (
                StatusCode::PAYLOAD_TOO_LARGE,
                "lab.snapshot_too_large",
                "World exceeds the subscription payload limit",
            ),
            Self::LayoutConflict => (
                StatusCode::CONFLICT,
                "lab.layout_conflict",
                "Layout changed; keep the draft, reload the current version and retry",
            ),
            Self::RuntimeUnavailable => (
                StatusCode::SERVICE_UNAVAILABLE,
                "lab.runtime_unavailable",
                "Device runtime is not initialized; no command was accepted",
            ),
            Self::ProgramNotRunning => (
                StatusCode::UNPROCESSABLE_ENTITY,
                "lab.program_not_running",
                "Start the device program explicitly before sending a command",
            ),
            Self::InvalidParameters => (
                StatusCode::UNPROCESSABLE_ENTITY,
                "lab.invalid_parameters",
                "Use the capability input types and allowed range",
            ),
            Self::InvalidReference => (
                StatusCode::BAD_REQUEST,
                "lab.invalid_reference",
                "Use an existing definition version, representation and Entity in this Lab",
            ),
            Self::WorldNotFound => (
                StatusCode::NOT_FOUND,
                "lab.world_not_found",
                "Lab or Entity not found",
            ),
            Self::NotImplemented => (
                StatusCode::UNPROCESSABLE_ENTITY,
                "lab.capability_not_implemented",
                "This Entity has no Binding implementing this capability",
            ),
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
                "Use valid Lab input and pagination",
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
    fn runtime_available(&self) -> bool {
        self.runtime
            .as_ref()
            .is_none_or(RuntimeAvailability::is_ready)
    }
    fn require_runtime(&self) -> Result<(), Failure> {
        if self.runtime_available() {
            Ok(())
        } else {
            Err(Failure::RuntimeUnavailable)
        }
    }
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
        self.access_current(connection, headers, actor_id).await?;
        sync::lock_world(connection).await?;
        Ok(())
    }

    async fn access_current(
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
