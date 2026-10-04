use super::{Failure, Lab, RetentionPolicy, world};
use crate::http::{ApiPath, ApiQuery, RequestId};
use axum::{
    Extension, Json, Router,
    extract::State,
    http::HeaderMap,
    response::{IntoResponse, Response},
    routing::get,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use utoipa::{IntoParams, OpenApi, ToSchema};

#[derive(Clone, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum LabRecordType {
    Command,
    Task,
    Event,
    Run,
}
impl LabRecordType {
    fn name(&self) -> &'static str {
        match self {
            Self::Command => "command",
            Self::Task => "task",
            Self::Event => "event",
            Self::Run => "run",
        }
    }
}

#[derive(Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
#[serde(deny_unknown_fields)]
pub struct LabRecordsQuery {
    pub from: DateTime<Utc>,
    pub to: DateTime<Utc>,
    pub entity_id: Option<String>,
    pub record_type: Option<LabRecordType>,
    #[param(minimum = 1, maximum = 100, default = 20)]
    pub limit: Option<u32>,
    #[param(max_length = 2048)]
    pub cursor: Option<String>,
}

#[derive(Serialize, ToSchema, sqlx::FromRow)]
pub struct LabRecord {
    pub id: String,
    pub record_type: String,
    pub entity_id: String,
    pub entity_name: String,
    pub reality: String,
    pub archived_at: Option<DateTime<Utc>>,
    pub run_id: String,
    pub binding_id: String,
    pub command_id: Option<String>,
    pub task_id: Option<String>,
    pub result_id: Option<String>,
    pub recorded_at: DateTime<Utc>,
    pub ended_at: Option<DateTime<Utc>>,
    pub state: String,
    pub summary: String,
    pub source: String,
    pub actor_id: Option<String>,
    pub actor_source: String,
    pub actor_role: String,
    pub data: Value,
}

#[derive(Serialize, ToSchema)]
pub struct LabRecordsPage {
    pub from: DateTime<Utc>,
    pub to: DateTime<Utc>,
    pub queried_at: DateTime<Utc>,
    pub query_upper_bound: DateTime<Utc>,
    pub entity_id: Option<String>,
    pub record_type: Option<LabRecordType>,
    pub retention: RetentionPolicy,
    pub coverage: Vec<LabRecordCoverage>,
    pub max_page_items: u32,
    pub max_range_seconds: i64,
    pub max_response_bytes: usize,
    pub items: Vec<LabRecord>,
    pub next_cursor: Option<String>,
}

#[derive(Serialize, ToSchema)]
pub struct LabRecordGap {
    pub from: DateTime<Utc>,
    pub to: DateTime<Utc>,
    pub reason: String,
}

#[derive(Serialize, ToSchema, sqlx::FromRow)]
pub struct LabRecordCoverage {
    pub record_type: String,
    #[sqlx(skip)]
    pub retention_seconds: Option<u32>,
    #[sqlx(skip)]
    pub preserves_unfinished: bool,
    pub captured_since: Option<DateTime<Utc>>,
    pub fully_captured_since: Option<DateTime<Utc>>,
    pub cleaned_before: Option<DateTime<Utc>>,
    #[sqlx(skip)]
    pub available_since: Option<DateTime<Utc>>,
    pub oldest_record_at: Option<DateTime<Utc>>,
    pub newest_record_at: Option<DateTime<Utc>>,
    #[sqlx(skip)]
    pub gaps: Vec<LabRecordGap>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    version: u8,
    lab: String,
    entity: Option<String>,
    kind: Option<LabRecordType>,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    queried_at: DateTime<Utc>,
    upper: DateTime<Utc>,
    time: DateTime<Utc>,
    record_type: LabRecordType,
    id: String,
}

fn database_bound(time: DateTime<Utc>) -> Result<DateTime<Utc>, Failure> {
    // Persisted record times use PostgreSQL microseconds. Both half-open bounds round up.
    let remainder = time.timestamp_subsec_nanos() % 1000;
    if remainder == 0 {
        return Ok(time);
    }
    time.checked_add_signed(chrono::Duration::nanoseconds(i64::from(1000 - remainder)))
        .ok_or(Failure::InvalidInput)
}

