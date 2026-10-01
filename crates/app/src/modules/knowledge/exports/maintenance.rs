use crate::modules::{
    files,
    jobs::{JobError, Maintenance},
};
use sqlx::PgPool;
use std::sync::Arc;

struct Expiry {
    pool: PgPool,
}
#[async_trait::async_trait]
impl Maintenance for Expiry {
    fn name(&self) -> &'static str {
        "knowledge.export_expiry"
    }
    async fn schedule(&self) -> Result<(), JobError> {
        let due:Vec<(String,String)>=sqlx::query_as("SELECT id::text, document_id::text FROM knowledge.exports WHERE expires_at <= clock_timestamp() AND (snapshot IS NOT NULL OR file_id IS NOT NULL) ORDER BY expires_at, id LIMIT 50").fetch_all(&self.pool).await?;
        for (id, document) in due {
            let mut tx = self.pool.begin().await?;
            // Document cleanup takes the source before its files/exports; follow that order.
            let source: Option<String> = sqlx::query_scalar(
                "SELECT id::text FROM knowledge.documents WHERE id = $1::uuid FOR SHARE",
            )
            .bind(document)
            .fetch_optional(&mut *tx)
            .await?;
            if source.is_none() {
                continue;
            }
            let file:Option<Option<String>>=sqlx::query_scalar("SELECT file_id::text FROM knowledge.exports WHERE id = $1::uuid AND expires_at <= clock_timestamp() AND (snapshot IS NOT NULL OR file_id IS NOT NULL) FOR UPDATE").bind(&id).fetch_optional(&mut *tx).await?;
            let Some(file) = file else {
                continue;
            };
            if let Some(file) = file {
                files::mark_deleting(&mut tx, &file, &uuid::Uuid::now_v7().to_string())
                    .await
                    .map_err(|_| JobError::Transient("knowledge.expiry_file_unavailable"))?;
            }
            sqlx::query("UPDATE knowledge.exports SET snapshot = NULL, file_id = NULL, updated_at = now() WHERE id = $1::uuid").bind(id).execute(&mut *tx).await?;
            tx.commit().await?;
        }
        Ok(())
    }
}
pub fn export_maintenance(pool: PgPool) -> Arc<dyn Maintenance> {
    Arc::new(Expiry { pool })
}
