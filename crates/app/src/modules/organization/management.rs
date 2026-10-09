use super::MemberRole;
use super::domain::{self, MembershipState, can_manage};
use crate::{
    http::{ApiPath, ApiQuery, BoundedJson, RequestId, public_error},
    modules::{audit, identity},
};
use axum::{
    Extension, Json, Router,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, put},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use labos_threejs_platform::config::AuthSettings;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use utoipa::{OpenApi, ToSchema};

#[derive(Clone)]
struct Organization {
    pool: PgPool,
    auth: AuthSettings,
}
#[derive(Serialize, ToSchema)]
struct Member {
    user_id: String,
    email: String,
    display_name: Option<String>,
    role: MemberRole,
    active: bool,
    version: i64,
    can_edit: bool,
}
#[derive(Serialize, ToSchema)]
struct MemberPage {
    data: Vec<Member>,
    next_cursor: Option<String>,
    has_more: bool,
    assignable_roles: Vec<MemberRole>,
}
#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
struct UpdateMember {
    role: MemberRole,
    active: bool,
    #[schema(minimum = 1)]
    version: i64,
}
#[derive(Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
struct MembersQuery {
    #[param(minimum = 1, maximum = 100, default = 50)]
    limit: Option<u32>,
    #[param(max_length = 512)]
    cursor: Option<String>,
}

enum Failure {
    Forbidden,
    LastOwner,
    NotFound,
    Conflict,
    InvalidVersion,
    InvalidPage,
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
            Self::Forbidden => (
                StatusCode::FORBIDDEN,
                "organization.forbidden",
                "This member change is not permitted",
            ),
            Self::LastOwner => (
                StatusCode::UNPROCESSABLE_ENTITY,
                "organization.last_owner",
                "Keep at least one active Owner",
            ),
            Self::NotFound => (
                StatusCode::NOT_FOUND,
                "organization.member_not_found",
                "Member not found",
            ),
            Self::InvalidVersion => (
                StatusCode::BAD_REQUEST,
                "organization.invalid_version",
                "Use a positive membership version",
            ),
            Self::Conflict => (
                StatusCode::CONFLICT,
                "organization.version_conflict",
                "Member changed; refresh before retrying",
            ),
            Self::InvalidPage => (
                StatusCode::BAD_REQUEST,
                "organization.invalid_page",
                "Use a valid cursor and a limit from 1 to 100",
            ),
            Self::Unavailable => (
                StatusCode::SERVICE_UNAVAILABLE,
                "organization.unavailable",
                "Member administration is temporarily unavailable",
            ),
        };
        public_error(status, code, message, id)
    }
}

pub fn router(pool: PgPool, auth: AuthSettings) -> Router {
    Router::new()
        .route("/api/v1/organization/members", get(list_members))
        .route("/api/v1/organization/members/{user_id}", put(update_member))
        .layer(DefaultBodyLimit::max(16 * 1024))
        .with_state(Organization { pool, auth })
}
#[derive(OpenApi)]
#[openapi(paths(list_members, update_member))]
struct OrganizationApi;
pub fn openapi() -> utoipa::openapi::OpenApi {
    OrganizationApi::openapi()
}

#[utoipa::path(get, path = "/api/v1/organization/members", operation_id = "listMembers", tag = "Organization", params(MembersQuery), responses((status = 200, body = MemberPage), (status = 400, body = crate::http::ApiErrorResponse), (status = 401, body = crate::http::ApiErrorResponse), (status = 403, body = crate::http::ApiErrorResponse), (status = 503, body = crate::http::ApiErrorResponse)))]
async fn list_members(
    State(state): State<Organization>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiQuery(query): ApiQuery<MembersQuery>,
) -> Response {
    let actor =
        match identity::require_session(&state.pool, &state.auth, &headers, &id, false).await {
            Ok(s) => s.user,
            Err(r) => return r,
        };
    match tokio::time::timeout(
        std::time::Duration::from_secs(3),
        list(&state.pool, &actor, query),
    )
    .await
    {
        Ok(Ok(page)) => Json(page).into_response(),
        Ok(Err(e)) => e.response(id),
        Err(_) => Failure::Unavailable.response(id),
    }
}

async fn list(
    pool: &PgPool,
    actor: &identity::CurrentUser,
    query: MembersQuery,
) -> Result<MemberPage, Failure> {
    if actor.role == MemberRole::Member {
        return Err(Failure::Forbidden);
    }
    let limit = query.limit.unwrap_or(50);
    if !(1..=100).contains(&limit) {
        return Err(Failure::InvalidPage);
    }
    let cursor = match query.cursor {
        Some(token) if token.len() <= 512 => {
            let bytes = URL_SAFE_NO_PAD
                .decode(token)
                .map_err(|_| Failure::InvalidPage)?;
            let (subject, last): (String, String) =
                serde_json::from_slice(&bytes).map_err(|_| Failure::InvalidPage)?;
            if subject != actor.id {
                return Err(Failure::InvalidPage);
            }
            Some(
                uuid::Uuid::parse_str(&last)
                    .map_err(|_| Failure::InvalidPage)?
                    .to_string(),
            )
        }
        Some(_) => return Err(Failure::InvalidPage),
        None => None,
    };
    let mut connection = pool.acquire().await?;
    let mut rows = sqlx::query_as::<_, (String, MemberRole, bool, i64)>("SELECT user_id::text, role, active, version FROM labos_threejs_core.memberships WHERE ($1::uuid IS NULL OR user_id > $1::uuid) ORDER BY user_id LIMIT $2")
        .bind(cursor).bind(i64::from(limit) + 1).fetch_all(&mut *connection).await?;
    let has_more = rows.len() > limit as usize;
    rows.truncate(limit as usize);
    let next_cursor = if has_more {
        rows.last().map(|row| {
            URL_SAFE_NO_PAD
                .encode(serde_json::to_vec(&(&actor.id, &row.0)).expect("strings serialize"))
        })
    } else {
        None
    };
    let ids: Vec<_> = rows.iter().map(|row| row.0.clone()).collect();
    let profiles = identity::profiles(&mut connection, &ids).await?;
    let mut data = Vec::with_capacity(rows.len());
    for (user_id, role, active, version) in rows {
        let profile = profiles
            .iter()
            .find(|p| p.id == user_id)
            .ok_or(Failure::Unavailable)?;
        data.push(Member {
            user_id,
            email: profile.email.clone(),
            display_name: profile.display_name.clone(),
            role,
            active,
            version,
            can_edit: can_manage(actor.role, role),
        });
    }
    let assignable_roles = if actor.role == MemberRole::Owner {
        vec![MemberRole::Owner, MemberRole::Admin, MemberRole::Member]
    } else {
        vec![MemberRole::Admin, MemberRole::Member]
    };
    Ok(MemberPage {
        data,
        next_cursor,
        has_more,
        assignable_roles,
    })
}

