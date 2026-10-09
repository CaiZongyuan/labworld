use super::{Failure, Lab, world};
use crate::{
    http::{ApiPath, BoundedJson, RequestId},
    modules::audit,
};
use axum::{
    Extension, Json, Router,
    extract::{DefaultBodyLimit, State},
    http::HeaderMap,
    response::{IntoResponse, Response},
    routing::get,
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use utoipa::{OpenApi, ToSchema};

const GUIDE: &str = "lab-onboarding";
const VERSION: &str = "1.0";
const COLUMNS: &str =
    "guide_id,guide_version,revision,status,step,guide_attempt_id::text,context,updated_at";

#[derive(Clone, Copy, Serialize, Deserialize, ToSchema, sqlx::Type, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[sqlx(type_name = "text", rename_all = "snake_case")]
pub enum LabGuideStatus {
    NotStarted,
    InProgress,
    Paused,
    Completed,
}

#[derive(Clone, Copy, Serialize, Deserialize, ToSchema, sqlx::Type, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
#[sqlx(type_name = "text", rename_all = "snake_case")]
pub enum LabGuideStep {
    CreateLab,
    RegisterLight,
    SelectEntity,
    EditPlacement,
    SaveLayout,
    ReturnRun,
    StartProgram,
    LightAction,
    VerifyObservation,
    AssetLibrary,
    Complete,
}

#[derive(Clone, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GuideBusinessOperation {
    CreateLab,
    RegisterEntity,
}

#[derive(Clone, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GuideBusinessAttempt {
    pub operation: GuideBusinessOperation,
    pub target_lab_id: Option<String>,
    pub request_key: String,
}

#[derive(Default, Clone, Serialize, Deserialize, ToSchema, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct LabGuideContext {
    pub lab_id: Option<String>,
    pub entity_id: Option<String>,
    pub node_id: Option<String>,
    /// Client attempt pointer only; never proves a committed business association.
    pub business_attempt: Option<GuideBusinessAttempt>,
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub struct SaveLabGuideProgress {
    pub expected_revision: i64,
    pub status: LabGuideStatus,
    pub step: Option<LabGuideStep>,
    pub guide_attempt_id: Option<String>,
    pub context: LabGuideContext,
}

#[derive(Serialize, ToSchema, sqlx::FromRow)]
pub struct LabGuideProgress {
    pub guide_id: String,
    pub guide_version: String,
    pub revision: i64,
    pub status: LabGuideStatus,
    /// Stored verbatim so older versions remain readable without replay or conversion.
    pub step: Option<String>,
    pub guide_attempt_id: Option<String>,
    #[sqlx(json)]
    pub context: LabGuideContext,
    pub updated_at: Option<DateTime<Utc>>,
}

#[derive(Serialize, ToSchema)]
#[serde(rename_all = "snake_case")]
pub enum LabGuideCompatibility {
    Compatible,
    RestartRequired,
    Unsupported,
}

#[derive(Serialize, ToSchema)]
pub struct LabGuideProgressRead {
    pub current_guide_version: String,
    pub compatibility: LabGuideCompatibility,
    pub progress: LabGuideProgress,
    pub previous_progress: Option<LabGuideProgress>,
}

pub(super) fn routes() -> Router<Lab> {
    Router::new()
        .route(
            "/api/v1/lab/guides/{guide_id}/{guide_version}/progress",
            get(get_progress).put(save_progress),
        )
        .layer(DefaultBodyLimit::max(8 * 1024))
}

#[derive(OpenApi)]
#[openapi(paths(get_progress, save_progress))]
struct ProgressApi;

pub(super) fn openapi() -> utoipa::openapi::OpenApi {
    ProgressApi::openapi()
}

fn guide(guide: &str, version: &str, mutation: bool) -> Result<(), Failure> {
    if guide != GUIDE {
        return Err(Failure::GuideNotFound);
    }
    if version.is_empty()
        || version.len() > 32
        || !version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
    {
        return Err(Failure::InvalidInput);
    }
    if mutation && version != VERSION {
        return Err(Failure::GuideVersionUnsupported);
    }
    Ok(())
}

async fn load(
    connection: &mut sqlx::PgConnection,
    actor: &str,
    guide: &str,
    version: &str,
) -> Result<Option<LabGuideProgress>, Failure> {
    Ok(sqlx::query_as(&format!(
        "SELECT {COLUMNS} FROM lab.guide_progress WHERE actor_id=$1::uuid AND guide_id=$2 AND guide_version=$3"
    ))
    .bind(actor)
    .bind(guide)
    .bind(version)
    .fetch_optional(connection)
    .await?)
}

