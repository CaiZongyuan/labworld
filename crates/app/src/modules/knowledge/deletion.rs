use super::{Failure, Knowledge, application};
use crate::{
    http::{ApiPath, RequestId},
    modules::{
        audit, files, identity,
        jobs::{self, Handler, JobError, Lease, NewJob},
    },
};
use axum::{
    Extension,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use serde::{Deserialize, Serialize};
use sqlx::{PgConnection, PgPool};
use std::{sync::Arc, time::Duration};
use utoipa::OpenApi;

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct DocumentCleanup {
    document_id: String,
}
#[derive(OpenApi)]
#[openapi(paths(delete_document, delete_base))]
struct DeletionApi;
pub(super) fn openapi() -> utoipa::openapi::OpenApi {
    DeletionApi::openapi()
}

#[utoipa::path(delete,path="/api/v1/knowledge/documents/{id}",operation_id="deleteDocument",tag="Knowledge",params(("id"=String,Path),("x-csrf-token"=String,Header)),responses((status=204),(status=400,body=crate::http::ApiErrorResponse),(status=401,body=crate::http::ApiErrorResponse),(status=403,body=crate::http::ApiErrorResponse),(status=404,body=crate::http::ApiErrorResponse),(status=503,body=crate::http::ApiErrorResponse)))]
pub(super) async fn delete_document(
    State(state): State<Knowledge>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiPath(document): ApiPath<String>,
) -> Response {
    let actor = match identity::require_session(&state.pool, &state.auth, &headers, &id, true).await
    {
        Ok(session) => session.user,
        Err(response) => return response,
    };
    let Ok(document) = uuid::Uuid::parse_str(&document) else {
        return Failure::NotFound.response(id);
    };
    match tokio::time::timeout(
        Duration::from_secs(3),
        request_deletion(&state.pool, &actor.id, document, &id.0),
    )
    .await
    {
        Ok(Ok(())) => StatusCode::NO_CONTENT.into_response(),
        Ok(Err(error)) => error.response(id),
        Err(_) => Failure::Unavailable.response(id),
    }
}
async fn request_deletion(
    pool: &PgPool,
    actor: &str,
    document: uuid::Uuid,
    request_id: &str,
) -> Result<(), Failure> {
    let mut tx = pool.begin().await?;
    application::lock_document_exclusive(&mut tx, actor, document).await?;
    queue_document_cleanup(&mut tx, &document.to_string(), request_id).await?;
    audit::append(
        &mut tx,
        audit::Event {
            actor_id: actor,
            action: "knowledge.document.delete",
            resource_type: "knowledge.document",
            resource_id: &document.to_string(),
            source: audit::Source::Request(request_id),
            subject_user_id: None,
        },
    )
    .await?;
    tx.commit().await?;
    Ok(())
}
async fn queue_document_cleanup(
    connection: &mut PgConnection,
    document: &str,
    correlation: &str,
) -> Result<(), Failure> {
    let job = jobs::enqueue(
        connection,
        NewJob {
            kind: "knowledge.cleanup_document",
            schema_version: 1,
            max_attempts: 5,
            payload: serde_json::to_value(DocumentCleanup {
                document_id: document.into(),
            })
            .map_err(|_| Failure::Unavailable)?,
            correlation_id: correlation,
        },
    )
    .await?;
    sqlx::query("UPDATE knowledge.documents SET deleted_at = COALESCE(deleted_at, clock_timestamp()), cleanup_job_id = $2::uuid WHERE id = $1::uuid").bind(document).bind(job).execute(connection).await?;
    Ok(())
}
struct CleanupDocument {
    pool: PgPool,
}
#[async_trait::async_trait]
impl Handler for CleanupDocument {
    fn kind(&self) -> &'static str {
        "knowledge.cleanup_document"
    }
    async fn run(&self, lease: &Lease) -> Result<(), JobError> {
        let work = async {
            if lease.schema_version != 1 {
                return Err(JobError::Permanent("knowledge.cleanup_payload"));
            }
            let payload: DocumentCleanup = serde_json::from_value(lease.payload.clone())
                .map_err(|_| JobError::Permanent("knowledge.cleanup_payload"))?;
            let id = uuid::Uuid::parse_str(&payload.document_id)
                .map_err(|_| JobError::Permanent("knowledge.cleanup_payload"))?
                .to_string();
            loop {
                let mut tx = self.pool.begin().await?;
                lease.lock_current(&mut tx).await?;
                let deleted:Option<bool>=sqlx::query_scalar("SELECT deleted_at IS NOT NULL FROM knowledge.documents WHERE id = $1::uuid FOR UPDATE").bind(&id).fetch_optional(&mut *tx).await?;
                if deleted == Some(false) {
                    return Err(JobError::Permanent("knowledge.cleanup_live_resource"));
                }
                if deleted.is_none() {
                    lease.succeed(&mut tx).await?;
                    tx.commit().await?;
                    return Ok(());
                }
                let ids:Vec<String>=sqlx::query_scalar("SELECT id::text FROM (SELECT upload_id AS id FROM knowledge.attachment_uploads WHERE document_id = $1::uuid UNION SELECT file_id AS id FROM knowledge.attachments WHERE document_id = $1::uuid UNION SELECT file_id AS id FROM knowledge.exports WHERE document_id = $1::uuid AND file_id IS NOT NULL) AS files ORDER BY id LIMIT 100")
                    .bind(&id).fetch_all(&mut *tx).await?;
                if ids.is_empty() {
                    sqlx::query("DELETE FROM knowledge.documents WHERE id = $1::uuid AND deleted_at IS NOT NULL").bind(&id).execute(&mut *tx).await?;
                    lease.succeed(&mut tx).await?;
                    tx.commit().await?;
                    return Ok(());
                }
                for file in &ids {
                    files::mark_deleting(&mut tx, file, &lease.correlation_id)
                        .await
                        .map_err(|_| JobError::Transient("knowledge.cleanup_file_unavailable"))?;
                }
                sqlx::query("DELETE FROM knowledge.attachments WHERE document_id = $1::uuid AND file_id = ANY($2::text[]::uuid[])").bind(&id).bind(&ids).execute(&mut *tx).await?;
                sqlx::query("DELETE FROM knowledge.attachment_uploads WHERE document_id = $1::uuid AND upload_id = ANY($2::text[]::uuid[])").bind(&id).bind(&ids).execute(&mut *tx).await?;
                sqlx::query("DELETE FROM knowledge.exports WHERE document_id = $1::uuid AND file_id = ANY($2::text[]::uuid[])").bind(&id).bind(&ids).execute(&mut *tx).await?;
                tx.commit().await?;
            }
        };
        tokio::time::timeout(Duration::from_secs(120), work)
            .await
            .map_err(|_| JobError::Transient("knowledge.cleanup_timeout"))?
    }
}
pub fn document_cleanup_handler(pool: PgPool) -> Arc<dyn Handler> {
    Arc::new(CleanupDocument { pool })
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct BaseCleanup {
    base_id: String,
}
#[utoipa::path(delete,path="/api/v1/knowledge/bases/{id}",operation_id="deleteKnowledgeBase",tag="Knowledge",params(("id"=String,Path),("x-csrf-token"=String,Header)),responses((status=204),(status=400,body=crate::http::ApiErrorResponse),(status=401,body=crate::http::ApiErrorResponse),(status=403,body=crate::http::ApiErrorResponse),(status=404,body=crate::http::ApiErrorResponse),(status=503,body=crate::http::ApiErrorResponse)))]
pub(super) async fn delete_base(
    State(state): State<Knowledge>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiPath(base): ApiPath<String>,
) -> Response {
    let actor = match identity::require_session(&state.pool, &state.auth, &headers, &id, true).await
    {
        Ok(session) => session.user,
        Err(response) => return response,
    };
    let Ok(base) = uuid::Uuid::parse_str(&base) else {
        return Failure::NotFound.response(id);
    };
    match tokio::time::timeout(
        Duration::from_secs(3),
        request_base_deletion(&state.pool, &actor.id, base, &id.0),
    )
    .await
    {
        Ok(Ok(())) => StatusCode::NO_CONTENT.into_response(),
        Ok(Err(error)) => error.response(id),
        Err(_) => Failure::Unavailable.response(id),
    }
}
async fn request_base_deletion(
    pool: &PgPool,
    actor: &str,
    base: uuid::Uuid,
    correlation: &str,
) -> Result<(), Failure> {
    let mut tx = pool.begin().await?;
    let role = crate::modules::organization::active_role_in(&mut tx, actor)
        .await?
        .ok_or(Failure::Forbidden)?;
    super::bases::lock_manage_base(&mut tx, actor, role, base).await?;
    let job = jobs::enqueue(
        &mut tx,
        NewJob {
            kind: "knowledge.cleanup_base",
            schema_version: 1,
            max_attempts: 5,
            payload: serde_json::to_value(BaseCleanup {
                base_id: base.to_string(),
            })
            .map_err(|_| Failure::Unavailable)?,
            correlation_id: correlation,
        },
    )
    .await?;
    sqlx::query("UPDATE knowledge.knowledge_bases SET deleted_at = clock_timestamp(), cleanup_job_id = $2::uuid WHERE id = $1::uuid").bind(base.to_string()).bind(job).execute(&mut *tx).await?;
    audit::append(
        &mut tx,
        audit::Event {
            actor_id: actor,
            action: "knowledge.base.delete",
            resource_type: "knowledge.base",
            resource_id: &base.to_string(),
            source: audit::Source::Request(correlation),
            subject_user_id: None,
        },
    )
    .await?;
    tx.commit().await?;
    Ok(())
}
struct CleanupBase {
    pool: PgPool,
}
#[async_trait::async_trait]
impl Handler for CleanupBase {
    fn kind(&self) -> &'static str {
        "knowledge.cleanup_base"
    }
    async fn run(&self, lease: &Lease) -> Result<(), JobError> {
        let work = async {
            if lease.schema_version != 1 {
                return Err(JobError::Permanent("knowledge.cleanup_payload"));
            }
            let payload: BaseCleanup = serde_json::from_value(lease.payload.clone())
                .map_err(|_| JobError::Permanent("knowledge.cleanup_payload"))?;
            let id = uuid::Uuid::parse_str(&payload.base_id)
                .map_err(|_| JobError::Permanent("knowledge.cleanup_payload"))?
                .to_string();
            loop {
                let mut tx = self.pool.begin().await?;
                lease.lock_current(&mut tx).await?;
                let deleted:Option<bool>=sqlx::query_scalar("SELECT deleted_at IS NOT NULL FROM knowledge.knowledge_bases WHERE id = $1::uuid FOR UPDATE").bind(&id).fetch_optional(&mut *tx).await?;
                if deleted == Some(false) {
                    return Err(JobError::Permanent("knowledge.cleanup_live_resource"));
                }
                if deleted.is_none() {
                    lease.succeed(&mut tx).await?;
                    tx.commit().await?;
                    return Ok(());
                }
                let documents:Vec<String>=sqlx::query_scalar("SELECT id::text FROM knowledge.documents WHERE knowledge_base_id = $1::uuid AND deleted_at IS NULL ORDER BY id LIMIT 100 FOR UPDATE").bind(&id).fetch_all(&mut *tx).await?;
                if documents.is_empty() {
                    sqlx::query("DELETE FROM knowledge.grants WHERE knowledge_base_id = $1::uuid")
                        .bind(&id)
                        .execute(&mut *tx)
                        .await?;
                    lease.succeed(&mut tx).await?;
                    tx.commit().await?;
                    return Ok(());
                }
                for document in documents {
                    queue_document_cleanup(&mut tx, &document, &lease.correlation_id)
                        .await
                        .map_err(|_| {
                            JobError::Transient("knowledge.cleanup_database_unavailable")
                        })?;
                }
                tx.commit().await?;
            }
        };
        tokio::time::timeout(Duration::from_secs(120), work)
            .await
            .map_err(|_| JobError::Transient("knowledge.cleanup_timeout"))?
    }
}
pub fn base_cleanup_handler(pool: PgPool) -> Arc<dyn Handler> {
    Arc::new(CleanupBase { pool })
}
