use super::{JobPayload, MailPayload, PasswordReset};
use crate::modules::{jobs, mail::Binding, organization};
use sqlx::PgPool;

pub(super) async fn issue(
    pool: &PgPool,
    service: &PasswordReset,
    origin: &str,
    email: &str,
    locale: Option<&str>,
    request: &str,
) -> Result<(), ()> {
    let mut tx = pool.begin().await.map_err(|_| ())?;
    let profile: Option<(String, String)> = sqlx::query_as(
        "SELECT id::text,email FROM labos_threejs_core.users WHERE normalized_email = $1",
    )
    .bind(email.to_lowercase())
    .fetch_optional(&mut *tx)
    .await
    .map_err(|_| ())?;
    let Some((user_id, recipient)) = profile else {
        return Ok(());
    };
    if organization::active_role_in(&mut tx, &user_id)
        .await
        .map_err(|_| ())?
        .is_none()
    {
        return Ok(());
    }
    let credential: Option<String> = sqlx::query_scalar(
        "SELECT user_id::text FROM labos_threejs_core.credentials WHERE user_id = $1::uuid FOR UPDATE",
    )
    .bind(&user_id)
    .fetch_optional(&mut *tx)
    .await
    .map_err(|_| ())?;
    if credential.is_none() {
        return Ok(());
    }
    // A repeated unauthenticated request cannot invalidate a link the user is about to use.
    let recent:bool=sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM labos_threejs_core.password_resets WHERE user_id = $1::uuid AND used_at IS NULL AND revoked_at IS NULL AND expires_at > clock_timestamp() AND created_at > clock_timestamp() - make_interval(secs => $2))").bind(&user_id).bind(f64::from(service.policy.cooldown_secs)).fetch_one(&mut *tx).await.map_err(|_|())?;
    if recent {
        return Ok(());
    }
    let expires: chrono::DateTime<chrono::Utc> = sqlx::query_scalar(
        "SELECT date_trunc('second',clock_timestamp()) + make_interval(secs => $1)",
    )
    .bind(f64::from(service.policy.ttl_secs))
    .fetch_one(&mut *tx)
    .await
    .map_err(|_| ())?;
    let reset_id = uuid::Uuid::now_v7().to_string();
    let token = crate::secrets::secret()?;
    let job_id = jobs::enqueue(
        &mut tx,
        jobs::NewJob {
            kind: "identity.password_reset",
            schema_version: 1,
            max_attempts: 5,
            payload: serde_json::to_value(JobPayload {
                reset_id: reset_id.clone(),
            })
            .map_err(|_| ())?,
            correlation_id: request,
        },
    )
    .await
    .map_err(|_| ())?;
    // The language hint rides in the fragment next to the token: it never
    // reaches the server and only steers the reset flow's language.
    let link = match locale {
        Some(language) => format!("{origin}/reset-password#token={token}&lang={language}"),
        None => format!("{origin}/reset-password#token={token}"),
    };
    let payload = serde_json::to_vec(&MailPayload {
        recipient,
        link,
        locale: locale.map(str::to_owned),
    })
    .map_err(|_| ())?;
    let sealed = service
        .mail
        .seal(
            &Binding {
                purpose: "identity.password_reset",
                resource_id: &reset_id,
                job_id: &job_id,
                user_id: &user_id,
                expires_at: expires.timestamp(),
            },
            &payload,
        )
        .map_err(|_| ())?;
    sqlx::query("INSERT INTO labos_threejs_core.password_resets (id,user_id,token_hash,job_id,expires_at) VALUES ($1::uuid,$2::uuid,$3,$4::uuid,$5)").bind(&reset_id).bind(&user_id).bind(crate::secrets::secret_hash(&token)).bind(&job_id).bind(expires).execute(&mut *tx).await.map_err(|_|())?;
    sqlx::query("INSERT INTO labos_threejs_core.password_reset_mail (reset_id,key_version,nonce,ciphertext) VALUES ($1::uuid,$2,$3,$4)").bind(&reset_id).bind(sealed.key_version).bind(sealed.nonce).bind(sealed.ciphertext).execute(&mut *tx).await.map_err(|_|())?;
    tx.commit().await.map_err(|_| ())
}
