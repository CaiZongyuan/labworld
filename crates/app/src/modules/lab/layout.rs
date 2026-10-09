use super::{
    Failure, Lab,
    relationships::{self, EntityRelationship, LayoutRelationship},
    world::{self, Placement, SceneNode},
};
use crate::http::{ApiPath, BoundedJson, RequestId};
use axum::{
    Extension, Json, Router,
    extract::{DefaultBodyLimit, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
    routing::put,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::{HashMap, HashSet};
use utoipa::{OpenApi, ToSchema};

#[derive(Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct LayoutNode {
    pub id: String,
    pub entity_id: String,
    pub representation_id: Option<String>,
    pub placement: Placement,
}
#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct SaveLabLayout {
    pub expected_version: i64,
    pub nodes: Vec<LayoutNode>,
    /// Omit to retain registered relationships; an array explicitly replaces them.
    pub relationships: Option<Vec<LayoutRelationship>>,
}
#[derive(Serialize, ToSchema)]
pub struct LabLayout {
    pub layout_version: i64,
    pub nodes: Vec<SceneNode>,
    pub relationships: Vec<EntityRelationship>,
}

pub(super) fn routes() -> Router<Lab> {
    Router::new()
        .route("/api/v1/lab/labs/{lab_id}/layout", put(save_layout))
        .layer(DefaultBodyLimit::max(512 * 1024))
}
#[derive(OpenApi)]
#[openapi(paths(save_layout))]
struct LayoutApi;
pub(super) fn openapi() -> utoipa::openapi::OpenApi {
    LayoutApi::openapi()
}
pub(super) async fn lock_version(
    connection: &mut sqlx::PgConnection,
    lab: &str,
    expected: i64,
) -> Result<(), Failure> {
    let version: i64 =
        sqlx::query_scalar("SELECT layout_version FROM lab.labs WHERE id=$1::uuid FOR UPDATE")
            .bind(lab)
            .fetch_optional(connection)
            .await?
            .ok_or(Failure::WorldNotFound)?;
    if version != expected {
        return Err(Failure::LayoutConflict);
    }
    Ok(())
}

#[utoipa::path(put, path="/api/v1/lab/labs/{lab_id}/layout", operation_id="saveLabLayout", tag="Lab", params(("lab_id"=String, Path)), request_body=SaveLabLayout, responses((status=200, body=LabLayout), (status=400, body=crate::http::ApiErrorResponse), (status=401, body=crate::http::ApiErrorResponse), (status=403, body=crate::http::ApiErrorResponse), (status=404, body=crate::http::ApiErrorResponse), (status=409, body=crate::http::ApiErrorResponse), (status=503, body=crate::http::ApiErrorResponse)))]
async fn save_layout(
    State(state): State<Lab>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiPath(lab): ApiPath<String>,
    BoundedJson(mut input): BoundedJson<SaveLabLayout>,
) -> Response {
    let actor = match state.actor(&headers, &id, true).await {
        Ok(actor) => actor,
        Err(response) => return response,
    };
    let result = async {
        let lab = world::uuid(&lab)?.to_string();
        if input.expected_version < 0 || input.nodes.len() > 1000 { return Err(Failure::InvalidInput); }
        let mut node_entities = HashMap::new();
        let mut entities = HashSet::new();
        let mut representations = HashSet::new();
        for node in &mut input.nodes {
            node.id = world::uuid(&node.id)?.to_string();
            node.entity_id = world::uuid(&node.entity_id)?.to_string();
            if node_entities.insert(node.id.clone(),node.entity_id.clone()).is_some() || !node.placement.valid() { return Err(Failure::InvalidInput); }
            entities.insert(node.entity_id.clone());
            if let Some(value) = &mut node.representation_id {
                *value = world::uuid(value)?.to_string();
                representations.insert(value.clone());
            }
        }
        let mut tx = state.pool.begin().await?;
        state.authorize(&mut tx, &headers, &actor).await?;
        lock_version(&mut tx,&lab,input.expected_version).await?;
        if let Some(relationships)=&mut input.relationships {
            relationships::save(&mut tx,&lab,&actor,relationships).await?;
        }
        let entity_ids = entities.into_iter().collect::<Vec<_>>();
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM lab.entities WHERE lab_id=$1::uuid AND id::text=ANY($2)")
            .bind(&lab).bind(&entity_ids).fetch_one(&mut *tx).await?;
        if count as usize != entity_ids.len() { return Err(Failure::InvalidReference); }
        let representation_ids = representations.into_iter().collect::<Vec<_>>();
        let found: Vec<String> = sqlx::query_scalar("SELECT id::text FROM lab.asset_representations WHERE id::text=ANY($1) FOR KEY SHARE")
            .bind(&representation_ids).fetch_all(&mut *tx).await?;
        if found.len() != representation_ids.len() { return Err(Failure::InvalidReference); }
        let existing: Vec<(String,String,String)> = sqlx::query_as("SELECT id::text,lab_id::text,entity_id::text FROM lab.scene_nodes WHERE id::text=ANY($1)")
            .bind(node_entities.keys().cloned().collect::<Vec<_>>()).fetch_all(&mut *tx).await?;
        if existing.iter().any(|(id,owner,entity)| owner != &lab || node_entities.get(id)!=Some(entity)) { return Err(Failure::InvalidReference); }
        sqlx::query("DELETE FROM lab.scene_nodes WHERE lab_id=$1::uuid").bind(&lab).execute(&mut *tx).await?;
        sqlx::query("INSERT INTO lab.scene_nodes(id,lab_id,entity_id,representation_id,placement) SELECT n.id::uuid,$1::uuid,n.entity_id::uuid,n.representation_id::uuid,n.placement FROM jsonb_to_recordset($2) AS n(id text,entity_id text,representation_id text,placement jsonb)")
            .bind(&lab).bind(json!(input.nodes)).execute(&mut *tx).await?;
        let layout_version = sqlx::query_scalar("UPDATE lab.labs SET layout_version=layout_version+1 WHERE id=$1::uuid RETURNING layout_version")
            .bind(&lab).fetch_one(&mut *tx).await?;
        world::event(&mut tx, &actor, "lab.layout.save", &lab, &id).await?;
        let relationships=relationships::load(&mut tx,&lab).await?;
        tx.commit().await?;
        let nodes = input.nodes.into_iter().map(|node| SceneNode {id:node.id,lab_id:lab.clone(),entity_id:node.entity_id,representation_id:node.representation_id,placement:node.placement}).collect();
        Ok::<_,Failure>(LabLayout {layout_version,nodes,relationships})
    }.await;
    match result {
        Ok(layout) => Json(layout).into_response(),
        Err(error) => error.response(id),
    }
}
