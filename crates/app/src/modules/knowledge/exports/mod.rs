mod archive;
mod configuration;
mod maintenance;
mod requests;
pub use configuration::{ExportPolicy, FIELDS};
pub use maintenance::export_maintenance;
mod worker;
use super::{
    Failure, Knowledge, application,
    bases::{self, PageQuery},
};
use crate::{
    http::{ApiPath, ApiQuery, RequestId},
    modules::{files, identity, jobs, organization},
};
use axum::{
    Extension, Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::PgConnection;
use utoipa::{OpenApi, ToSchema};
pub use worker::{export_handler, process_export};

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExportPayload {
    export_id: String,
}

#[derive(Serialize, Deserialize)]
struct Snapshot {
    title: String,
    markdown: String,
    attachments: Vec<files::FileSnapshot>,
}

#[derive(sqlx::FromRow)]
struct ExportRow {
    id: String,
    document_id: String,
    requested_by: String,
    job_id: String,
    document_version: i64,
    file_id: Option<String>,
    created_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
}
const COLUMNS: &str = "id::text, document_id::text, requested_by::text, job_id::text, document_version, file_id::text, created_at, expires_at";

#[derive(Serialize, ToSchema)]
struct DocumentExport {
    id: String,
    document_id: String,
    document_version: i64,
    status: String,
    last_error: Option<String>,
    can_download: bool,
    created_at: DateTime<Utc>,
    expires_at: DateTime<Utc>,
}
#[derive(Serialize, ToSchema)]
struct ExportPage {
    data: Vec<DocumentExport>,
    next_cursor: Option<String>,
    has_more: bool,
}

pub(super) fn routes() -> Router<Knowledge> {
    Router::new()
        .route(
            "/api/v1/knowledge/documents/{id}/exports",
            get(list_exports).post(request_export),
        )
        .route(
            "/api/v1/knowledge/documents/{id}/exports/{export_id}",
            get(get_export),
        )
        .route(
            "/api/v1/knowledge/documents/{id}/exports/{export_id}/download",
            get(download_export),
        )
}
#[derive(OpenApi)]
#[openapi(paths(request_export, list_exports, get_export, download_export))]
struct ExportApi;
pub(super) fn openapi() -> utoipa::openapi::OpenApi {
    ExportApi::openapi()
}

#[utoipa::path(post, path = "/api/v1/knowledge/documents/{id}/exports", operation_id = "requestDocumentExport", tag = "Knowledge", params(("id" = String, Path), ("x-csrf-token" = String, Header), ("idempotency-key" = String, Header)), responses((status = 202, body = DocumentExport), (status = 400, body = crate::http::ApiErrorResponse), (status = 401, body = crate::http::ApiErrorResponse), (status = 403, body = crate::http::ApiErrorResponse), (status = 404, body = crate::http::ApiErrorResponse), (status = 409, body = crate::http::ApiErrorResponse), (status = 413, body = crate::http::ApiErrorResponse), (status = 503, body = crate::http::ApiErrorResponse)))]
async fn request_export(
    State(state): State<Knowledge>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiPath(document_id): ApiPath<String>,
) -> Response {
    let actor = match identity::require_session(&state.pool, &state.auth, &headers, &id, true).await
    {
        Ok(s) => s.user,
        Err(r) => return r,
    };
    if state.files.is_none() {
        return files::Error::Unavailable.response(id);
    }
    let Ok(document_id) = uuid::Uuid::parse_str(&document_id) else {
        return Failure::NotFound.response(id);
    };
    let Some(key) = headers.get("idempotency-key").and_then(|h| h.to_str().ok()) else {
        return Failure::InvalidKey.response(id);
    };
    let create = async {
        let mut connection = state.pool.acquire().await?;
        let credential =
            identity::background_credential(&mut connection, &state.auth, &headers, &actor.id)
                .await?
                .ok_or(Failure::Unauthorized)?;
        drop(connection);
        requests::create(
            &state.pool,
            &state.auth,
            &state.export_policy,
            requests::ExportRequest {
                actor_id: &actor.id,
                document_id,
                key,
                credential,
                request_id: &id.0,
            },
        )
        .await
    };
    match tokio::time::timeout(std::time::Duration::from_secs(3), create).await {
        Ok(Ok(info)) => (StatusCode::ACCEPTED, Json(info)).into_response(),
        Ok(Err(error)) => error.response(id),
        Err(_) => Failure::Unavailable.response(id),
    }
}

async fn information(
    connection: &mut PgConnection,
    rows: Vec<ExportRow>,
) -> Result<Vec<DocumentExport>, Failure> {
    let ids = rows
        .iter()
        .map(|row| row.job_id.clone())
        .collect::<Vec<_>>();
    let statuses = jobs::statuses(connection, &ids)
        .await?
        .into_iter()
        .map(|status| (status.id.clone(), status))
        .collect::<std::collections::HashMap<_, _>>();
    rows.into_iter()
        .map(|row| {
            let job = statuses.get(&row.job_id).ok_or(Failure::Unavailable)?;
            let status = if row.expires_at <= Utc::now() {
                "expired".into()
            } else {
                job.status.clone()
            };
            Ok(DocumentExport {
                id: row.id,
                document_id: row.document_id,
                document_version: row.document_version,
                can_download: status == "succeeded" && row.file_id.is_some(),
                status,
                last_error: job.last_error.clone(),
                created_at: row.created_at,
                expires_at: row.expires_at,
            })
        })
        .collect()
}

#[utoipa::path(get, path = "/api/v1/knowledge/documents/{id}/exports", operation_id = "listDocumentExports", tag = "Knowledge", params(("id" = String, Path), PageQuery), responses((status = 200, body = ExportPage), (status = 400, body = crate::http::ApiErrorResponse), (status = 401, body = crate::http::ApiErrorResponse), (status = 403, body = crate::http::ApiErrorResponse), (status = 404, body = crate::http::ApiErrorResponse), (status = 503, body = crate::http::ApiErrorResponse)))]
async fn list_exports(
    State(state): State<Knowledge>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiPath(document_id): ApiPath<String>,
    ApiQuery(query): ApiQuery<PageQuery>,
) -> Response {
    let actor =
        match identity::require_session(&state.pool, &state.auth, &headers, &id, false).await {
            Ok(s) => s.user,
            Err(r) => return r,
        };
    let Ok(document_id) = uuid::Uuid::parse_str(&document_id) else {
        return Failure::NotFound.response(id);
    };
    let list = async {
        let mut tx = state.pool.begin().await?;
        application::lock_document(&mut tx, &actor.id, document_id, false).await?;
        let scope = format!("exports:{document_id}:id-desc");
        let (limit, cursor) = query.decode(&actor.id, &scope)?;
        let mut rows: Vec<ExportRow> = sqlx::query_as(&format!("SELECT {COLUMNS} FROM knowledge.exports WHERE document_id = $1::uuid AND requested_by = $2::uuid AND ($3::uuid IS NULL OR id < $3::uuid) ORDER BY id DESC LIMIT $4"))
            .bind(document_id.to_string()).bind(&actor.id).bind(cursor).bind(i64::from(limit) + 1).fetch_all(&mut *tx).await?;
        let has_more = rows.len() > limit as usize;
        rows.truncate(limit as usize);
        let next_cursor = if has_more {
            rows.last()
                .map(|row| bases::next_cursor(&actor.id, &scope, &row.id))
                .transpose()?
        } else {
            None
        };
        let data = information(&mut tx, rows).await?;
        tx.commit().await?;
        Ok::<_, Failure>(ExportPage {
            data,
            next_cursor,
            has_more,
        })
    };
    match tokio::time::timeout(std::time::Duration::from_secs(3), list).await {
        Ok(Ok(page)) => Json(page).into_response(),
        Ok(Err(error)) => error.response(id),
        Err(_) => Failure::Unavailable.response(id),
    }
}

async fn authorized_export(
    connection: &mut PgConnection,
    actor_id: &str,
    document_id: uuid::Uuid,
    export_id: uuid::Uuid,
) -> Result<ExportRow, Failure> {
    let row: ExportRow = sqlx::query_as(&format!(
        "SELECT {COLUMNS} FROM knowledge.exports WHERE id = $1::uuid AND document_id = $2::uuid"
    ))
    .bind(export_id.to_string())
    .bind(document_id.to_string())
    .fetch_optional(&mut *connection)
    .await?
    .ok_or(Failure::NotFound)?;
    let mut ids = vec![actor_id.to_owned(), row.requested_by.clone()];
    ids.sort();
    ids.dedup();
    let members = organization::lock_memberships(connection, &ids).await?;
    let role = members
        .iter()
        .find(|m| m.user_id == actor_id && m.active)
        .map(|m| m.role)
        .ok_or(Failure::NotFound)?;
    if !members
        .iter()
        .any(|m| m.user_id == row.requested_by && m.active)
        || (actor_id != row.requested_by && !application::manager(role))
    {
        return Err(Failure::NotFound);
    }
    application::lock_document(connection, actor_id, document_id, false).await?;
    if actor_id != row.requested_by {
        application::lock_document(connection, &row.requested_by, document_id, false).await?;
    }
    Ok(row)
}

#[utoipa::path(get, path = "/api/v1/knowledge/documents/{id}/exports/{export_id}", operation_id = "getDocumentExport", tag = "Knowledge", params(("id" = String, Path), ("export_id" = String, Path)), responses((status = 200, body = DocumentExport), (status = 400, body = crate::http::ApiErrorResponse), (status = 401, body = crate::http::ApiErrorResponse), (status = 403, body = crate::http::ApiErrorResponse), (status = 404, body = crate::http::ApiErrorResponse), (status = 503, body = crate::http::ApiErrorResponse)))]
async fn get_export(
    State(state): State<Knowledge>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiPath((document_id, export_id)): ApiPath<(String, String)>,
) -> Response {
    let actor =
        match identity::require_session(&state.pool, &state.auth, &headers, &id, false).await {
            Ok(s) => s.user,
            Err(r) => return r,
        };
    let (Ok(document_id), Ok(export_id)) = (
        uuid::Uuid::parse_str(&document_id),
        uuid::Uuid::parse_str(&export_id),
    ) else {
        return Failure::NotFound.response(id);
    };
    let read = async {
        let mut tx = state.pool.begin().await?;
        let row = authorized_export(&mut tx, &actor.id, document_id, export_id).await?;
        let info = information(&mut tx, vec![row])
            .await?
            .pop()
            .ok_or(Failure::Unavailable)?;
        tx.commit().await?;
        Ok::<_, Failure>(info)
    };
    match tokio::time::timeout(std::time::Duration::from_secs(3), read).await {
        Ok(Ok(info)) => Json(info).into_response(),
        Ok(Err(error)) => error.response(id),
        Err(_) => Failure::Unavailable.response(id),
    }
}

#[utoipa::path(get, path = "/api/v1/knowledge/documents/{id}/exports/{export_id}/download", operation_id = "downloadDocumentExport", tag = "Knowledge", params(("id" = String, Path), ("export_id" = String, Path)), responses((status = 200, body = files::DownloadCapability), (status = 400, body = crate::http::ApiErrorResponse), (status = 401, body = crate::http::ApiErrorResponse), (status = 403, body = crate::http::ApiErrorResponse), (status = 404, body = crate::http::ApiErrorResponse), (status = 409, body = crate::http::ApiErrorResponse), (status = 410, body = crate::http::ApiErrorResponse), (status = 503, body = crate::http::ApiErrorResponse)))]
async fn download_export(
    State(state): State<Knowledge>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiPath((document_id, export_id)): ApiPath<(String, String)>,
) -> Response {
    let actor =
        match identity::require_session(&state.pool, &state.auth, &headers, &id, false).await {
            Ok(s) => s.user,
            Err(r) => return r,
        };
    let Some(files) = &state.files else {
        return files::Error::Unavailable.response(id);
    };
    let (Ok(document_id), Ok(export_id)) = (
        uuid::Uuid::parse_str(&document_id),
        uuid::Uuid::parse_str(&export_id),
    ) else {
        return Failure::NotFound.response(id);
    };
    let download = async {
        let mut tx = state.pool.begin().await?;
        let row = authorized_export(&mut tx, &actor.id, document_id, export_id).await?;
        if row.expires_at <= Utc::now() {
            return Err(Failure::ExportExpired);
        }
        let file_id = row.file_id.as_deref().ok_or(Failure::ExportNotReady)?;
        let signed = files.download(&mut tx, file_id, false).await?;
        tx.commit().await?;
        Ok::<_, Failure>(signed)
    };
    match tokio::time::timeout(std::time::Duration::from_secs(3), download).await {
        Ok(Ok(signed)) => Json(signed).into_response(),
        Ok(Err(error)) => error.response(id),
        Err(_) => Failure::Unavailable.response(id),
    }
}
