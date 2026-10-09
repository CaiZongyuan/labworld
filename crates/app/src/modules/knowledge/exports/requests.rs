use super::{
    COLUMNS, DocumentExport, ExportPayload, ExportPolicy, ExportRow, Failure, Snapshot,
    application, information,
};
use crate::modules::{audit, files, idempotency, identity, jobs, notifications};
use labos_threejs_platform::config::AuthSettings;
use sqlx::PgPool;

pub(super) struct ExportRequest<'a> {
    pub actor_id: &'a str,
    pub document_id: uuid::Uuid,
    pub key: &'a str,
    pub credential: identity::CredentialRef,
    pub request_id: &'a str,
}

pub(super) async fn create(
    pool: &PgPool,
    auth: &AuthSettings,
    policy: &ExportPolicy,
    request: ExportRequest<'_>,
) -> Result<DocumentExport, Failure> {
    let ExportRequest {
        actor_id,
        document_id,
        key,
        credential,
        request_id,
    } = request;
    let mut tx = pool.begin().await?;
    application::lock_document(&mut tx, actor_id, document_id, false).await?;
    if !identity::credential_is_current(&mut tx, auth, actor_id, &credential).await? {
        return Err(Failure::Unauthorized);
    }
    let scope = format!("POST /api/v1/knowledge/documents/{document_id}/exports");
    let fingerprint = idempotency::fingerprint(&())?;
    let attempt = idempotency::Attempt {
        actor_id,
        scope: &scope,
        key,
        fingerprint: &fingerprint,
    };
    let export_id = if let Some(replayed) = idempotency::claim(&mut tx, &attempt).await? {
        replayed["export_id"]
            .as_str()
            .ok_or(Failure::Unavailable)?
            .to_owned()
    } else {
        let (title, markdown, version): (String, String, i64) = sqlx::query_as(
            "SELECT title, markdown, version FROM knowledge.documents WHERE id = $1::uuid",
        )
        .bind(document_id.to_string())
        .fetch_one(&mut *tx)
        .await?;
        let ids: Vec<String> = sqlx::query_scalar("SELECT file_id::text FROM knowledge.attachments WHERE document_id = $1::uuid ORDER BY file_id LIMIT $2").bind(document_id.to_string()).bind(i64::from(policy.max_attachments) + 1).fetch_all(&mut *tx).await?;
        if ids.len() > policy.max_attachments as usize {
            return Err(Failure::ExportTooLarge);
        }
        let attachments = files::snapshots(&mut tx, &ids).await?;
        let total = attachments
            .iter()
            .try_fold(markdown.len() as i64, |sum, file| {
                sum.checked_add(file.size)
            })
            .ok_or(Failure::ExportTooLarge)?;
        if total > policy.max_input_bytes {
            return Err(Failure::ExportTooLarge);
        }
        let export_id = uuid::Uuid::now_v7().to_string();
        let job_id = jobs::enqueue(
            &mut tx,
            jobs::NewJob {
                kind: "knowledge.export",
                schema_version: 1,
                max_attempts: policy.max_attempts,
                payload: serde_json::to_value(ExportPayload {
                    export_id: export_id.clone(),
                })
                .map_err(|_| Failure::Unavailable)?,
                correlation_id: request_id,
            },
        )
        .await?;
        notifications::on_job_outcome(
            &mut tx,
            &job_id,
            notifications::JobNotification {
                recipient_id: actor_id,
                event_key: &format!("knowledge.export:{export_id}"),
                subject: "文档导出",
                target: notifications::NotificationTarget {
                    kind: "knowledge.export".into(),
                    resource_id: export_id.clone(),
                    context: [("document_id".into(), document_id.to_string())].into(),
                },
            },
        )
        .await?;
        let snapshot = serde_json::to_value(Snapshot {
            title,
            markdown,
            attachments,
        })
        .map_err(|_| Failure::Unavailable)?;
        let credential = serde_json::to_value(credential).map_err(|_| Failure::Unavailable)?;
        sqlx::query("INSERT INTO knowledge.exports (id, document_id, requested_by, credential, job_id, document_version, snapshot, expires_at) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6, $7, clock_timestamp() + make_interval(secs => $8))")
                .bind(&export_id).bind(document_id.to_string()).bind(actor_id).bind(credential).bind(job_id).bind(version).bind(snapshot).bind(f64::from(policy.retention_secs)).execute(&mut *tx).await?;
        audit::append(
            &mut tx,
            audit::Event {
                actor_id,
                action: "knowledge.export.request",
                resource_type: "knowledge.export",
                resource_id: &export_id,
                source: audit::Source::Request(request_id),
                subject_user_id: None,
            },
        )
        .await?;
        idempotency::complete(
            &mut tx,
            &attempt,
            serde_json::json!({"export_id":export_id}),
        )
        .await?;
        export_id
    };
    let row: ExportRow = sqlx::query_as(&format!("SELECT {COLUMNS} FROM knowledge.exports WHERE id = $1::uuid AND document_id = $2::uuid AND requested_by = $3::uuid"))
            .bind(&export_id).bind(document_id.to_string()).bind(actor_id).fetch_optional(&mut *tx).await?.ok_or(Failure::NotFound)?;
    let info = information(&mut tx, vec![row])
        .await?
        .pop()
        .ok_or(Failure::Unavailable)?;
    tx.commit().await?;
    Ok::<_, Failure>(info)
}
