use super::{
    Failure, Knowledge,
    bases::{self, PageQuery},
};
use crate::{
    http::{ApiPath, ApiQuery, BoundedJson, RequestId},
    modules::{audit, identity, organization},
};
use axum::{
    Extension, Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, put},
};
use serde::{Deserialize, Serialize};
use utoipa::{OpenApi, ToSchema};

#[derive(Clone, Copy, Serialize, Deserialize, ToSchema, sqlx::Type)]
#[serde(rename_all = "lowercase")]
#[sqlx(type_name = "text", rename_all = "lowercase")]
pub(super) enum GrantAccess {
    Reader,
    Editor,
}
#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
struct SetGrant {
    access: GrantAccess,
}
#[derive(Serialize, ToSchema, sqlx::FromRow)]
struct GrantAssignment {
    user_id: String,
    access: GrantAccess,
}
#[derive(Serialize, ToSchema)]
struct KnowledgeBaseGrant {
    user_id: String,
    email: String,
    display_name: Option<String>,
    access: GrantAccess,
}
#[derive(Serialize, ToSchema)]
struct GrantPage {
    data: Vec<KnowledgeBaseGrant>,
    next_cursor: Option<String>,
    has_more: bool,
}

pub(super) fn routes() -> Router<Knowledge> {
    Router::new()
        .route("/api/v1/knowledge/bases/{id}/grants", get(list_grants))
        .route(
            "/api/v1/knowledge/bases/{id}/grants/{user_id}",
            put(set_grant).delete(revoke_grant),
        )
}
#[derive(OpenApi)]
#[openapi(paths(list_grants, set_grant, revoke_grant))]
struct GrantsApi;
pub(super) fn openapi() -> utoipa::openapi::OpenApi {
    GrantsApi::openapi()
}

#[utoipa::path(get, path = "/api/v1/knowledge/bases/{id}/grants", operation_id = "listKnowledgeBaseGrants", tag = "Knowledge", params(("id" = String, Path), PageQuery), responses((status = 200, body = GrantPage), (status = 400, body = crate::http::ApiErrorResponse), (status = 401, body = crate::http::ApiErrorResponse), (status = 403, body = crate::http::ApiErrorResponse), (status = 404, body = crate::http::ApiErrorResponse), (status = 503, body = crate::http::ApiErrorResponse)))]
async fn list_grants(
    State(state): State<Knowledge>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiPath(base_id): ApiPath<String>,
    ApiQuery(query): ApiQuery<PageQuery>,
) -> Response {
    let actor =
        match identity::require_session(&state.pool, &state.auth, &headers, &id, false).await {
            Ok(session) => session.user,
            Err(response) => return response,
        };
    let Ok(base_id) = uuid::Uuid::parse_str(&base_id) else {
        return Failure::NotFound.response(id);
    };
    match tokio::time::timeout(
        std::time::Duration::from_secs(3),
        list(&state.pool, &actor, base_id, query),
    )
    .await
    {
        Ok(Ok(page)) => Json(page).into_response(),
        Ok(Err(error)) => error.response(id),
        Err(_) => Failure::Unavailable.response(id),
    }
}

#[utoipa::path(put, path = "/api/v1/knowledge/bases/{id}/grants/{user_id}", operation_id = "setKnowledgeBaseGrant", tag = "Knowledge", request_body = SetGrant, params(("id" = String, Path), ("user_id" = String, Path), ("x-csrf-token" = String, Header)), responses((status = 200, body = GrantAssignment), (status = 400, body = crate::http::ApiErrorResponse), (status = 401, body = crate::http::ApiErrorResponse), (status = 403, body = crate::http::ApiErrorResponse), (status = 404, body = crate::http::ApiErrorResponse), (status = 408, body = crate::http::ApiErrorResponse), (status = 413, body = crate::http::ApiErrorResponse), (status = 503, body = crate::http::ApiErrorResponse)))]
async fn set_grant(
    State(state): State<Knowledge>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiPath((base, user_id)): ApiPath<(String, String)>,
    BoundedJson(input): BoundedJson<SetGrant>,
) -> Response {
    let actor = match identity::require_session(&state.pool, &state.auth, &headers, &id, true).await
    {
        Ok(session) => session.user,
        Err(response) => return response,
    };
    let (Ok(base), Ok(target)) = (
        uuid::Uuid::parse_str(&base),
        uuid::Uuid::parse_str(&user_id),
    ) else {
        return Failure::NotFound.response(id);
    };
    match tokio::time::timeout(
        std::time::Duration::from_secs(3),
        change(
            &state.pool,
            &actor.id,
            base,
            target,
            Some(input.access),
            &id.0,
        ),
    )
    .await
    {
        Ok(Ok(())) => Json(GrantAssignment {
            user_id: target.to_string(),
            access: input.access,
        })
        .into_response(),
        Ok(Err(error)) => error.response(id),
        Err(_) => Failure::Unavailable.response(id),
    }
}

