use super::{
    Document, DocumentPage, DocumentSummary, DocumentsQuery, Failure, domain::Content,
    pagination::Cursor,
};
use crate::modules::{
    audit, idempotency,
    identity::CurrentUser,
    organization::{self, MemberRole},
};
use sqlx::PgPool;

const COLUMNS: &str = "id::text, knowledge_base_id::text, title, markdown, version, created_by::text, updated_by::text, created_at, updated_at";

pub(super) fn manager(role: MemberRole) -> bool {
    matches!(role, MemberRole::Owner | MemberRole::Admin)
}

/// Lock membership, base, then source document; return the current write capability.
pub(super) async fn lock_document(
    connection: &mut sqlx::PgConnection,
    actor_id: &str,
    document_id: uuid::Uuid,
    write: bool,
) -> Result<bool, Failure> {
    lock_document_row(connection, actor_id, document_id, write, false).await
}
pub(super) async fn lock_document_exclusive(
    connection: &mut sqlx::PgConnection,
    actor_id: &str,
    document_id: uuid::Uuid,
) -> Result<(), Failure> {
    lock_document_row(connection, actor_id, document_id, true, true)
        .await
        .map(|_| ())
}
async fn lock_document_row(
    connection: &mut sqlx::PgConnection,
    actor_id: &str,
    document_id: uuid::Uuid,
    write: bool,
    exclusive: bool,
) -> Result<bool, Failure> {
    let role = organization::active_role_in(connection, actor_id)
        .await?
        .ok_or(Failure::Forbidden)?;
    let base: String = sqlx::query_scalar(
        "SELECT knowledge_base_id::text FROM knowledge.documents WHERE id = $1::uuid AND deleted_at IS NULL",
    )
    .bind(document_id.to_string())
    .fetch_optional(&mut *connection)
    .await?
    .ok_or(Failure::NotFound)?;
    let exists: Option<String> = sqlx::query_scalar(
        "SELECT id::text FROM knowledge.knowledge_bases WHERE id = $1::uuid AND deleted_at IS NULL FOR SHARE",
    )
    .bind(&base)
    .fetch_optional(&mut *connection)
    .await?;
    if exists.is_none() {
        return Err(Failure::NotFound);
    }
    let row_query = if exclusive {
        "SELECT id::text FROM knowledge.documents WHERE id = $1::uuid AND knowledge_base_id = $2::uuid AND deleted_at IS NULL FOR UPDATE"
    } else {
        "SELECT id::text FROM knowledge.documents WHERE id = $1::uuid AND knowledge_base_id = $2::uuid AND deleted_at IS NULL FOR SHARE"
    };
    let exists: Option<String> = sqlx::query_scalar(row_query)
        .bind(document_id.to_string())
        .bind(&base)
        .fetch_optional(&mut *connection)
        .await?;
    if exists.is_none() {
        return Err(Failure::NotFound);
    }
    let can_edit = if manager(role) {
        true
    } else {
        let grant: Option<String> = sqlx::query_scalar("SELECT access FROM knowledge.grants WHERE knowledge_base_id = $1::uuid AND user_id = $2::uuid")
            .bind(&base).bind(actor_id).fetch_optional(connection).await?;
        match grant.as_deref() {
            Some("editor") => true,
            Some(_) => false,
            None => return Err(Failure::NotFound),
        }
    };
    if write && !can_edit {
        return Err(Failure::Forbidden);
    }
    Ok(can_edit)
}

