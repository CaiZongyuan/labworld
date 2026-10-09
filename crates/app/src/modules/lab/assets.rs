use super::{Failure, Lab};
use crate::modules::idempotency;
use crate::{
    http::{ApiPath, ApiQuery, BoundedJson, RequestId},
    modules::{
        audit,
        files::{
            self, CompletionPlan, DownloadCapability, Publication, UploadCapability, UploadInput,
        },
    },
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
use utoipa::{OpenApi, ToSchema};

#[derive(Serialize, Deserialize, ToSchema)]
pub struct AssetRepresentation {
    pub id: String,
    pub file_id: String,
    pub file_name: String,
    pub size: i64,
    pub sha256: String,
    pub content_type: String,
}

#[derive(Serialize, Deserialize, ToSchema, sqlx::FromRow)]
pub struct LabAsset {
    pub id: String,
    pub name: String,
    pub source: String,
    pub license: String,
    pub version: String,
    pub created_by: String,
    pub updated_by: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
    #[sqlx(json)]
    pub representation: AssetRepresentation,
}

#[derive(Serialize, ToSchema)]
pub struct AssetPage {
    pub data: Vec<LabAsset>,
    pub next_cursor: Option<String>,
    pub has_more: bool,
    pub max_upload_bytes: i64,
    pub max_decoded_resource_bytes: i64,
}

#[derive(Deserialize, Serialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct CreateAssetUpload {
    pub name: String,
    pub source: String,
    pub license: String,
    pub version: String,
    pub file: UploadInput,
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct RenameAsset {
    pub name: String,
}

#[derive(Deserialize, utoipa::IntoParams)]
#[into_params(parameter_in = Query)]
struct PageQuery {
    #[param(minimum = 1, maximum = 100, default = 50)]
    limit: Option<u32>,
    cursor: Option<String>,
}

const COLUMNS: &str = "a.id::text, a.name, a.source, a.license, a.version, a.created_by::text, a.updated_by::text, a.created_at, a.updated_at, jsonb_build_object('id', r.id, 'file_id', r.file_id, 'file_name', r.file_name, 'size', r.size, 'sha256', r.sha256, 'content_type', r.content_type) AS representation";
const JOIN: &str = "lab.assets a JOIN lab.asset_representations r ON r.asset_id = a.id";

pub(super) fn routes() -> Router<Lab> {
    Router::new()
        .route("/api/v1/lab/assets", get(list_assets))
        .route(
            "/api/v1/lab/assets/{id}",
            get(get_asset).patch(rename_asset).delete(delete_asset),
        )
        .route("/api/v1/lab/assets/{id}/download", get(download_asset))
        .route("/api/v1/lab/asset-uploads", post(start_upload))
        .route(
            "/api/v1/lab/asset-uploads/{id}/complete",
            post(complete_upload),
        )
        .layer(DefaultBodyLimit::max(16 * 1024))
}

#[derive(OpenApi)]
#[openapi(paths(
    list_assets,
    get_asset,
    rename_asset,
    delete_asset,
    start_upload,
    complete_upload,
    download_asset
))]
struct AssetApi;
pub(super) fn openapi() -> utoipa::openapi::OpenApi {
    AssetApi::openapi()
}

fn uuid(id: &str) -> Result<uuid::Uuid, Failure> {
    uuid::Uuid::parse_str(id).map_err(|_| Failure::NotFound)
}
fn valid_text(text: &str, max: usize, required: bool) -> bool {
    (!required || !text.trim().is_empty())
        && text.chars().count() <= max
        && !text.chars().any(char::is_control)
}

async fn load(connection: &mut sqlx::PgConnection, id: &str) -> Result<LabAsset, Failure> {
    sqlx::query_as(&format!(
        "SELECT {COLUMNS} FROM {JOIN} WHERE a.id = $1::uuid"
    ))
    .bind(id)
    .fetch_one(connection)
    .await
    .map_err(Into::into)
}

pub(super) async fn load_representations(
    connection: &mut sqlx::PgConnection,
    ids: &[String],
) -> Result<Vec<LabAsset>, Failure> {
    sqlx::query_as(&format!(
        "SELECT {COLUMNS} FROM {JOIN} WHERE r.id::text=ANY($1) ORDER BY a.id"
    ))
    .bind(ids)
    .fetch_all(connection)
    .await
    .map_err(Into::into)
}

