use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

async fn register(app: Router, email: &str) -> axum::response::Response {
    app.oneshot(Request::post("/api/v1/auth/register")
        .header("content-type", "application/json")
        .header("origin", "http://127.0.0.1:5173")
        .body(Body::from(json!({"email": email, "password": "a-long-test-password", "display_name": "学习者"}).to_string())).unwrap())
        .await.unwrap()
}

async fn json_body(response: axum::response::Response) -> Value {
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}

#[sqlx::test(migrations = "../../migrations")]
async fn registration_creates_an_owner_and_an_http_only_session(pool: PgPool) {
    let app = labos_threejs_app::router(pool);
    let response = register(app.clone(), "  Learner@Example.com  ").await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let cookie = response
        .headers()
        .get("set-cookie")
        .unwrap()
        .to_str()
        .unwrap()
        .to_owned();
    assert!(cookie.contains("HttpOnly"));
    assert!(cookie.contains("SameSite=Lax"));
    assert!(cookie.contains("Path=/"));
    let registered = json_body(response).await;
    assert_eq!(registered["user"]["role"], "owner");
    assert_eq!(registered["user"]["email"], "Learner@Example.com");
    assert!(registered["csrf_token"].as_str().unwrap().len() >= 32);
    let current = app
        .oneshot(
            Request::get("/api/v1/auth/session")
                .header("cookie", cookie.split(';').next().unwrap())
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(current.status(), StatusCode::OK);
    assert_eq!(current.headers()["cache-control"], "no-store");
    assert_eq!(json_body(current).await, registered);
}

#[sqlx::test(migrations = "../../migrations")]
async fn a_blocked_session_reports_a_committed_account_without_allowing_a_duplicate(pool: PgPool) {
    let mut lock = pool.begin().await.unwrap();
    sqlx::query("LOCK TABLE labos_threejs_core.sessions IN ACCESS EXCLUSIVE MODE")
        .execute(&mut *lock)
        .await
        .unwrap();
    let app = labos_threejs_app::router(pool.clone());
    let response = register(app.clone(), "session-failure@example.com").await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(
        json_body(response).await["error"]["code"],
        "auth.session_unavailable"
    );
    lock.rollback().await.unwrap();
    assert_eq!(
        register(app, "session-failure@example.com").await.status(),
        StatusCode::CONFLICT
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn concurrent_registration_has_one_initial_owner_and_one_account_per_normalized_email(
    pool: PgPool,
) {
    let app = labos_threejs_app::router(pool.clone());
    let mut owner_gate = pool.begin().await.unwrap();
    sqlx::query("LOCK TABLE labos_threejs_core.organizations IN SHARE MODE")
        .execute(&mut *owner_gate)
        .await
        .unwrap();
    let (a, b, ()) = tokio::join!(
        register(app.clone(), "first@example.com"),
        register(app.clone(), "second@example.com"),
        release_after_two_waiters(&pool, owner_gate)
    );
    assert_eq!(a.status(), StatusCode::CREATED);
    assert_eq!(b.status(), StatusCode::CREATED);
    let roles = [
        json_body(a).await["user"]["role"].clone(),
        json_body(b).await["user"]["role"].clone(),
    ];
    assert_eq!(roles.iter().filter(|role| **role == "owner").count(), 1);
    assert_eq!(roles.iter().filter(|role| **role == "member").count(), 1);
    let mut email_gate = pool.begin().await.unwrap();
    sqlx::query("LOCK TABLE labos_threejs_core.users IN SHARE MODE")
        .execute(&mut *email_gate)
        .await
        .unwrap();
    let (a, b, ()) = tokio::join!(
        register(app.clone(), "  Same@Example.com "),
        register(app, "same@example.COM"),
        release_after_two_waiters(&pool, email_gate)
    );
    let mut codes = [a.status().as_u16(), b.status().as_u16()];
    codes.sort();
    assert_eq!(codes, [201, 409]);
    // Storage invariants: every successful account has exactly one related row.
    for table in ["users", "credentials", "memberships", "audit_events"] {
        let count: i64 =
            sqlx::query_scalar(&format!("SELECT count(*) FROM labos_threejs_core.{table}"))
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count, 3, "{table}");
    }
}

async fn release_after_two_waiters(pool: &PgPool, gate: sqlx::Transaction<'_, sqlx::Postgres>) {
    // Observe real PostgreSQL lock contention before releasing the shared barrier.
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        loop {
            let waiting: i64 = sqlx::query_scalar("SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'").fetch_one(pool).await.unwrap();
            if waiting >= 2 { break; }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
    }).await.expect("both registrations must contend before the gate opens");
    gate.rollback().await.unwrap();
}

#[sqlx::test(migrations = "../../migrations")]
async fn audit_failure_rolls_back_registration_and_preserves_first_owner_initialization(
    pool: PgPool,
) {
    sqlx::raw_sql("CREATE FUNCTION labos_threejs_core.reject_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected storage failure'; END $$; CREATE TRIGGER reject_audit BEFORE INSERT ON labos_threejs_core.audit_events FOR EACH ROW EXECUTE FUNCTION labos_threejs_core.reject_audit();")
        .execute(&pool).await.unwrap();
    let app = labos_threejs_app::router(pool.clone());
    assert_eq!(
        register(app.clone(), "rollback@example.com").await.status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    for table in [
        "users",
        "credentials",
        "memberships",
        "organizations",
        "audit_events",
    ] {
        let count: i64 =
            sqlx::query_scalar(&format!("SELECT count(*) FROM labos_threejs_core.{table}"))
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(count, 0, "{table}");
    }
    sqlx::query("DROP TRIGGER reject_audit ON labos_threejs_core.audit_events")
        .execute(&pool)
        .await
        .unwrap();
    let retried = register(app, "rollback@example.com").await;
    assert_eq!(retried.status(), StatusCode::CREATED);
    assert_eq!(json_body(retried).await["user"]["role"], "owner");
}

#[sqlx::test(migrations = "../../migrations")]
async fn untrusted_origins_invalid_input_and_injected_roles_cannot_claim_owner(pool: PgPool) {
    let app = labos_threejs_app::router(pool);
    for (origin, body, expected) in [
        (
            "https://attacker.test",
            json!({"email":"owner@example.com","password":"a-long-test-password"}),
            StatusCode::FORBIDDEN,
        ),
        (
            "null",
            json!({"email":"owner@example.com","password":"a-long-test-password"}),
            StatusCode::FORBIDDEN,
        ),
        (
            "http://127.0.0.1:5173",
            json!({"email":"owner@example.com","password":"a-long-test-password","role":"owner"}),
            StatusCode::BAD_REQUEST,
        ),
        (
            "http://127.0.0.1:5173",
            json!({"email":"invalid","password":"short"}),
            StatusCode::BAD_REQUEST,
        ),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::post("/api/v1/auth/register")
                    .header("origin", origin)
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), expected);
        let body = json_body(response).await;
        assert!(body["error"]["request_id"].is_string());
        assert!(!body.to_string().contains("a-long-test-password"));
    }
    assert_eq!(
        json_body(register(app, "owner@example.com").await).await["user"]["role"],
        "owner"
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn duplicate_registration_cannot_replace_credentials_or_reactivate_membership(pool: PgPool) {
    let app = labos_threejs_app::router(pool.clone());
    let response = register(app.clone(), "disabled@example.com").await;
    let cookie = response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let user_id = json_body(response).await["user"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let old_hash: String = sqlx::query_scalar(
        "SELECT password_hash FROM labos_threejs_core.credentials WHERE user_id = $1::uuid",
    )
    .bind(&user_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert!(old_hash.starts_with("$argon2id$v=19$m=19456,t=2,p=1$"));
    assert!(!old_hash.contains("a-long-test-password"));
    let session_hash: Vec<u8> = sqlx::query_scalar(
        "SELECT secret_hash FROM labos_threejs_core.sessions WHERE user_id = $1::uuid",
    )
    .bind(&user_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(session_hash.len(), 32);
    assert_ne!(hex::encode(session_hash), cookie.split_once('=').unwrap().1);
    // Set up a stopped membership before the member-management UI is introduced.
    sqlx::query(
        "UPDATE labos_threejs_core.memberships SET active = false WHERE user_id = $1::uuid",
    )
    .bind(&user_id)
    .execute(&pool)
    .await
    .unwrap();
    let repeated = app
        .clone()
        .oneshot(
            Request::post("/api/v1/auth/register")
                .header("origin", "http://127.0.0.1:5173")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"email":"DISABLED@example.com", "password":"different-long-password"})
                        .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(repeated.status(), StatusCode::CONFLICT);
    let current_hash: String = sqlx::query_scalar(
        "SELECT password_hash FROM labos_threejs_core.credentials WHERE user_id = $1::uuid",
    )
    .bind(&user_id)
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(current_hash, old_hash);
    let current = app
        .oneshot(
            Request::get("/api/v1/auth/session")
                .header("cookie", cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(current.status(), StatusCode::UNAUTHORIZED);
}

#[sqlx::test(migrations = "../../migrations")]
async fn https_sessions_use_host_only_secure_cookies(pool: PgPool) {
    let app = labos_threejs_app::router_with_auth(
        pool,
        labos_threejs_platform::config::AuthSettings {
            origin: "https://knowledge.example.com".into(),
            secure_cookie: true,
            ..Default::default()
        },
    );
    let response = app
        .oneshot(
            Request::post("/api/v1/auth/register")
                .header("origin", "https://knowledge.example.com")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"email":"secure@example.com", "password":"a-long-test-password"})
                        .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let cookie = response.headers()["set-cookie"].to_str().unwrap();
    assert!(cookie.starts_with("__Host-labos_threejs_session="));
    assert!(cookie.contains("; Secure"));
    assert!(cookie.contains("HttpOnly"));
    assert!(!cookie.contains("Domain="));
}

#[sqlx::test(migrations = "../../migrations")]
async fn oversized_registration_has_the_public_413_error_contract(pool: PgPool) {
    let response = labos_threejs_app::router(pool)
        .oneshot(
            Request::post("/api/v1/auth/register")
                .header("origin", "http://127.0.0.1:5173")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"email":"large@example.com", "password":"x".repeat(17000)}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert!(json_body(response).await["error"]["request_id"].is_string());
}

#[sqlx::test(migrations = "../../migrations")]
async fn incomplete_registration_bodies_time_out_with_a_request_id(pool: PgPool) {
    let pending =
        futures_util::stream::pending::<Result<axum::body::Bytes, std::convert::Infallible>>();
    let response = tokio::time::timeout(
        std::time::Duration::from_secs(4),
        labos_threejs_app::router(pool).oneshot(
            Request::post("/api/v1/auth/register")
                .header("origin", "http://127.0.0.1:5173")
                .header("content-type", "application/json")
                .body(Body::from_stream(pending))
                .unwrap(),
        ),
    )
    .await
    .expect("body extraction must have a deadline")
    .unwrap();
    assert_eq!(response.status(), StatusCode::REQUEST_TIMEOUT);
    assert!(json_body(response).await["error"]["request_id"].is_string());
}