pub(super) async fn create(
    pool: &PgPool,
    actor: &CurrentUser,
    base_id: Option<uuid::Uuid>,
    content: Content,
    request_id: &str,
    key: &str,
) -> Result<Document, Failure> {
    let mut tx = pool.begin().await?;
    let role = organization::active_role_in(&mut tx, &actor.id)
        .await?
        .ok_or(Failure::Forbidden)?;
    let base = if let Some(id) = base_id {
        let base: String = sqlx::query_scalar(
            "SELECT id::text FROM knowledge.knowledge_bases WHERE id = $1::uuid AND deleted_at IS NULL FOR SHARE",
        )
        .bind(id.to_string())
        .fetch_optional(&mut *tx)
        .await?
        .ok_or(Failure::NotFound)?;
        require_edit(&mut tx, &actor.id, role, &base).await?;
        base
    } else {
        let new_base = sqlx::query_scalar::<_, String>("INSERT INTO knowledge.knowledge_bases (id, name, personal_owner, created_by) VALUES ($1::uuid, '我的知识库', $2::uuid, $2::uuid) ON CONFLICT (personal_owner) DO NOTHING RETURNING id::text")
        .bind(uuid::Uuid::now_v7().to_string()).bind(&actor.id).fetch_optional(&mut *tx).await?;
        if let Some(base) = &new_base {
            sqlx::query("INSERT INTO knowledge.grants (knowledge_base_id, user_id, access) VALUES ($1::uuid, $2::uuid, 'editor')").bind(base).bind(&actor.id).execute(&mut *tx).await?;
            audit::append(
                &mut tx,
                audit::Event {
                    actor_id: &actor.id,
                    action: "knowledge.base.create",
                    resource_type: "knowledge.base",
                    resource_id: base,
                    source: audit::Source::Request(request_id),
                    subject_user_id: None,
                },
            )
            .await?;
            audit::append(
                &mut tx,
                audit::Event {
                    actor_id: &actor.id,
                    action: "knowledge.grant.assign",
                    resource_type: "knowledge.grant",
                    resource_id: base,
                    source: audit::Source::Request(request_id),
                    subject_user_id: Some(&actor.id),
                },
            )
            .await?;
        }
        let base: String = sqlx::query_scalar(
        "SELECT id::text FROM knowledge.knowledge_bases WHERE personal_owner = $1::uuid AND deleted_at IS NULL FOR SHARE",
    )
    .bind(&actor.id)
    .fetch_optional(&mut *tx)
    .await?.ok_or(Failure::NotFound)?;
        // Default personal-space initialization keeps its established forbidden response.
        require_edit(&mut tx, &actor.id, role, &base)
            .await
            .map_err(|error| match error {
                Failure::NotFound => Failure::Forbidden,
                other => other,
            })?;
        base
    };
    let fingerprint = idempotency::fingerprint(&(&content.title, &content.markdown))?;
    let scope = format!("POST /api/v1/knowledge/documents:{base}");
    let attempt = idempotency::Attempt {
        actor_id: &actor.id,
        scope: &scope,
        key,
        fingerprint: &fingerprint,
    };
    if let Some(response) = idempotency::claim(&mut tx, &attempt).await? {
        let saved_id = response["document_id"]
            .as_str()
            .or_else(|| response["id"].as_str())
            .ok_or(Failure::Unavailable)?;
        let document: Document = sqlx::query_as(&format!("SELECT {COLUMNS}, true AS can_edit FROM knowledge.documents WHERE id = $1::uuid AND knowledge_base_id = $2::uuid AND deleted_at IS NULL"))
            .bind(saved_id).bind(&base).fetch_optional(&mut *tx).await?.ok_or(Failure::NotFound)?;
        tx.commit().await?;
        return Ok(document);
    }
    let document = sqlx::query_as::<_, Document>(&format!("INSERT INTO knowledge.documents (id, knowledge_base_id, title, markdown, created_by, updated_by) VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid, $5::uuid) RETURNING {COLUMNS}, true AS can_edit"))
        .bind(uuid::Uuid::now_v7().to_string()).bind(base).bind(content.title).bind(content.markdown).bind(&actor.id).fetch_one(&mut *tx).await?;
    audit::append(
        &mut tx,
        audit::Event {
            actor_id: &actor.id,
            action: "knowledge.document.create",
            resource_type: "knowledge.document",
            resource_id: &document.id,
            source: audit::Source::Request(request_id),
            subject_user_id: None,
        },
    )
    .await?;
    idempotency::complete(
        &mut tx,
        &attempt,
        serde_json::json!({"document_id":document.id}),
    )
    .await?;
    tx.commit().await?;
    Ok(document)
}

pub(super) fn body_cache_key(id: &str, version: i64) -> String {
    format!("knowledge:body:v1:{id}:{version}")
}

