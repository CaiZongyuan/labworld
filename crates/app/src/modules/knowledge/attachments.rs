use super::{
    Failure, Knowledge, application,
    bases::{self, PageQuery},
};
use crate::{
    http::{ApiPath, ApiQuery, BoundedJson, RequestId},
    modules::{
        audit,
        files::{
            self, CompletionPlan, DownloadCapability, FileInfo, Publication, UploadCapability,
            UploadInput,
        },
        idempotency, identity,
    },
};
use axum::{
    Extension, Json, Router,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, post},
};
use serde::{Deserialize, Serialize};
use utoipa::{OpenApi, ToSchema};

#[derive(Serialize, ToSchema)]
struct AttachmentPage {
    can_upload: bool,
    can_delete: bool,
    max_upload_bytes: i64,
    data: Vec<FileInfo>,
    next_cursor: Option<String>,
    has_more: bool,
}

pub(super) fn routes() -> Router<Knowledge> {
    Router::new()
        .route(
            "/api/v1/knowledge/documents/{id}/attachments/{file_id}",
            delete(remove_attachment),
        )
        .route(
            "/api/v1/knowledge/documents/{id}/uploads",
            post(start_upload),
        )
        .route(
            "/api/v1/knowledge/documents/{id}/uploads/{upload_id}/complete",
            post(complete_upload),
        )
        .route(
            "/api/v1/knowledge/documents/{id}/attachments",
            get(list_attachments),
        )
        .route(
            "/api/v1/knowledge/documents/{id}/attachments/{file_id}/download",
            get(download_attachment),
        )
        .layer(DefaultBodyLimit::max(16 * 1024))
}
#[derive(OpenApi)]
#[openapi(paths(
    start_upload,
    list_attachments,
    complete_upload,
    download_attachment,
    remove_attachment
))]
struct AttachmentApi;
pub(super) fn openapi() -> utoipa::openapi::OpenApi {
    AttachmentApi::openapi()
}

#[utoipa::path(post, path = "/api/v1/knowledge/documents/{id}/uploads", operation_id = "startAttachmentUpload", tag = "Knowledge", request_body = UploadInput, params(("id" = String, Path), ("x-csrf-token" = String, Header), ("idempotency-key" = String, Header)), responses((status = 201, body = UploadCapability), (status = 400, body = crate::http::ApiErrorResponse), (status = 401, body = crate::http::ApiErrorResponse), (status = 403, body = crate::http::ApiErrorResponse), (status = 404, body = crate::http::ApiErrorResponse), (status = 409, body = crate::http::ApiErrorResponse), (status = 410, body = crate::http::ApiErrorResponse), (status = 413, body = crate::http::ApiErrorResponse), (status = 422, body = crate::http::ApiErrorResponse), (status = 503, body = crate::http::ApiErrorResponse)))]
async fn start_upload(
    State(state): State<Knowledge>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiPath(document_id): ApiPath<String>,
    BoundedJson(mut input): BoundedJson<UploadInput>,
) -> Response {
    let actor = match identity::require_session(&state.pool, &state.auth, &headers, &id, true).await
    {
        Ok(s) => s.user,
        Err(r) => return r,
    };
    let Some(files) = &state.files else {
        return files::Error::Unavailable.response(id);
    };
    let Ok(document_id) = uuid::Uuid::parse_str(&document_id) else {
        return Failure::NotFound.response(id);
    };
    if let Err(error) = files.validate(&mut input) {
        return error.response(id);
    }
    let Some(key) = headers.get("idempotency-key").and_then(|h| h.to_str().ok()) else {
        return Failure::InvalidKey.response(id);
    };
    let register = register_upload(&state.pool, files, &actor.id, document_id, key, &input);
    let upload = match tokio::time::timeout(std::time::Duration::from_secs(3), register).await {
        Ok(Ok(upload)) => upload,
        Ok(Err(error)) => return error.response(id),
        Err(_) => return Failure::Unavailable.response(id),
    };
    match files.upload_capability(&upload).await {
        Ok(capability) => (StatusCode::CREATED, Json(capability)).into_response(),
        Err(error) => error.response(id),
    }
}

