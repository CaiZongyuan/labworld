use crate::{
    http::{ApiQuery, RequestId, public_error},
    modules::{
        identity,
        organization::{self, MemberRole},
    },
};
use axum::{
    Extension, Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
};
use labos_threejs_platform::config::AuthSettings;
use serde::Serialize;
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use utoipa::{OpenApi, ToSchema};

#[derive(Clone)]
struct Administration {
    pool: PgPool,
    auth: AuthSettings,
}
pub fn router(pool: PgPool, auth: AuthSettings) -> Router {
    Router::new()
        .route("/api/v1/audit-events", get(list_audit_events))
        .with_state(Administration { pool, auth })
}
#[derive(OpenApi)]
#[openapi(paths(list_audit_events))]
struct AuditApi;
pub fn openapi() -> utoipa::openapi::OpenApi {
    AuditApi::openapi()
}
#[derive(Serialize, ToSchema, sqlx::FromRow)]
struct AuditEvent {
    id: String,
    actor_id: Option<String>,
    action: String,
    resource_id: String,
    actor_type: String,
    resource_type: String,
    request_id: Option<String>,
    trace_id: Option<String>,
    correlation_id: String,
    job_id: Option<String>,
    #[sqlx(json)]
    metadata: super::Metadata,
    created_at: chrono::DateTime<chrono::Utc>,
}
#[derive(Serialize, ToSchema)]
struct AuditPage {
    data: Vec<AuditEvent>,
    next_cursor: Option<String>,
    has_more: bool,
}
#[derive(serde::Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in=Query)]
struct AuditQuery {
    #[param(max_length = 200)]
    resource_id: Option<String>,
    #[param(max_length = 200)]
    action: Option<String>,
    #[param(max_length = 200)]
    request_id: Option<String>,
    #[param(max_length = 200)]
    resource_type: Option<String>,
    actor_id: Option<String>,
    #[param(max_length = 200)]
    correlation_id: Option<String>,
    job_id: Option<String>,
    #[param(minimum = 1, maximum = 100, default = 50)]
    limit: Option<u32>,
    #[param(max_length = 512)]
    cursor: Option<String>,
}
enum Error {
    Forbidden,
    InvalidPage,
    Unavailable,
}
impl From<sqlx::Error> for Error {
    fn from(_: sqlx::Error) -> Self {
        Self::Unavailable
    }
}
async fn list(pool: &PgPool, actor: &str, mut query: AuditQuery) -> Result<AuditPage, Error> {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    let mut tx = pool.begin().await?;
    // Keep the role's share lock until all global audit reads complete.
    if !matches!(
        organization::active_role_in(&mut tx, actor).await?,
        Some(MemberRole::Owner | MemberRole::Admin)
    ) {
        return Err(Error::Forbidden);
    }
    let limit = query.limit.unwrap_or(50);
    if !(1..=100).contains(&limit) {
        return Err(Error::InvalidPage);
    }
    for id in [&mut query.actor_id, &mut query.job_id]
        .into_iter()
        .flatten()
    {
        *id = uuid::Uuid::parse_str(id)
            .map_err(|_| Error::InvalidPage)?
            .to_string();
    }
    let filters = [
        &query.resource_id,
        &query.action,
        &query.request_id,
        &query.resource_type,
        &query.actor_id,
        &query.correlation_id,
        &query.job_id,
    ];
    if filters.iter().any(|value| {
        value
            .as_ref()
            .is_some_and(|s| s.is_empty() || s.len() > 200 || s.contains('\0'))
    }) {
        return Err(Error::InvalidPage);
    }
    let scope = hex::encode(Sha256::digest(
        serde_json::to_vec(&filters).map_err(|_| Error::Unavailable)?,
    ));
    let cursor = if let Some(cursor) = query.cursor {
        if cursor.len() > 512 {
            return Err(Error::InvalidPage);
        }
        let bytes = URL_SAFE_NO_PAD
            .decode(cursor)
            .map_err(|_| Error::InvalidPage)?;
        let (subject, saved_scope, id): (String, String, String) =
            serde_json::from_slice(&bytes).map_err(|_| Error::InvalidPage)?;
        if subject != actor || saved_scope != scope {
            return Err(Error::InvalidPage);
        }
        Some(
            uuid::Uuid::parse_str(&id)
                .map_err(|_| Error::InvalidPage)?
                .to_string(),
        )
    } else {
        None
    };
    let mut data: Vec<AuditEvent> = sqlx::query_as("SELECT id::text, actor_id::text, actor_type, action, resource_type, resource_id, request_id, trace_id, correlation_id, job_id::text, metadata, created_at FROM labos_threejs_core.audit_events WHERE ($1::text IS NULL OR resource_id = $1) AND ($2::text IS NULL OR action = $2) AND ($3::text IS NULL OR request_id = $3) AND ($4::text IS NULL OR resource_type = $4) AND ($5::uuid IS NULL OR actor_id = $5::uuid) AND ($6::text IS NULL OR correlation_id = $6) AND ($7::uuid IS NULL OR job_id = $7::uuid) AND ($8::uuid IS NULL OR id < $8::uuid) ORDER BY id DESC LIMIT $9")
        .bind(query.resource_id).bind(query.action).bind(query.request_id).bind(query.resource_type).bind(query.actor_id).bind(query.correlation_id).bind(query.job_id).bind(cursor).bind(i64::from(limit) + 1).fetch_all(&mut *tx).await?;
    tx.commit().await?;
    let has_more = data.len() > limit as usize;
    data.truncate(limit as usize);
    let next_cursor = if has_more {
        data.last()
            .map(|event| {
                serde_json::to_vec(&(actor, &scope, &event.id))
                    .map(|bytes| URL_SAFE_NO_PAD.encode(bytes))
                    .map_err(|_| Error::Unavailable)
            })
            .transpose()?
    } else {
        None
    };
    Ok(AuditPage {
        data,
        next_cursor,
        has_more,
    })
}
#[utoipa::path(get,path="/api/v1/audit-events",operation_id="listAuditEvents",tag="Audit",params(AuditQuery),responses((status=200,body=AuditPage),(status=400,body=crate::http::ApiErrorResponse),(status=401,body=crate::http::ApiErrorResponse),(status=403,body=crate::http::ApiErrorResponse),(status=503,body=crate::http::ApiErrorResponse)))]
async fn list_audit_events(
    State(state): State<Administration>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiQuery(query): ApiQuery<AuditQuery>,
) -> Response {
    let actor =
        match identity::require_session(&state.pool, &state.auth, &headers, &id, false).await {
            Ok(session) => session.user,
            Err(response) => return response,
        };
    let response = tokio::time::timeout(
        std::time::Duration::from_secs(3),
        list(&state.pool, &actor.id, query),
    )
    .await;
    match response {
        Ok(Ok(page)) => Json(page).into_response(),
        Ok(Err(Error::Forbidden)) => public_error(
            StatusCode::FORBIDDEN,
            "audit.forbidden",
            "Only an active Owner or Admin can read audit events",
            id,
        ),
        Ok(Err(Error::InvalidPage)) => public_error(
            StatusCode::BAD_REQUEST,
            "audit.invalid_page",
            "Use valid audit filters and cursor",
            id,
        ),
        _ => public_error(
            StatusCode::SERVICE_UNAVAILABLE,
            "audit.unavailable",
            "Audit events are temporarily unavailable",
            id,
        ),
    }
}
