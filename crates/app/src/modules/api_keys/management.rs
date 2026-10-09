use super::{COLUMNS, KeyInfo, KeyScope, SECRET_PREFIX};
use crate::{
    http::{ApiPath, ApiQuery, BoundedJson, RequestId, public_error},
    modules::{audit, identity, organization},
};
use axum::{
    Extension, Json, Router,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::get,
};
use labos_threejs_platform::config::AuthSettings;
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use std::sync::Arc;
use utoipa::{OpenApi, ToSchema};

#[derive(Clone)]
struct Keys {
    pool: PgPool,
    auth: AuthSettings,
    scopes: Arc<Vec<KeyScope>>,
}
pub fn router(pool: PgPool, auth: AuthSettings, scopes: Vec<KeyScope>) -> Router {
    Router::new()
        .route("/api/v1/api-keys", get(list_api_keys).post(create_api_key))
        .route(
            "/api/v1/api-keys/{id}",
            axum::routing::delete(revoke_api_key),
        )
        .route("/api/v1/profile", get(get_profile))
        .route("/api/v1/api-keys/scopes", get(list_key_scopes))
        .layer(DefaultBodyLimit::max(16 * 1024))
        .with_state(Keys {
            pool,
            auth,
            scopes: Arc::new(scopes),
        })
}
#[derive(OpenApi)]
#[openapi(paths(
    create_api_key,
    list_api_keys,
    revoke_api_key,
    get_profile,
    list_key_scopes
))]
struct KeysApi;
pub fn openapi() -> utoipa::openapi::OpenApi {
    KeysApi::openapi()
}
#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
struct CreateApiKey {
    #[schema(min_length = 1, max_length = 100)]
    name: String,
    #[schema(min_items = 1, max_items = 16)]
    scopes: Vec<String>,
    #[schema(minimum = 1, maximum = 365)]
    expires_in_days: u32,
}
#[derive(Serialize, ToSchema)]
struct CreatedApiKey {
    key: KeyInfo,
    secret: String,
}
#[derive(Serialize, ToSchema)]
struct ApiKeyPage {
    data: Vec<KeyInfo>,
    next_cursor: Option<String>,
    has_more: bool,
}
fn unavailable(id: RequestId) -> Response {
    public_error(
        StatusCode::SERVICE_UNAVAILABLE,
        "api_keys.unavailable",
        "API keys are temporarily unavailable",
        id,
    )
}
#[utoipa::path(post,path="/api/v1/api-keys",operation_id="createApiKey",tag="API Keys",request_body=CreateApiKey,params(("x-csrf-token"=String,Header)),responses((status=201,body=CreatedApiKey),(status=400,body=crate::http::ApiErrorResponse),(status=401,body=crate::http::ApiErrorResponse),(status=403,body=crate::http::ApiErrorResponse),(status=503,body=crate::http::ApiErrorResponse)))]
async fn create_api_key(
    State(state): State<Keys>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    BoundedJson(mut input): BoundedJson<CreateApiKey>,
) -> Response {
    let actor = match identity::require_session(&state.pool, &state.auth, &headers, &id, true).await
    {
        Ok(session) => session.user,
        Err(response) => return response,
    };
    input.name = input.name.trim().to_owned();
    input.scopes.sort();
    input.scopes.dedup();
    if input.name.is_empty()
        || input.name.chars().count() > 100
        || input.name.contains('\0')
        || !(1..=365).contains(&input.expires_in_days)
        || input.scopes.is_empty()
        || input.scopes.len() > 16
        || input
            .scopes
            .iter()
            .any(|id| !state.scopes.iter().any(|scope| &scope.id == id))
    {
        return public_error(
            StatusCode::BAD_REQUEST,
            "api_keys.invalid_input",
            "Choose a name, supported scopes and an expiry of 1 to 365 days",
            id,
        );
    }
    let Ok(random) = crate::secrets::secret() else {
        return unavailable(id);
    };
    let secret = format!("{SECRET_PREFIX}{random}");
    let prefix = format!("{SECRET_PREFIX}{}", &random[..8]);
    let hash = crate::secrets::secret_hash(&secret);
    let result = tokio::time::timeout(std::time::Duration::from_secs(3), async {
        let mut tx = state.pool.begin().await?;
        if organization::active_role_in(&mut tx, &actor.id).await?.is_none() || identity::background_credential(&mut tx, &state.auth, &headers, &actor.id).await?.is_none() {return Ok(None);}
        let key: KeyInfo = sqlx::query_as(&format!("INSERT INTO labos_threejs_core.api_keys (id, user_id, name, prefix, secret_hash, scopes, expires_at) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, clock_timestamp() + make_interval(days => $7)) RETURNING {COLUMNS}"))
            .bind(uuid::Uuid::now_v7().to_string()).bind(&actor.id).bind(input.name).bind(prefix).bind(hash).bind(input.scopes).bind(input.expires_in_days as i32).fetch_one(&mut *tx).await?;
        audit::append(&mut tx, audit::Event { actor_id: &actor.id, action: "api_keys.create", resource_type: "api_keys.key", resource_id: &key.id, source: audit::Source::Request(&id.0), subject_user_id: None }).await?;
        tx.commit().await?;
        Ok::<_, sqlx::Error>(Some(key))
    }).await;
    match result {
        Ok(Ok(Some(key))) => {
            (StatusCode::CREATED, Json(CreatedApiKey { key, secret })).into_response()
        }
        Ok(Ok(None)) => public_error(
            StatusCode::UNAUTHORIZED,
            "auth.unauthorized",
            "Sign in to continue",
            id,
        ),
        _ => unavailable(id),
    }
}
#[derive(Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in=Query)]
struct KeysQuery {
    #[param(minimum = 1, maximum = 100, default = 50)]
    limit: Option<u32>,
    #[param(max_length = 512)]
    cursor: Option<String>,
}
#[utoipa::path(get,path="/api/v1/api-keys",operation_id="listApiKeys",tag="API Keys",params(KeysQuery),responses((status=200,body=ApiKeyPage),(status=400,body=crate::http::ApiErrorResponse),(status=401,body=crate::http::ApiErrorResponse),(status=503,body=crate::http::ApiErrorResponse)))]
async fn list_api_keys(
    State(state): State<Keys>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiQuery(query): ApiQuery<KeysQuery>,
) -> Response {
    use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
    let actor =
        match identity::require_session(&state.pool, &state.auth, &headers, &id, false).await {
            Ok(session) => session.user,
            Err(response) => return response,
        };
    let invalid = || {
        public_error(
            StatusCode::BAD_REQUEST,
            "api_keys.invalid_page",
            "Use a valid key list cursor and page size",
            id.clone(),
        )
    };
    let limit = query.limit.unwrap_or(50);
    if !(1..=100).contains(&limit) {
        return invalid();
    }
    let cursor = if let Some(cursor) = query.cursor {
        let parsed = (|| {
            if cursor.len() > 512 {
                return None;
            }
            let bytes = URL_SAFE_NO_PAD.decode(cursor).ok()?;
            let (subject, key_id): (String, String) = serde_json::from_slice(&bytes).ok()?;
            if subject != actor.id {
                return None;
            }
            Some(uuid::Uuid::parse_str(&key_id).ok()?.to_string())
        })();
        let Some(cursor) = parsed else {
            return invalid();
        };
        Some(cursor)
    } else {
        None
    };
    let result = tokio::time::timeout(std::time::Duration::from_secs(3), sqlx::query_as::<_,KeyInfo>(&format!("SELECT {COLUMNS} FROM labos_threejs_core.api_keys WHERE user_id = $1::uuid AND ($2::uuid IS NULL OR id < $2::uuid) ORDER BY id DESC LIMIT $3")).bind(&actor.id).bind(cursor).bind(i64::from(limit)+1).fetch_all(&state.pool)).await;
    let Ok(Ok(mut data)) = result else {
        return unavailable(id);
    };
    let has_more = data.len() > limit as usize;
    data.truncate(limit as usize);
    let next_cursor = if has_more {
        match data
            .last()
            .map(|key| {
                serde_json::to_vec(&(&actor.id, &key.id)).map(|bytes| URL_SAFE_NO_PAD.encode(bytes))
            })
            .transpose()
        {
            Ok(cursor) => cursor,
            Err(_) => return unavailable(id),
        }
    } else {
        None
    };
    Json(ApiKeyPage {
        data,
        next_cursor,
        has_more,
    })
    .into_response()
}
#[derive(Serialize, ToSchema)]
struct KeyScopeList {
    data: Vec<KeyScope>,
}
#[utoipa::path(get,path="/api/v1/api-keys/scopes",operation_id="listApiKeyScopes",tag="API Keys",responses((status=200,body=KeyScopeList),(status=401,body=crate::http::ApiErrorResponse),(status=503,body=crate::http::ApiErrorResponse)))]
async fn list_key_scopes(
    State(state): State<Keys>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) =
        identity::require_session(&state.pool, &state.auth, &headers, &id, false).await
    {
        return response;
    }
    Json(KeyScopeList {
        data: state.scopes.as_ref().clone(),
    })
    .into_response()
}