#[utoipa::path(get, path = "/api/v1/lab/assets", operation_id = "listLabAssets", tag = "Lab", params(PageQuery), responses((status = 200, body = AssetPage), (status = 400, body = crate::http::ApiErrorResponse), (status = 401, body = crate::http::ApiErrorResponse), (status = 403, body = crate::http::ApiErrorResponse), (status = 503, body = crate::http::ApiErrorResponse)))]
async fn list_assets(
    State(state): State<Lab>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiQuery(query): ApiQuery<PageQuery>,
) -> Response {
    if let Err(response) = state.actor(&headers, &id, false).await {
        return response;
    }
    let limit = query.limit.unwrap_or(50);
    let cursor = match query.cursor.as_deref().map(uuid).transpose() {
        Ok(cursor) if (1..=100).contains(&limit) => cursor,
        _ => return Failure::InvalidInput.response(id),
    };
    let result = sqlx::query_as::<_, LabAsset>(&format!("SELECT {COLUMNS} FROM {JOIN} WHERE ($1::uuid IS NULL OR a.id < $1::uuid) ORDER BY a.id DESC LIMIT $2"))
        .bind(cursor.map(|id| id.to_string())).bind(i64::from(limit) + 1).fetch_all(&state.pool).await;
    match result {
        Ok(mut data) => {
            let has_more = data.len() > limit as usize;
            data.truncate(limit as usize);
            let next_cursor = if has_more {
                data.last().map(|asset| asset.id.clone())
            } else {
                None
            };
            Json(AssetPage {
                data,
                has_more,
                next_cursor,
                max_upload_bytes: state
                    .files
                    .as_ref()
                    .map_or(0, |files| files.policy.max_bytes),
                max_decoded_resource_bytes: super::glb::MAX_DECODED_RESOURCE_BYTES as i64,
            })
            .into_response()
        }
        Err(error) => Failure::from(error).response(id),
    }
}

#[utoipa::path(get, path = "/api/v1/lab/assets/{id}", operation_id = "getLabAsset", tag = "Lab", params(("id" = String, Path)), responses((status = 200, body = LabAsset), (status = 401, body = crate::http::ApiErrorResponse), (status = 403, body = crate::http::ApiErrorResponse), (status = 404, body = crate::http::ApiErrorResponse), (status = 503, body = crate::http::ApiErrorResponse)))]
async fn get_asset(
    State(state): State<Lab>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiPath(asset_id): ApiPath<String>,
) -> Response {
    if let Err(response) = state.actor(&headers, &id, false).await {
        return response;
    }
    let result = async {
        let asset_id = uuid(&asset_id)?.to_string();
        let mut connection = state.pool.acquire().await?;
        load(&mut connection, &asset_id).await
    }
    .await;
    match result {
        Ok(asset) => Json(asset).into_response(),
        Err(error) => error.response(id),
    }
}

async fn event(
    connection: &mut sqlx::PgConnection,
    actor_id: &str,
    action: &str,
    asset_id: &str,
    request_id: &str,
) -> Result<(), Failure> {
    audit::append(
        connection,
        audit::Event {
            actor_id,
            action,
            resource_type: "lab.asset",
            resource_id: asset_id,
            source: audit::Source::Request(request_id),
            subject_user_id: None,
        },
    )
    .await?;
    Ok(())
}