pub(super) async fn read(
    pool: &PgPool,
    actor: &CurrentUser,
    id: uuid::Uuid,
    cache: &labos_threejs_platform::cache::Cache,
) -> Result<Document, Failure> {
    use labos_threejs_platform::cache::Lookup;
    let fresh = || authorized_document(pool, actor, id, true, None);
    if !cache.snapshot().enabled {
        return fresh().await?.ok_or(Failure::NotFound);
    }
    let deadline = cache.deadline();
    for _ in 0..2 {
        let mut header = authorized_document(pool, actor, id, false, None)
            .await?
            .ok_or(Failure::NotFound)?;
        let key = body_cache_key(&header.id, header.version);
        match cache.get(&key, deadline).await {
            Lookup::Hit(markdown) => {
                header.markdown = markdown;
                return Ok(header);
            }
            Lookup::Miss => {
                if let Some(document) =
                    authorized_document(pool, actor, id, true, Some(header.version)).await?
                {
                    let _ = cache.put(&key, &document.markdown, deadline).await;
                    return Ok(document);
                }
                // The version or authorization changed: restart before touching another key.
            }
            Lookup::Unavailable | Lookup::Disabled => {
                return fresh().await?.ok_or(Failure::NotFound);
            }
        }
    }
    // Concurrent editing cannot force an unbounded retry loop; skip cache for this read.
    fresh().await?.ok_or(Failure::NotFound)
}
async fn authorized_document(
    pool: &PgPool,
    actor: &CurrentUser,
    id: uuid::Uuid,
    include_body: bool,
    version: Option<i64>,
) -> Result<Option<Document>, Failure> {
    let mut tx = pool.begin().await?;
    let role = organization::active_role_in(&mut tx, &actor.id)
        .await?
        .ok_or(Failure::Unauthorized)?;
    let body = if include_body {
        "markdown"
    } else {
        "''::text AS markdown"
    };
    let document=sqlx::query_as::<_,Document>(&format!("SELECT id::text, knowledge_base_id::text, title, {body}, version, created_by::text, updated_by::text, created_at, updated_at, ($2 OR EXISTS (SELECT 1 FROM knowledge.grants g WHERE g.knowledge_base_id = documents.knowledge_base_id AND g.user_id = $3::uuid AND g.access = 'editor')) AS can_edit FROM knowledge.documents WHERE id = $1::uuid AND ($4::bigint IS NULL OR version = $4) AND deleted_at IS NULL AND EXISTS (SELECT 1 FROM knowledge.knowledge_bases b WHERE b.id = documents.knowledge_base_id AND b.deleted_at IS NULL) AND ($2 OR EXISTS (SELECT 1 FROM knowledge.grants g WHERE g.knowledge_base_id = documents.knowledge_base_id AND g.user_id = $3::uuid))"))
        .bind(id.to_string()).bind(manager(role)).bind(&actor.id).bind(version).fetch_optional(&mut *tx).await?;
    tx.commit().await?;
    Ok(document)
}

/// Call after holding the current membership and base locks for the mutation.
async fn require_edit(
    connection: &mut sqlx::PgConnection,
    actor_id: &str,
    role: MemberRole,
    base: &str,
) -> Result<(), Failure> {
    if manager(role) {
        return Ok(());
    }
    let grant: Option<String> = sqlx::query_scalar("SELECT access FROM knowledge.grants WHERE knowledge_base_id = $1::uuid AND user_id = $2::uuid")
        .bind(base).bind(actor_id).fetch_optional(connection).await?;
    match grant.as_deref() {
        Some("editor") => Ok(()),
        Some(_) => Err(Failure::Forbidden),
        None => Err(Failure::NotFound),
    }
}

pub(super) async fn update(
    pool: &PgPool,
    actor: &CurrentUser,
    id: uuid::Uuid,
    version: i64,
    content: Content,
    request_id: &str,
) -> Result<Document, Failure> {
    let mut tx = pool.begin().await?;
    let role = organization::active_role_in(&mut tx, &actor.id)
        .await?
        .ok_or(Failure::Forbidden)?;
    let base: String = sqlx::query_scalar("SELECT b.id::text FROM knowledge.knowledge_bases b JOIN knowledge.documents d ON d.knowledge_base_id = b.id WHERE d.id = $1::uuid AND d.deleted_at IS NULL AND b.deleted_at IS NULL FOR SHARE OF b")
        .bind(id.to_string()).fetch_optional(&mut *tx).await?.ok_or(Failure::NotFound)?;
    require_edit(&mut tx, &actor.id, role, &base).await?;
    let document = sqlx::query_as::<_, Document>(&format!("UPDATE knowledge.documents SET title = $1, markdown = $2, version = version + 1, updated_by = $3::uuid, updated_at = clock_timestamp() WHERE id = $4::uuid AND knowledge_base_id = $5::uuid AND version = $6 AND deleted_at IS NULL RETURNING {COLUMNS}, true AS can_edit"))
        .bind(content.title).bind(content.markdown).bind(&actor.id).bind(id.to_string()).bind(base).bind(version)
        .fetch_optional(&mut *tx).await?.ok_or(Failure::VersionConflict)?;
    audit::append(
        &mut tx,
        audit::Event {
            actor_id: &actor.id,
            action: "knowledge.document.update",
            resource_type: "knowledge.document",
            resource_id: &document.id,
            source: audit::Source::Request(request_id),
            subject_user_id: None,
        },
    )
    .await?;
    tx.commit().await?;
    Ok(document)
}

