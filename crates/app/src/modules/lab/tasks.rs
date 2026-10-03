use super::{Failure, Lab, world};
use crate::http::{ApiPath, RequestId};
use axum::{
    Extension, Json, Router,
    extract::State,
    http::HeaderMap,
    response::{IntoResponse, Response},
    routing::get,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::PgConnection;
use utoipa::{OpenApi, ToSchema};

#[derive(Clone, Serialize, Deserialize, ToSchema, sqlx::FromRow)]
pub struct DeviceTask {
    pub id: String,
    pub entity_id: String,
    pub run_id: String,
    pub command_id: String,
    pub result_id: String,
    pub parameters: Value,
    pub status: String,
    pub elapsed_seconds: f64,
    pub timer_started_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub ended_at: Option<DateTime<Utc>>,
}
impl DeviceTask {
    pub(super) fn active(&self) -> bool {
        matches!(
            self.status.as_str(),
            "pending" | "preparing" | "running" | "decelerating"
        )
    }
}
#[derive(Clone, Serialize, Deserialize, ToSchema, sqlx::FromRow)]
pub struct DeviceTaskResult {
    pub id: String,
    pub task_id: String,
    pub status: String,
    pub reason: Option<String>,
    pub ended_at: Option<DateTime<Utc>>,
}
pub(super) fn valid_parameters(parameters: &Value) -> bool {
    parameters.as_object().is_some_and(|parameters| {
        parameters.len() == 3
            && parameters
                .get("rpm")
                .and_then(Value::as_u64)
                .is_some_and(|value| (500..=15000).contains(&value))
            && parameters
                .get("temperature")
                .and_then(Value::as_f64)
                .is_some_and(|value| (-10.0..=40.0).contains(&value))
            && parameters
                .get("duration_seconds")
                .and_then(Value::as_u64)
                .is_some_and(|value| (6..=3600).contains(&value))
    })
}
pub(super) async fn reserve(
    connection: &mut PgConnection,
    entity: &str,
    run: &str,
    command: &str,
    parameters: &Value,
) -> Result<String, Failure> {
    let task = uuid::Uuid::now_v7().to_string();
    let result = uuid::Uuid::now_v7().to_string();
    sqlx::query("INSERT INTO lab.device_tasks(id,entity_id,run_id,command_id,result_id,parameters,status) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::uuid,$6,'pending')")
        .bind(&task).bind(entity).bind(run).bind(command).bind(&result).bind(parameters).execute(&mut *connection).await?;
    sqlx::query("INSERT INTO lab.device_task_results(id,task_id,status) VALUES($1::uuid,$2::uuid,'pending')").bind(result).bind(&task).execute(connection).await?;
    Ok(task)
}
pub(super) fn routes() -> Router<Lab> {
    Router::new()
        .route(
            "/api/v1/lab/labs/{lab_id}/entities/{entity_id}/tasks/{task_id}",
            get(get_task),
        )
        .route(
            "/api/v1/lab/labs/{lab_id}/entities/{entity_id}/results/{result_id}",
            get(get_result),
        )
        .route(
            "/api/v1/lab/labs/{lab_id}/entities/{entity_id}/runs/{run_id}",
            get(get_run),
        )
}
#[derive(OpenApi)]
#[openapi(paths(get_task, get_result, get_run))]
struct TaskApi;
pub(super) fn openapi() -> utoipa::openapi::OpenApi {
    TaskApi::openapi()
}

#[utoipa::path(get,path="/api/v1/lab/labs/{lab_id}/entities/{entity_id}/tasks/{task_id}",operation_id="getLabDeviceTask",tag="Lab",params(("lab_id"=String,Path),("entity_id"=String,Path),("task_id"=String,Path)),responses((status=200,body=DeviceTask),(status=400,body=crate::http::ApiErrorResponse),(status=401,body=crate::http::ApiErrorResponse),(status=403,body=crate::http::ApiErrorResponse),(status=404,body=crate::http::ApiErrorResponse),(status=503,body=crate::http::ApiErrorResponse)))]
async fn get_task(
    State(state): State<Lab>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiPath((lab, entity, task)): ApiPath<(String, String, String)>,
) -> Response {
    if let Err(response) = state.actor(&headers, &id, false).await {
        return response;
    }
    let result=async {
        world::uuid(&lab)?; world::uuid(&entity)?;
        world::uuid(&task)?; let mut connection=state.pool.acquire().await?;
        world::load_entity(&mut connection,&lab,&entity).await?;
        sqlx::query_as::<_,DeviceTask>("SELECT id::text,entity_id::text,run_id::text,command_id::text,result_id::text,parameters,status,elapsed_seconds,timer_started_at,created_at,ended_at FROM lab.device_tasks WHERE entity_id=$1::uuid AND id=$2::uuid")
            .bind(&entity).bind(task).fetch_optional(&mut *connection).await?.ok_or(Failure::WorldNotFound)
    }.await;
    match result {
        Ok(value) => Json(value).into_response(),
        Err(error) => error.response(id),
    }
}
#[utoipa::path(get,path="/api/v1/lab/labs/{lab_id}/entities/{entity_id}/results/{result_id}",operation_id="getLabDeviceTaskResult",tag="Lab",params(("lab_id"=String,Path),("entity_id"=String,Path),("result_id"=String,Path)),responses((status=200,body=DeviceTaskResult),(status=400,body=crate::http::ApiErrorResponse),(status=401,body=crate::http::ApiErrorResponse),(status=403,body=crate::http::ApiErrorResponse),(status=404,body=crate::http::ApiErrorResponse),(status=503,body=crate::http::ApiErrorResponse)))]
async fn get_result(
    State(state): State<Lab>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiPath((lab, entity, result)): ApiPath<(String, String, String)>,
) -> Response {
    if let Err(response) = state.actor(&headers, &id, false).await {
        return response;
    }
    let value=async {
        world::uuid(&lab)?; world::uuid(&entity)?;
        world::uuid(&result)?; let mut connection=state.pool.acquire().await?;
        world::load_entity(&mut connection,&lab,&entity).await?;
        sqlx::query_as::<_,DeviceTaskResult>("SELECT r.id::text,r.task_id::text,r.status,r.reason,r.ended_at FROM lab.device_task_results r JOIN lab.device_tasks t ON t.result_id=r.id WHERE t.entity_id=$1::uuid AND r.id=$2::uuid")
            .bind(entity).bind(result).fetch_optional(&mut *connection).await?.ok_or(Failure::WorldNotFound)
    }.await;
    match value {
        Ok(value) => Json(value).into_response(),
        Err(error) => error.response(id),
    }
}
#[utoipa::path(get,path="/api/v1/lab/labs/{lab_id}/entities/{entity_id}/runs/{run_id}",operation_id="getLabDeviceProgramRun",tag="Lab",params(("lab_id"=String,Path),("entity_id"=String,Path),("run_id"=String,Path)),responses((status=200,body=super::devices::DeviceProgramRun),(status=400,body=crate::http::ApiErrorResponse),(status=401,body=crate::http::ApiErrorResponse),(status=403,body=crate::http::ApiErrorResponse),(status=404,body=crate::http::ApiErrorResponse),(status=503,body=crate::http::ApiErrorResponse)))]
async fn get_run(
    State(state): State<Lab>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiPath((lab, entity, run)): ApiPath<(String, String, String)>,
) -> Response {
    if let Err(response) = state.actor(&headers, &id, false).await {
        return response;
    }
    let value=async {
        world::uuid(&lab)?; world::uuid(&entity)?;
        world::uuid(&run)?; let mut connection=state.pool.acquire().await?;
        world::load_entity(&mut connection,&lab,&entity).await?;
        sqlx::query_as::<_,super::devices::DeviceProgramRun>("SELECT id::text,entity_id::text,binding_id::text,configuration,status,started_by::text,started_at,ended_at FROM lab.program_runs WHERE entity_id=$1::uuid AND id=$2::uuid")
            .bind(entity).bind(run).fetch_optional(&mut *connection).await?.ok_or(Failure::WorldNotFound)
    }.await;
    match value {
        Ok(value) => Json(value).into_response(),
        Err(error) => error.response(id),
    }
}
