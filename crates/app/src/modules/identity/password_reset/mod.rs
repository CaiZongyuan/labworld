mod maintenance;
pub use maintenance::maintenance;
mod consume;
pub use consume::revoke;
mod requests;
mod worker;
use super::{Identity, origin_rejection};
use crate::{
    http::{BoundedJson, RequestId, public_error},
    modules::{jobs, mail::MailService},
};
use axum::{
    Extension, Json,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
};
use labos_threejs_platform::config::{ConfigError, Setting};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use std::sync::Arc;
use utoipa::{OpenApi, ToSchema};

pub const FIELDS: &[Setting] = &[
    Setting {
        name: "PASSWORD_RESET_TTL_SECS",
        default: Some("1800"),
        secret: false,
        description: "Reset link lifetime (60..3600 seconds); mail material cannot outlive the link.",
        description_zh: "重置链接有效期（60..3600 秒）；邮件材料不会超过链接有效期。",
    },
    Setting {
        name: "PASSWORD_RESET_COOLDOWN_SECS",
        default: Some("60"),
        secret: false,
        description: "Coalesce repeated active reset requests for one account (1..300 seconds).",
        description_zh: "合并同一账号活跃的重置请求（1..300 秒）。",
    },
];
#[derive(Clone)]
pub struct ResetPolicy {
    pub ttl_secs: u32,
    pub cooldown_secs: u32,
}
impl Default for ResetPolicy {
    fn default() -> Self {
        Self {
            ttl_secs: 1800,
            cooldown_secs: 60,
        }
    }
}
#[derive(Clone)]
pub struct PasswordReset {
    mail: MailService,
    policy: ResetPolicy,
}
impl PasswordReset {
    pub fn new(mail: MailService, policy: ResetPolicy) -> Result<Self, ConfigError> {
        if !(60..=3600).contains(&policy.ttl_secs) {
            return Err(ConfigError("PASSWORD_RESET_TTL_SECS"));
        }
        if !(1..=300).contains(&policy.cooldown_secs) {
            return Err(ConfigError("PASSWORD_RESET_COOLDOWN_SECS"));
        }
        Ok(Self { mail, policy })
    }
    pub fn from_env() -> Result<Option<Self>, ConfigError> {
        let Some(mail) = MailService::from_env()? else {
            return Ok(None);
        };
        let number = |name: &'static str, default: &str| {
            std::env::var(name)
                .unwrap_or_else(|_| default.into())
                .parse::<u32>()
                .map_err(|_| ConfigError(name))
        };
        Self::new(
            mail,
            ResetPolicy {
                ttl_secs: number("PASSWORD_RESET_TTL_SECS", "1800")?,
                cooldown_secs: number("PASSWORD_RESET_COOLDOWN_SECS", "60")?,
            },
        )
        .map(Some)
    }
    pub fn handler(&self, pool: PgPool) -> Arc<dyn jobs::Handler> {
        Arc::new(worker::ResetMail {
            pool,
            service: self.clone(),
        })
    }
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct JobPayload {
    reset_id: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct MailPayload {
    recipient: String,
    link: String,
    /// Delivery language captured when the reset was requested; retries
    /// read this snapshot. Material sealed before the field existed has
    /// no key and keeps the default Chinese delivery.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    locale: Option<String>,
}
#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct ResetRequest {
    email: String,
    /// Reset email language: `zh` or `en`. Omitted keeps the default
    /// Chinese delivery for existing clients. Other values are rejected
    /// with `auth.invalid_input`.
    locale: Option<String>,
}
#[derive(Serialize, ToSchema)]
struct ResetAccepted {
    status: &'static str,
}
#[derive(OpenApi)]
#[openapi(paths(request, complete))]
struct ResetApi;
pub fn openapi() -> utoipa::openapi::OpenApi {
    ResetApi::openapi()
}
#[utoipa::path(post,path="/api/v1/auth/password-reset",operation_id="requestPasswordReset",tag="Identity",request_body=ResetRequest,responses((status=202,body=ResetAccepted),(status=400,body=crate::http::ApiErrorResponse),(status=403,body=crate::http::ApiErrorResponse),(status=408,body=crate::http::ApiErrorResponse),(status=413,body=crate::http::ApiErrorResponse),(status=503,body=crate::http::ApiErrorResponse)))]
pub(super) async fn request(
    State(state): State<Identity>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    BoundedJson(input): BoundedJson<ResetRequest>,
) -> Response {
    if let Some(response) = origin_rejection(&state.settings, &headers, &id) {
        return response;
    }
    let email = input.email.trim();
    if email.len() > 254 || !email_address::EmailAddress::is_valid(email) {
        return public_error(
            StatusCode::BAD_REQUEST,
            "auth.invalid_input",
            "Use a valid email address",
            id,
        );
    }
    // Constrained vocabulary: an unsupported language is a validation
    // error, not a silent fallback to the default delivery.
    let locale = input.locale.as_deref();
    if locale.is_some_and(|language| language != "zh" && language != "en") {
        return public_error(
            StatusCode::BAD_REQUEST,
            "auth.invalid_input",
            "Use zh or en as the reset language",
            id,
        );
    }
    let Some(service) = &state.password_reset else {
        return unavailable(id);
    };
    match tokio::time::timeout(
        std::time::Duration::from_secs(3),
        requests::issue(
            &state.pool,
            service,
            &state.settings.origin,
            email,
            locale,
            &id.0,
        ),
    )
    .await
    {
        Ok(Ok(())) => (
            StatusCode::ACCEPTED,
            Json(ResetAccepted { status: "accepted" }),
        )
            .into_response(),
        _ => unavailable(id),
    }
}
fn unavailable(id: RequestId) -> Response {
    public_error(
        StatusCode::SERVICE_UNAVAILABLE,
        "auth.reset_unavailable",
        "Password reset is temporarily unavailable",
        id,
    )
}