fn missing(guide: String, version: String) -> LabGuideProgress {
    LabGuideProgress {
        guide_id: guide,
        guide_version: version,
        revision: 0,
        status: LabGuideStatus::NotStarted,
        step: None,
        guide_attempt_id: None,
        context: LabGuideContext::default(),
        updated_at: None,
    }
}

fn normalize_input(input: &mut SaveLabGuideProgress) -> Result<(), Failure> {
    if input.expected_revision < 0 || input.expected_revision == i64::MAX {
        return Err(Failure::InvalidInput);
    }
    let valid_state = match input.status {
        LabGuideStatus::NotStarted => {
            input.step.is_none()
                && input.guide_attempt_id.is_none()
                && input.context == LabGuideContext::default()
        }
        LabGuideStatus::InProgress | LabGuideStatus::Paused => {
            input.step.is_some()
                && input.step != Some(LabGuideStep::Complete)
                && input.guide_attempt_id.is_some()
        }
        LabGuideStatus::Completed => {
            input.step == Some(LabGuideStep::Complete) && input.guide_attempt_id.is_some()
        }
    };
    if !valid_state {
        return Err(Failure::InvalidInput);
    }
    for value in [
        &mut input.guide_attempt_id,
        &mut input.context.lab_id,
        &mut input.context.entity_id,
        &mut input.context.node_id,
    ]
    .into_iter()
    .flatten()
    {
        *value = world::uuid(value)?.to_string();
    }
    if let Some(attempt) = &mut input.context.business_attempt {
        if attempt.request_key.is_empty()
            || attempt.request_key.len() > 128
            || !attempt
                .request_key
                .bytes()
                .all(|byte| (33..=126).contains(&byte))
        {
            return Err(Failure::InvalidInput);
        }
        if let Some(target) = &mut attempt.target_lab_id {
            *target = world::uuid(target)?.to_string();
        }
        match attempt.operation {
            GuideBusinessOperation::CreateLab if attempt.target_lab_id.is_some() => {
                return Err(Failure::InvalidReference);
            }
            GuideBusinessOperation::RegisterEntity
                if attempt.target_lab_id.is_none()
                    || attempt.target_lab_id != input.context.lab_id =>
            {
                return Err(Failure::InvalidReference);
            }
            _ => {}
        }
    }
    Ok(())
}

async fn validate_context(
    connection: &mut sqlx::PgConnection,
    context: &LabGuideContext,
    previous: Option<&LabGuideContext>,
) -> Result<(), Failure> {
    // Previously validated references survive later node removal or object unavailability.
    if previous.is_some_and(|previous| {
        previous.lab_id == context.lab_id
            && previous.entity_id == context.entity_id
            && previous.node_id == context.node_id
    }) {
        return Ok(());
    }
    let Some(lab) = &context.lab_id else {
        return if context.entity_id.is_none() && context.node_id.is_none() {
            Ok(())
        } else {
            Err(Failure::InvalidReference)
        };
    };
    let valid: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM lab.labs WHERE id=$1::uuid)
         AND ($2::uuid IS NULL OR EXISTS(SELECT 1 FROM lab.entities WHERE lab_id=$1::uuid AND id=$2::uuid))
         AND ($3::uuid IS NULL OR EXISTS(SELECT 1 FROM lab.scene_nodes WHERE lab_id=$1::uuid AND id=$3::uuid AND ($2::uuid IS NULL OR entity_id=$2::uuid)))"
    ).bind(lab).bind(&context.entity_id).bind(&context.node_id).fetch_one(connection).await?;
    if !valid {
        return Err(Failure::InvalidReference);
    }
    Ok(())
}

