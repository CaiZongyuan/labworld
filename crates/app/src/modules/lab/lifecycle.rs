use super::{
    Failure, Lab, definitions, devices,
    world::{self, LabEntity},
};
use crate::http::{ApiPath, BoundedJson, RequestId};
use axum::{
    Extension, Json, Router,
    extract::{DefaultBodyLimit, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
    routing::{post, put},
};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use sqlx::PgConnection;
use utoipa::{OpenApi, ToSchema};

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ChangeEntityDefinition {
    pub definition_id: String,
    pub definition_version: String,
    pub configuration: Map<String, Value>,
}
#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ChangeEntityAppearance {
    /// Null selects the built-in appearance. Applies to the Entity and all its current Scene Nodes.
    pub representation_id: Option<String>,
}

pub(super) fn routes() -> Router<Lab> {
    Router::new()
        .route(
            "/api/v1/lab/labs/{lab_id}/entities/{entity_id}/archive",
            post(archive_entity),
        )
        .route(
            "/api/v1/lab/labs/{lab_id}/entities/{entity_id}/definition",
            put(change_definition),
        )
        .route(
            "/api/v1/lab/labs/{lab_id}/entities/{entity_id}/appearance",
            put(change_appearance),
        )
        .layer(DefaultBodyLimit::max(16 * 1024))
}
#[derive(OpenApi)]
#[openapi(paths(archive_entity, change_definition, change_appearance))]
struct LifecycleApi;
pub(super) fn openapi() -> utoipa::openapi::OpenApi {
    LifecycleApi::openapi()
}

async fn ensure_change_allowed(
    connection: &mut PgConnection,
    entity: &LabEntity,
) -> Result<(), Failure> {
    // The caller holds the world writer lock and Entity lock through commit.
    let in_use: bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM lab.program_runs WHERE entity_id=$1::uuid AND status='running') OR EXISTS(SELECT 1 FROM lab.device_tasks WHERE entity_id=$1::uuid AND ended_at IS NULL)")
        .bind(&entity.id).fetch_one(connection).await?;
    if in_use {
        Err(Failure::EntityInUse)
    } else {
        Ok(())
    }
}

#[utoipa::path(put, path="/api/v1/lab/labs/{lab_id}/entities/{entity_id}/appearance", operation_id="changeLabEntityAppearance", tag="Lab", params(("lab_id"=String, Path), ("entity_id"=String, Path)), request_body=ChangeEntityAppearance, responses((status=200, body=LabEntity), (status=400, body=crate::http::ApiErrorResponse), (status=401, body=crate::http::ApiErrorResponse), (status=403, body=crate::http::ApiErrorResponse), (status=404, body=crate::http::ApiErrorResponse), (status=503, body=crate::http::ApiErrorResponse)))]
async fn change_appearance(
    State(state): State<Lab>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiPath((lab, entity)): ApiPath<(String, String)>,
    BoundedJson(input): BoundedJson<ChangeEntityAppearance>,
) -> Response {
    let actor = match state.actor(&headers, &id, true).await {
        Ok(actor) => actor,
        Err(response) => return response,
    };
    let result=async {
        let mut tx=state.pool.begin().await?;
        state.authorize(&mut tx,&headers,&actor).await?;
        let entity=devices::lock_entity(&mut tx,&lab,&entity).await?;
        let representation=input.representation_id.as_deref().map(world::uuid).transpose()?.map(|id|id.to_string());
        world::representation(&mut tx,representation.as_deref()).await?;
        sqlx::query("UPDATE lab.entities SET representation_id=$2::uuid,updated_by=$3::uuid,updated_at=now() WHERE id=$1::uuid")
            .bind(&entity.id).bind(&representation).bind(&actor).execute(&mut *tx).await?;
        let nodes=sqlx::query("UPDATE lab.scene_nodes SET representation_id=$2::uuid WHERE entity_id=$1::uuid")
            .bind(&entity.id).bind(&representation).execute(&mut *tx).await?.rows_affected();
        if nodes>0 {
            sqlx::query("UPDATE lab.labs SET layout_version=layout_version+1 WHERE id=$1::uuid").bind(&lab).execute(&mut *tx).await?;
        }
        world::event(&mut tx,&actor,"lab.entity.appearance",&entity.id,&id).await?;
        let entity=world::load_entity(&mut tx,&lab,&entity.id).await?;
        tx.commit().await?;
        Ok::<_,Failure>(entity)
    }.await;
    match result {
        Ok(entity) => Json(entity).into_response(),
        Err(error) => error.response(id),
    }
}