#[utoipa::path(post, path = "/api/v1/lab/asset-uploads", operation_id = "startAssetUpload", tag = "Lab", request_body = CreateAssetUpload, params(("x-csrf-token" = String, Header), ("idempotency-key" = String, Header)), responses((status = 201, body = UploadCapability), (status = 400, body = crate::http::ApiErrorResponse), (status = 401, body = crate::http::ApiErrorResponse), (status = 403, body = crate::http::ApiErrorResponse), (status = 404, body = crate::http::ApiErrorResponse), (status = 409, body = crate::http::ApiErrorResponse), (status = 410, body = crate::http::ApiErrorResponse), (status = 413, body = crate::http::ApiErrorResponse), (status = 422, body = crate::http::ApiErrorResponse), (status = 503, body = crate::http::ApiErrorResponse)))]
async fn start_upload(
    State(state): State<Lab>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    BoundedJson(mut input): BoundedJson<CreateAssetUpload>,
) -> Response {
    let actor = match state.actor(&headers, &id, true).await {
        Ok(actor) => actor,
        Err(response) => return response,
    };
    let Some(files) = &state.files else {
        return files::Error::Unavailable.response(id);
    };
    input.name = input.name.trim().to_owned();
    if !valid_text(&input.name, 120, true)
        || !valid_text(&input.source, 2048, false)
        || !valid_text(&input.license, 200, false)
        || !valid_text(&input.version, 80, true)
        || !input.file.file_name.to_ascii_lowercase().ends_with(".glb")
        || input.file.content_type != "model/gltf-binary"
    {
        return Failure::InvalidInput.response(id);
    }
    if let Err(error) = files.validate(&mut input.file) {
        return error.response(id);
    }
    let Some(key) = headers
        .get("idempotency-key")
        .and_then(|value| value.to_str().ok())
    else {
        return Failure::Idempotency(idempotency::Error::InvalidKey).response(id);
    };
    let result = async {
        let mut tx = state.pool.begin().await?;
        state.authorize(&mut tx, &headers, &actor).await?;
        let fingerprint = idempotency::fingerprint(&input)?;
        let attempt = idempotency::Attempt { actor_id: &actor, scope: "POST /api/v1/lab/asset-uploads", key, fingerprint: &fingerprint };
        if let Some(previous) = idempotency::claim(&mut tx, &attempt).await? {
            let upload_id = previous["upload_id"].as_str().ok_or(Failure::Unavailable)?;
            associated(&mut tx, upload_id).await?;
            let upload = files.load(&mut tx, upload_id).await?;
            tx.commit().await?;
            return Ok(upload);
        }
        let upload = files.start(&mut tx, &actor, &input.file).await?;
        sqlx::query("INSERT INTO lab.asset_uploads (upload_id, asset_id, name, source, license, version, created_by) VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::uuid)")
            .bind(&upload.id).bind(uuid::Uuid::now_v7().to_string()).bind(&input.name).bind(&input.source).bind(&input.license).bind(&input.version).bind(&actor).execute(&mut *tx).await?;
        idempotency::complete(&mut tx, &attempt, serde_json::json!({"upload_id":upload.id})).await?;
        tx.commit().await?;
        Ok::<_, Failure>(upload)
    }.await;
    match result {
        Ok(upload) => match files.upload_capability(&upload).await {
            Ok(capability) => (StatusCode::CREATED, Json(capability)).into_response(),
            Err(error) => error.response(id),
        },
        Err(error) => error.response(id),
    }
}

async fn associated(
    connection: &mut sqlx::PgConnection,
    upload_id: &str,
) -> Result<String, Failure> {
    sqlx::query_scalar(
        "SELECT asset_id::text FROM lab.asset_uploads WHERE upload_id = $1::uuid FOR SHARE",
    )
    .bind(upload_id)
    .fetch_one(connection)
    .await
    .map_err(Into::into)
}

async fn abandon(state: &Lab, attempt: &files::CompletionAttempt, rejected: bool) {
    let _ = tokio::time::timeout(std::time::Duration::from_secs(3), async {
        let mut tx = state.pool.begin().await?;
        state
            .files
            .as_ref()
            .ok_or(files::Error::Unavailable)?
            .abandon(&mut tx, attempt, rejected)
            .await?;
        tx.commit().await?;
        Ok::<_, files::Error>(())
    })
    .await;
}