async fn register_upload(
    pool: &sqlx::PgPool,
    files: &files::FileService,
    actor_id: &str,
    document_id: uuid::Uuid,
    key: &str,
    input: &UploadInput,
) -> Result<files::Upload, Failure> {
    let mut tx = pool.begin().await?;
    application::lock_document(&mut tx, actor_id, document_id, true).await?;
    let fingerprint = idempotency::fingerprint(input)?;
    let scope = format!("POST /api/v1/knowledge/documents/{document_id}/uploads");
    let attempt = idempotency::Attempt {
        actor_id,
        scope: &scope,
        key,
        fingerprint: &fingerprint,
    };
    let upload = if let Some(response) = idempotency::claim(&mut tx, &attempt).await? {
        let upload_id = response["upload_id"].as_str().ok_or(Failure::Unavailable)?;
        let associated: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM knowledge.attachment_uploads WHERE upload_id = $1::uuid AND document_id = $2::uuid)")
            .bind(upload_id).bind(document_id.to_string()).fetch_one(&mut *tx).await?;
        if !associated {
            return Err(Failure::NotFound);
        }
        files.load(&mut tx, upload_id).await?
    } else {
        let upload = files.start(&mut tx, actor_id, input).await?;
        sqlx::query("INSERT INTO knowledge.attachment_uploads (upload_id, document_id) VALUES ($1::uuid, $2::uuid)").bind(&upload.id).bind(document_id.to_string()).execute(&mut *tx).await?;
        idempotency::complete(
            &mut tx,
            &attempt,
            serde_json::json!({"upload_id":upload.id}),
        )
        .await?;
        upload
    };
    tx.commit().await?;
    Ok(upload)
}

#[utoipa::path(get, path = "/api/v1/knowledge/documents/{id}/attachments", operation_id = "listAttachments", tag = "Knowledge", params(("id" = String, Path), PageQuery), responses((status = 200, body = AttachmentPage), (status = 400, body = crate::http::ApiErrorResponse), (status = 401, body = crate::http::ApiErrorResponse), (status = 404, body = crate::http::ApiErrorResponse), (status = 503, body = crate::http::ApiErrorResponse)))]
async fn list_attachments(
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
    match tokio::time::timeout(
        std::time::Duration::from_secs(3),
        list(
            &state.pool,
            &actor.id,
            document_id,
            query,
            state.files.as_ref(),
        ),
    )
    .await
    {
        Ok(Ok(page)) => Json(page).into_response(),
        Ok(Err(error)) => error.response(id),
        Err(_) => Failure::Unavailable.response(id),
    }
}
async fn list(
    pool: &sqlx::PgPool,
    actor_id: &str,
    document_id: uuid::Uuid,
    query: PageQuery,
    file_service: Option<&files::FileService>,
) -> Result<AttachmentPage, Failure> {
    let mut tx = pool.begin().await?;
    let can_edit = application::lock_document(&mut tx, actor_id, document_id, false).await?;
    let scope = format!("attachments:{document_id}:id-asc");
    let (limit, cursor) = query.decode(actor_id, &scope)?;
    let mut ids: Vec<String> = sqlx::query_scalar("SELECT file_id::text FROM knowledge.attachments WHERE document_id = $1::uuid AND ($2::uuid IS NULL OR file_id > $2::uuid) ORDER BY file_id LIMIT $3")
        .bind(document_id.to_string()).bind(cursor).bind(i64::from(limit) + 1).fetch_all(&mut *tx).await?;
    let has_more = ids.len() > limit as usize;
    ids.truncate(limit as usize);
    let next_cursor = if has_more {
        ids.last()
            .map(|id| bases::next_cursor(actor_id, &scope, id))
            .transpose()?
    } else {
        None
    };
    let data = files::ready_info(&mut tx, &ids).await?;
    tx.commit().await?;
    Ok(AttachmentPage {
        can_upload: can_edit && file_service.is_some(),
        can_delete: can_edit,
        max_upload_bytes: file_service.map_or(0, |service| service.policy.max_bytes),
        data,
        next_cursor,
        has_more,
    })
}