pub(super) fn routes() -> Router<Lab> {
    Router::new().route("/api/v1/lab/labs/{lab_id}/records", get(list_records))
}

#[derive(OpenApi)]
#[openapi(paths(list_records))]
struct RecordsApi;
pub(super) fn openapi() -> utoipa::openapi::OpenApi {
    RecordsApi::openapi()
}

#[utoipa::path(get, path="/api/v1/lab/labs/{lab_id}/records", operation_id="listLabRecords", tag="Lab", params(("lab_id"=String, Path), LabRecordsQuery), responses((status=200, body=LabRecordsPage), (status=400, body=crate::http::ApiErrorResponse), (status=401, body=crate::http::ApiErrorResponse), (status=403, body=crate::http::ApiErrorResponse), (status=404, body=crate::http::ApiErrorResponse), (status=413, body=crate::http::ApiErrorResponse), (status=503, body=crate::http::ApiErrorResponse)))]
async fn list_records(
    State(state): State<Lab>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiPath(lab): ApiPath<String>,
    ApiQuery(query): ApiQuery<LabRecordsQuery>,
) -> Response {
    if let Err(response) = state.actor(&headers, &id, false).await {
        return response;
    }
    let result = async {
        world::uuid(&lab)?;
        if let Some(entity) = &query.entity_id {
            world::uuid(entity)?;
        }
        let limit = query.limit.unwrap_or(20);
        if !(1..=100).contains(&limit)
            || query.from >= query.to
            || query.to - query.from > chrono::Duration::days(31)
        {
            return Err(Failure::InvalidInput);
        }
        let now = Utc::now();
        let cursor = query
            .cursor
            .as_ref()
            .map(|encoded| {
                if encoded.len() > 2048 {
                    return Err(Failure::InvalidInput);
                }
                let cursor: Cursor = serde_json::from_slice(
                    &URL_SAFE_NO_PAD
                        .decode(encoded)
                        .map_err(|_| Failure::InvalidInput)?,
                )
                .map_err(|_| Failure::InvalidInput)?;
                world::uuid(&cursor.id)?;
                if cursor.version != 1
                    || cursor.lab != lab
                    || cursor.entity != query.entity_id
                    || cursor.kind != query.record_type
                    || cursor.from != query.from
                    || cursor.to != query.to
                    || cursor.queried_at > now
                    || cursor.upper != cursor.to.min(cursor.queried_at)
                    || cursor.time < cursor.from
                    || cursor.time >= cursor.upper
                    || !cursor.time.timestamp_subsec_nanos().is_multiple_of(1000)
                    || cursor
                        .kind
                        .as_ref()
                        .is_some_and(|kind| kind != &cursor.record_type)
                {
                    return Err(Failure::InvalidInput);
                }
                Ok(cursor)
            })
            .transpose()?;
        let queried_at = cursor.as_ref().map_or(now, |cursor| cursor.queried_at);
        let upper = query.to.min(queried_at);
        let database_from = database_bound(query.from)?;
        let database_upper = database_bound(upper)?;
        let mut tx = state.pool.begin().await?;
        sqlx::query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY")
            .execute(&mut *tx)
            .await?;
        world::load_lab(&mut tx, &lab).await?;
        if let Some(entity) = &query.entity_id {
            world::load_entity(&mut tx, &lab, entity).await?;
        }
        if let Some(cursor) = &cursor {
            let valid: bool = sqlx::query_scalar(include_str!("records/anchor.sql"))
                .bind(&lab)
                .bind(&query.entity_id)
                .bind(cursor.record_type.name())
                .bind(&cursor.id)
                .bind(cursor.time)
                .fetch_one(&mut *tx)
                .await?;
            if !valid {
                return Err(Failure::InvalidInput);
            }
        }
        let cutoff =
            queried_at - chrono::Duration::seconds(i64::from(state.retention.record_seconds));
        let mut items: Vec<LabRecord> = sqlx::query_as(include_str!("records/list.sql"))
            .bind(&lab)
            .bind(database_from)
            .bind(database_upper)
            .bind(i64::from(limit) + 1)
            .bind(&query.entity_id)
            .bind(query.record_type.as_ref().map(LabRecordType::name))
            .bind(cursor.as_ref().map(|cursor| cursor.time))
            .bind(cursor.as_ref().map(|cursor| cursor.record_type.name()))
            .bind(cursor.as_ref().map(|cursor| &cursor.id))
            .bind(cutoff)
            .fetch_all(&mut *tx)
            .await?;
        let mut coverage: Vec<LabRecordCoverage> =
            sqlx::query_as(include_str!("records/coverage.sql"))
                .bind(&lab)
                .bind(database_from)
                .bind(database_upper)
                .bind(&query.entity_id)
                .bind(query.record_type.as_ref().map(LabRecordType::name))
                .bind(cutoff)
                .fetch_all(&mut *tx)
                .await?;
        for row in &mut coverage {
            let retained_after = if row.record_type == "run" {
                None
            } else {
                Some(cutoff.max(row.cleaned_before.unwrap_or(cutoff)))
            };
            row.retention_seconds =
                (row.record_type != "run").then_some(state.retention.record_seconds);
            row.preserves_unfinished = matches!(row.record_type.as_str(), "command" | "task");
            row.available_since = row
                .captured_since
                .map(|captured| retained_after.map_or(captured, |retained| retained.max(captured)));
            for (reason, start, end) in [
                ("capture", Some(query.from), row.captured_since),
                (
                    "partial_capture",
                    row.captured_since,
                    row.fully_captured_since,
                ),
                ("retention", Some(query.from), retained_after),
            ] {
                if let (Some(start), Some(end)) = (start, end) {
                    let from = start.max(query.from);
                    let to = end.min(upper);
                    if from < to {
                        row.gaps.push(LabRecordGap {
                            from,
                            to,
                            reason: reason.into(),
                        });
                    }
                }
            }
        }
        let fetched_count = items.len();
        items.truncate(limit as usize);
        let mut page = LabRecordsPage {
            from: query.from,
            to: query.to,
            queried_at,
            query_upper_bound: upper,
            entity_id: query.entity_id.clone(),
            record_type: query.record_type.clone(),
            retention: state.retention,
            coverage,
            max_page_items: 100,
            max_range_seconds: 31 * 86400,
            max_response_bytes: 256 * 1024,
            items,
            next_cursor: None,
        };
        loop {
            page.next_cursor = if fetched_count > page.items.len() {
                page.items
                    .last()
                    .map(|last| {
                        let record_type =
                            serde_json::from_value(Value::String(last.record_type.clone()))
                                .map_err(|_| Failure::Unavailable)?;
                        serde_json::to_vec(&Cursor {
                            version: 1,
                            lab: lab.clone(),
                            entity: query.entity_id.clone(),
                            kind: query.record_type.clone(),
                            from: query.from,
                            to: query.to,
                            queried_at,
                            upper,
                            time: last.recorded_at,
                            record_type,
                            id: last.id.clone(),
                        })
                        .map(|bytes| URL_SAFE_NO_PAD.encode(bytes))
                        .map_err(|_| Failure::Unavailable)
                    })
                    .transpose()?
            } else {
                None
            };
            if serde_json::to_vec(&page)
                .map_err(|_| Failure::Unavailable)?
                .len()
                <= page.max_response_bytes
            {
                break;
            }
            if page.items.len() <= 1 {
                return Err(Failure::RecordsTooLarge);
            }
            page.items.pop();
        }
        tx.commit().await?;
        Ok::<_, Failure>(page)
    }
    .await;
    match result {
        Ok(page) => Json(page).into_response(),
        Err(error) => error.response(id),
    }
}
