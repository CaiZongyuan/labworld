pub mod cache;
use axum::{Extension, Json, extract::State, http::StatusCode, response::Response};
use serde::Serialize;
use sqlx::PgPool;
use utoipa::ToSchema;

use crate::http::{RequestId, public_error};

#[derive(Serialize, ToSchema)]
pub struct SystemStatus {
    status: &'static str,
    service: &'static str,
    database: &'static str,
    schema_version: i64,
    version: &'static str,
}

#[utoipa::path(get, path = "/api/v1/system/status", operation_id = "getSystemStatus", tag = "System", responses((status = 200, body = SystemStatus, description = "Status from the live PostgreSQL connection"), (status = 503, body = crate::http::ApiErrorResponse, description = "Database or migration metadata is unavailable")))]
pub async fn status(
    State(pool): State<PgPool>,
    Extension(id): Extension<RequestId>,
) -> Result<Json<SystemStatus>, Response> {
    let schema_version = schema_version(&pool).await.ok_or_else(|| {
        public_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "database.unavailable",
            "Database is not ready",
            id,
        )
    })?;
    Ok(Json(SystemStatus {
        status: "ok",
        service: "labos-threejs-api",
        database: "connected",
        schema_version,
        version: env!("CARGO_PKG_VERSION"),
    }))
}

/// Includes pool acquisition and the query in one bounded readiness budget.
pub async fn schema_version(pool: &PgPool) -> Option<i64> {
    let query = sqlx::query_as::<_, (i64, bool, Vec<u8>)>(
        "SELECT version, success, checksum FROM _sqlx_migrations",
    )
    .fetch_all(pool);
    match tokio::time::timeout(std::time::Duration::from_secs(2), query).await {
        Ok(Ok(applied)) => {
            let required: Vec<_> = labos_threejs_platform::postgres::MIGRATOR.iter().collect();
            if applied.len() == required.len()
                && required.iter().all(|expected| {
                    applied.iter().any(|(version, success, checksum)| {
                        *version == expected.version
                            && *success
                            && checksum.as_slice() == expected.checksum.as_ref()
                    })
                })
            {
                applied.iter().map(|(version, _, _)| *version).max()
            } else {
                tracing::warn!("database migration history does not match this application");
                None
            }
        }
        Ok(Err(error)) => {
            let sqlstate = error
                .as_database_error()
                .and_then(|error| error.code())
                .map(|code| code.into_owned());
            tracing::warn!(
                sqlstate = sqlstate.as_deref().unwrap_or("unavailable"),
                "database readiness check failed"
            );
            None
        }
        Err(_) => {
            tracing::warn!("database readiness check timed out");
            None
        }
    }
}
