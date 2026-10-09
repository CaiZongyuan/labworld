mod application;
mod attachments;
mod bases;
mod deletion;
mod domain;
pub use deletion::{base_cleanup_handler, document_cleanup_handler};
mod exports;
mod grants;
pub use exports::{
    ExportPolicy, FIELDS as CONFIG_FIELDS, export_handler, export_maintenance, process_export,
};
mod pagination;

use crate::{
    http::{ApiPath, ApiQuery, BoundedJson, RequestId, public_error},
    modules::identity,
};
use axum::{
    Extension, Json, Router,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use labos_threejs_platform::config::AuthSettings;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use std::time::Duration;
use utoipa::{OpenApi, ToSchema};

#[derive(Clone)]
struct Knowledge {
    pool: PgPool,
    auth: AuthSettings,
    cache: labos_threejs_platform::cache::Cache,
    export_policy: ExportPolicy,
    files: Option<crate::modules::files::FileService>,
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateDocument {
    knowledge_base_id: Option<String>,
    title: String,
    markdown: String,
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct UpdateDocument {
    title: String,
    markdown: String,
    #[schema(minimum = 1)]
    version: i64,
}

#[derive(Serialize, Deserialize, ToSchema, sqlx::FromRow)]
pub struct Document {
    #[serde(default)]
    #[schema(required = true)]
    #[sqlx(default)]
    pub can_edit: bool,
    pub id: String,
    pub knowledge_base_id: String,
    pub title: String,
    pub markdown: String,
    pub version: i64,
    pub created_by: String,
    pub updated_by: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Serialize, ToSchema, sqlx::FromRow)]
pub struct DocumentSummary {
    pub id: String,
    pub knowledge_base_id: String,
    pub title: String,
    pub version: i64,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Serialize, ToSchema)]
pub struct DocumentPage {
    pub can_create: bool,
    pub data: Vec<DocumentSummary>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
}

#[derive(Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub struct DocumentsQuery {
    /// Omit for the personal library; specify an accessible library to browse it.
    knowledge_base_id: Option<String>,
    /// Literal, case-insensitive title keyword; surrounding whitespace is ignored.
    #[param(max_length = 200)]
    q: Option<String>,
    #[param(minimum = 1, maximum = 100, default = 50)]
    limit: Option<u32>,
    #[param(max_length = 1024)]
    cursor: Option<String>,
}

