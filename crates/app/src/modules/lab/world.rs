use super::{
    Failure, Lab,
    assets::{self, LabAsset},
    definitions::{self, AssetDefinition},
};
use crate::{
    http::{ApiPath, ApiQuery, BoundedJson, RequestId},
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
use serde_json::{Map, Value, json};
use sqlx::PgConnection;
use utoipa::{OpenApi, ToSchema};

#[derive(Serialize, ToSchema, sqlx::FromRow)]
pub struct PersistentLab {
    pub id: String,
    pub name: String,
    pub layout_version: i64,
    pub created_by: String,
    pub created_at: DateTime<Utc>,
}
#[derive(Serialize, ToSchema)]
pub struct LabPage {
    pub data: Vec<PersistentLab>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
}
#[derive(Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
struct LabQuery {
    #[param(minimum = 1, maximum = 100, default = 50)]
    limit: Option<u32>,
    cursor: Option<String>,
}
#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateLab {
    pub name: String,
}

#[derive(Serialize, Deserialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum EntityReality {
    Simulated,
    Physical,
}

#[derive(Serialize, Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct Placement {
    pub position: [f64; 3],
    pub rotation: [f64; 3],
    pub scale: [f64; 3],
}
impl Default for Placement {
    fn default() -> Self {
        Self {
            position: [0.0; 3],
            rotation: [0.0; 3],
            scale: [1.0; 3],
        }
    }
}
#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct RegisterEntity {
    pub name: String,
    pub definition_id: String,
    pub definition_version: String,
    pub reality: EntityReality,
    pub configuration: Map<String, Value>,
    pub representation_id: Option<String>,
}
#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct ConfigureEntity {
    pub name: String,
    pub configuration: Map<String, Value>,
}
#[derive(Serialize, Deserialize, ToSchema)]
pub struct EntityCapability {
    pub id: String,
    pub definition_supported: bool,
    pub binding_implemented: bool,
    pub executable: bool,
    pub reason: String,
    pub parameters: Value,
}
#[derive(Serialize, ToSchema, sqlx::FromRow)]
pub struct LabEntity {
    pub id: String,
    pub lab_id: String,
    pub name: String,
    pub kind: String,
    pub reality: String,
    pub definition_id: String,
    pub definition_version: String,
    #[sqlx(json)]
    pub definition: AssetDefinition,
    #[sqlx(json)]
    pub configuration: Map<String, Value>,
    pub representation_id: Option<String>,
    pub created_by: String,
    pub updated_by: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    #[sqlx(skip)]
    pub binding: Option<Value>,
    #[sqlx(skip)]
    pub observation: Option<Value>,
    #[sqlx(skip)]
    pub capabilities: Vec<EntityCapability>,
}
impl LabEntity {
    fn with_capabilities(mut self) -> Self {
        self.capabilities = self
            .definition
            .capabilities
            .iter()
            .map(|capability| EntityCapability {
                id: capability.id.clone(),
                definition_supported: true,
                binding_implemented: false,
                executable: false,
                reason: "binding_not_implemented".into(),
                parameters: capability.parameters.clone(),
            })
            .collect();
        self
    }
}
#[derive(Serialize, ToSchema, sqlx::FromRow)]
pub struct SceneNode {
    pub id: String,
    pub lab_id: String,
    pub entity_id: String,
    pub representation_id: Option<String>,
    #[sqlx(json)]
    pub placement: Placement,
}
#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateSceneNode {
    pub entity_id: String,
    pub representation_id: Option<String>,
    pub placement: Placement,
}
#[derive(Serialize, ToSchema)]
pub struct LabWorld {
    pub lab: PersistentLab,
    pub entities: Vec<LabEntity>,
    pub nodes: Vec<SceneNode>,
    pub assets: Vec<LabAsset>,
}
#[derive(Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
struct WorldQuery {
    kind: Option<String>,
    capability: Option<String>,
    state: Option<String>,
}
#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct EntityAction {
    pub capability: String,
    pub parameters: Value,
}

