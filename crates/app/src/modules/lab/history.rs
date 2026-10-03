use super::{Failure, Lab, world};
use crate::http::{ApiPath, ApiQuery, RequestId};
use axum::{
    Extension, Json, Router,
    extract::State,
    http::HeaderMap,
    response::{IntoResponse, Response},
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::{IntoParams, OpenApi, ToSchema};
pub mod retention;
use retention::{HistoryCleanup, RetentionPolicy};
pub const MAX_RANGE_SECONDS: i64 = 31 * 86400;
pub const MAX_RESPONSE_BYTES: usize = 256 * 1024;

#[derive(Clone, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HistoryRecordType {
    Observation,
    Command,
    Task,
    Event,
}
impl HistoryRecordType {
    fn name(&self) -> &'static str {
        match self {
            Self::Observation => "observation",
            Self::Command => "command",
            Self::Task => "task",
            Self::Event => "event",
        }
    }
}

#[derive(Deserialize, IntoParams)]
#[into_params(parameter_in=Query)]
#[serde(deny_unknown_fields)]
pub struct HistoryQuery {
    pub record_type: HistoryRecordType,
    pub from: DateTime<Utc>,
    pub to: DateTime<Utc>,
    #[param(minimum = 1, maximum = 100, default = 20)]
    pub limit: Option<u32>,
    #[param(max_length = 2048)]
    pub cursor: Option<String>,
}
#[derive(Serialize, ToSchema, sqlx::FromRow)]
pub struct HistoryRecord {
    pub id: String,
    pub entity_id: String,
    pub run_id: String,
    pub recorded_at: DateTime<Utc>,
    pub observed_at: Option<DateTime<Utc>>,
    pub received_at: DateTime<Utc>,
    pub data: Value,
}
#[derive(Serialize, ToSchema)]
pub struct HistoryPage {
    pub record_type: HistoryRecordType,
    pub from: DateTime<Utc>,
    pub to: DateTime<Utc>,
    pub available_since: DateTime<Utc>,
    pub gap: bool,
    pub retention: RetentionPolicy,
    pub max_range_seconds: i64,
    pub max_response_bytes: usize,
    pub items: Vec<HistoryRecord>,
    pub next_cursor: Option<String>,
}
#[derive(Serialize, Deserialize)]
struct Cursor {
    entity: String,
    kind: HistoryRecordType,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    time: DateTime<Utc>,
    id: String,
}
pub(super) fn routes() -> Router<Lab> {
    Router::new()
        .route(
            "/api/v1/lab/labs/{lab_id}/entities/{entity_id}/history",
            get(list_history),
        )
        .route(
            "/api/v1/lab/labs/{lab_id}/history/retention",
            get(get_retention),
        )
        .route(
            "/api/v1/lab/labs/{lab_id}/history/cleanup",
            post(cleanup_history),
        )
}
#[derive(OpenApi)]
#[openapi(paths(list_history, get_retention, cleanup_history))]
struct HistoryApi;
pub(super) fn openapi() -> utoipa::openapi::OpenApi {
    HistoryApi::openapi()
}

