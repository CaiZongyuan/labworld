use super::administration::{self, Error, JobDetails, JobInfo};
use crate::{
    http::{ApiPath, ApiQuery, RequestId},
    modules::identity,
};
use axum::{
    Extension, Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use labos_threejs_platform::config::AuthSettings;
use serde::Deserialize;
use sqlx::PgPool;
use utoipa::OpenApi;

#[derive(Clone)]
struct Administration {
    pool: PgPool,
    auth: AuthSettings,
}
pub fn router(pool: PgPool, auth: AuthSettings) -> Router {
    Router::new()
        .route("/api/v1/jobs", get(list_jobs))
        .route("/api/v1/jobs/{id}", get(get_job))
        .route("/api/v1/jobs/{id}/retry", post(retry_job))
        .with_state(Administration { pool, auth })
}
#[derive(OpenApi)]
#[openapi(
    paths(list_jobs, get_job, retry_job),
    components(schemas(administration::StatusFilter))
)]
struct JobsApi;
pub fn openapi() -> utoipa::openapi::OpenApi {
    JobsApi::openapi()
}

#[derive(Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in=Query)]
struct HistoryQuery {
    #[param(minimum = 1)]
    before_batch: Option<i32>,
}
#[utoipa::path(get,path="/api/v1/jobs/{id}",operation_id="getJob",tag="Jobs",params(("id"=String,Path),HistoryQuery),responses((status=200,body=JobDetails),(status=400,body=crate::http::ApiErrorResponse),(status=401,body=crate::http::ApiErrorResponse),(status=403,body=crate::http::ApiErrorResponse),(status=404,body=crate::http::ApiErrorResponse),(status=503,body=crate::http::ApiErrorResponse)))]
async fn get_job(
    State(state): State<Administration>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiPath(job): ApiPath<String>,
    ApiQuery(query): ApiQuery<HistoryQuery>,
) -> Response {
    let actor =
        match identity::require_session(&state.pool, &state.auth, &headers, &id, false).await {
            Ok(session) => session.user,
            Err(response) => return response,
        };
    let Ok(job) = uuid::Uuid::parse_str(&job) else {
        return Error::NotFound.response(id);
    };
    match tokio::time::timeout(
        std::time::Duration::from_secs(3),
        administration::details(&state.pool, &actor.id, &job.to_string(), query.before_batch),
    )
    .await
    {
        Ok(Ok(details)) => Json(details).into_response(),
        Ok(Err(error)) => error.response(id),
        Err(_) => Error::Unavailable.response(id),
    }
}
#[utoipa::path(post,path="/api/v1/jobs/{id}/retry",operation_id="retryJob",tag="Jobs",params(("id"=String,Path),("x-csrf-token"=String,Header),("idempotency-key"=String,Header)),responses((status=202,body=JobInfo),(status=400,body=crate::http::ApiErrorResponse),(status=401,body=crate::http::ApiErrorResponse),(status=403,body=crate::http::ApiErrorResponse),(status=404,body=crate::http::ApiErrorResponse),(status=409,body=crate::http::ApiErrorResponse),(status=503,body=crate::http::ApiErrorResponse)))]
async fn retry_job(
    State(state): State<Administration>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiPath(job): ApiPath<String>,
) -> Response {
    let actor = match identity::require_session(&state.pool, &state.auth, &headers, &id, true).await
    {
        Ok(session) => session.user,
        Err(response) => return response,
    };
    let Ok(job) = uuid::Uuid::parse_str(&job) else {
        return Error::NotFound.response(id);
    };
    let Some(key) = headers
        .get("idempotency-key")
        .and_then(|value| value.to_str().ok())
    else {
        return Error::InvalidKey.response(id);
    };
    match tokio::time::timeout(
        std::time::Duration::from_secs(3),
        administration::retry(&state.pool, &actor.id, &job.to_string(), key, &id.0),
    )
    .await
    {
        Ok(Ok(info)) => (StatusCode::ACCEPTED, Json(info)).into_response(),
        Ok(Err(error)) => error.response(id),
        Err(_) => Error::Unavailable.response(id),
    }
}

#[utoipa::path(get,path="/api/v1/jobs",operation_id="listJobs",tag="Jobs",params(administration::JobsQuery),responses((status=200,body=administration::JobPage),(status=400,body=crate::http::ApiErrorResponse),(status=401,body=crate::http::ApiErrorResponse),(status=403,body=crate::http::ApiErrorResponse),(status=503,body=crate::http::ApiErrorResponse)))]
async fn list_jobs(
    State(state): State<Administration>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiQuery(query): ApiQuery<administration::JobsQuery>,
) -> Response {
    let actor =
        match identity::require_session(&state.pool, &state.auth, &headers, &id, false).await {
            Ok(session) => session.user,
            Err(response) => return response,
        };
    match tokio::time::timeout(
        std::time::Duration::from_secs(3),
        administration::list(&state.pool, &actor.id, query),
    )
    .await
    {
        Ok(Ok(page)) => Json(page).into_response(),
        Ok(Err(error)) => error.response(id),
        Err(_) => Error::Unavailable.response(id),
    }
}