enum Failure {
    File(crate::modules::files::Error),
    InvalidName,
    Unauthorized,
    ExportTooLarge,
    ExportExpired,
    ExportNotReady,
    InvalidVersion,
    VersionConflict,
    InvalidText,
    InvalidPage,
    InvalidSearch,
    InvalidKey,
    KeyConflict,
    InvalidTitle,
    TooLarge,
    Forbidden,
    NotFound,
    Unavailable,
}
impl From<crate::modules::files::Error> for Failure {
    fn from(error: crate::modules::files::Error) -> Self {
        Self::File(error)
    }
}
impl From<domain::ContentError> for Failure {
    fn from(error: domain::ContentError) -> Self {
        match error {
            domain::ContentError::InvalidTitle => Self::InvalidTitle,
            domain::ContentError::TooLarge => Self::TooLarge,
            domain::ContentError::InvalidText => Self::InvalidText,
        }
    }
}
impl From<sqlx::Error> for Failure {
    fn from(_: sqlx::Error) -> Self {
        Self::Unavailable
    }
}
impl From<crate::modules::idempotency::Error> for Failure {
    fn from(error: crate::modules::idempotency::Error) -> Self {
        match error {
            crate::modules::idempotency::Error::InvalidKey => Self::InvalidKey,
            crate::modules::idempotency::Error::Conflict => Self::KeyConflict,
            crate::modules::idempotency::Error::Unavailable => Self::Unavailable,
        }
    }
}
impl Failure {
    fn response(self, id: RequestId) -> Response {
        let (status, code, message) = match self {
            Self::ExportExpired => (
                StatusCode::GONE,
                "knowledge.export_expired",
                "Export has expired",
            ),
            Self::ExportNotReady => (
                StatusCode::CONFLICT,
                "knowledge.export_not_ready",
                "Export is not ready to download",
            ),
            Self::Unauthorized => (
                StatusCode::UNAUTHORIZED,
                "auth.unauthorized",
                "Sign in to continue",
            ),
            Self::ExportTooLarge => (
                StatusCode::PAYLOAD_TOO_LARGE,
                "knowledge.export_too_large",
                "Document export exceeds the configured limits",
            ),
            Self::File(error) => return error.response(id),
            Self::InvalidName => (
                StatusCode::BAD_REQUEST,
                "knowledge.invalid_name",
                "Use a knowledge base name with 1–120 characters without NUL bytes",
            ),
            Self::InvalidVersion => (
                StatusCode::BAD_REQUEST,
                "document.invalid_version",
                "Use a positive document version",
            ),
            Self::VersionConflict => (
                StatusCode::CONFLICT,
                "document.version_conflict",
                "Document has changed; read its latest version before saving again",
            ),
            Self::InvalidText => (
                StatusCode::BAD_REQUEST,
                "knowledge.invalid_text",
                "Title and Markdown cannot contain NUL bytes",
            ),
            Self::InvalidPage => (
                StatusCode::BAD_REQUEST,
                "knowledge.invalid_page",
                "Use a valid cursor for this identity and filter, and a limit from 1 to 100",
            ),
            Self::InvalidSearch => (
                StatusCode::BAD_REQUEST,
                "knowledge.invalid_search",
                "Use a search keyword of at most 200 characters without NUL bytes",
            ),
            Self::InvalidKey => (
                StatusCode::BAD_REQUEST,
                "idempotency.invalid_key",
                "Provide an Idempotency-Key with 1–128 visible ASCII characters",
            ),
            Self::KeyConflict => (
                StatusCode::CONFLICT,
                "idempotency.conflict",
                "This Idempotency-Key was used with a different request",
            ),
            Self::InvalidTitle => (
                StatusCode::BAD_REQUEST,
                "knowledge.invalid_title",
                "Use a title with 1–200 characters",
            ),
            Self::TooLarge => (
                StatusCode::PAYLOAD_TOO_LARGE,
                "knowledge.too_large",
                "Markdown exceeds the allowed size",
            ),
            Self::Forbidden => (
                StatusCode::FORBIDDEN,
                "knowledge.forbidden",
                "Document editing is not permitted",
            ),
            Self::NotFound => (
                StatusCode::NOT_FOUND,
                "knowledge.not_found",
                "Document not found",
            ),
            Self::Unavailable => (
                StatusCode::SERVICE_UNAVAILABLE,
                "knowledge.unavailable",
                "Knowledge is temporarily unavailable",
            ),
        };
        public_error(status, code, message, id)
    }
}

const READ_SCOPE: &str = "knowledge:read";
pub fn api_key_scope() -> crate::modules::api_keys::KeyScope {
    crate::modules::api_keys::KeyScope {
        id: READ_SCOPE.into(),
        label: "读取有权访问的文档".into(),
    }
}

pub fn router(pool: PgPool, auth: AuthSettings) -> Router {
    router_with_files(pool, auth, None)
}
pub fn router_with_files(
    pool: PgPool,
    auth: AuthSettings,
    files: Option<crate::modules::files::FileService>,
) -> Router {
    router_with_policy(pool, auth, files, ExportPolicy::default())
}
pub fn router_with_policy(
    pool: PgPool,
    auth: AuthSettings,
    files: Option<crate::modules::files::FileService>,
    export_policy: ExportPolicy,
) -> Router {
    router_with_cache(pool, auth, files, export_policy, Default::default())
}
pub fn router_with_cache(
    pool: PgPool,
    auth: AuthSettings,
    files: Option<crate::modules::files::FileService>,
    export_policy: ExportPolicy,
    cache: labos_threejs_platform::cache::Cache,
) -> Router {
    Router::new()
        .merge(attachments::routes())
        .merge(exports::routes())
        .merge(bases::routes())
        .merge(grants::routes())
        .route(
            "/api/v1/knowledge/documents",
            post(create_document).get(list_documents),
        )
        .route(
            "/api/v1/knowledge/documents/{id}",
            get(get_document)
                .put(update_document)
                .delete(deletion::delete_document),
        )
        .layer(DefaultBodyLimit::max(8 * 1024 * 1024))
        .with_state(Knowledge {
            pool,
            auth,
            cache,
            files,
            export_policy,
        })
}