#[utoipa::path(post, path = "/api/v1/lab/asset-uploads/{id}/complete", operation_id = "completeAssetUpload", tag = "Lab", params(("id" = String, Path), ("x-csrf-token" = String, Header)), responses((status = 200, body = LabAsset), (status = 400, body = crate::http::ApiErrorResponse), (status = 401, body = crate::http::ApiErrorResponse), (status = 403, body = crate::http::ApiErrorResponse), (status = 404, body = crate::http::ApiErrorResponse), (status = 409, body = crate::http::ApiErrorResponse), (status = 410, body = crate::http::ApiErrorResponse), (status = 413, body = crate::http::ApiErrorResponse), (status = 422, body = crate::http::ApiErrorResponse), (status = 503, body = crate::http::ApiErrorResponse)))]
async fn complete_upload(
    State(state): State<Lab>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiPath(upload_id): ApiPath<String>,
) -> Response {
    let actor = match state.actor(&headers, &id, true).await {
        Ok(actor) => actor,
        Err(response) => return response,
    };
    let Some(files) = &state.files else {
        return files::Error::Unavailable.response(id);
    };
    let upload_id = match uuid(&upload_id) {
        Ok(value) => value.to_string(),
        Err(error) => return error.response(id),
    };
    let plan = async {
        let mut tx = state.pool.begin().await?;
        state.authorize(&mut tx, &headers, &actor).await?;
        let asset_id = associated(&mut tx, &upload_id).await?;
        let plan = files.plan_completion(&mut tx, &upload_id).await?;
        let ready = if matches!(plan, CompletionPlan::Ready(_)) {
            Some(load(&mut tx, &asset_id).await?)
        } else {
            None
        };
        tx.commit().await?;
        Ok::<_, Failure>((plan, ready))
    }
    .await;
    let attempt = match plan {
        Ok((_, Some(asset))) => return Json(asset).into_response(),
        Ok((CompletionPlan::Attempt(attempt), _)) => attempt,
        Ok((CompletionPlan::Expired, _)) => return files::Error::Expired.response(id),
        Ok((CompletionPlan::Rejected, _)) => return files::Error::Rejected.response(id),
        Ok(_) => return Failure::Unavailable.response(id),
        Err(error) => return error.response(id),
    };
    let verified = match files
        .verify_candidate_with(&attempt, super::glb::valid)
        .await
    {
        Ok(verified) => verified,
        Err(error) => {
            abandon(
                &state,
                &attempt,
                matches!(error, files::Error::Rejected | files::Error::TooLarge),
            )
            .await;
            return error.response(id);
        }
    };
    if let Err(response) = state.actor(&headers, &id, true).await {
        abandon(&state, &attempt, false).await;
        return response;
    }
    let result = async {
        let mut tx = state.pool.begin().await?;
        state.authorize(&mut tx, &headers, &actor).await?;
        let asset_id = associated(&mut tx, &upload_id).await?;
        match files.publish(&mut tx, &verified).await? {
            Publication::Adopted(file) => {
                sqlx::query("INSERT INTO lab.assets (id, name, source, license, version, created_by, updated_by) SELECT asset_id, name, source, license, version, created_by, $2::uuid FROM lab.asset_uploads WHERE upload_id = $1::uuid")
                    .bind(&upload_id).bind(&actor).execute(&mut *tx).await?;
                sqlx::query("INSERT INTO lab.asset_representations (id, asset_id, file_id, file_name, size, sha256, content_type) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7)")
                    .bind(uuid::Uuid::now_v7().to_string()).bind(&asset_id).bind(&file.id).bind(&file.file_name).bind(file.size).bind(&file.sha256).bind(&file.content_type).execute(&mut *tx).await?;
                event(&mut tx, &actor, "lab.asset.publish", &asset_id, &id.0).await?;
            }
            Publication::Existing(_) => {},
            Publication::Expired => { tx.commit().await?; return Err(files::Error::Expired.into()); }
        }
        let asset = load(&mut tx, &asset_id).await?;
        tx.commit().await?;
        Ok::<_, Failure>(asset)
    }.await;
    match result {
        Ok(asset) => Json(asset).into_response(),
        Err(error) => {
            abandon(&state, &attempt, false).await;
            error.response(id)
        }
    }
}

