use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
    response::Response,
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

async fn post(
    app: &Router,
    path: &str,
    body: Value,
    cookie: Option<&str>,
    csrf: Option<&str>,
) -> Response {
    let mut request = Request::post(path)
        .header("origin", "http://127.0.0.1:5173")
        .header("content-type", "application/json");
    if let Some(cookie) = cookie {
        request = request.header("cookie", cookie);
    }
    if let Some(csrf) = csrf {
        request = request.header("x-csrf-token", csrf);
    }
    app.clone()
        .oneshot(request.body(Body::from(body.to_string())).unwrap())
        .await
        .unwrap()
}

fn cookie(response: &Response) -> String {
    response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned()
}

async fn body(response: Response) -> Value {
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}

async fn current(app: &Router, cookie: &str) -> Response {
    app.clone()
        .oneshot(
            Request::get("/api/v1/auth/session")
                .header("cookie", cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
}

fn credentials(email: &str) -> Value {
    json!({"email":email, "password":"a-long-test-password"})
}

#[sqlx::test(migrations = "../../migrations")]
async fn an_existing_account_can_sign_in_with_a_fresh_persistent_session(pool: PgPool) {
    let app = labos_threejs_app::router(pool);
    let registration = post(
        &app,
        "/api/v1/auth/register",
        credentials("Login@Example.com"),
        None,
        None,
    )
    .await;
    assert_eq!(registration.status(), StatusCode::CREATED);
    let original_cookie = cookie(&registration);
    let registered = body(registration).await;
    let login = post(
        &app,
        "/api/v1/auth/login",
        credentials(" login@example.COM "),
        None,
        None,
    )
    .await;
    assert_eq!(login.status(), StatusCode::OK);
    let login_cookie = cookie(&login);
    assert_ne!(login_cookie, original_cookie);
    assert_eq!(body(login).await["user"], registered["user"]);
    assert_eq!(
        body(current(&app, &login_cookie).await).await["user"],
        registered["user"]
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn logout_requires_the_session_csrf_token_and_revokes_the_old_cookie(pool: PgPool) {
    let app = labos_threejs_app::router(pool);
    let registration = post(
        &app,
        "/api/v1/auth/register",
        credentials("logout@example.com"),
        None,
        None,
    )
    .await;
    let session_cookie = cookie(&registration);
    let registered = body(registration).await;
    for csrf in [None, Some("not-the-session-token")] {
        let denied = post(
            &app,
            "/api/v1/auth/logout",
            json!({}),
            Some(&session_cookie),
            csrf,
        )
        .await;
        assert_eq!(denied.status(), StatusCode::FORBIDDEN);
        assert_eq!(
            current(&app, &session_cookie).await.status(),
            StatusCode::OK
        );
    }
    let logged_out = post(
        &app,
        "/api/v1/auth/logout",
        json!({}),
        Some(&session_cookie),
        registered["csrf_token"].as_str(),
    )
    .await;
    assert_eq!(logged_out.status(), StatusCode::NO_CONTENT);
    assert!(
        logged_out.headers()["set-cookie"]
            .to_str()
            .unwrap()
            .contains("Max-Age=0")
    );
    assert_eq!(
        current(&app, &session_cookie).await.status(),
        StatusCode::UNAUTHORIZED
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn expired_or_inactive_sessions_are_rejected_using_database_time(pool: PgPool) {
    let app = labos_threejs_app::router(pool.clone());
    for (email, setup) in [
        (
            "absolute@example.com",
            "UPDATE labos_threejs_core.sessions SET expires_at = now() - interval '1 second'",
        ),
        (
            "idle@example.com",
            "UPDATE labos_threejs_core.sessions SET last_seen_at = now() - interval '25 hours'",
        ),
        (
            "inactive@example.com",
            "UPDATE labos_threejs_core.memberships SET active = false",
        ),
    ] {
        let registered = post(
            &app,
            "/api/v1/auth/register",
            credentials(email),
            None,
            None,
        )
        .await;
        let session_cookie = cookie(&registered);
        assert_eq!(
            current(&app, &session_cookie).await.status(),
            StatusCode::OK
        );
        sqlx::query(setup).execute(&pool).await.unwrap();
        assert_eq!(
            current(&app, &session_cookie).await.status(),
            StatusCode::UNAUTHORIZED
        );
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn unknown_wrong_password_and_disabled_credentials_have_the_same_public_error(pool: PgPool) {
    let app = labos_threejs_app::router(pool.clone());
    post(
        &app,
        "/api/v1/auth/register",
        credentials("existing@example.com"),
        None,
        None,
    )
    .await;
    let wrong = post(
        &app,
        "/api/v1/auth/login",
        json!({"email":"existing@example.com", "password":"incorrect-password"}),
        None,
        None,
    )
    .await;
    let missing = post(
        &app,
        "/api/v1/auth/login",
        credentials("missing@example.com"),
        None,
        None,
    )
    .await;
    sqlx::query("UPDATE labos_threejs_core.memberships SET active = false")
        .execute(&pool)
        .await
        .unwrap();
    let stopped = post(
        &app,
        "/api/v1/auth/login",
        credentials("existing@example.com"),
        None,
        None,
    )
    .await;
    for response in [wrong, missing, stopped] {
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert!(!response.headers().contains_key("set-cookie"));
        let response = body(response).await;
        assert_eq!(response["error"]["code"], "auth.invalid_credentials");
        assert_eq!(
            response["error"]["message"],
            "Email or password is incorrect"
        );
        assert!(!response.to_string().contains("a-long-test-password"));
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn login_recovers_an_account_when_registration_session_issuance_failed(pool: PgPool) {
    let app = labos_threejs_app::router(pool.clone());
    let mut blocked = pool.begin().await.unwrap();
    sqlx::query("LOCK TABLE labos_threejs_core.sessions IN ACCESS EXCLUSIVE MODE")
        .execute(&mut *blocked)
        .await
        .unwrap();
    let registration = post(
        &app,
        "/api/v1/auth/register",
        credentials("recover@example.com"),
        None,
        None,
    )
    .await;
    assert_eq!(registration.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        body(registration).await["error"]["code"],
        "auth.session_unavailable"
    );
    blocked.rollback().await.unwrap();
    let login = post(
        &app,
        "/api/v1/auth/login",
        credentials("recover@example.com"),
        None,
        None,
    )
    .await;
    assert_eq!(login.status(), StatusCode::OK);
    assert_eq!(body(login).await["user"]["role"], "owner");
}

#[sqlx::test(migrations = "../../migrations")]
async fn csrf_is_bound_to_its_session_and_foreign_origins_get_no_credentialed_cors(pool: PgPool) {
    let app = labos_threejs_app::router(pool);
    let first = post(
        &app,
        "/api/v1/auth/register",
        credentials("first@example.com"),
        None,
        None,
    )
    .await;
    let first_cookie = cookie(&first);
    let second = post(
        &app,
        "/api/v1/auth/register",
        credentials("second@example.com"),
        None,
        None,
    )
    .await;
    let token = body(second).await["csrf_token"]
        .as_str()
        .unwrap()
        .to_owned();
    assert_eq!(
        post(
            &app,
            "/api/v1/auth/logout",
            json!({}),
            Some(&first_cookie),
            Some(&token)
        )
        .await
        .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(current(&app, &first_cookie).await.status(), StatusCode::OK);
    for origin in [None, Some("https://attacker.test"), Some("null")] {
        let mut request =
            Request::post("/api/v1/auth/login").header("content-type", "application/json");
        if let Some(origin) = origin {
            request = request.header("origin", origin);
        }
        let denied = app
            .clone()
            .oneshot(
                request
                    .body(Body::from(credentials("first@example.com").to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(denied.status(), StatusCode::FORBIDDEN);
        assert!(!denied.headers().contains_key("access-control-allow-origin"));
        assert!(
            !denied
                .headers()
                .contains_key("access-control-allow-credentials")
        );
    }
    let preflight = app
        .oneshot(
            Request::builder()
                .method("OPTIONS")
                .uri("/api/v1/auth/logout")
                .header("origin", "https://attacker.test")
                .header("access-control-request-method", "POST")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert!(
        !preflight
            .headers()
            .contains_key("access-control-allow-origin")
    );
}