#[utoipa::path(post, path = "/api/v1/knowledge/documents", operation_id = "createDocument", tag = "Knowledge", request_body = CreateDocument, params(("x-csrf-token" = String, Header), ("idempotency-key" = String, Header)), responses((status = 201, body = Document), (status = 400, body = crate::http::ApiErrorResponse), (status = 401, body = crate::http::ApiErrorResponse), (status = 403, body = crate::http::ApiErrorResponse), (status = 408, body = crate::http::ApiErrorResponse), (status = 409, body = crate::http::ApiErrorResponse), (status = 413, body = crate::http::ApiErrorResponse), (status = 503, body = crate::http::ApiErrorResponse)))]
async fn create_document(
    State(state): State<Knowledge>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    BoundedJson(input): BoundedJson<CreateDocument>,
) -> Response {
    let actor = match identity::require_session(&state.pool, &state.auth, &headers, &id, true).await
    {
        Ok(session) => session.user,
        Err(response) => return response,
    };
    let base_id = match input
        .knowledge_base_id
        .as_deref()
        .map(uuid::Uuid::parse_str)
        .transpose()
    {
        Ok(base) => base,
        Err(_) => return Failure::NotFound.response(id),
    };
    let content = match domain::Content::new(input.title, input.markdown) {
        Ok(content) => content,
        Err(error) => return Failure::from(error).response(id),
    };
    let Some(key) = headers
        .get("idempotency-key")
        .and_then(|value| value.to_str().ok())
    else {
        return Failure::InvalidKey.response(id);
    };
    match tokio::time::timeout(
        Duration::from_secs(3),
        application::create(&state.pool, &actor, base_id, content, &id.0, key),
    )
    .await
    {
        Ok(Ok(document)) => (StatusCode::CREATED, Json(document)).into_response(),
        Ok(Err(error)) => error.response(id),
        Err(_) => Failure::Unavailable.response(id),
    }
}

#[utoipa::path(get, path = "/api/v1/knowledge/documents/{id}", operation_id = "getDocument", tag = "Knowledge", params(("id" = String, Path), ("authorization" = Option<String>, Header, description="Bearer key with knowledge:read or browser Session")), responses((status = 200, body = Document), (status = 400, body = crate::http::ApiErrorResponse), (status = 401, body = crate::http::ApiErrorResponse), (status = 403, body = crate::http::ApiErrorResponse), (status = 404, body = crate::http::ApiErrorResponse), (status = 503, body = crate::http::ApiErrorResponse)))]
async fn get_document(
    State(state): State<Knowledge>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiPath(document_id): ApiPath<String>,
) -> Response {
    let actor = match crate::modules::api_keys::require_read(
        &state.pool,
        &state.auth,
        &headers,
        &id,
        READ_SCOPE,
    )
    .await
    {
        Ok(access) => access,
        Err(response) => return response,
    };
    let Ok(document_id) = uuid::Uuid::parse_str(&document_id) else {
        return Failure::NotFound.response(id);
    };
    match tokio::time::timeout(
        Duration::from_secs(3),
        application::read(&state.pool, &actor.user, document_id, &state.cache),
    )
    .await
    {
        Ok(Ok(mut document)) => {
            if actor.is_api_key {
                document.can_edit = false;
            }
            Json(document).into_response()
        }
        Ok(Err(error)) => error.response(id),
        Err(_) => Failure::Unavailable.response(id),
    }
}