#[utoipa::path(post, path = "/api/v1/knowledge/documents/{id}/uploads/{upload_id}/complete", operation_id = "completeAttachmentUpload", tag = "Knowledge", params(("id" = String, Path), ("upload_id" = String, Path), ("x-csrf-token" = String, Header)), responses((status = 200, body = FileInfo), (status = 400, body = crate::http::ApiErrorResponse), (status = 401, body = crate::http::ApiErrorResponse), (status = 403, body = crate::http::ApiErrorResponse), (status = 404, body = crate::http::ApiErrorResponse), (status = 409, body = crate::http::ApiErrorResponse), (status = 410, body = crate::http::ApiErrorResponse), (status = 413, body = crate::http::ApiErrorResponse), (status = 422, body = crate::http::ApiErrorResponse), (status = 503, body = crate::http::ApiErrorResponse)))]
async fn complete_upload(
    State(state): State<Knowledge>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiPath((document_id, upload_id)): ApiPath<(String, String)>,
) -> Response {
    let actor = match identity::require_session(&state.pool, &state.auth, &headers, &id, true).await
    {
        Ok(s) => s.user,
        Err(r) => return r,
    };
    let Some(files) = &state.files else {
        return files::Error::Unavailable.response(id);
    };
    let (Ok(document_id), Ok(upload_id)) = (
        uuid::Uuid::parse_str(&document_id),
        uuid::Uuid::parse_str(&upload_id),
    ) else {
        return Failure::NotFound.response(id);
    };
    let upload_id = upload_id.to_string();
    let plan = match tokio::time::timeout(
        std::time::Duration::from_secs(3),
        plan(&state.pool, files, &actor.id, document_id, &upload_id),
    )
    .await
    {
        Ok(Ok(plan)) => plan,
        Ok(Err(error)) => return error.response(id),
        Err(_) => return Failure::Unavailable.response(id),
    };
    let attempt = match plan {
        CompletionPlan::Ready(file) => return Json(file).into_response(),
        CompletionPlan::Expired => return files::Error::Expired.response(id),
        CompletionPlan::Rejected => return files::Error::Rejected.response(id),
        CompletionPlan::Attempt(attempt) => attempt,
    };
    let verified = match files.verify_candidate(&attempt).await {
        Ok(verified) => verified,
        Err(error) => {
            abandon(
                &state.pool,
                files,
                &attempt,
                matches!(error, files::Error::Rejected | files::Error::TooLarge),
            )
            .await;
            return error.response(id);
        }
    };
    // Credentials can expire or be revoked while object I/O is in flight.
    if let Err(response) =
        identity::require_session(&state.pool, &state.auth, &headers, &id, true).await
    {
        abandon(&state.pool, files, &attempt, false).await;
        return response;
    }
    match tokio::time::timeout(
        std::time::Duration::from_secs(3),
        publish(
            &state.pool,
            files,
            &actor.id,
            document_id,
            &upload_id,
            &verified,
            &id.0,
        ),
    )
    .await
    {
        Ok(Ok(Some(file))) => Json(file).into_response(),
        Ok(Ok(None)) => files::Error::Expired.response(id),
        result => {
            abandon(&state.pool, files, &attempt, false).await;
            match result {
                Ok(Err(error)) => error.response(id),
                _ => Failure::Unavailable.response(id),
            }
        }
    }
}