#[utoipa::path(get,path="/api/v1/profile",operation_id="getProfile",tag="Identity",params(("authorization"=Option<String>,Header,description="Bearer API key with profile:read, or use a browser Session")),responses((status=200,body=identity::CurrentUser),(status=401,body=crate::http::ApiErrorResponse),(status=403,body=crate::http::ApiErrorResponse),(status=503,body=crate::http::ApiErrorResponse)))]
async fn get_profile(
    State(state): State<Keys>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
) -> Response {
    match super::require_read(&state.pool, &state.auth, &headers, &id, "profile:read").await {
        Ok(actor) => Json(actor.user).into_response(),
        Err(response) => response,
    }
}
#[utoipa::path(delete,path="/api/v1/api-keys/{id}",operation_id="revokeApiKey",tag="API Keys",params(("id"=String,Path),("x-csrf-token"=String,Header)),responses((status=204),(status=401,body=crate::http::ApiErrorResponse),(status=403,body=crate::http::ApiErrorResponse),(status=404,body=crate::http::ApiErrorResponse),(status=503,body=crate::http::ApiErrorResponse)))]
async fn revoke_api_key(
    State(state): State<Keys>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiPath(key_id): ApiPath<String>,
) -> Response {
    let actor = match identity::require_session(&state.pool, &state.auth, &headers, &id, true).await
    {
        Ok(session) => session.user,
        Err(response) => return response,
    };
    let Ok(key_id) = uuid::Uuid::parse_str(&key_id) else {
        return public_error(
            StatusCode::NOT_FOUND,
            "api_keys.not_found",
            "API key not found",
            id,
        );
    };
    let result = tokio::time::timeout(std::time::Duration::from_secs(3), async {
        let mut tx = state.pool.begin().await?;
        if organization::active_role_in(&mut tx, &actor.id).await?.is_none() || identity::background_credential(&mut tx, &state.auth, &headers, &actor.id).await?.is_none() {return Ok(StatusCode::UNAUTHORIZED);}
        let current: Option<bool> = sqlx::query_scalar("SELECT revoked_at IS NOT NULL FROM labos_threejs_core.api_keys WHERE id = $1::uuid AND user_id = $2::uuid FOR UPDATE").bind(key_id.to_string()).bind(&actor.id).fetch_optional(&mut *tx).await?;
        let Some(revoked) = current else {return Ok(StatusCode::NOT_FOUND);};
        if !revoked {
            sqlx::query("UPDATE labos_threejs_core.api_keys SET revoked_at = clock_timestamp() WHERE id = $1::uuid").bind(key_id.to_string()).execute(&mut *tx).await?;
            audit::append(&mut tx, audit::Event {actor_id: &actor.id, action:"api_keys.revoke", resource_type:"api_keys.key", resource_id:&key_id.to_string(), source: audit::Source::Request(&id.0), subject_user_id: None}).await?;
        }
        tx.commit().await?;
        Ok::<_,sqlx::Error>(StatusCode::NO_CONTENT)
    }).await;
    match result {
        Ok(Ok(StatusCode::NO_CONTENT)) => StatusCode::NO_CONTENT.into_response(),
        Ok(Ok(StatusCode::NOT_FOUND)) => public_error(
            StatusCode::NOT_FOUND,
            "api_keys.not_found",
            "API key not found",
            id,
        ),
        Ok(Ok(StatusCode::UNAUTHORIZED)) => public_error(
            StatusCode::UNAUTHORIZED,
            "auth.unauthorized",
            "Sign in to continue",
            id,
        ),
        _ => unavailable(id),
    }
}
