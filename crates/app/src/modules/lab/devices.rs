use super::{
    Failure, Lab,
    world::{self, EntityAction, LabEntity},
};
use crate::{
    http::{ApiPath, RequestId},
    modules::audit,
};
use axum::{
    Extension, Json, Router,
    extract::{DefaultBodyLimit, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::PgConnection;
use utoipa::{OpenApi, ToSchema};

#[derive(Clone, Serialize, Deserialize, ToSchema, sqlx::FromRow)]
pub struct RuntimeBinding {
    pub id: String,
    pub entity_id: String,
    pub program_id: String,
    pub source: String,
}
#[derive(Clone, Serialize, Deserialize, ToSchema, sqlx::FromRow)]
pub struct DeviceProgramRun {
    pub id: String,
    pub entity_id: String,
    pub binding_id: String,
    pub configuration: Value,
    pub status: String,
    pub started_by: String,
    pub started_at: DateTime<Utc>,
    pub ended_at: Option<DateTime<Utc>>,
}
#[derive(Clone, Serialize, Deserialize, ToSchema, sqlx::FromRow)]
pub struct DeviceCommand {
    pub id: String,
    pub entity_id: String,
    pub run_id: String,
    pub actor_id: String,
    pub actor_source: String,
    pub request_key: String,
    pub capability: String,
    pub parameters: Value,
    pub status: String,
    pub result: Option<Value>,
    pub task_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
pub struct ObservationProperty {
    pub value: Value,
    pub unit: Option<String>,
    pub binding_id: String,
    pub run_id: String,
    pub sequence: i64,
    pub source: String,
    pub observed_at: Option<DateTime<Utc>>,
    pub received_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub quality: String,
    pub freshness: String,
}
#[derive(Clone, Serialize, Deserialize, ToSchema)]
pub struct DeviceObservation {
    pub entity_id: String,
    pub run_id: String,
    pub sequence: i64,
    pub source: String,
    pub values: Value,
    pub observed_at: Option<DateTime<Utc>>,
    pub received_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    pub quality: String,
    pub freshness: String,
    pub properties: std::collections::BTreeMap<String, ObservationProperty>,
}
const RUN_COLUMNS: &str = "id::text,entity_id::text,binding_id::text,configuration,status,started_by::text,started_at,ended_at";
const COMMAND_COLUMNS: &str = "id::text,entity_id::text,run_id::text,actor_id::text,actor_source,request_key,capability,parameters,status,result,task_id::text,created_at,updated_at";

pub(super) async fn register_binding(
    connection: &mut PgConnection,
    entity: &str,
    definition: &str,
    reality: &str,
) -> Result<(), Failure> {
    if matches!(definition, "light" | "sensor" | "centrifuge") && reality == "simulated" {
        let binding = uuid::Uuid::now_v7().to_string();
        let program = format!("{definition}.v1");
        sqlx::query("INSERT INTO lab.runtime_bindings(id,entity_id,program_id,source) VALUES($1::uuid,$2::uuid,$3,$4)")
            .bind(&binding).bind(entity).bind(&program).bind(format!("simulated:{program}:{binding}")).execute(connection).await?;
    }
    Ok(())
}
pub(super) fn routes() -> Router<Lab> {
    Router::new()
        .route(
            "/api/v1/lab/labs/{lab_id}/entities/{entity_id}/program/start",
            post(start_program),
        )
        .route(
            "/api/v1/lab/labs/{lab_id}/entities/{entity_id}/program/stop",
            post(stop_program),
        )
        .route(
            "/api/v1/lab/labs/{lab_id}/entities/{entity_id}/commands/{command_id}",
            get(get_command),
        )
        .layer(DefaultBodyLimit::max(16 * 1024))
}
#[derive(OpenApi)]
#[openapi(paths(start_program, stop_program, get_command))]
struct DeviceApi;
pub(super) fn openapi() -> utoipa::openapi::OpenApi {
    DeviceApi::openapi()
}

async fn audit(
    connection: &mut PgConnection,
    actor: &str,
    action: &str,
    resource: &str,
    id: &RequestId,
) -> Result<(), Failure> {
    audit::append(
        connection,
        audit::Event {
            actor_id: actor,
            action,
            resource_type: "lab.device",
            resource_id: resource,
            source: audit::Source::Request(&id.0),
            subject_user_id: None,
        },
    )
    .await?;
    Ok(())
}
async fn lock_entity(
    connection: &mut PgConnection,
    lab: &str,
    entity: &str,
) -> Result<LabEntity, Failure> {
    world::uuid(lab)?;
    world::uuid(entity)?;
    sqlx::query("SELECT id FROM lab.entities WHERE lab_id=$1::uuid AND id=$2::uuid FOR UPDATE")
        .bind(lab)
        .bind(entity)
        .fetch_optional(&mut *connection)
        .await?
        .ok_or(Failure::WorldNotFound)?;
    world::load_entity(connection, lab, entity).await
}
async fn run(connection: &mut PgConnection, id: &str) -> Result<DeviceProgramRun, Failure> {
    Ok(sqlx::query_as(&format!(
        "SELECT {RUN_COLUMNS} FROM lab.program_runs WHERE id=$1::uuid"
    ))
    .bind(id)
    .fetch_one(connection)
    .await?)
}
fn valid_light_configuration(configuration: &Value) -> bool {
    configuration.get("brightness").is_none_or(|value| {
        value
            .as_f64()
            .is_some_and(|value| (0.0..=100.0).contains(&value))
    }) && configuration.get("on").is_none_or(Value::is_boolean)
}

#[utoipa::path(post, path="/api/v1/lab/labs/{lab_id}/entities/{entity_id}/program/start", operation_id="startLabDeviceProgram", tag="Lab", params(("lab_id"=String, Path), ("entity_id"=String, Path)), responses((status=201, body=DeviceProgramRun), (status=200, body=DeviceProgramRun), (status=400, body=crate::http::ApiErrorResponse), (status=401, body=crate::http::ApiErrorResponse), (status=403, body=crate::http::ApiErrorResponse), (status=404, body=crate::http::ApiErrorResponse), (status=422, body=crate::http::ApiErrorResponse), (status=503, body=crate::http::ApiErrorResponse)))]
async fn start_program(
    State(state): State<Lab>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiPath((lab, entity)): ApiPath<(String, String)>,
) -> Response {
    let actor = match state.actor(&headers, &id, true).await {
        Ok(actor) => actor,
        Err(response) => return response,
    };
    let result = async {
        state.require_runtime()?;
        let mut tx = state.pool.begin().await?;
        state.authorize(&mut tx,&headers,&actor).await?;
        let generation: i64 = sqlx::query_scalar("SELECT generation FROM lab.runtime_generation WHERE singleton FOR SHARE").fetch_one(&mut *tx).await?;
        let entity = lock_entity(&mut tx,&lab,&entity).await?;
        let binding = entity.binding.ok_or(Failure::NotImplemented)?;
        if let Some(run) = entity.program_run.filter(|run| run.status == "running") { return Ok((StatusCode::OK,run)); }
        let configuration = json!(entity.configuration);
        if (binding.program_id=="light.v1" && !valid_light_configuration(&configuration)) ||
            (binding.program_id=="centrifuge.v1" && configuration.get("initial_temperature").is_some_and(|value| !value.as_f64().is_some_and(|value|(-10.0..=40.0).contains(&value)))) ||
            (binding.program_id=="sensor.v1" && configuration.get("baseline_temperature").is_some_and(|value| !value.as_f64().is_some_and(|value|(-50.0..=100.0).contains(&value)))) { return Err(Failure::InvalidParameters); }
        let id_run = uuid::Uuid::now_v7().to_string();
        sqlx::query("INSERT INTO lab.program_runs(id,entity_id,binding_id,generation,configuration,status,started_by) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$5,'running',$6::uuid)")
            .bind(&id_run).bind(&entity.id).bind(&binding.id).bind(generation).bind(configuration).bind(&actor).execute(&mut *tx).await?;
        audit(&mut tx,&actor,"lab.program.start",&id_run,&id).await?;
        let value = run(&mut tx,&id_run).await?; tx.commit().await?;
        Ok::<_,Failure>((StatusCode::CREATED,value))
    }.await;
    match result {
        Ok((status, value)) => (status, Json(value)).into_response(),
        Err(error) => error.response(id),
    }
}
#[utoipa::path(post, path="/api/v1/lab/labs/{lab_id}/entities/{entity_id}/program/stop", operation_id="stopLabDeviceProgram", tag="Lab", params(("lab_id"=String, Path), ("entity_id"=String, Path)), responses((status=200, body=DeviceProgramRun), (status=400, body=crate::http::ApiErrorResponse), (status=401, body=crate::http::ApiErrorResponse), (status=403, body=crate::http::ApiErrorResponse), (status=404, body=crate::http::ApiErrorResponse), (status=409, body=crate::http::ApiErrorResponse), (status=422, body=crate::http::ApiErrorResponse), (status=503, body=crate::http::ApiErrorResponse)))]
async fn stop_program(
    State(state): State<Lab>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiPath((lab, entity)): ApiPath<(String, String)>,
) -> Response {
    let actor = match state.actor(&headers, &id, true).await {
        Ok(actor) => actor,
        Err(response) => return response,
    };
    let result = async {
        let mut tx = state.pool.begin().await?; state.authorize(&mut tx,&headers,&actor).await?;
        let entity = lock_entity(&mut tx,&lab,&entity).await?;
        if entity.task.as_ref().is_some_and(|task|task.active()) { return Err(Failure::DeviceBusy); }
        let previous = entity.program_run.ok_or(Failure::ProgramNotRunning)?;
        sqlx::query("UPDATE lab.program_runs SET status='stopped',ended_at=now() WHERE id=$1::uuid AND status='running'").bind(&previous.id).execute(&mut *tx).await?;
        sqlx::query("UPDATE lab.device_commands SET status=CASE WHEN status='executing' THEN 'unknown' ELSE 'failed' END,result=jsonb_build_object('reason','program_stopped'),updated_at=now() WHERE run_id=$1::uuid AND status IN ('accepted','executing')").bind(&previous.id).execute(&mut *tx).await?;
        audit(&mut tx,&actor,"lab.program.stop",&previous.id,&id).await?;
        let value = run(&mut tx,&previous.id).await?; tx.commit().await?; Ok::<_,Failure>(value)
    }.await;
    match result {
        Ok(value) => Json(value).into_response(),
        Err(error) => error.response(id),
    }
}

pub(super) async fn accept(
    state: &Lab,
    headers: &HeaderMap,
    actor: &str,
    lab: &str,
    entity: &str,
    input: EntityAction,
    id: &RequestId,
) -> Result<DeviceCommand, Failure> {
    state.require_runtime()?;
    let mut tx = state.pool.begin().await?;
    state.authorize(&mut tx, headers, actor).await?;
    let entity = lock_entity(&mut tx, lab, entity).await?;
    let capability = entity
        .capabilities
        .iter()
        .find(|capability| capability.id == input.capability)
        .ok_or(Failure::InvalidInput)?;
    if !capability.binding_implemented {
        return Err(Failure::NotImplemented);
    }
    let key = headers
        .get("idempotency-key")
        .and_then(|key| key.to_str().ok())
        .unwrap_or("");
    if key.is_empty() || key.len() > 128 || !key.bytes().all(|byte| (33..=126).contains(&byte)) {
        return Err(crate::modules::idempotency::Error::InvalidKey.into());
    }
    let previous: Option<(bool,sqlx::types::Json<DeviceCommand>)> = sqlx::query_as("SELECT capability=$4 AND parameters=$5,to_jsonb(c) FROM lab.device_commands c WHERE actor_id=$1::uuid AND entity_id=$2::uuid AND request_key=$3").bind(actor).bind(&entity.id).bind(key).bind(&input.capability).bind(&input.parameters).fetch_optional(&mut *tx).await?;
    if let Some((same, previous)) = previous {
        if !same {
            return Err(crate::modules::idempotency::Error::Conflict.into());
        }
        return Ok(previous.0);
    }
    let expired:Option<String>=sqlx::query_scalar("SELECT fingerprint FROM lab.command_receipts WHERE actor_id=$1::uuid AND entity_id=$2::uuid AND request_key=$3").bind(actor).bind(&entity.id).bind(key).fetch_optional(&mut *tx).await?;
    if let Some(fingerprint) = expired {
        return Err(
            if fingerprint == request_fingerprint(&input.capability, &input.parameters) {
                Failure::CommandExpired
            } else {
                crate::modules::idempotency::Error::Conflict.into()
            },
        );
    }
    let running = entity
        .program_run
        .filter(|run| run.status == "running")
        .ok_or(Failure::ProgramNotRunning)?;
    let valid =
        input
            .parameters
            .as_object()
            .is_some_and(|params| match input.capability.as_str() {
                "centrifuge.start" => super::tasks::valid_parameters(&input.parameters),
                "centrifuge.stop" => params.is_empty(),
                "light.set_power" => {
                    params.len() == 1 && params.get("on").is_some_and(Value::is_boolean)
                }
                "light.set_brightness" => {
                    params.len() == 1
                        && params
                            .get("brightness")
                            .and_then(Value::as_f64)
                            .is_some_and(|value| (0.0..=100.0).contains(&value))
                }
                _ => false,
            });
    if !valid {
        return Err(Failure::InvalidParameters);
    }
    if input.capability == "centrifuge.start"
        && entity.task.as_ref().is_some_and(|task| task.active())
    {
        return Err(Failure::DeviceBusy);
    }
    let command = uuid::Uuid::now_v7().to_string();
    sqlx::query("INSERT INTO lab.device_commands(id,entity_id,run_id,actor_id,actor_source,request_key,capability,parameters,status) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5,$6,$7,$8,'accepted')")
        .bind(&command).bind(&entity.id).bind(&running.id).bind(actor).bind(if headers.contains_key("authorization") {"agent"} else {"member"}).bind(key).bind(&input.capability).bind(&input.parameters).execute(&mut *tx).await?;
    let task = if input.capability == "centrifuge.start" {
        Some(
            super::tasks::reserve(
                &mut tx,
                &entity.id,
                &running.id,
                &command,
                &input.parameters,
            )
            .await?,
        )
    } else if input.capability == "centrifuge.stop" {
        entity.task.filter(|task| task.active()).map(|task| task.id)
    } else {
        None
    };
    if let Some(task) = task {
        sqlx::query("UPDATE lab.device_commands SET task_id=$2::uuid WHERE id=$1::uuid")
            .bind(&command)
            .bind(task)
            .execute(&mut *tx)
            .await?;
    }
    audit(&mut tx, actor, "lab.command.accept", &command, id).await?;
    let command = load_command(&mut tx, &entity.id, &command).await?;
    tx.commit().await?;
    Ok(command)
}
fn request_fingerprint(capability: &str, parameters: &Value) -> String {
    let mut parameters = parameters.clone();
    // Built-in inputs are flat; numeric encodings such as 22 and 22.0 have the same JSONB meaning.
    if let Some(parameters) = parameters.as_object_mut() {
        for value in parameters.values_mut() {
            if let Some(number) = value.as_f64() {
                *value = json!(if number == 0.0 { 0.0 } else { number });
            }
        }
    }
    format!(
        "{:x}",
        Sha256::digest(
            json!({"capability":capability,"parameters":parameters})
                .to_string()
                .as_bytes()
        )
    )
}
pub(super) async fn remember_expired_commands(
    connection: &mut PgConnection,
    ids: &[String],
) -> Result<(), sqlx::Error> {
    let commands:Vec<(String,String,String,String,String,Value)>=sqlx::query_as("SELECT actor_id::text,entity_id::text,request_key,id::text,capability,parameters FROM lab.device_commands WHERE id=ANY($1::text[]::uuid[])").bind(ids).fetch_all(&mut *connection).await?;
    let receipts:Vec<Value>=commands.into_iter().map(|(actor,entity,key,command,capability,parameters)|json!({"actor_id":actor,"entity_id":entity,"request_key":key,"command_id":command,"fingerprint":request_fingerprint(&capability,&parameters)})).collect();
    sqlx::query("INSERT INTO lab.command_receipts(actor_id,entity_id,request_key,command_id,fingerprint) SELECT actor_id,entity_id,request_key,command_id,fingerprint FROM jsonb_to_recordset($1) AS receipt(actor_id uuid,entity_id uuid,request_key text,command_id uuid,fingerprint text) ON CONFLICT(actor_id,entity_id,request_key) DO NOTHING").bind(json!(receipts)).execute(connection).await?;
    Ok(())
}
async fn load_command(
    connection: &mut PgConnection,
    entity: &str,
    command: &str,
) -> Result<DeviceCommand, Failure> {
    world::uuid(command)?;
    sqlx::query_as(&format!(
        "SELECT {COMMAND_COLUMNS} FROM lab.device_commands WHERE entity_id=$1::uuid AND id=$2::uuid"
    ))
    .bind(entity)
    .bind(command)
    .fetch_optional(connection)
    .await?
    .ok_or(Failure::WorldNotFound)
}
#[utoipa::path(get, path="/api/v1/lab/labs/{lab_id}/entities/{entity_id}/commands/{command_id}", operation_id="getLabDeviceCommand", tag="Lab", params(("lab_id"=String, Path), ("entity_id"=String, Path), ("command_id"=String, Path)), responses((status=200, body=DeviceCommand), (status=400, body=crate::http::ApiErrorResponse), (status=401, body=crate::http::ApiErrorResponse), (status=403, body=crate::http::ApiErrorResponse), (status=404, body=crate::http::ApiErrorResponse), (status=503, body=crate::http::ApiErrorResponse)))]
async fn get_command(
    State(state): State<Lab>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiPath((lab, entity, command)): ApiPath<(String, String, String)>,
) -> Response {
    if let Err(response) = state.actor(&headers, &id, false).await {
        return response;
    }
    let result = async {
        world::uuid(&lab)?;
        world::uuid(&entity)?;
        let mut connection = state.pool.acquire().await?;
        world::load_entity(&mut connection, &lab, &entity).await?;
        load_command(&mut connection, &entity, &command).await
    }
    .await;
    match result {
        Ok(value) => Json(value).into_response(),
        Err(error) => error.response(id),
    }
}
