use super::{JobPayload, MailPayload, PasswordReset};
use crate::modules::{
    jobs::{Handler, JobError, Lease},
    mail::{Binding, MaterialError, Sealed},
    organization,
};
use labos_threejs_platform::mail::DeliveryFailure;
use sqlx::PgPool;

pub(super) struct ResetMail {
    pub pool: PgPool,
    pub service: PasswordReset,
}
#[async_trait::async_trait]
impl Handler for ResetMail {
    fn kind(&self) -> &'static str {
        "identity.password_reset"
    }
    async fn run(&self, lease: &Lease) -> Result<(), JobError> {
        if lease.schema_version != 1 {
            return Err(JobError::Permanent("identity.reset_unknown_payload"));
        }
        let payload: JobPayload = serde_json::from_value(lease.payload.clone())
            .map_err(|_| JobError::Permanent("identity.reset_unknown_payload"))?;
        let reset_id = uuid::Uuid::parse_str(&payload.reset_id)
            .map_err(|_| JobError::Permanent("identity.reset_unknown_payload"))?
            .to_string();
        let mut tx = self.pool.begin().await?;
        let user:Option<String>=sqlx::query_scalar("SELECT user_id::text FROM labos_threejs_core.password_resets WHERE id=$1::uuid AND job_id=$2::uuid").bind(&reset_id).bind(&lease.id).fetch_optional(&mut *tx).await?;
        let Some(user) = user else {
            lease.succeed(&mut tx).await?;
            tx.commit().await?;
            return Ok(());
        };
        let member = organization::active_role_in(&mut tx, &user)
            .await?
            .is_some();
        let credential: Option<String> = sqlx::query_scalar(
            "SELECT user_id::text FROM labos_threejs_core.credentials WHERE user_id=$1::uuid FOR SHARE",
        )
        .bind(&user)
        .fetch_optional(&mut *tx)
        .await?;
        let (expires,active):(chrono::DateTime<chrono::Utc>,bool)=sqlx::query_as("SELECT expires_at,used_at IS NULL AND revoked_at IS NULL AND expires_at > clock_timestamp() FROM labos_threejs_core.password_resets WHERE id=$1::uuid AND job_id=$2::uuid FOR SHARE").bind(&reset_id).bind(&lease.id).fetch_one(&mut *tx).await?;
        if !member || !active || credential.is_none() {
            lease.lock_current(&mut tx).await?;
            sqlx::query("DELETE FROM labos_threejs_core.password_reset_mail WHERE reset_id=$1::uuid")
                .bind(&reset_id)
                .execute(&mut *tx)
                .await?;
            lease.succeed(&mut tx).await?;
            tx.commit().await?;
            return Ok(());
        }
        let material:Option<(i32,Vec<u8>,Vec<u8>)>=sqlx::query_as("SELECT key_version,nonce,ciphertext FROM labos_threejs_core.password_reset_mail WHERE reset_id=$1::uuid FOR SHARE").bind(&reset_id).fetch_optional(&mut *tx).await?;
        let Some((key_version, nonce, ciphertext)) = material else {
            return Err(JobError::Permanent("identity.reset_material_missing"));
        };
        lease.lock_current(&mut tx).await?;
        tx.commit().await?;
        let raw = self
            .service
            .mail
            .open(
                &Binding {
                    purpose: "identity.password_reset",
                    resource_id: &reset_id,
                    job_id: &lease.id,
                    user_id: &user,
                    expires_at: expires.timestamp(),
                },
                &Sealed {
                    key_version,
                    nonce,
                    ciphertext,
                },
            )
            .map_err(|error| match error {
                MaterialError::KeyUnavailable => JobError::Permanent("mail.key_unavailable"),
                _ => JobError::Permanent("mail.material_invalid"),
            })?;
        let material: MailPayload = serde_json::from_slice(&raw)
            .map_err(|_| JobError::Permanent("mail.material_invalid"))?;
        let remaining = (expires - chrono::Utc::now())
            .to_std()
            .map_err(|_| JobError::Permanent("identity.reset_expired"))?;
        // The language was fixed when the material was sealed, so every
        // attempt of this job — and material sealed before the field
        // existed — speaks one language.
        let (subject, body) = match material.locale.as_deref() {
            Some("en") => (
                "Reset your password",
                format!(
                    "Use the one-time link below to set a new password:\n\n{}\n\nThe link stops working once it expires. If you did not request this email, you can ignore it.",
                    material.link
                ),
            ),
            _ => (
                "重置密码",
                format!(
                    "请使用下面的一次性链接设置新密码：\n\n{}\n\n链接到期后无法使用。如果不是你申请的，可以忽略本邮件。",
                    material.link
                ),
            ),
        };
        self.service
            .mail
            .send_plain_text(
                &material.recipient,
                subject,
                body,
                &format!("password-reset-{reset_id}"),
                tokio::time::Instant::now() + remaining,
            )
            .await
            .map_err(|error| match error {
                DeliveryFailure::Transient(code) => JobError::Transient(code),
                DeliveryFailure::Permanent(code) => JobError::Permanent(code),
            })?;
        let mut tx = self.pool.begin().await?;
        lease.lock_current(&mut tx).await?;
        sqlx::query("DELETE FROM labos_threejs_core.password_reset_mail WHERE reset_id=$1::uuid")
            .bind(&reset_id)
            .execute(&mut *tx)
            .await?;
        lease.succeed(&mut tx).await?;
        tx.commit().await?;
        Ok(())
    }
}