#[utoipa::path(put, path = "/api/v1/organization/members/{user_id}", operation_id = "updateMember", tag = "Organization", request_body = UpdateMember, params(("user_id" = String, Path), ("x-csrf-token" = String, Header)), responses((status = 200, body = Member), (status = 400, body = crate::http::ApiErrorResponse), (status = 401, body = crate::http::ApiErrorResponse), (status = 403, body = crate::http::ApiErrorResponse), (status = 404, body = crate::http::ApiErrorResponse), (status = 409, body = crate::http::ApiErrorResponse), (status = 408, body = crate::http::ApiErrorResponse), (status = 413, body = crate::http::ApiErrorResponse), (status = 422, body = crate::http::ApiErrorResponse), (status = 503, body = crate::http::ApiErrorResponse)))]
async fn update_member(
    State(state): State<Organization>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiPath(user_id): ApiPath<String>,
    BoundedJson(input): BoundedJson<UpdateMember>,
) -> Response {
    let actor = match identity::require_session(&state.pool, &state.auth, &headers, &id, true).await
    {
        Ok(s) => s.user,
        Err(r) => return r,
    };
    if input.version < 1 {
        return Failure::InvalidVersion.response(id);
    }
    let Ok(target) = uuid::Uuid::parse_str(&user_id) else {
        return Failure::NotFound.response(id);
    };
    match tokio::time::timeout(
        std::time::Duration::from_secs(3),
        update(&state.pool, &actor.id, &target.to_string(), input, &id.0),
    )
    .await
    {
        Ok(Ok(member)) => Json(member).into_response(),
        Ok(Err(e)) => e.response(id),
        Err(_) => Failure::Unavailable.response(id),
    }
}

async fn update(
    pool: &PgPool,
    actor_id: &str,
    target: &str,
    input: UpdateMember,
    request_id: &str,
) -> Result<Member, Failure> {
    let mut tx = pool.begin().await?;
    sqlx::query("SELECT id FROM labos_threejs_core.organizations WHERE id = 1 FOR UPDATE")
        .execute(&mut *tx)
        .await?;
    let rows = sqlx::query_as::<_, (String, MemberRole, bool, i64)>("SELECT user_id::text, role, active, version FROM labos_threejs_core.memberships WHERE user_id IN ($1::uuid, $2::uuid) ORDER BY user_id FOR UPDATE")
        .bind(actor_id).bind(target).fetch_all(&mut *tx).await?;
    let actor = rows
        .iter()
        .find(|r| r.0 == actor_id && r.2)
        .ok_or(Failure::Forbidden)?;
    let current = rows
        .iter()
        .find(|r| r.0 == target)
        .ok_or(Failure::NotFound)?;
    if !can_manage(actor.1, current.1) || !can_manage(actor.1, input.role) {
        return Err(Failure::Forbidden);
    }
    if current.3 != input.version {
        return Err(Failure::Conflict);
    }
    let active_owners: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM labos_threejs_core.memberships WHERE active AND role = 'owner'",
    )
    .fetch_one(&mut *tx)
    .await?;
    domain::validate_change(
        actor.1,
        MembershipState {
            role: current.1,
            active: current.2,
        },
        MembershipState {
            role: input.role,
            active: input.active,
        },
        active_owners as u64,
    )
    .map_err(|error| match error {
        domain::ChangeError::Forbidden => Failure::Forbidden,
        domain::ChangeError::LastOwner => Failure::LastOwner,
    })?;
    let version: i64 = sqlx::query_scalar("UPDATE labos_threejs_core.memberships SET role = $1, active = $2, version = version + 1 WHERE user_id = $3::uuid RETURNING version")
        .bind(input.role).bind(input.active).bind(target).fetch_one(&mut *tx).await?;
    if !input.active {
        identity::revoke_user_sessions(&mut tx, target).await?;
        identity::revoke_password_resets(&mut tx, target).await?;
    }
    audit::append(
        &mut tx,
        audit::Event {
            actor_id,
            action: "organization.member.update",
            resource_type: "organization.member",
            resource_id: target,
            source: audit::Source::Request(request_id),
            subject_user_id: None,
        },
    )
    .await?;
    let profile = identity::profiles(&mut tx, &[target.to_owned()])
        .await?
        .pop()
        .ok_or(Failure::NotFound)?;
    let member = Member {
        user_id: profile.id,
        email: profile.email,
        display_name: profile.display_name,
        role: input.role,
        active: input.active,
        version,
        can_edit: can_manage(actor.1, input.role),
    };
    tx.commit().await?;
    Ok(member)
}
