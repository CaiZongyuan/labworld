use super::{Failure, Lab, world};
use crate::http::{ApiPath, ApiQuery, RequestId};
use axum::{
    Extension, Json, Router,
    extract::State,
    http::HeaderMap,
    response::{IntoResponse, Response},
    routing::get,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use utoipa::{IntoParams, OpenApi, ToSchema};

const MAX_POINTS: u32 = 1000;
const DEFAULT_POINTS: u32 = 600;
const MAX_BYTES: usize = 256 * 1024;
const MAX_RANGE_SECONDS: i64 = 86400;

#[derive(Deserialize, IntoParams)]
#[into_params(parameter_in=Query)]
#[serde(deny_unknown_fields)]
pub struct TrendQuery {
    pub property: String,
    pub from: DateTime<Utc>,
    pub to: DateTime<Utc>,
    #[param(minimum = 1, maximum = 1000, default = 600)]
    pub max_points: Option<u32>,
}
#[derive(Serialize, Deserialize, ToSchema)]
pub struct TrendSample {
    pub id: String,
    #[schema(value_type=f64)]
    pub value: Value,
    pub sequence: i64,
    pub observed_at: Option<DateTime<Utc>>,
    pub received_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
}
#[derive(Serialize, Deserialize, ToSchema)]
pub struct TrendSegment {
    pub binding_id: String,
    pub run_id: String,
    pub source: String,
    pub quality: String,
    pub unit: Option<String>,
    pub source_time_known: bool,
    pub resolution_seconds: f64,
    pub samples: Vec<TrendSample>,
}
#[derive(Serialize, Deserialize, ToSchema)]
pub struct TrendGap {
    pub from: DateTime<Utc>,
    pub to: DateTime<Utc>,
    pub reasons: Vec<String>,
}
#[derive(Serialize, ToSchema)]
pub struct EntityTrend {
    pub property: String,
    pub from: DateTime<Utc>,
    pub to: DateTime<Utc>,
    pub max_points: u32,
    pub raw_sample_count: usize,
    pub returned_sample_count: usize,
    pub plot_item_count: usize,
    pub sampling_strategy: String,
    pub segments: Vec<TrendSegment>,
    pub gaps: Vec<TrendGap>,
    pub first_report_at: Option<DateTime<Utc>>,
    pub last_report_at: Option<DateTime<Utc>>,
    pub retained_since: DateTime<Utc>,
    pub captured_since: DateTime<Utc>,
    pub available_since: DateTime<Utc>,
    pub observation_retention_seconds: u32,
    pub max_response_bytes: usize,
    pub max_range_seconds: i64,
}
#[derive(Deserialize)]
struct TrendRead {
    raw_sample_count: usize,
    returned_sample_count: usize,
    plot_item_count: usize,
    budget_exceeded: bool,
    first_report_at: Option<DateTime<Utc>>,
    last_report_at: Option<DateTime<Utc>>,
    segments: Vec<TrendSegment>,
    gaps: Vec<TrendGap>,
}
pub(super) fn routes() -> Router<Lab> {
    Router::new().route(
        "/api/v1/lab/labs/{lab_id}/entities/{entity_id}/trend",
        get(get_trend),
    )
}
#[derive(OpenApi)]
#[openapi(paths(get_trend))]
struct TrendApi;
pub(super) fn openapi() -> utoipa::openapi::OpenApi {
    TrendApi::openapi()
}

#[utoipa::path(get,path="/api/v1/lab/labs/{lab_id}/entities/{entity_id}/trend",operation_id="getLabEntityTrend",tag="Lab",params(("lab_id"=String,Path),("entity_id"=String,Path),TrendQuery),responses((status=200,body=EntityTrend),(status=400,body=crate::http::ApiErrorResponse),(status=401,body=crate::http::ApiErrorResponse),(status=403,body=crate::http::ApiErrorResponse),(status=404,body=crate::http::ApiErrorResponse),(status=413,body=crate::http::ApiErrorResponse),(status=503,body=crate::http::ApiErrorResponse)))]
async fn get_trend(
    State(state): State<Lab>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiPath((lab, entity)): ApiPath<(String, String)>,
    ApiQuery(query): ApiQuery<TrendQuery>,
) -> Response {
    if let Err(response) = state.actor(&headers, &id, false).await {
        return response;
    }
    let result = query_trend(&state, &lab, &entity, query).await;
    match result {
        Ok(trend) => Json(trend).into_response(),
        Err(error) => error.response(id),
    }
}
async fn query_trend(
    state: &Lab,
    lab: &str,
    entity: &str,
    query: TrendQuery,
) -> Result<EntityTrend, Failure> {
    world::uuid(lab)?;
    world::uuid(entity)?;
    let max_points = query.max_points.unwrap_or(DEFAULT_POINTS);
    if query.from >= query.to
        || query.to - query.from > chrono::Duration::seconds(MAX_RANGE_SECONDS)
        || !(1..=MAX_POINTS).contains(&max_points)
    {
        return Err(Failure::InvalidInput);
    }
    let mut tx = state.pool.begin().await?;
    sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
        .execute(&mut *tx)
        .await?;
    let device = world::load_entity(&mut tx, lab, entity).await?;
    if !matches!(query.property.as_str(), "temperature" | "speed") {
        return Err(Failure::InvalidInput);
    }
    if device.definition.state["properties"][&query.property]["type"] != "number" {
        let historical_numeric:bool=sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM lab.runtime_bindings WHERE entity_id=$1::uuid AND definition->'state'->'properties'->$2->>'type'='number')")
            .bind(entity).bind(&query.property).fetch_one(&mut *tx).await?;
        if !historical_numeric {
            return Err(Failure::InvalidInput);
        }
    }
    let (captured_since,cleaned_before):(DateTime<Utc>,Option<DateTime<Utc>>)=sqlx::query_as("SELECT captured_since,cleaned_before FROM lab.history_bounds WHERE entity_id=$1::uuid AND record_type='observation'").bind(entity).fetch_one(&mut *tx).await?;
    let cutoff =
        Utc::now() - chrono::Duration::seconds(i64::from(state.retention.observation_seconds));
    let retained_since = cutoff.max(cleaned_before.unwrap_or(cutoff));
    let clocks = json!({"from":query_clock(query.from),"to":query_clock(query.to),"retained":query_clock(retained_since),"captured":query_clock(captured_since)});
    let sqlx::types::Json(read): sqlx::types::Json<TrendRead> =
        sqlx::query_scalar(include_str!("trend.sql"))
            .bind(entity)
            .bind(&query.property)
            .bind(query.from)
            .bind(query.to)
            .bind(i64::from(max_points))
            .bind(retained_since)
            .bind(captured_since)
            .bind(clocks)
            .fetch_one(&mut *tx)
            .await?;
    if read.budget_exceeded {
        return Err(Failure::TrendBudgetExceeded);
    }
    tx.commit().await?;
    let trend = EntityTrend {
        property: query.property,
        from: query.from,
        to: query.to,
        max_points,
        raw_sample_count: read.raw_sample_count,
        returned_sample_count: read.returned_sample_count,
        plot_item_count: read.plot_item_count,
        sampling_strategy: "first_last_min_max".into(),
        segments: read.segments,
        gaps: read.gaps,
        first_report_at: read.first_report_at,
        last_report_at: read.last_report_at,
        retained_since,
        captured_since,
        available_since: retained_since.max(captured_since),
        observation_retention_seconds: state.retention.observation_seconds,
        max_response_bytes: MAX_BYTES,
        max_range_seconds: MAX_RANGE_SECONDS,
    };
    if serde_json::to_vec(&trend)
        .map_err(|_| Failure::Unavailable)?
        .len()
        > MAX_BYTES
    {
        return Err(Failure::TrendBudgetExceeded);
    }
    Ok(trend)
}
fn query_clock(at: DateTime<Utc>) -> Value {
    json!({"seconds":at.timestamp(),"nanos":at.timestamp_subsec_nanos(),"value":at})
}
