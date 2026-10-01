use axum::{
    Extension, Json,
    extract::{FromRequest, FromRequestParts, MatchedPath, Path, Query, Request},
    http::{HeaderValue, StatusCode},
    middleware::Next,
    response::{IntoResponse, Response},
};
use serde::Serialize;
use std::collections::BTreeMap;
use tracing::Instrument;
use utoipa::ToSchema;

/// Bound incoming JSON before the handler starts its database/CPU budgets.
pub struct BoundedJson<T>(pub T);

pub struct ApiQuery<T>(pub T);

pub struct ApiPath<T>(pub T);

impl<S, T> FromRequestParts<S> for ApiPath<T>
where
    S: Send + Sync,
    T: serde::de::DeserializeOwned + Send,
{
    type Rejection = Response;
    async fn from_request_parts(
        parts: &mut axum::http::request::Parts,
        state: &S,
    ) -> Result<Self, Self::Rejection> {
        let id = parts
            .extensions
            .get::<RequestId>()
            .expect("request_context wraps application routes")
            .clone();
        Path::<T>::from_request_parts(parts, state)
            .await
            .map(|Path(value)| Self(value))
            .map_err(|_| {
                public_error(
                    StatusCode::BAD_REQUEST,
                    "http.invalid_path",
                    "Path parameters are invalid",
                    id,
                )
            })
    }
}

impl<S, T> FromRequestParts<S> for ApiQuery<T>
where
    S: Send + Sync,
    T: serde::de::DeserializeOwned + Send,
{
    type Rejection = Response;
    async fn from_request_parts(
        parts: &mut axum::http::request::Parts,
        state: &S,
    ) -> Result<Self, Self::Rejection> {
        let id = parts
            .extensions
            .get::<RequestId>()
            .expect("request_context wraps application routes")
            .clone();
        Query::<T>::from_request_parts(parts, state)
            .await
            .map(|Query(value)| Self(value))
            .map_err(|_| {
                public_error(
                    StatusCode::BAD_REQUEST,
                    "http.invalid_query",
                    "Query parameters are invalid",
                    id,
                )
            })
    }
}

impl<S, T> FromRequest<S> for BoundedJson<T>
where
    S: Send + Sync,
    T: serde::de::DeserializeOwned + Send,
{
    type Rejection = Response;

    async fn from_request(request: Request, state: &S) -> Result<Self, Self::Rejection> {
        let id = request
            .extensions()
            .get::<RequestId>()
            .expect("request_context wraps application routes")
            .clone();
        match tokio::time::timeout(
            std::time::Duration::from_secs(3),
            Json::<T>::from_request(request, state),
        )
        .await
        {
            Ok(Ok(Json(value))) => Ok(Self(value)),
            Ok(Err(error)) if error.status() == StatusCode::PAYLOAD_TOO_LARGE => Err(public_error(
                StatusCode::PAYLOAD_TOO_LARGE,
                "http.payload_too_large",
                "Request body exceeds the allowed size",
                id,
            )),
            Ok(Err(_)) => Err(public_error(
                StatusCode::BAD_REQUEST,
                "http.invalid_json",
                "Provide a valid JSON request",
                id,
            )),
            Err(_) => Err(public_error(
                StatusCode::REQUEST_TIMEOUT,
                "http.body_timeout",
                "Request body was not received in time",
                id,
            )),
        }
    }
}

#[derive(Clone)]
pub struct RequestId(pub String);

#[derive(Serialize, ToSchema)]
pub struct ApiErrorResponse {
    error: ApiError,
}

#[derive(Serialize, ToSchema)]
pub struct ApiError {
    code: &'static str,
    message: &'static str,
    request_id: String,
    details: BTreeMap<String, String>,
}

pub async fn request_context(mut request: Request, next: Next) -> Response {
    let id = uuid::Uuid::now_v7().to_string();
    let route = request
        .extensions()
        .get::<MatchedPath>()
        .map_or("unmatched", |path| path.as_str());
    let method = labos_threejs_platform::telemetry::method_name(request.method().as_str());
    let metric_route = route.to_owned();
    let started = std::time::Instant::now();
    let span = labos_threejs_platform::telemetry::http_span(
        &id,
        method,
        route,
        request
            .headers()
            .get("traceparent")
            .and_then(|v| v.to_str().ok()),
    );
    let trace_id = labos_threejs_platform::telemetry::trace_id(&span);
    request.extensions_mut().insert(RequestId(id.clone()));
    let correlation = labos_threejs_platform::telemetry::Correlation {
        request_id: Some(id.clone()),
        ..Default::default()
    };
    let mut response = labos_threejs_platform::telemetry::scope(
        correlation,
        async move {
            let response = next.run(request).await;
            labos_threejs_platform::telemetry::http_completed(
                method,
                metric_route,
                response.status().as_u16(),
                started.elapsed(),
            );
            tracing::info!(status = response.status().as_u16(), "request completed");
            response
        }
        .instrument(span),
    )
    .await;
    response.headers_mut().insert(
        "x-request-id",
        HeaderValue::from_str(&id).expect("UUID is a valid header"),
    );
    if let Some(trace_id) = trace_id {
        response.headers_mut().insert(
            "x-trace-id",
            HeaderValue::from_str(&trace_id).expect("trace ID is a valid header"),
        );
    }
    response
        .headers_mut()
        .entry("cache-control")
        .or_insert(HeaderValue::from_static("no-store"));
    response
}

pub async fn not_found(Extension(id): Extension<RequestId>) -> Response {
    public_error(
        StatusCode::NOT_FOUND,
        "http.not_found",
        "Resource not found",
        id,
    )
}

pub async fn method_not_allowed(Extension(id): Extension<RequestId>) -> Response {
    public_error(
        StatusCode::METHOD_NOT_ALLOWED,
        "http.method_not_allowed",
        "Method not allowed",
        id,
    )
}

pub fn public_error(
    status: StatusCode,
    code: &'static str,
    message: &'static str,
    id: RequestId,
) -> Response {
    (
        status,
        Json(ApiErrorResponse {
            error: ApiError {
                code,
                message,
                request_id: id.0,
                details: BTreeMap::new(),
            },
        }),
    )
        .into_response()
}

/// One public error contract for all limiter policies and backends.
pub fn too_many_requests(id: RequestId, retry_after: u64) -> Response {
    let seconds = retry_after.max(1).to_string();
    let mut response = (
        StatusCode::TOO_MANY_REQUESTS,
        Json(ApiErrorResponse {
            error: ApiError {
                code: "rate_limit.exceeded",
                message: "Too many requests; wait before retrying",
                request_id: id.0,
                details: [("retry_after_seconds".into(), seconds.clone())].into(),
            },
        }),
    )
        .into_response();
    response.headers_mut().insert(
        "retry-after",
        HeaderValue::from_str(&seconds).expect("numeric retry delay is a valid header"),
    );
    response
}