#[utoipa::path(get, path="/api/v1/lab/guides/{guide_id}/{guide_version}/progress", operation_id="getLabGuideProgress", tag="Lab", params(("guide_id"=String,Path),("guide_version"=String,Path)), responses((status=200,body=LabGuideProgressRead),(status=400,body=crate::http::ApiErrorResponse),(status=401,body=crate::http::ApiErrorResponse),(status=403,body=crate::http::ApiErrorResponse),(status=404,body=crate::http::ApiErrorResponse),(status=503,body=crate::http::ApiErrorResponse)))]
async fn get_progress(
    State(state): State<Lab>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiPath((guide_id, version)): ApiPath<(String, String)>,
) -> Response {
    let actor = match state.actor(&headers, &id, false).await {
        Ok(actor) => actor,
        Err(response) => return response,
    };
    let result = async {
        guide(&guide_id, &version, false)?;
        let mut tx = state.pool.begin().await?;
        state.access_current(&mut tx, &headers, &actor).await?;
        let stored = load(&mut tx, &actor, &guide_id, &version).await?;
        let previous_progress = if version == VERSION && stored.as_ref().is_none_or(|progress| progress.status == LabGuideStatus::NotStarted) {
            sqlx::query_as::<_,LabGuideProgress>(&format!(
                "SELECT {COLUMNS} FROM lab.guide_progress WHERE actor_id=$1::uuid AND guide_id=$2 AND guide_version<>$3 ORDER BY updated_at DESC,guide_version DESC LIMIT 1"
            )).bind(&actor).bind(&guide_id).bind(&version).fetch_optional(&mut *tx).await?
        } else { None };
        let compatibility = if version != VERSION {
            LabGuideCompatibility::Unsupported
        } else if previous_progress.is_some() {
            LabGuideCompatibility::RestartRequired
        } else {
            LabGuideCompatibility::Compatible
        };
        let progress = stored.unwrap_or_else(|| missing(guide_id, version));
        tx.commit().await?;
        Ok::<_, Failure>(LabGuideProgressRead {
            current_guide_version: VERSION.into(),
            compatibility,
            progress,
            previous_progress,
        })
    }
    .await;
    match result {
        Ok(progress) => Json(progress).into_response(),
        Err(error) => error.response(id),
    }
}

#[utoipa::path(put, path="/api/v1/lab/guides/{guide_id}/{guide_version}/progress", operation_id="saveLabGuideProgress", tag="Lab", params(("guide_id"=String,Path),("guide_version"=String,Path)), request_body=SaveLabGuideProgress, responses((status=200,body=LabGuideProgress),(status=400,body=crate::http::ApiErrorResponse),(status=401,body=crate::http::ApiErrorResponse),(status=403,body=crate::http::ApiErrorResponse),(status=404,body=crate::http::ApiErrorResponse),(status=409,body=crate::http::ApiErrorResponse),(status=413,body=crate::http::ApiErrorResponse),(status=503,body=crate::http::ApiErrorResponse)))]
async fn save_progress(
    State(state): State<Lab>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiPath((guide_id, version)): ApiPath<(String, String)>,
    BoundedJson(mut input): BoundedJson<SaveLabGuideProgress>,
) -> Response {
    let actor = match state.actor(&headers, &id, true).await {
        Ok(actor) => actor,
        Err(response) => return response,
    };
    let result = async {
        guide(&guide_id, &version, true)?;
        normalize_input(&mut input)?;
        let mut tx = state.pool.begin().await?;
        state.access_current(&mut tx, &headers, &actor).await?;
        let previous = load(&mut tx,&actor,&guide_id,&version).await?;
        if previous.as_ref().map_or(0, |progress| progress.revision) != input.expected_revision {
            return Err(Failure::GuideProgressConflict);
        }
        validate_context(&mut tx,&input.context,previous.as_ref().map(|progress|&progress.context)).await?;
        let progress: LabGuideProgress = sqlx::query_as(&format!(
            "INSERT INTO lab.guide_progress AS old(actor_id,guide_id,guide_version,revision,status,step,guide_attempt_id,context) VALUES($1::uuid,$2,$3,1,$4,$5,$6::uuid,$7) ON CONFLICT(actor_id,guide_id,guide_version) DO UPDATE SET revision=old.revision+1,status=excluded.status,step=excluded.step,guide_attempt_id=excluded.guide_attempt_id,context=excluded.context,updated_at=now() WHERE old.revision=$8 RETURNING {COLUMNS}"
        ))
        .bind(&actor).bind(&guide_id).bind(&version).bind(input.status).bind(input.step)
        .bind(&input.guide_attempt_id).bind(sqlx::types::Json(&input.context))
        .bind(input.expected_revision)
        .fetch_optional(&mut *tx).await?.ok_or(Failure::GuideProgressConflict)?;
        audit::append(&mut tx, audit::Event {
            actor_id: &actor,
            action: "lab.guide_progress.save",
            resource_type: "lab.guide_progress",
            resource_id: &format!("{actor}/{guide_id}/{version}"),
            source: audit::Source::Request(&id.0),
            subject_user_id: None,
        }).await?;
        tx.commit().await?;
        Ok::<_, Failure>(progress)
    }.await;
    match result {
        Ok(progress) => Json(progress).into_response(),
        Err(error) => error.response(id),
    }
}