async fn associated(
    connection: &mut sqlx::PgConnection,
    document_id: uuid::Uuid,
    upload_id: &str,
) -> Result<(), Failure> {
    let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM knowledge.attachment_uploads WHERE upload_id = $1::uuid AND document_id = $2::uuid)")
        .bind(upload_id).bind(document_id.to_string()).fetch_one(connection).await?;
    if !exists {
        return Err(Failure::NotFound);
    }
    Ok(())
}
async fn ready_association(
    connection: &mut sqlx::PgConnection,
    document_id: uuid::Uuid,
    file_id: &str,
) -> Result<(), Failure> {
    let exists: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM knowledge.attachments WHERE file_id = $1::uuid AND document_id = $2::uuid)")
        .bind(file_id).bind(document_id.to_string()).fetch_one(connection).await?;
    if !exists {
        return Err(Failure::NotFound);
    }
    Ok(())
}
async fn plan(
    pool: &sqlx::PgPool,
    files: &files::FileService,
    actor_id: &str,
    document_id: uuid::Uuid,
    upload_id: &str,
) -> Result<CompletionPlan, Failure> {
    let mut tx = pool.begin().await?;
    application::lock_document(&mut tx, actor_id, document_id, true).await?;
    associated(&mut tx, document_id, upload_id).await?;
    let plan = files.plan_completion(&mut tx, upload_id).await?;
    if matches!(plan, CompletionPlan::Ready(_)) {
        ready_association(&mut tx, document_id, upload_id).await?;
    }
    tx.commit().await?;
    Ok(plan)
}
async fn publish(
    pool: &sqlx::PgPool,
    files: &files::FileService,
    actor_id: &str,
    document_id: uuid::Uuid,
    upload_id: &str,
    verified: &files::VerifiedCandidate,
    request_id: &str,
) -> Result<Option<FileInfo>, Failure> {
    let mut tx = pool.begin().await?;
    application::lock_document(&mut tx, actor_id, document_id, true).await?;
    associated(&mut tx, document_id, upload_id).await?;
    let file = match files.publish(&mut tx, verified).await? {
        Publication::Adopted(file) => {
            sqlx::query("INSERT INTO knowledge.attachments (file_id, document_id) VALUES ($1::uuid, $2::uuid)").bind(&file.id).bind(document_id.to_string()).execute(&mut *tx).await?;
            audit::append(
                &mut tx,
                audit::Event {
                    actor_id,
                    action: "knowledge.attachment.complete",
                    resource_type: "knowledge.attachment",
                    resource_id: &file.id,
                    source: audit::Source::Request(request_id),
                    subject_user_id: None,
                },
            )
            .await?;
            Some(file)
        }
        Publication::Existing(file) => {
            ready_association(&mut tx, document_id, &file.id).await?;
            Some(file)
        }
        Publication::Expired => None,
    };
    tx.commit().await?;
    Ok(file)
}
async fn abandon(
    pool: &sqlx::PgPool,
    files: &files::FileService,
    attempt: &files::CompletionAttempt,
    rejected: bool,
) {
    // The previously committed candidate location remains recoverable even if this update fails.
    let _ = tokio::time::timeout(std::time::Duration::from_secs(3), async {
        let mut tx = pool.begin().await?;
        files.abandon(&mut tx, attempt, rejected).await?;
        tx.commit().await?;
        Ok::<_, files::Error>(())
    })
    .await;
}