const LAB_COLUMNS: &str = "id::text, name, layout_version, created_by::text, created_at";
const ENTITY_COLUMNS: &str = "id::text, lab_id::text, name, kind, reality, definition_id, definition_version, definition, configuration, representation_id::text, created_by::text, updated_by::text, created_at, updated_at";
const NODE_COLUMNS: &str =
    "id::text, lab_id::text, entity_id::text, representation_id::text, placement";

pub(super) fn routes() -> Router<Lab> {
    Router::new()
        .route("/api/v1/lab/labs", get(list_labs).post(create_lab))
        .route("/api/v1/lab/labs/{lab_id}/world", get(get_world))
        .route("/api/v1/lab/labs/{lab_id}/entities", post(register_entity))
        .route(
            "/api/v1/lab/labs/{lab_id}/entities/{entity_id}",
            get(get_entity).patch(configure_entity),
        )
        .route("/api/v1/lab/labs/{lab_id}/nodes", post(create_node))
        .route(
            "/api/v1/lab/labs/{lab_id}/entities/{entity_id}/actions",
            post(entity_action),
        )
        .layer(DefaultBodyLimit::max(16 * 1024))
}
#[derive(OpenApi)]
#[openapi(paths(
    list_labs,
    create_lab,
    get_world,
    register_entity,
    get_entity,
    configure_entity,
    create_node,
    entity_action
))]
struct WorldApi;
pub(super) fn openapi() -> utoipa::openapi::OpenApi {
    WorldApi::openapi()
}

fn uuid(value: &str) -> Result<uuid::Uuid, Failure> {
    uuid::Uuid::parse_str(value).map_err(|_| Failure::InvalidReference)
}
fn valid_name(value: &str) -> bool {
    !value.trim().is_empty() && value.chars().count() <= 120 && !value.chars().any(char::is_control)
}
fn valid_configuration(value: &Map<String, Value>) -> bool {
    json!(value).to_string().len() <= 8192
}
async fn load_lab(connection: &mut PgConnection, id: &str) -> Result<PersistentLab, Failure> {
    sqlx::query_as(&format!(
        "SELECT {LAB_COLUMNS} FROM lab.labs WHERE id=$1::uuid"
    ))
    .bind(id)
    .fetch_optional(connection)
    .await?
    .ok_or(Failure::WorldNotFound)
}
async fn load_entity(
    connection: &mut PgConnection,
    lab: &str,
    entity: &str,
) -> Result<LabEntity, Failure> {
    sqlx::query_as::<_, LabEntity>(&format!(
        "SELECT {ENTITY_COLUMNS} FROM lab.entities WHERE lab_id=$1::uuid AND id=$2::uuid"
    ))
    .bind(lab)
    .bind(entity)
    .fetch_optional(connection)
    .await?
    .map(LabEntity::with_capabilities)
    .ok_or(Failure::WorldNotFound)
}
async fn representation(connection: &mut PgConnection, id: Option<&str>) -> Result<(), Failure> {
    if let Some(id) = id {
        let id = uuid(id)?.to_string();
        if sqlx::query("SELECT id FROM lab.asset_representations WHERE id=$1::uuid FOR KEY SHARE")
            .bind(id)
            .fetch_optional(connection)
            .await?
            .is_none()
        {
            return Err(Failure::InvalidReference);
        }
    }
    Ok(())
}
async fn event(
    connection: &mut PgConnection,
    actor: &str,
    action: &str,
    resource: &str,
    request: &RequestId,
) -> Result<(), Failure> {
    audit::append(
        connection,
        audit::Event {
            actor_id: actor,
            action,
            resource_type: "lab.world",
            resource_id: resource,
            source: audit::Source::Request(&request.0),
            subject_user_id: None,
        },
    )
    .await?;
    Ok(())
}

