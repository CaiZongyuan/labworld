use super::{Failure, Knowledge, application::manager};
use crate::{
    http::{ApiPath, ApiQuery, BoundedJson, RequestId},
    modules::{audit, idempotency, identity, organization},
};
use axum::{
    Extension, Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use utoipa::{OpenApi, ToSchema};

#[derive(Serialize, Deserialize, ToSchema, sqlx::FromRow)]
pub(super) struct KnowledgeBase {
    pub id: String,
    pub name: String,
    pub personal: bool,
    pub can_edit: bool,
    pub can_manage: bool,
}
#[derive(Serialize, ToSchema)]
struct KnowledgeBasePage {
    data: Vec<KnowledgeBase>,
    next_cursor: Option<String>,
    has_more: bool,
    can_create: bool,
}
#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
struct CreateKnowledgeBase {
    name: String,
}
#[derive(Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
pub(super) struct PageQuery {
    #[param(minimum = 1, maximum = 100, default = 50)]
    pub limit: Option<u32>,
    #[param(max_length = 512)]
    pub cursor: Option<String>,
}

impl PageQuery {
    pub fn decode(&self, actor: &str, scope: &str) -> Result<(u32, Option<String>), Failure> {
        let limit = self.limit.unwrap_or(50);
        if !(1..=100).contains(&limit) {
            return Err(Failure::InvalidPage);
        }
        let cursor = match self.cursor.as_deref() {
            Some(token) if token.len() <= 512 => {
                let bytes = URL_SAFE_NO_PAD
                    .decode(token)
                    .map_err(|_| Failure::InvalidPage)?;
                let (subject, saved_scope, id): (String, String, String) =
                    serde_json::from_slice(&bytes).map_err(|_| Failure::InvalidPage)?;
                if subject != actor || saved_scope != scope {
                    return Err(Failure::InvalidPage);
                }
                Some(
                    uuid::Uuid::parse_str(&id)
                        .map_err(|_| Failure::InvalidPage)?
                        .to_string(),
                )
            }
            Some(_) => return Err(Failure::InvalidPage),
            None => None,
        };
        Ok((limit, cursor))
    }
}
pub(super) fn next_cursor(actor: &str, scope: &str, id: &str) -> Result<String, Failure> {
    serde_json::to_vec(&(actor, scope, id))
        .map(|bytes| URL_SAFE_NO_PAD.encode(bytes))
        .map_err(|_| Failure::Unavailable)
}

pub(super) async fn read_base(
    connection: &mut sqlx::PgConnection,
    actor_id: &str,
    role: organization::MemberRole,
    id: uuid::Uuid,
) -> Result<KnowledgeBase, Failure> {
    sqlx::query_as::<_, KnowledgeBase>("SELECT b.id::text, b.name, (b.personal_owner IS NOT NULL) AS personal, ($2 OR EXISTS (SELECT 1 FROM knowledge.grants g WHERE g.knowledge_base_id = b.id AND g.user_id = $1::uuid AND g.access = 'editor')) AS can_edit, $2 AS can_manage FROM knowledge.knowledge_bases b WHERE b.id = $3::uuid AND b.deleted_at IS NULL AND ($2 OR EXISTS (SELECT 1 FROM knowledge.grants g WHERE g.knowledge_base_id = b.id AND g.user_id = $1::uuid))")
        .bind(actor_id).bind(manager(role)).bind(id.to_string()).fetch_optional(connection).await?.ok_or(Failure::NotFound)
}

pub(super) fn routes() -> Router<Knowledge> {
    Router::new()
        .route("/api/v1/knowledge/bases", post(create_base).get(list_bases))
        .route(
            "/api/v1/knowledge/bases/{id}",
            get(get_base)
                .put(rename_base)
                .delete(super::deletion::delete_base),
        )
}
#[derive(OpenApi)]
#[openapi(paths(create_base, list_bases, get_base, rename_base))]
struct BasesApi;
pub(super) fn openapi() -> utoipa::openapi::OpenApi {
    BasesApi::openapi()
}

#[utoipa::path(get, path = "/api/v1/knowledge/bases/{id}", operation_id = "getKnowledgeBase", tag = "Knowledge", params(("id" = String, Path)), responses((status = 200, body = KnowledgeBase), (status = 400, body = crate::http::ApiErrorResponse), (status = 401, body = crate::http::ApiErrorResponse), (status = 404, body = crate::http::ApiErrorResponse), (status = 503, body = crate::http::ApiErrorResponse)))]
async fn get_base(
    State(state): State<Knowledge>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiPath(base): ApiPath<String>,
) -> Response {
    let actor =
        match identity::require_session(&state.pool, &state.auth, &headers, &id, false).await {
            Ok(session) => session.user,
            Err(response) => return response,
        };
    let Ok(base_id) = uuid::Uuid::parse_str(&base) else {
        return Failure::NotFound.response(id);
    };
    let read = async {
        let mut connection = state.pool.acquire().await?;
        read_base(&mut connection, &actor.id, actor.role, base_id).await
    };
    match tokio::time::timeout(std::time::Duration::from_secs(3), read).await {
        Ok(Ok(base)) => Json(base).into_response(),
        Ok(Err(error)) => error.response(id),
        Err(_) => Failure::Unavailable.response(id),
    }
}

#[utoipa::path(post, path = "/api/v1/knowledge/bases", operation_id = "createKnowledgeBase", tag = "Knowledge", request_body = CreateKnowledgeBase, params(("x-csrf-token" = String, Header), ("idempotency-key" = String, Header)), responses((status = 201, body = KnowledgeBase), (status = 400, body = crate::http::ApiErrorResponse), (status = 401, body = crate::http::ApiErrorResponse), (status = 403, body = crate::http::ApiErrorResponse), (status = 409, body = crate::http::ApiErrorResponse), (status = 408, body = crate::http::ApiErrorResponse), (status = 413, body = crate::http::ApiErrorResponse), (status = 503, body = crate::http::ApiErrorResponse)))]
async fn create_base(
    State(state): State<Knowledge>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    BoundedJson(input): BoundedJson<CreateKnowledgeBase>,
) -> Response {
    let actor = match identity::require_session(&state.pool, &state.auth, &headers, &id, true).await
    {
        Ok(session) => session.user,
        Err(response) => return response,
    };
    let name = match validated_name(&input.name) {
        Ok(name) => name,
        Err(error) => return error.response(id),
    };
    let Some(key) = headers.get("idempotency-key").and_then(|h| h.to_str().ok()) else {
        return Failure::InvalidKey.response(id);
    };
    match tokio::time::timeout(
        std::time::Duration::from_secs(3),
        create(&state.pool, &actor, name, key, &id.0),
    )
    .await
    {
        Ok(Ok(base)) => (StatusCode::CREATED, Json(base)).into_response(),
        Ok(Err(error)) => error.response(id),
        Err(_) => Failure::Unavailable.response(id),
    }
}

#[utoipa::path(get, path = "/api/v1/knowledge/bases", operation_id = "listKnowledgeBases", tag = "Knowledge", params(PageQuery), responses((status = 200, body = KnowledgeBasePage), (status = 400, body = crate::http::ApiErrorResponse), (status = 401, body = crate::http::ApiErrorResponse), (status = 503, body = crate::http::ApiErrorResponse)))]
async fn list_bases(
    State(state): State<Knowledge>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiQuery(query): ApiQuery<PageQuery>,
) -> Response {
    let actor =
        match identity::require_session(&state.pool, &state.auth, &headers, &id, false).await {
            Ok(session) => session.user,
            Err(response) => return response,
        };
    match tokio::time::timeout(
        std::time::Duration::from_secs(3),
        list(&state.pool, &actor, query),
    )
    .await
    {
        Ok(Ok(page)) => Json(page).into_response(),
        Ok(Err(error)) => error.response(id),
        Err(_) => Failure::Unavailable.response(id),
    }
}

async fn create(
    pool: &sqlx::PgPool,
    actor: &identity::CurrentUser,
    name: &str,
    key: &str,
    request_id: &str,
) -> Result<KnowledgeBase, Failure> {
    let mut tx = pool.begin().await?;
    let role = organization::active_role_in(&mut tx, &actor.id)
        .await?
        .ok_or(Failure::Forbidden)?;
    if !manager(role) {
        return Err(Failure::Forbidden);
    }
    let fingerprint = idempotency::fingerprint(&name)?;
    let attempt = idempotency::Attempt {
        actor_id: &actor.id,
        scope: "POST /api/v1/knowledge/bases",
        key,
        fingerprint: &fingerprint,
    };
    if let Some(response) = idempotency::claim(&mut tx, &attempt).await? {
        let saved = response["base_id"]
            .as_str()
            .or_else(|| response["id"].as_str())
            .and_then(|value| uuid::Uuid::parse_str(value).ok())
            .ok_or(Failure::Unavailable)?;
        let base = read_base(&mut tx, &actor.id, role, saved).await?;
        tx.commit().await?;
        return Ok(base);
    }
    let base = sqlx::query_as::<_, KnowledgeBase>("INSERT INTO knowledge.knowledge_bases (id, name, created_by) VALUES ($1::uuid, $2, $3::uuid) RETURNING id::text, name, false AS personal, true AS can_edit, true AS can_manage")
            .bind(uuid::Uuid::now_v7().to_string()).bind(name).bind(&actor.id).fetch_one(&mut *tx).await?;
    audit::append(
        &mut tx,
        audit::Event {
            actor_id: &actor.id,
            action: "knowledge.base.create",
            resource_type: "knowledge.base",
            resource_id: &base.id,
            source: audit::Source::Request(request_id),
            subject_user_id: None,
        },
    )
    .await?;
    idempotency::complete(&mut tx, &attempt, serde_json::json!({"base_id":base.id})).await?;
    tx.commit().await?;
    Ok::<_, Failure>(base)
}

async fn list(
    pool: &sqlx::PgPool,
    actor: &identity::CurrentUser,
    query: PageQuery,
) -> Result<KnowledgeBasePage, Failure> {
    let (limit, cursor) = query.decode(&actor.id, "bases-id-asc")?;
    let mut data = sqlx::query_as::<_, KnowledgeBase>("SELECT b.id::text, b.name, (b.personal_owner IS NOT NULL) AS personal, ($2 OR EXISTS (SELECT 1 FROM knowledge.grants g WHERE g.knowledge_base_id = b.id AND g.user_id = $1::uuid AND g.access = 'editor')) AS can_edit, $2 AS can_manage FROM knowledge.knowledge_bases b WHERE b.deleted_at IS NULL AND ($2 OR EXISTS (SELECT 1 FROM knowledge.grants g WHERE g.knowledge_base_id = b.id AND g.user_id = $1::uuid)) AND ($3::uuid IS NULL OR b.id > $3::uuid) ORDER BY b.id LIMIT $4")
            .bind(&actor.id).bind(manager(actor.role)).bind(cursor).bind(i64::from(limit) + 1).fetch_all(pool).await?;
    let has_more = data.len() > limit as usize;
    data.truncate(limit as usize);
    let next_cursor = if has_more {
        data.last()
            .map(|last| next_cursor(&actor.id, "bases-id-asc", &last.id))
            .transpose()?
    } else {
        None
    };
    Ok::<_, Failure>(KnowledgeBasePage {
        data,
        next_cursor,
        has_more,
        can_create: manager(actor.role),
    })
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
struct RenameKnowledgeBase {
    name: String,
}

pub(super) async fn lock_manage_base(
    connection: &mut sqlx::PgConnection,
    actor_id: &str,
    role: organization::MemberRole,
    base_id: uuid::Uuid,
) -> Result<KnowledgeBase, Failure> {
    let exists: Option<String> = sqlx::query_scalar(
        "SELECT id::text FROM knowledge.knowledge_bases WHERE id = $1::uuid AND deleted_at IS NULL FOR UPDATE",
    )
    .bind(base_id.to_string())
    .fetch_optional(&mut *connection)
    .await?;
    if exists.is_none() {
        return Err(Failure::NotFound);
    }
    let base = read_base(connection, actor_id, role, base_id).await?;
    if !base.can_manage {
        return Err(Failure::Forbidden);
    }
    Ok(base)
}

#[utoipa::path(put, path = "/api/v1/knowledge/bases/{id}", operation_id = "renameKnowledgeBase", tag = "Knowledge", request_body = RenameKnowledgeBase, params(("id" = String, Path), ("x-csrf-token" = String, Header)), responses((status = 200, body = KnowledgeBase), (status = 400, body = crate::http::ApiErrorResponse), (status = 401, body = crate::http::ApiErrorResponse), (status = 403, body = crate::http::ApiErrorResponse), (status = 404, body = crate::http::ApiErrorResponse), (status = 408, body = crate::http::ApiErrorResponse), (status = 413, body = crate::http::ApiErrorResponse), (status = 503, body = crate::http::ApiErrorResponse)))]
async fn rename_base(
    State(state): State<Knowledge>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiPath(base_id): ApiPath<String>,
    BoundedJson(input): BoundedJson<RenameKnowledgeBase>,
) -> Response {
    let actor = match identity::require_session(&state.pool, &state.auth, &headers, &id, true).await
    {
        Ok(session) => session.user,
        Err(response) => return response,
    };
    let Ok(base_id) = uuid::Uuid::parse_str(&base_id) else {
        return Failure::NotFound.response(id);
    };
    let name = match validated_name(&input.name) {
        Ok(name) => name,
        Err(error) => return error.response(id),
    };
    match tokio::time::timeout(
        std::time::Duration::from_secs(3),
        rename(&state.pool, &actor.id, base_id, name, &id.0),
    )
    .await
    {
        Ok(Ok(base)) => Json(base).into_response(),
        Ok(Err(error)) => error.response(id),
        Err(_) => Failure::Unavailable.response(id),
    }
}
async fn rename(
    pool: &sqlx::PgPool,
    actor_id: &str,
    base_id: uuid::Uuid,
    name: &str,
    request_id: &str,
) -> Result<KnowledgeBase, Failure> {
    let mut tx = pool.begin().await?;
    let role = organization::active_role_in(&mut tx, actor_id)
        .await?
        .ok_or(Failure::Forbidden)?;
    let mut base = lock_manage_base(&mut tx, actor_id, role, base_id).await?;
    if base.name != name {
        sqlx::query("UPDATE knowledge.knowledge_bases SET name = $1 WHERE id = $2::uuid")
            .bind(name)
            .bind(base_id.to_string())
            .execute(&mut *tx)
            .await?;
        audit::append(
            &mut tx,
            audit::Event {
                actor_id,
                action: "knowledge.base.rename",
                resource_type: "knowledge.base",
                resource_id: &base.id,
                source: audit::Source::Request(request_id),
                subject_user_id: None,
            },
        )
        .await?;
        base.name = name.to_owned();
    }
    tx.commit().await?;
    Ok(base)
}

fn validated_name(input: &str) -> Result<&str, Failure> {
    let name = input.trim();
    if name.is_empty() || name.chars().count() > 120 || name.contains('\0') {
        return Err(Failure::InvalidName);
    }
    Ok(name)
}