pub(super) async fn list(
    pool: &PgPool,
    actor: &CurrentUser,
    query: DocumentsQuery,
) -> Result<DocumentPage, Failure> {
    let limit = query.limit.unwrap_or(50);
    if !(1..=100).contains(&limit) {
        return Err(Failure::InvalidPage);
    }
    let keyword = query.q.as_deref().unwrap_or("");
    if keyword.chars().count() > 200 || keyword.contains('\0') {
        return Err(Failure::InvalidSearch);
    }
    let keyword = keyword.trim();
    let base_id = query
        .knowledge_base_id
        .as_deref()
        .map(uuid::Uuid::parse_str)
        .transpose()
        .map_err(|_| Failure::NotFound)?;
    let can_create = if let Some(base) = base_id {
        let mut connection = pool.acquire().await?;
        super::bases::read_base(&mut connection, &actor.id, actor.role, base)
            .await?
            .can_edit
    } else {
        sqlx::query_scalar::<_, bool>("SELECT NOT EXISTS (SELECT 1 FROM knowledge.knowledge_bases WHERE personal_owner = $1::uuid) OR EXISTS (SELECT 1 FROM knowledge.knowledge_bases b WHERE b.personal_owner = $1::uuid AND b.deleted_at IS NULL AND ($2 OR EXISTS (SELECT 1 FROM knowledge.grants g WHERE g.knowledge_base_id = b.id AND g.user_id = $1::uuid AND g.access = 'editor')))")
            .bind(&actor.id).bind(manager(actor.role)).fetch_one(pool).await?
    };
    let base_id = base_id.map(|base| base.to_string());
    let filter = idempotency::fingerprint(&(&base_id, keyword))?;
    let pattern = format!(
        "%{}%",
        keyword
            .replace('\\', "\\\\")
            .replace('%', "\\%")
            .replace('_', "\\_")
    );
    let cursor = query
        .cursor
        .as_deref()
        .map(|token| Cursor::decode(token, &actor.id, &filter))
        .transpose()?;
    let mut data = sqlx::query_as::<_, DocumentSummary>("SELECT d.id::text, d.knowledge_base_id::text, d.title, d.version, d.created_at, d.updated_at FROM knowledge.documents d JOIN knowledge.knowledge_bases b ON b.id = d.knowledge_base_id WHERE d.deleted_at IS NULL AND b.deleted_at IS NULL AND (($7::uuid IS NULL AND b.personal_owner = $1::uuid) OR b.id = $7::uuid) AND ($2 OR EXISTS (SELECT 1 FROM knowledge.grants g WHERE g.knowledge_base_id = b.id AND g.user_id = $1::uuid)) AND ($3::timestamptz IS NULL OR (d.created_at, d.id) < ($3::timestamptz, $4::uuid)) AND d.title ILIKE $6 ORDER BY d.created_at DESC, d.id DESC LIMIT $5")
        .bind(&actor.id).bind(manager(actor.role)).bind(cursor.as_ref().map(|cursor| cursor.at)).bind(cursor.as_ref().map(|cursor| cursor.id.as_str())).bind(i64::from(limit) + 1).bind(pattern).bind(base_id).fetch_all(pool).await?;
    let has_more = data.len() > limit as usize;
    data.truncate(limit as usize);
    let next_cursor = if has_more {
        data.last()
            .map(|last| Cursor::encode(&actor.id, &filter, last.created_at, &last.id))
            .transpose()?
    } else {
        None
    };
    Ok(DocumentPage {
        can_create,
        data,
        next_cursor,
        has_more,
    })
}
