use super::Lab;
use crate::http::{ApiPath, RequestId};
use axum::{
    Extension, Json, Router,
    extract::State,
    http::HeaderMap,
    response::{IntoResponse, Response},
    routing::get,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::{OpenApi, ToSchema};

#[derive(Serialize, Deserialize, ToSchema)]
pub struct DefinitionCapability {
    pub id: String,
    pub parameters: Value,
    pub implemented: bool,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct DefinitionInterface {
    pub id: String,
    pub implemented: bool,
}

#[derive(Serialize, Deserialize, ToSchema)]
pub struct AssetDefinition {
    pub id: String,
    pub version: String,
    pub name: String,
    pub name_en: String,
    pub category: String,
    pub specifications: Value,
    pub capabilities: Vec<DefinitionCapability>,
    pub state: Value,
    pub interfaces: Vec<DefinitionInterface>,
}

#[derive(Serialize, ToSchema)]
struct DefinitionPage {
    data: Vec<AssetDefinition>,
}

fn catalog() -> Vec<AssetDefinition> {
    serde_json::from_str(include_str!("definitions.json")).expect("checked built-in catalog")
}

pub(super) fn routes() -> Router<Lab> {
    Router::new()
        .route("/api/v1/lab/asset-definitions", get(list_definitions))
        .route(
            "/api/v1/lab/asset-definitions/{id}/{version}",
            get(get_definition),
        )
}

#[derive(OpenApi)]
#[openapi(paths(list_definitions, get_definition))]
struct DefinitionApi;
pub(super) fn openapi() -> utoipa::openapi::OpenApi {
    DefinitionApi::openapi()
}

#[utoipa::path(get, path = "/api/v1/lab/asset-definitions", operation_id = "listAssetDefinitions", tag = "Lab", responses((status = 200, body = DefinitionPage), (status = 401, body = crate::http::ApiErrorResponse), (status = 403, body = crate::http::ApiErrorResponse), (status = 503, body = crate::http::ApiErrorResponse)))]
async fn list_definitions(
    State(state): State<Lab>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
) -> Response {
    if let Err(response) = state.actor(&headers, &id, false).await {
        return response;
    }
    Json(DefinitionPage { data: catalog() }).into_response()
}

#[utoipa::path(get, path = "/api/v1/lab/asset-definitions/{id}/{version}", operation_id = "getAssetDefinition", tag = "Lab", params(("id" = String, Path), ("version" = String, Path)), responses((status = 200, body = AssetDefinition), (status = 401, body = crate::http::ApiErrorResponse), (status = 403, body = crate::http::ApiErrorResponse), (status = 404, body = crate::http::ApiErrorResponse), (status = 503, body = crate::http::ApiErrorResponse)))]
async fn get_definition(
    State(state): State<Lab>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiPath((definition_id, version)): ApiPath<(String, String)>,
) -> Response {
    if let Err(response) = state.actor(&headers, &id, false).await {
        return response;
    }
    match catalog()
        .into_iter()
        .find(|definition| definition.id == definition_id && definition.version == version)
    {
        Some(definition) => Json(definition).into_response(),
        None => super::Failure::NotFound.response(id),
    }
}