#[derive(Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
struct DownloadQuery {
    inline: Option<bool>,
}
#[utoipa::path(get, path = "/api/v1/knowledge/documents/{id}/attachments/{file_id}/download", operation_id = "getAttachmentDownload", tag = "Knowledge", params(("id" = String, Path), ("file_id" = String, Path), DownloadQuery), responses((status = 200, body = DownloadCapability), (status = 400, body = crate::http::ApiErrorResponse), (status = 401, body = crate::http::ApiErrorResponse), (status = 404, body = crate::http::ApiErrorResponse), (status = 503, body = crate::http::ApiErrorResponse)))]
async fn download_attachment(
    State(state): State<Knowledge>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiPath((document_id, file_id)): ApiPath<(String, String)>,
    ApiQuery(query): ApiQuery<DownloadQuery>,
) -> Response {
    let actor =
        match identity::require_session(&state.pool, &state.auth, &headers, &id, false).await {
            Ok(s) => s.user,
            Err(r) => return r,
        };
    let Some(files) = &state.files else {
        return files::Error::Unavailable.response(id);
    };
    let (Ok(document_id), Ok(file_id)) = (
        uuid::Uuid::parse_str(&document_id),
        uuid::Uuid::parse_str(&file_id),
    ) else {
        return Failure::NotFound.response(id);
    };
    let download = async {
        let mut tx = state.pool.begin().await?;
        application::lock_document(&mut tx, &actor.id, document_id, false).await?;
        ready_association(&mut tx, document_id, &file_id.to_string()).await?;
        let signed = files
            .download(&mut tx, &file_id.to_string(), query.inline.unwrap_or(false))
            .await?;
        tx.commit().await?;
        Ok::<_, Failure>(signed)
    };
    match tokio::time::timeout(std::time::Duration::from_secs(3), download).await {
        Ok(Ok(signed)) => Json(signed).into_response(),
        Ok(Err(error)) => error.response(id),
        Err(_) => Failure::Unavailable.response(id),
    }
}

#[utoipa::path(delete, path = "/api/v1/knowledge/documents/{id}/attachments/{file_id}", operation_id = "deleteAttachment", tag = "Knowledge", params(("id" = String, Path), ("file_id" = String, Path), ("x-csrf-token" = String, Header)), responses((status = 204), (status = 400, body = crate::http::ApiErrorResponse), (status = 401, body = crate::http::ApiErrorResponse), (status = 403, body = crate::http::ApiErrorResponse), (status = 404, body = crate::http::ApiErrorResponse), (status = 503, body = crate::http::ApiErrorResponse)))]
async fn remove_attachment(
    State(state): State<Knowledge>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiPath((document_id, file_id)): ApiPath<(String, String)>,
) -> Response {
    let actor = match identity::require_session(&state.pool, &state.auth, &headers, &id, true).await
    {
        Ok(session) => session.user,
        Err(response) => return response,
    };
    let (Ok(document_id), Ok(file_id)) = (
        uuid::Uuid::parse_str(&document_id),
        uuid::Uuid::parse_str(&file_id),
    ) else {
        return Failure::NotFound.response(id);
    };
    match tokio::time::timeout(
        std::time::Duration::from_secs(3),
        remove_attachment_in(&state.pool, &actor.id, document_id, file_id, &id.0),
    )
    .await
    {
        Ok(Ok(())) => StatusCode::NO_CONTENT.into_response(),
        Ok(Err(error)) => error.response(id),
        Err(_) => Failure::Unavailable.response(id),
    }
}
async fn remove_attachment_in(
    pool: &sqlx::PgPool,
    actor: &str,
    document_id: uuid::Uuid,
    file_id: uuid::Uuid,
    request_id: &str,
) -> Result<(), Failure> {
    let mut tx = pool.begin().await?;
    application::lock_document(&mut tx, actor, document_id, true).await?;
    let removed = sqlx::query(
        "DELETE FROM knowledge.attachments WHERE document_id = $1::uuid AND file_id = $2::uuid",
    )
    .bind(document_id.to_string())
    .bind(file_id.to_string())
    .execute(&mut *tx)
    .await?;
    if removed.rows_affected() != 1 {
        return Err(Failure::NotFound);
    }
    sqlx::query("DELETE FROM knowledge.attachment_uploads WHERE document_id = $1::uuid AND upload_id = $2::uuid").bind(document_id.to_string()).bind(file_id.to_string()).execute(&mut *tx).await?;
    files::mark_deleting(&mut tx, &file_id.to_string(), request_id).await?;
    audit::append(
        &mut tx,
        audit::Event {
            actor_id: actor,
            action: "knowledge.attachment.delete",
            resource_type: "knowledge.attachment",
            resource_id: &file_id.to_string(),
            source: audit::Source::Request(request_id),
            subject_user_id: None,
        },
    )
    .await?;
    tx.commit().await?;
    Ok(())
}