#[derive(OpenApi)]
#[openapi(paths(create_document, get_document, list_documents, update_document))]
struct KnowledgeApi;

pub fn openapi() -> utoipa::openapi::OpenApi {
    let mut document = KnowledgeApi::openapi();
    document.merge(bases::openapi());
    document.merge(grants::openapi());
    document.merge(attachments::openapi());
    document.merge(deletion::openapi());
    document.merge(exports::openapi());
    document
}

#[utoipa::path(put, path = "/api/v1/knowledge/documents/{id}", operation_id = "updateDocument", tag = "Knowledge", request_body = UpdateDocument, params(("id" = String, Path), ("x-csrf-token" = String, Header)), responses((status = 200, body = Document), (status = 400, body = crate::http::ApiErrorResponse), (status = 401, body = crate::http::ApiErrorResponse), (status = 403, body = crate::http::ApiErrorResponse), (status = 404, body = crate::http::ApiErrorResponse), (status = 408, body = crate::http::ApiErrorResponse), (status = 409, body = crate::http::ApiErrorResponse), (status = 413, body = crate::http::ApiErrorResponse), (status = 503, body = crate::http::ApiErrorResponse)))]
async fn update_document(
    State(state): State<Knowledge>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiPath(document_id): ApiPath<String>,
    BoundedJson(input): BoundedJson<UpdateDocument>,
) -> Response {
    let actor = match identity::require_session(&state.pool, &state.auth, &headers, &id, true).await
    {
        Ok(session) => session.user,
        Err(response) => return response,
    };
    let Ok(document_id) = uuid::Uuid::parse_str(&document_id) else {
        return Failure::NotFound.response(id);
    };
    if input.version < 1 {
        return Failure::InvalidVersion.response(id);
    }
    let content = match domain::Content::new(input.title, input.markdown) {
        Ok(content) => content,
        Err(error) => return Failure::from(error).response(id),
    };
    match tokio::time::timeout(
        Duration::from_secs(3),
        application::update(
            &state.pool,
            &actor,
            document_id,
            input.version,
            content,
            &id.0,
        ),
    )
    .await
    {
        Ok(Ok(document)) => {
            let key = application::body_cache_key(&document.id, input.version);
            let _ = state.cache.remove(&key, state.cache.deadline()).await;
            Json(document).into_response()
        }
        Ok(Err(error)) => error.response(id),
        Err(_) => Failure::Unavailable.response(id),
    }
}

#[utoipa::path(get, path = "/api/v1/knowledge/documents", operation_id = "listPersonalDocuments", tag = "Knowledge", params(DocumentsQuery, ("authorization" = Option<String>, Header, description="Bearer key with knowledge:read or browser Session")), responses((status = 200, body = DocumentPage), (status = 400, body = crate::http::ApiErrorResponse), (status = 401, body = crate::http::ApiErrorResponse), (status = 403, body = crate::http::ApiErrorResponse), (status = 503, body = crate::http::ApiErrorResponse)))]
async fn list_documents(
    State(state): State<Knowledge>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiQuery(query): ApiQuery<DocumentsQuery>,
) -> Response {
    let actor = match crate::modules::api_keys::require_read(
        &state.pool,
        &state.auth,
        &headers,
        &id,
        READ_SCOPE,
    )
    .await
    {
        Ok(access) => access,
        Err(response) => return response,
    };
    match tokio::time::timeout(
        Duration::from_secs(3),
        application::list(&state.pool, &actor.user, query),
    )
    .await
    {
        Ok(Ok(mut page)) => {
            if actor.is_api_key {
                page.can_create = false;
            }
            Json(page).into_response()
        }
        Ok(Err(error)) => error.response(id),
        Err(_) => Failure::Unavailable.response(id),
    }
}
