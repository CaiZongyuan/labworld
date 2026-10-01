use crate::modules::jobs::{JobError, Maintenance};
use sqlx::PgPool;
use std::sync::Arc;
struct ResetMaintenance {
    pool: PgPool,
}
#[async_trait::async_trait]
impl Maintenance for ResetMaintenance {
    fn name(&self) -> &'static str {
        "identity.reset_materials"
    }
    async fn schedule(&self) -> Result<(), JobError> {
        sqlx::query("DELETE FROM labos_threejs_core.password_reset_mail WHERE reset_id IN (SELECT m.reset_id FROM labos_threejs_core.password_reset_mail m JOIN labos_threejs_core.password_resets r ON r.id=m.reset_id WHERE r.expires_at <= clock_timestamp() OR r.used_at IS NOT NULL OR r.revoked_at IS NOT NULL ORDER BY r.expires_at,m.reset_id FOR UPDATE OF m SKIP LOCKED LIMIT 100)").execute(&self.pool).await?;
        Ok(())
    }
}
/// Expiry cleanup remains registered even if no SMTP service/key is currently configured.
pub fn maintenance(pool: PgPool) -> Arc<dyn Maintenance> {
    Arc::new(ResetMaintenance { pool })
}
