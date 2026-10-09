use super::inbox::{self, Notification, NotificationPage};
use crate::{
    http::{ApiPath, ApiQuery, RequestId, public_error},
    modules::identity,
};
use axum::{
    Extension, Json, Router,
    extract::State,
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use labos_threejs_platform::config::AuthSettings;
use sqlx::PgPool;
use utoipa::OpenApi;

#[derive(Clone)]
struct Inbox {
    pool: PgPool,
    auth: AuthSettings,
}
pub fn router(pool: PgPool, auth: AuthSettings) -> Router {
    Router::new()
        .route("/api/v1/notifications", get(list_notifications))
        .route("/api/v1/notifications/{id}/read", post(read_notification))
        .with_state(Inbox { pool, auth })
}
#[derive(OpenApi)]
#[openapi(paths(list_notifications, read_notification))]
struct NotificationsApi;
pub fn openapi() -> utoipa::openapi::OpenApi {
    NotificationsApi::openapi()
}
fn unavailable(id: RequestId) -> Response {
    public_error(
        StatusCode::SERVICE_UNAVAILABLE,
        "notifications.unavailable",
        "Notifications are temporarily unavailable",
        id,
    )
}
fn not_found(id: RequestId) -> Response {
    public_error(
        StatusCode::NOT_FOUND,
        "notifications.not_found",
        "Notification not found",
        id,
    )
}
#[utoipa::path(get,path="/api/v1/notifications",operation_id="listNotifications",tag="Notifications",params(inbox::InboxQuery),responses((status=200,body=NotificationPage),(status=400,body=crate::http::ApiErrorResponse),(status=401,body=crate::http::ApiErrorResponse),(status=503,body=crate::http::ApiErrorResponse)))]
async fn list_notifications(
    State(state): State<Inbox>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiQuery(query): ApiQuery<inbox::InboxQuery>,
) -> Response {
    let session =
        match identity::require_session(&state.pool, &state.auth, &headers, &id, false).await {
            Ok(session) => session,
            Err(response) => return response,
        };
    match tokio::time::timeout(
        std::time::Duration::from_secs(3),
        inbox::list(&state.pool, &session.user.id, query),
    )
    .await
    {
        Ok(Ok(page)) => Json(page).into_response(),
        Ok(Err(inbox::Error::InvalidPage)) => public_error(
            StatusCode::BAD_REQUEST,
            "notifications.invalid_page",
            "Use a valid inbox cursor and filter",
            id,
        ),
        _ => unavailable(id),
    }
}
#[utoipa::path(post,path="/api/v1/notifications/{id}/read",operation_id="readNotification",tag="Notifications",params(("id"=String,Path),("x-csrf-token"=String,Header)),responses((status=200,body=Notification),(status=401,body=crate::http::ApiErrorResponse),(status=403,body=crate::http::ApiErrorResponse),(status=404,body=crate::http::ApiErrorResponse),(status=503,body=crate::http::ApiErrorResponse)))]
async fn read_notification(
    State(state): State<Inbox>,
    Extension(id): Extension<RequestId>,
    headers: HeaderMap,
    ApiPath(notification): ApiPath<String>,
) -> Response {
    let session =
        match identity::require_session(&state.pool, &state.auth, &headers, &id, true).await {
            Ok(session) => session,
            Err(response) => return response,
        };
    let Ok(notification) = uuid::Uuid::parse_str(&notification) else {
        return not_found(id);
    };
    match tokio::time::timeout(
        std::time::Duration::from_secs(3),
        inbox::read(&state.pool, &session.user.id, notification),
    )
    .await
    {
        Ok(Ok(Some(notice))) => Json(notice).into_response(),
        Ok(Ok(None)) => not_found(id),
        _ => unavailable(id),
    }
}