#[utoipa::path(get,path="/api/v1/lab/labs/{lab_id}/entities/{entity_id}/history",operation_id="listLabDeviceHistory",tag="Lab",params(("lab_id"=String,Path),("entity_id"=String,Path),HistoryQuery),responses((status=200,body=HistoryPage),(status=400,body=crate::http::ApiErrorResponse),(status=401,body=crate::http::ApiErrorResponse),(status=403,body=crate::http::ApiErrorResponse),(status=404,body=crate::http::ApiErrorResponse),(status=503,body=crate::http::ApiErrorResponse)))]
async fn list_history(
    State(state): State<Lab>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiPath((lab, entity)): ApiPath<(String, String)>,
    ApiQuery(query): ApiQuery<HistoryQuery>,
) -> Response {
    if let Err(response) = state.actor(&headers, &id, false).await {
        return response;
    }
    let result=async {
        world::uuid(&lab)?; world::uuid(&entity)?;
        let limit=query.limit.unwrap_or(20);
        if !(1..=100).contains(&limit) || query.from>=query.to || query.to-query.from>chrono::Duration::seconds(MAX_RANGE_SECONDS) { return Err(Failure::InvalidInput); }
        let cursor=query.cursor.as_ref().map(|encoded| {
            if encoded.len()>2048 { return Err(Failure::InvalidInput); }
            let cursor: Cursor=serde_json::from_slice(&URL_SAFE_NO_PAD.decode(encoded).map_err(|_|Failure::InvalidInput)?).map_err(|_|Failure::InvalidInput)?;
            world::uuid(&cursor.id)?;
            if cursor.entity!=entity || cursor.kind!=query.record_type || cursor.from!=query.from || cursor.to!=query.to || cursor.time<query.from || cursor.time>=query.to { return Err(Failure::InvalidInput); }
            Ok(cursor)
        }).transpose()?;
        let mut tx=state.pool.begin().await?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY").execute(&mut *tx).await?;
        world::load_entity(&mut tx,&lab,&entity).await?;
        let (captured_since,cleaned_before):(DateTime<Utc>,Option<DateTime<Utc>>)=sqlx::query_as("SELECT captured_since,cleaned_before FROM lab.history_bounds WHERE entity_id=$1::uuid AND record_type=$2").bind(&entity).bind(query.record_type.name()).fetch_one(&mut *tx).await?;
        let cutoff=state.retention.cutoff(&query.record_type,Utc::now());
        let retained_since=cutoff.max(cleaned_before.unwrap_or(cutoff));
        let available_since=retained_since.max(captured_since);
        // Table and projection names come only from this closed record-type set.
        let (table,time,columns,unfinished)=match query.record_type {
            HistoryRecordType::Observation=>("lab.observation_history","h.received_at","h.observed_at,h.received_at,h.data","false"),
            HistoryRecordType::Command=>("lab.device_commands","h.created_at","NULL::timestamptz AS observed_at,h.created_at AS received_at,to_jsonb(h) AS data","h.status IN ('accepted','executing') OR h.updated_at >= $7 OR EXISTS(SELECT 1 FROM lab.device_tasks t WHERE t.command_id=h.id AND t.ended_at IS NULL)"),
            HistoryRecordType::Task=>("lab.device_tasks","h.created_at","NULL::timestamptz AS observed_at,h.created_at AS received_at,(to_jsonb(h)-'last_tick_at'-'pending_outcome')||jsonb_build_object('result',(SELECT to_jsonb(r) FROM lab.device_task_results r WHERE r.id=h.result_id)) AS data","h.ended_at IS NULL OR h.ended_at >= $7"),
            HistoryRecordType::Event=>("lab.device_events","h.received_at","h.occurred_at AS observed_at,h.received_at,h.data","false"),
        };
        let mut items=sqlx::query_as::<_,HistoryRecord>(&format!("SELECT h.id::text,h.entity_id::text,h.run_id::text,{time} AS recorded_at,{columns} FROM {table} h WHERE h.entity_id=$1::uuid AND {time}>=$2 AND {time}<$3 AND ($4::timestamptz IS NULL OR ({time},h.id)<($4,$5::uuid)) AND ({time}>=$7 OR ({unfinished})) ORDER BY {time} DESC,h.id DESC LIMIT $6"))
            .bind(&entity).bind(query.from).bind(query.to).bind(cursor.as_ref().map(|c|c.time)).bind(cursor.as_ref().map(|c|&c.id)).bind(i64::from(limit)+1).bind(retained_since).fetch_all(&mut *tx).await?;
        let count=items.len();
        let mut bytes=0;
        let take=items.iter().take(limit as usize).take_while(|item| {
            bytes+=serde_json::to_vec(item).map_or(MAX_RESPONSE_BYTES,|value|value.len()+1);
            bytes<MAX_RESPONSE_BYTES-4096
        }).count();
        if count>0 && take==0 {return Err(Failure::SnapshotTooLarge);}
        items.truncate(take);
        let next_cursor=if count>take {items.last().map(|last|serde_json::to_vec(&Cursor{entity,kind:query.record_type.clone(),from:query.from,to:query.to,time:last.recorded_at,id:last.id.clone()}).map(|value|URL_SAFE_NO_PAD.encode(value)).map_err(|_|Failure::Unavailable)).transpose()?}else{None};
        tx.commit().await?;
        Ok::<_,Failure>(HistoryPage{record_type:query.record_type,from:query.from,to:query.to,available_since,gap:query.from<available_since,retention:state.retention,max_range_seconds:MAX_RANGE_SECONDS,max_response_bytes:MAX_RESPONSE_BYTES,items,next_cursor})
    }.await;
    match result {
        Ok(page) => Json(page).into_response(),
        Err(error) => error.response(id),
    }
}

#[utoipa::path(get,path="/api/v1/lab/labs/{lab_id}/history/retention",operation_id="getLabHistoryRetention",tag="Lab",params(("lab_id"=String,Path)),responses((status=200,body=RetentionPolicy),(status=400,body=crate::http::ApiErrorResponse),(status=401,body=crate::http::ApiErrorResponse),(status=403,body=crate::http::ApiErrorResponse),(status=404,body=crate::http::ApiErrorResponse),(status=503,body=crate::http::ApiErrorResponse)))]
async fn get_retention(
    State(state): State<Lab>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiPath(lab): ApiPath<String>,
) -> Response {
    if let Err(response) = state.actor(&headers, &id, false).await {
        return response;
    }
    let result = async {
        world::uuid(&lab)?;
        let mut connection = state.pool.acquire().await?;
        world::load_lab(&mut connection, &lab).await?;
        Ok::<_, Failure>(state.retention)
    }
    .await;
    match result {
        Ok(value) => Json(value).into_response(),
        Err(error) => error.response(id),
    }
}
#[utoipa::path(post,path="/api/v1/lab/labs/{lab_id}/history/cleanup",operation_id="cleanupLabHistory",tag="Lab",params(("lab_id"=String,Path)),responses((status=200,body=HistoryCleanup),(status=400,body=crate::http::ApiErrorResponse),(status=401,body=crate::http::ApiErrorResponse),(status=403,body=crate::http::ApiErrorResponse),(status=404,body=crate::http::ApiErrorResponse),(status=503,body=crate::http::ApiErrorResponse)))]
async fn cleanup_history(
    State(state): State<Lab>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiPath(lab): ApiPath<String>,
) -> Response {
    let actor = match state.actor(&headers, &id, true).await {
        Ok(actor) => actor,
        Err(response) => return response,
    };
    let result = async {
        world::uuid(&lab)?;
        let mut tx = state.pool.begin().await?;
        state.authorize(&mut tx, &headers, &actor).await?;
        world::load_lab(&mut tx, &lab).await?;
        let cleaned = retention::cleanup_in(&mut tx, &lab, state.retention, Utc::now()).await?;
        crate::modules::audit::append(
            &mut tx,
            crate::modules::audit::Event {
                actor_id: &actor,
                action: "lab.history.cleanup",
                resource_type: "lab.lab",
                resource_id: &lab,
                source: crate::modules::audit::Source::Request(&id.0),
                subject_user_id: None,
            },
        )
        .await
        .map_err(|_| Failure::Unavailable)?;
        tx.commit().await?;
        Ok::<_, Failure>(cleaned)
    }
    .await;
    match result {
        Ok(value) => Json(value).into_response(),
        Err(error) => error.response(id),
    }
}