#[utoipa::path(put, path="/api/v1/lab/labs/{lab_id}/entities/{entity_id}/definition", operation_id="changeLabEntityDefinition", tag="Lab", params(("lab_id"=String, Path), ("entity_id"=String, Path)), request_body=ChangeEntityDefinition, responses((status=200, body=LabEntity), (status=400, body=crate::http::ApiErrorResponse), (status=401, body=crate::http::ApiErrorResponse), (status=403, body=crate::http::ApiErrorResponse), (status=404, body=crate::http::ApiErrorResponse), (status=409, body=crate::http::ApiErrorResponse), (status=503, body=crate::http::ApiErrorResponse)))]
async fn change_definition(
    State(state): State<Lab>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiPath((lab, entity)): ApiPath<(String, String)>,
    BoundedJson(input): BoundedJson<ChangeEntityDefinition>,
) -> Response {
    let actor = match state.actor(&headers, &id, true).await {
        Ok(actor) => actor,
        Err(response) => return response,
    };
    let result=async {
        let mut tx=state.pool.begin().await?;
        state.authorize(&mut tx,&headers,&actor).await?;
        let entity=devices::lock_entity(&mut tx,&lab,&entity).await?;
        if entity.archived_at.is_some() { return Err(Failure::EntityArchived); }
        ensure_change_allowed(&mut tx,&entity).await?;
        let definition=definitions::catalog().iter().find(|definition|definition.id==input.definition_id && definition.version==input.definition_version).ok_or(Failure::InvalidReference)?;
        if !world::valid_configuration(&input.configuration) { return Err(Failure::InvalidInput); }
        let incompatible:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM lab.entity_relationships r JOIN lab.entities other ON other.id=CASE WHEN r.source_id=$1::uuid THEN r.target_id ELSE r.source_id END WHERE (r.source_id=$1::uuid OR r.target_id=$1::uuid) AND ((r.kind='simulates' AND other.definition_id<>$2) OR ((r.kind='located_in' AND r.target_id=$1::uuid OR r.kind='contains' AND r.source_id=$1::uuid) AND $3 NOT IN ('furniture','location','labware'))))")
            .bind(&entity.id).bind(&definition.id).bind(&definition.category).fetch_one(&mut *tx).await?;
        if incompatible { return Err(Failure::InvalidReference); }
        sqlx::query("UPDATE lab.entities SET kind=$2,definition_id=$3,definition_version=$4,definition=$5,configuration=$6,updated_by=$7::uuid,updated_at=now() WHERE id=$1::uuid")
            .bind(&entity.id).bind(&definition.category).bind(&definition.id).bind(&definition.version).bind(json!(definition)).bind(json!(input.configuration)).bind(&actor).execute(&mut *tx).await?;
        sqlx::query("UPDATE lab.runtime_bindings SET current=false WHERE entity_id=$1::uuid AND current").bind(&entity.id).execute(&mut *tx).await?;
        devices::register_binding(&mut tx,&entity.id,&definition.id,&entity.reality).await?;
        world::event(&mut tx,&actor,"lab.entity.definition",&entity.id,&id).await?;
        let entity=world::load_entity(&mut tx,&lab,&entity.id).await?;
        tx.commit().await?;
        Ok::<_,Failure>(entity)
    }.await;
    match result {
        Ok(entity) => Json(entity).into_response(),
        Err(error) => error.response(id),
    }
}

#[utoipa::path(post, path="/api/v1/lab/labs/{lab_id}/entities/{entity_id}/archive", operation_id="archiveLabEntity", tag="Lab", params(("lab_id"=String, Path), ("entity_id"=String, Path)), responses((status=200, body=LabEntity), (status=400, body=crate::http::ApiErrorResponse), (status=401, body=crate::http::ApiErrorResponse), (status=403, body=crate::http::ApiErrorResponse), (status=404, body=crate::http::ApiErrorResponse), (status=409, body=crate::http::ApiErrorResponse), (status=503, body=crate::http::ApiErrorResponse)))]
async fn archive_entity(
    State(state): State<Lab>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiPath((lab, entity)): ApiPath<(String, String)>,
) -> Response {
    let actor = match state.actor(&headers, &id, true).await {
        Ok(actor) => actor,
        Err(response) => return response,
    };
    let result=async {
        let mut tx=state.pool.begin().await?;
        state.authorize(&mut tx,&headers,&actor).await?;
        let entity=devices::lock_entity(&mut tx,&lab,&entity).await?;
        if entity.archived_at.is_some() { return Ok(entity); }
        ensure_change_allowed(&mut tx,&entity).await?;
        sqlx::query("UPDATE lab.entities SET archived_at=now(),updated_by=$2::uuid,updated_at=now() WHERE id=$1::uuid")
            .bind(&entity.id).bind(&actor).execute(&mut *tx).await?;
        world::event(&mut tx,&actor,"lab.entity.archive",&entity.id,&id).await?;
        let entity=world::load_entity(&mut tx,&lab,&entity.id).await?;
        tx.commit().await?;
        Ok::<_,Failure>(entity)
    }.await;
    match result {
        Ok(entity) => Json(entity).into_response(),
        Err(error) => error.response(id),
    }
}