#[derive(Deserialize, ToSchema)]
#[serde(deny_unknown_fields)]
pub(super) struct CompleteReset {
    #[schema(min_length = 64, max_length = 64)]
    token: String,
    #[schema(min_length = 12, max_length = 128)]
    password: String,
}
#[utoipa::path(post,path="/api/v1/auth/password-reset/complete",operation_id="completePasswordReset",tag="Identity",request_body=CompleteReset,responses((status=204),(status=400,body=crate::http::ApiErrorResponse),(status=401,body=crate::http::ApiErrorResponse),(status=403,body=crate::http::ApiErrorResponse),(status=408,body=crate::http::ApiErrorResponse),(status=413,body=crate::http::ApiErrorResponse),(status=503,body=crate::http::ApiErrorResponse)))]
pub(super) async fn complete(
    State(state): State<Identity>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    BoundedJson(input): BoundedJson<CompleteReset>,
) -> Response {
    if let Some(response) = origin_rejection(&state.settings, &headers, &id) {
        return response;
    }
    if input.token.len() != 64
        || !input.token.bytes().all(|b| b.is_ascii_hexdigit())
        || !(12..=128).contains(&input.password.chars().count())
    {
        return public_error(
            StatusCode::BAD_REQUEST,
            "auth.invalid_input",
            "Use the reset token and a 12–128 character password",
            id,
        );
    }
    let token_hash = crate::secrets::secret_hash(&input.token);
    let user = match tokio::time::timeout(
        std::time::Duration::from_secs(3),
        consume::eligible(&state.pool, &token_hash),
    )
    .await
    {
        Ok(Ok(user)) => user,
        Ok(Err(consume::Error::Invalid)) => return invalid(id),
        _ => return unavailable(id),
    };
    let Ok(permit) = state.password_slots.clone().try_acquire_owned() else {
        return unavailable(id);
    };
    let hashed = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        super::crypto::hash_password(input.password)
    });
    let password_hash = match tokio::time::timeout(std::time::Duration::from_secs(5), hashed).await
    {
        Ok(Ok(Ok(hash))) => hash,
        _ => return unavailable(id),
    };
    match tokio::time::timeout(
        std::time::Duration::from_secs(3),
        consume::change(&state.pool, &user, &token_hash, password_hash, &id.0),
    )
    .await
    {
        Ok(Ok(())) => {
            let cookie = format!(
                "{}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0{}",
                super::cookie_name(&state.settings),
                if state.settings.secure_cookie {
                    "; Secure"
                } else {
                    ""
                }
            );
            (StatusCode::NO_CONTENT, [("set-cookie", cookie)]).into_response()
        }
        Ok(Err(consume::Error::Invalid)) => invalid(id),
        _ => unavailable(id),
    }
}
fn invalid(id: RequestId) -> Response {
    public_error(
        StatusCode::UNAUTHORIZED,
        "auth.reset_invalid",
        "Reset link is invalid or no longer active",
        id,
    )
}