#[utoipa::path(patch, path = "/api/v1/lab/assets/{id}", operation_id = "renameLabAsset", tag = "Lab", request_body = RenameAsset, params(("id" = String, Path), ("x-csrf-token" = String, Header)), responses((status = 200, body = LabAsset), (status = 400, body = crate::http::ApiErrorResponse), (status = 401, body = crate::http::ApiErrorResponse), (status = 403, body = crate::http::ApiErrorResponse), (status = 404, body = crate::http::ApiErrorResponse), (status = 503, body = crate::http::ApiErrorResponse)))]
async fn rename_asset(
    State(state): State<Lab>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiPath(asset_id): ApiPath<String>,
    BoundedJson(input): BoundedJson<RenameAsset>,
) -> Response {
    let actor = match state.actor(&headers, &id, true).await {
        Ok(actor) => actor,
        Err(response) => return response,
    };
    if !valid_text(&input.name, 120, true) {
        return Failure::InvalidInput.response(id);
    }
    let result = async {
        let asset_id = uuid(&asset_id)?.to_string();
        let mut tx = state.pool.begin().await?;
        state.authorize(&mut tx, &headers, &actor).await?;
        let result = sqlx::query("UPDATE lab.assets SET name = $2, updated_by = $3::uuid, updated_at = now() WHERE id = $1::uuid")
            .bind(&asset_id).bind(input.name.trim()).bind(&actor).execute(&mut *tx).await?;
        if result.rows_affected() != 1 { return Err(Failure::NotFound); }
        event(&mut tx, &actor, "lab.asset.rename", &asset_id, &id.0).await?;
        let asset = load(&mut tx, &asset_id).await?;
        tx.commit().await?;
        Ok::<_, Failure>(asset)
    }.await;
    match result {
        Ok(asset) => Json(asset).into_response(),
        Err(error) => error.response(id),
    }
}

#[utoipa::path(delete, path = "/api/v1/lab/assets/{id}", operation_id = "deleteLabAsset", tag = "Lab", params(("id" = String, Path), ("x-csrf-token" = String, Header)), responses((status = 204), (status = 401, body = crate::http::ApiErrorResponse), (status = 403, body = crate::http::ApiErrorResponse), (status = 404, body = crate::http::ApiErrorResponse), (status = 409, body = crate::http::ApiErrorResponse), (status = 503, body = crate::http::ApiErrorResponse)))]
async fn delete_asset(
    State(state): State<Lab>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiPath(asset_id): ApiPath<String>,
) -> Response {
    let actor = match state.actor(&headers, &id, true).await {
        Ok(actor) => actor,
        Err(response) => return response,
    };
    let result = async {
        let asset_id = uuid(&asset_id)?.to_string();
        let mut tx = state.pool.begin().await?;
        state.authorize(&mut tx, &headers, &actor).await?;
        sqlx::query("SELECT id FROM lab.assets WHERE id = $1::uuid FOR UPDATE")
            .bind(&asset_id)
            .fetch_one(&mut *tx)
            .await?;
        let asset = load(&mut tx, &asset_id).await?;
        sqlx::query("DELETE FROM lab.assets WHERE id = $1::uuid")
            .bind(&asset_id)
            .execute(&mut *tx)
            .await?;
        files::mark_deleting(&mut tx, &asset.representation.file_id, &id.0).await?;
        event(&mut tx, &actor, "lab.asset.delete", &asset_id, &id.0).await?;
        tx.commit().await?;
        Ok::<_, Failure>(())
    }
    .await;
    match result {
        Ok(()) => StatusCode::NO_CONTENT.into_response(),
        Err(error) => error.response(id),
    }
}

#[utoipa::path(get, path = "/api/v1/lab/assets/{id}/download", operation_id = "getLabAssetDownload", tag = "Lab", params(("id" = String, Path)), responses((status = 200, body = DownloadCapability), (status = 401, body = crate::http::ApiErrorResponse), (status = 403, body = crate::http::ApiErrorResponse), (status = 404, body = crate::http::ApiErrorResponse), (status = 503, body = crate::http::ApiErrorResponse)))]
async fn download_asset(
    State(state): State<Lab>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiPath(asset_id): ApiPath<String>,
) -> Response {
    let actor = match state.actor(&headers, &id, false).await {
        Ok(actor) => actor,
        Err(response) => return response,
    };
    let Some(files) = &state.files else {
        return files::Error::Unavailable.response(id);
    };
    let result = async {
        let asset_id = uuid(&asset_id)?.to_string();
        let mut tx = state.pool.begin().await?;
        state.authorize(&mut tx, &headers, &actor).await?;
        sqlx::query("SELECT id FROM lab.assets WHERE id = $1::uuid FOR SHARE")
            .bind(&asset_id)
            .fetch_one(&mut *tx)
            .await?;
        let asset = load(&mut tx, &asset_id).await?;
        let capability = files
            .download(&mut tx, &asset.representation.file_id, false)
            .await?;
        tx.commit().await?;
        Ok::<_, Failure>(capability)
    }
    .await;
    match result {
        Ok(capability) => Json(capability).into_response(),
        Err(error) => error.response(id),
    }
}