#[utoipa::path(get, path="/api/v1/lab/labs", operation_id="listLabs", tag="Lab", params(LabQuery), responses((status=200, body=LabPage), (status=400, body=crate::http::ApiErrorResponse), (status=401, body=crate::http::ApiErrorResponse), (status=403, body=crate::http::ApiErrorResponse), (status=503, body=crate::http::ApiErrorResponse)))]
async fn list_labs(
    State(state): State<Lab>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiQuery(query): ApiQuery<LabQuery>,
) -> Response {
    if let Err(response) = state.actor(&headers, &id, false).await {
        return response;
    }
    let limit = query.limit.unwrap_or(50);
    let cursor = match query.cursor.as_deref().map(uuid).transpose() {
        Ok(cursor) if (1..=100).contains(&limit) => cursor.map(|id| id.to_string()),
        _ => return Failure::InvalidInput.response(id),
    };
    match sqlx::query_as::<_,PersistentLab>(&format!(
        "SELECT {LAB_COLUMNS} FROM lab.labs WHERE ($1::uuid IS NULL OR id<$1::uuid) ORDER BY id DESC LIMIT $2"
    )).bind(cursor).bind(i64::from(limit)+1)
    .fetch_all(&state.pool)
    .await
    {
        Ok(mut data) => {
            let has_more=data.len()>limit as usize;
            data.truncate(limit as usize);
            let next_cursor=if has_more {data.last().map(|lab|lab.id.clone())} else {None};
            Json(LabPage {data,next_cursor,has_more}).into_response()
        },
        Err(error) => Failure::from(error).response(id),
    }
}
#[utoipa::path(post, path="/api/v1/lab/labs", operation_id="createLab", tag="Lab", request_body=CreateLab, responses((status=201, body=PersistentLab), (status=400, body=crate::http::ApiErrorResponse), (status=401, body=crate::http::ApiErrorResponse), (status=403, body=crate::http::ApiErrorResponse), (status=503, body=crate::http::ApiErrorResponse)))]
async fn create_lab(
    State(state): State<Lab>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    BoundedJson(input): BoundedJson<CreateLab>,
) -> Response {
    let actor = match state.actor(&headers, &id, true).await {
        Ok(actor) => actor,
        Err(response) => return response,
    };
    let result = async {
        if !valid_name(&input.name) {
            return Err(Failure::InvalidInput);
        }
        let mut tx = state.pool.begin().await?;
        state.authorize(&mut tx, &headers, &actor).await?;
        let lab = uuid::Uuid::now_v7().to_string();
        sqlx::query("INSERT INTO lab.labs(id,name,created_by) VALUES($1::uuid,$2,$3::uuid)")
            .bind(&lab)
            .bind(input.name.trim())
            .bind(&actor)
            .execute(&mut *tx)
            .await?;
        event(&mut tx, &actor, "lab.create", &lab, &id).await?;
        let lab = load_lab(&mut tx, &lab).await?;
        tx.commit().await?;
        Ok::<_, Failure>(lab)
    }
    .await;
    match result {
        Ok(lab) => (StatusCode::CREATED, Json(lab)).into_response(),
        Err(error) => error.response(id),
    }
}
#[utoipa::path(get, path="/api/v1/lab/labs/{lab_id}/world", operation_id="getLabWorld", tag="Lab", params(("lab_id"=String, Path), WorldQuery), responses((status=200, body=LabWorld), (status=400, body=crate::http::ApiErrorResponse), (status=401, body=crate::http::ApiErrorResponse), (status=403, body=crate::http::ApiErrorResponse), (status=404, body=crate::http::ApiErrorResponse), (status=503, body=crate::http::ApiErrorResponse)))]
async fn get_world(
    State(state): State<Lab>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiPath(lab): ApiPath<String>,
    ApiQuery(query): ApiQuery<WorldQuery>,
) -> Response {
    if let Err(response) = state.actor(&headers, &id, false).await {
        return response;
    }
    let result = async {
        let lab_id = uuid(&lab)?.to_string();
        let mut tx = state.pool.begin().await?;
        // Authentication already completed; session refresh locks cannot share this snapshot.
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ").execute(&mut *tx).await?;
        let lab = load_lab(&mut tx, &lab_id).await?;
        let entities = sqlx::query_as::<_, LabEntity>(&format!("SELECT {ENTITY_COLUMNS} FROM lab.entities WHERE lab_id=$1::uuid AND ($2::text IS NULL OR kind=$2) AND ($3::text IS NULL OR EXISTS(SELECT 1 FROM jsonb_array_elements(definition->'capabilities') c WHERE c->>'id'=$3)) AND ($4::text IS NULL OR $4='unknown') ORDER BY id"))
            .bind(&lab_id).bind(query.kind).bind(query.capability).bind(query.state).fetch_all(&mut *tx).await?.into_iter().map(LabEntity::with_capabilities).collect::<Vec<_>>();
        let entity_ids = entities.iter().map(|entity| entity.id.clone()).collect::<Vec<_>>();
        let nodes: Vec<SceneNode> = sqlx::query_as(&format!("SELECT {NODE_COLUMNS} FROM lab.scene_nodes WHERE lab_id=$1::uuid AND entity_id::text=ANY($2) ORDER BY id"))
            .bind(&lab_id).bind(entity_ids).fetch_all(&mut *tx).await?;
        let representations = nodes.iter().filter_map(|node| node.representation_id.clone()).collect::<Vec<_>>();
        let assets = assets::load_representations(&mut tx, &representations).await?;
        tx.commit().await?;
        Ok::<_, Failure>(LabWorld { lab, entities, nodes, assets })
    }.await;
    match result {
        Ok(world) => Json(world).into_response(),
        Err(error) => error.response(id),
    }
}
#[utoipa::path(post, path="/api/v1/lab/labs/{lab_id}/entities", operation_id="registerLabEntity", tag="Lab", params(("lab_id"=String, Path)), request_body=RegisterEntity, responses((status=201, body=LabEntity), (status=400, body=crate::http::ApiErrorResponse), (status=401, body=crate::http::ApiErrorResponse), (status=403, body=crate::http::ApiErrorResponse), (status=404, body=crate::http::ApiErrorResponse), (status=503, body=crate::http::ApiErrorResponse)))]
async fn register_entity(
    State(state): State<Lab>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiPath(lab): ApiPath<String>,
    BoundedJson(input): BoundedJson<RegisterEntity>,
) -> Response {
    let actor = match state.actor(&headers, &id, true).await {
        Ok(actor) => actor,
        Err(response) => return response,
    };
    let result = async {
        let lab = uuid(&lab)?.to_string();
        if !valid_name(&input.name) || !valid_configuration(&input.configuration) { return Err(Failure::InvalidInput); }
        let definition = definitions::catalog().into_iter().find(|definition| definition.id==input.definition_id && definition.version==input.definition_version).ok_or(Failure::InvalidReference)?;
        let mut tx = state.pool.begin().await?;
        state.authorize(&mut tx, &headers, &actor).await?;
        sqlx::query("SELECT id FROM lab.labs WHERE id=$1::uuid FOR UPDATE").bind(&lab).fetch_optional(&mut *tx).await?.ok_or(Failure::WorldNotFound)?;
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM lab.entities WHERE lab_id=$1::uuid").bind(&lab).fetch_one(&mut *tx).await?;
        let node_count: i64 = sqlx::query_scalar("SELECT count(*) FROM lab.scene_nodes WHERE lab_id=$1::uuid").bind(&lab).fetch_one(&mut *tx).await?;
        if count >= 1000 || node_count >= 1000 { return Err(Failure::InvalidInput); }
        representation(&mut tx, input.representation_id.as_deref()).await?;
        let entity = uuid::Uuid::now_v7().to_string();
        let reality = match input.reality { EntityReality::Simulated => "simulated", EntityReality::Physical => "physical" };
        sqlx::query("INSERT INTO lab.entities(id,lab_id,name,kind,reality,definition_id,definition_version,definition,configuration,representation_id,created_by,updated_by) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$9,$10::uuid,$11::uuid,$11::uuid)")
            .bind(&entity).bind(&lab).bind(input.name.trim()).bind(&definition.category).bind(reality).bind(&definition.id).bind(&definition.version).bind(serde_json::to_value(&definition).map_err(|_| Failure::Unavailable)?).bind(json!(input.configuration)).bind(&input.representation_id).bind(&actor).execute(&mut *tx).await?;
        let placement = Placement { position: [(count % 5) as f64 * 1.5, 0.0, (count / 5) as f64 * 1.5], ..Default::default() };
        insert_node(&mut tx, &lab, &entity, input.representation_id.as_deref(), placement).await?;
        event(&mut tx, &actor, "lab.entity.register", &entity, &id).await?;
        let entity = load_entity(&mut tx, &lab, &entity).await?;
        tx.commit().await?;
        Ok::<_, Failure>(entity)
    }.await;
    match result {
        Ok(entity) => (StatusCode::CREATED, Json(entity)).into_response(),
        Err(error) => error.response(id),
    }
}
#[utoipa::path(get, path="/api/v1/lab/labs/{lab_id}/entities/{entity_id}", operation_id="getLabEntity", tag="Lab", params(("lab_id"=String, Path), ("entity_id"=String, Path)), responses((status=200, body=LabEntity), (status=400, body=crate::http::ApiErrorResponse), (status=401, body=crate::http::ApiErrorResponse), (status=403, body=crate::http::ApiErrorResponse), (status=404, body=crate::http::ApiErrorResponse), (status=503, body=crate::http::ApiErrorResponse)))]
async fn get_entity(
    State(state): State<Lab>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiPath((lab, entity)): ApiPath<(String, String)>,
) -> Response {
    if let Err(response) = state.actor(&headers, &id, false).await {
        return response;
    }
    let result = async {
        let lab = uuid(&lab)?.to_string();
        let entity = uuid(&entity)?.to_string();
        let mut connection = state.pool.acquire().await?;
        load_entity(&mut connection, &lab, &entity).await
    }
    .await;
    match result {
        Ok(entity) => Json(entity).into_response(),
        Err(error) => error.response(id),
    }
}
#[utoipa::path(patch, path="/api/v1/lab/labs/{lab_id}/entities/{entity_id}", operation_id="configureLabEntity", tag="Lab", params(("lab_id"=String, Path), ("entity_id"=String, Path)), request_body=ConfigureEntity, responses((status=200, body=LabEntity), (status=400, body=crate::http::ApiErrorResponse), (status=401, body=crate::http::ApiErrorResponse), (status=403, body=crate::http::ApiErrorResponse), (status=404, body=crate::http::ApiErrorResponse), (status=503, body=crate::http::ApiErrorResponse)))]
async fn configure_entity(
    State(state): State<Lab>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiPath((lab, entity)): ApiPath<(String, String)>,
    BoundedJson(input): BoundedJson<ConfigureEntity>,
) -> Response {
    let actor = match state.actor(&headers, &id, true).await {
        Ok(actor) => actor,
        Err(response) => return response,
    };
    let result = async {
        let lab = uuid(&lab)?.to_string(); let entity = uuid(&entity)?.to_string();
        if !valid_name(&input.name) || !valid_configuration(&input.configuration) { return Err(Failure::InvalidInput); }
        let mut tx = state.pool.begin().await?; state.authorize(&mut tx, &headers, &actor).await?;
        if sqlx::query("UPDATE lab.entities SET name=$3,configuration=$4,updated_by=$5::uuid,updated_at=now() WHERE lab_id=$1::uuid AND id=$2::uuid")
            .bind(&lab).bind(&entity).bind(input.name.trim()).bind(json!(input.configuration)).bind(&actor).execute(&mut *tx).await?.rows_affected()==0 { return Err(Failure::WorldNotFound); }
        event(&mut tx, &actor, "lab.entity.configure", &entity, &id).await?;
        let entity = load_entity(&mut tx,&lab,&entity).await?; tx.commit().await?; Ok::<_, Failure>(entity)
    }.await;
    match result {
        Ok(entity) => Json(entity).into_response(),
        Err(error) => error.response(id),
    }
}
async fn insert_node(
    connection: &mut PgConnection,
    lab: &str,
    entity: &str,
    representation: Option<&str>,
    placement: Placement,
) -> Result<SceneNode, Failure> {
    let node = uuid::Uuid::now_v7().to_string();
    let node = sqlx::query_as(&format!("INSERT INTO lab.scene_nodes(id,lab_id,entity_id,representation_id,placement) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5) RETURNING {NODE_COLUMNS}"))
        .bind(node).bind(lab).bind(entity).bind(representation).bind(json!(placement)).fetch_one(&mut *connection).await?;
    sqlx::query("UPDATE lab.labs SET layout_version=layout_version+1 WHERE id=$1::uuid")
        .bind(lab)
        .execute(connection)
        .await?;
    Ok(node)
}
#[utoipa::path(post, path="/api/v1/lab/labs/{lab_id}/nodes", operation_id="createLabSceneNode", tag="Lab", params(("lab_id"=String, Path)), request_body=CreateSceneNode, responses((status=201, body=SceneNode), (status=400, body=crate::http::ApiErrorResponse), (status=401, body=crate::http::ApiErrorResponse), (status=403, body=crate::http::ApiErrorResponse), (status=404, body=crate::http::ApiErrorResponse), (status=503, body=crate::http::ApiErrorResponse)))]
async fn create_node(
    State(state): State<Lab>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiPath(lab): ApiPath<String>,
    BoundedJson(input): BoundedJson<CreateSceneNode>,
) -> Response {
    let actor = match state.actor(&headers, &id, true).await {
        Ok(actor) => actor,
        Err(response) => return response,
    };
    let result = async {
        let lab = uuid(&lab)?.to_string();
        let entity = uuid(&input.entity_id)?.to_string();
        if input
            .placement
            .position
            .iter()
            .chain(input.placement.rotation.iter())
            .any(|value| !value.is_finite() || value.abs() > 10000.0)
            || input
                .placement
                .scale
                .iter()
                .any(|value| !value.is_finite() || *value < 0.001 || *value > 1000.0)
        {
            return Err(Failure::InvalidInput);
        }
        let mut tx = state.pool.begin().await?;
        state.authorize(&mut tx, &headers, &actor).await?;
        sqlx::query("SELECT id FROM lab.labs WHERE id=$1::uuid FOR UPDATE")
            .bind(&lab)
            .fetch_optional(&mut *tx)
            .await?
            .ok_or(Failure::WorldNotFound)?;
        load_entity(&mut tx, &lab, &entity)
            .await
            .map_err(|error| match error {
                Failure::WorldNotFound => Failure::InvalidReference,
                other => other,
            })?;
        representation(&mut tx, input.representation_id.as_deref()).await?;
        let count: i64 =
            sqlx::query_scalar("SELECT count(*) FROM lab.scene_nodes WHERE lab_id=$1::uuid")
                .bind(&lab)
                .fetch_one(&mut *tx)
                .await?;
        if count >= 1000 {
            return Err(Failure::InvalidInput);
        }
        let node = insert_node(
            &mut tx,
            &lab,
            &entity,
            input.representation_id.as_deref(),
            input.placement,
        )
        .await?;
        event(&mut tx, &actor, "lab.node.create", &node.id, &id).await?;
        tx.commit().await?;
        Ok::<_, Failure>(node)
    }
    .await;
    match result {
        Ok(node) => (StatusCode::CREATED, Json(node)).into_response(),
        Err(error) => error.response(id),
    }
}
#[utoipa::path(post, path="/api/v1/lab/labs/{lab_id}/entities/{entity_id}/actions", operation_id="invokeLabEntityAction", tag="Lab", params(("lab_id"=String, Path), ("entity_id"=String, Path)), request_body=EntityAction, responses((status=400, body=crate::http::ApiErrorResponse), (status=401, body=crate::http::ApiErrorResponse), (status=403, body=crate::http::ApiErrorResponse), (status=404, body=crate::http::ApiErrorResponse), (status=422, body=crate::http::ApiErrorResponse), (status=503, body=crate::http::ApiErrorResponse)))]
async fn entity_action(
    State(state): State<Lab>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiPath((lab, entity)): ApiPath<(String, String)>,
    BoundedJson(input): BoundedJson<EntityAction>,
) -> Response {
    let actor = match state.actor(&headers, &id, true).await {
        Ok(actor) => actor,
        Err(response) => return response,
    };
    let result = async {
        let lab = uuid(&lab)?.to_string();
        let entity = uuid(&entity)?.to_string();
        if !input.parameters.is_object() {
            return Err(Failure::InvalidInput);
        }
        let mut tx = state.pool.begin().await?;
        state.authorize(&mut tx, &headers, &actor).await?;
        let entity = load_entity(&mut tx, &lab, &entity).await?;
        if !entity
            .capabilities
            .iter()
            .any(|capability| capability.id == input.capability)
        {
            return Err(Failure::InvalidInput);
        }
        Err::<(), _>(Failure::NotImplemented)
    }
    .await;
    match result {
        Err(error) => error.response(id),
        Ok(()) => unreachable!(),
    }
}