#[utoipa::path(delete, path = "/api/v1/knowledge/bases/{id}/grants/{user_id}", operation_id = "revokeKnowledgeBaseGrant", tag = "Knowledge", params(("id" = String, Path), ("user_id" = String, Path), ("x-csrf-token" = String, Header)), responses((status = 204), (status = 400, body = crate::http::ApiErrorResponse), (status = 401, body = crate::http::ApiErrorResponse), (status = 403, body = crate::http::ApiErrorResponse), (status = 404, body = crate::http::ApiErrorResponse), (status = 503, body = crate::http::ApiErrorResponse)))]
async fn revoke_grant(
    State(state): State<Knowledge>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiPath((base, user_id)): ApiPath<(String, String)>,
) -> Response {
    let actor = match identity::require_session(&state.pool, &state.auth, &headers, &id, true).await
    {
        Ok(session) => session.user,
        Err(response) => return response,
    };
    let (Ok(base), Ok(target)) = (
        uuid::Uuid::parse_str(&base),
        uuid::Uuid::parse_str(&user_id),
    ) else {
        return Failure::NotFound.response(id);
    };
    match tokio::time::timeout(
        std::time::Duration::from_secs(3),
        change(&state.pool, &actor.id, base, target, None, &id.0),
    )
    .await
    {
        Ok(Ok(())) => StatusCode::NO_CONTENT.into_response(),
        Ok(Err(error)) => error.response(id),
        Err(_) => Failure::Unavailable.response(id),
    }
}

async fn change(
    pool: &sqlx::PgPool,
    actor_id: &str,
    base_id: uuid::Uuid,
    target: uuid::Uuid,
    access: Option<GrantAccess>,
    request_id: &str,
) -> Result<(), Failure> {
    let mut tx = pool.begin().await?;
    let memberships =
        organization::lock_memberships(&mut tx, &[actor_id.to_owned(), target.to_string()]).await?;
    let actor = memberships
        .iter()
        .find(|m| m.user_id == actor_id && m.active)
        .ok_or(Failure::Forbidden)?;
    bases::lock_manage_base(&mut tx, actor_id, actor.role, base_id).await?;
    if !memberships
        .iter()
        .any(|m| m.user_id == target.to_string() && (access.is_none() || m.active))
    {
        return Err(Failure::NotFound);
    }
    let result = if let Some(access) = access {
        sqlx::query("INSERT INTO knowledge.grants AS previous (knowledge_base_id, user_id, access) VALUES ($1::uuid, $2::uuid, $3) ON CONFLICT (knowledge_base_id, user_id) DO UPDATE SET access = excluded.access WHERE previous.access <> excluded.access")
            .bind(base_id.to_string()).bind(target.to_string()).bind(access).execute(&mut *tx).await?
    } else {
        sqlx::query("DELETE FROM knowledge.grants WHERE knowledge_base_id = $1::uuid AND user_id = $2::uuid")
            .bind(base_id.to_string()).bind(target.to_string()).execute(&mut *tx).await?
    };
    if result.rows_affected() > 0 {
        audit::append(
            &mut tx,
            audit::Event {
                actor_id,
                action: if access.is_some() {
                    "knowledge.grant.assign"
                } else {
                    "knowledge.grant.revoke"
                },
                resource_type: "knowledge.grant",
                resource_id: &base_id.to_string(),
                source: audit::Source::Request(request_id),
                subject_user_id: Some(&target.to_string()),
            },
        )
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

async fn list(
    pool: &sqlx::PgPool,
    actor: &identity::CurrentUser,
    base_id: uuid::Uuid,
    query: PageQuery,
) -> Result<GrantPage, Failure> {
    let mut connection = pool.acquire().await?;
    let base = bases::read_base(&mut connection, &actor.id, actor.role, base_id).await?;
    if !base.can_manage {
        return Err(Failure::Forbidden);
    }
    let scope = format!("base-grants:{}:user-id-asc", base.id);
    let (limit, cursor) = query.decode(&actor.id, &scope)?;
    let mut grants = sqlx::query_as::<_, GrantAssignment>("SELECT user_id::text, access FROM knowledge.grants WHERE knowledge_base_id = $1::uuid AND ($2::uuid IS NULL OR user_id > $2::uuid) ORDER BY user_id LIMIT $3")
            .bind(&base.id).bind(cursor).bind(i64::from(limit) + 1).fetch_all(&mut *connection).await?;
    let has_more = grants.len() > limit as usize;
    grants.truncate(limit as usize);
    let next_cursor = if has_more {
        grants
            .last()
            .map(|last| bases::next_cursor(&actor.id, &scope, &last.user_id))
            .transpose()?
    } else {
        None
    };
    let ids: Vec<_> = grants.iter().map(|grant| grant.user_id.clone()).collect();
    let profiles = identity::profiles(&mut connection, &ids).await?;
    let mut data = Vec::with_capacity(grants.len());
    for grant in grants {
        let profile = profiles
            .iter()
            .find(|p| p.id == grant.user_id)
            .ok_or(Failure::Unavailable)?;
        data.push(KnowledgeBaseGrant {
            user_id: grant.user_id,
            email: profile.email.clone(),
            display_name: profile.display_name.clone(),
            access: grant.access,
        });
    }
    Ok::<_, Failure>(GrantPage {
        data,
        next_cursor,
        has_more,
    })
}
