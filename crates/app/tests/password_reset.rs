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

struct Browser {
    id: String,
    cookie: String,
    csrf: String,
}
async fn data(response: Response) -> Value {
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}
async fn register(app: &Router, email: &str) -> Browser {
    let response = app
        .clone()
        .oneshot(
            Request::post("/api/v1/auth/register")
                .header("origin", "http://127.0.0.1:5173")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"email":email,"password":"a-long-test-password"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let cookie = response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let result = data(response).await;
    Browser {
        id: result["user"]["id"].as_str().unwrap().into(),
        cookie,
        csrf: result["csrf_token"].as_str().unwrap().into(),
    }
}
async fn request(app: &Router, actor: &Browser, method: &str, path: &str, body: Value) -> Response {
    request_key(
        app,
        actor,
        method,
        path,
        body,
        &uuid::Uuid::now_v7().to_string(),
    )
    .await
}
async fn request_key(
    app: &Router,
    actor: &Browser,
    method: &str,
    path: &str,
    body: Value,
    key: &str,
) -> Response {
    app.clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("origin", "http://127.0.0.1:5173")
                .header("content-type", "application/json")
                .header("cookie", &actor.cookie)
                .header("x-csrf-token", &actor.csrf)
                .header("idempotency-key", key)
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap()
}

#[sqlx::test(migrations = "../../migrations")]
async fn unavailable_mail_has_the_same_reset_feedback_and_does_not_block_registration(
    pool: PgPool,
) {
    let app = labos_threejs_app::router(pool);
    let owner = register(&app, "reset-owner@example.com").await;
    assert!(!owner.id.is_empty());
    for email in ["reset-owner@example.com", "absent-reset@example.com"] {
        let response = request(
            &app,
            &owner,
            "POST",
            "/api/v1/auth/password-reset",
            json!({"email":email}),
        )
        .await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            data(response).await["error"]["code"],
            "auth.reset_unavailable"
        );
    }
    let another = register(&app, "reset-another@example.com").await;
    assert_ne!(another.id, owner.id);
}

async fn configured(pool: PgPool) -> (Router, labos_threejs_app::modules::identity::PasswordReset) {
    let reset = labos_threejs_app::modules::identity::PasswordReset::from_env()
        .unwrap()
        .expect("run scripts/test-backend.mjs");
    let app = labos_threejs_app::compose_routes_with_options(
        pool,
        Default::default(),
        Router::new(),
        labos_threejs_app::openapi(),
        labos_threejs_app::CoreOptions {
            password_reset: Some(reset.clone()),
            ..Default::default()
        },
    );
    (app, reset)
}
#[sqlx::test(migrations = "../../migrations")]
async fn known_and_missing_emails_have_identical_feedback_and_a_real_worker_delivers_the_link(
    pool: PgPool,
) {
    let (app, reset) = configured(pool.clone()).await;
    let email = format!("reset-{}@example.test", uuid::Uuid::now_v7());
    let owner = register(&app, &email).await;
    let known = request(
        &app,
        &owner,
        "POST",
        "/api/v1/auth/password-reset",
        json!({"email":email}),
    )
    .await;
    let missing = request(
        &app,
        &owner,
        "POST",
        "/api/v1/auth/password-reset",
        json!({"email":"missing-recipient@example.test"}),
    )
    .await;
    assert_eq!(known.status(), StatusCode::ACCEPTED);
    assert_eq!(missing.status(), StatusCode::ACCEPTED);
    assert_eq!(data(known).await, data(missing).await);
    let abandoned = labos_threejs_app::modules::jobs::claim(
        &pool,
        &["identity.password_reset"],
        "crashed-mail-worker",
        60,
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(abandoned.payload.as_object().unwrap().len(), 1);
    assert!(uuid::Uuid::parse_str(abandoned.payload["reset_id"].as_str().unwrap()).is_ok());
    assert!(!abandoned.payload.to_string().contains(&email));
    sqlx::query("UPDATE labos_threejs_core.jobs SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1::uuid").bind(&abandoned.id).execute(&pool).await.unwrap();
    let restarted = labos_threejs_app::modules::identity::PasswordReset::from_env()
        .unwrap()
        .unwrap();
    let worker = labos_threejs_app::modules::jobs::Worker::new(
        pool.clone(),
        vec![restarted.handler(pool.clone())],
        Default::default(),
    );
    assert!(worker.run_once().await.unwrap());
    assert!(!worker.run_once().await.unwrap());
    assert!(reset.handler(pool.clone()).run(&abandoned).await.is_err());
    let materials: i64 =
        sqlx::query_scalar("SELECT count(*) FROM labos_threejs_core.password_reset_mail")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(materials, 0);
    let client = reqwest::Client::new();
    let base = std::env::var("MAILPIT_HTTP_URL").unwrap();
    let search: Value = client
        .get(format!("{base}/api/v1/search"))
        .query(&[("query", format!("to:{email}"))])
        .send()
        .await
        .expect("mail capture transport failed")
        .json()
        .await
        .expect("mail capture response failed");
    let messages = search["messages"]
        .as_array()
        .expect("mail capture search shape");
    assert_eq!(messages.len(), 1);
    let message_id = messages[0]["ID"].as_str().unwrap();
    let message: Value = client
        .get(format!("{base}/api/v1/message/{message_id}"))
        .send()
        .await
        .expect("mail capture transport failed")
        .json()
        .await
        .expect("mail capture response failed");
    let text = message["Text"].as_str().unwrap();
    assert!(
        text.contains("http://127.0.0.1:5173/reset-password#token="),
        "reset link must use the configured origin and keep token out of HTTP paths"
    );
}

async fn search_messages(mailpit: &str, email: &str) -> Value {
    reqwest::Client::new()
        .get(format!("{mailpit}/api/v1/search"))
        .query(&[("query", format!("to:{email}"))])
        .send()
        .await
        .expect("mail capture transport failed")
        .json()
        .await
        .expect("mail capture response failed")
}

fn reset_link_of(message: &Value) -> String {
    message["Text"]
        .as_str()
        .and_then(|text| {
            text.split_whitespace().find_map(|word| {
                word.contains("/reset-password#token=")
                    .then(|| word.to_owned())
            })
        })
        .expect("reset link in the captured mail")
}

async fn captured_message(mailpit: &str, email: &str) -> Value {
    let client = reqwest::Client::new();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    loop {
        let search = search_messages(mailpit, email).await;
        if let Some(id) = search["messages"]
            .as_array()
            .and_then(|rows| rows.first())
            .and_then(|row| row["ID"].as_str())
        {
            return client
                .get(format!("{mailpit}/api/v1/message/{id}"))
                .send()
                .await
                .expect("mail capture transport failed")
                .json()
                .await
                .expect("mail capture response failed");
        }
        assert!(
            std::time::Instant::now() < deadline,
            "reset mail should arrive within the capture budget"
        );
        tokio::time::sleep(std::time::Duration::from_millis(20)).await;
    }
}
async fn captured_token(email: &str) -> String {
    let message = captured_message(&std::env::var("MAILPIT_HTTP_URL").unwrap(), email).await;
    let link = reset_link_of(&message);
    let token = link
        .split_once("#token=")
        .map(|(_, rest)| rest.split('&').next().unwrap())
        .expect("captured reset mail has a token");
    assert_eq!(token.len(), 64);
    token.to_owned()
}
async fn login(app: &Router, email: &str, password: &str) -> Response {
    app.clone()
        .oneshot(
            Request::post("/api/v1/auth/login")
                .header("origin", "http://127.0.0.1:5173")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"email":email,"password":password}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap()
}
#[sqlx::test(migrations = "../../migrations")]
async fn a_delivered_token_changes_password_once_and_revokes_all_old_sessions(pool: PgPool) {
    let (app, reset) = configured(pool.clone()).await;
    let email = format!("consume-{}@example.test", uuid::Uuid::now_v7());
    let owner = register(&app, &email).await;
    let second = login(&app, &email, "a-long-test-password").await;
    assert_eq!(second.status(), StatusCode::OK);
    let second_cookie = second.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    assert_eq!(
        request(
            &app,
            &owner,
            "POST",
            "/api/v1/auth/password-reset",
            json!({"email":email})
        )
        .await
        .status(),
        StatusCode::ACCEPTED
    );
    let worker = labos_threejs_app::modules::jobs::Worker::new(
        pool.clone(),
        vec![reset.handler(pool)],
        Default::default(),
    );
    assert!(worker.run_once().await.unwrap());
    let token = captured_token(&email).await;
    let changed = request(
        &app,
        &owner,
        "POST",
        "/api/v1/auth/password-reset/complete",
        json!({"token":token,"password":"a-new-long-test-password"}),
    )
    .await;
    assert_eq!(changed.status(), StatusCode::NO_CONTENT);
    for cookie in [&owner.cookie, &second_cookie] {
        assert_eq!(
            app.clone()
                .oneshot(
                    Request::get("/api/v1/auth/session")
                        .header("cookie", cookie)
                        .body(Body::empty())
                        .unwrap()
                )
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
    }
    let replay = request(
        &app,
        &owner,
        "POST",
        "/api/v1/auth/password-reset/complete",
        json!({"token":token,"password":"yet-another-test-password"}),
    )
    .await;
    assert_eq!(replay.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        login(&app, &email, "a-long-test-password").await.status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        login(&app, &email, "a-new-long-test-password")
            .await
            .status(),
        StatusCode::OK
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn expired_deliveries_are_not_sent_and_expired_material_is_purged(pool: PgPool) {
    let (app, reset) = configured(pool.clone()).await;
    let email = format!("expire-{}@example.test", uuid::Uuid::now_v7());
    let owner = register(&app, &email).await;
    request(
        &app,
        &owner,
        "POST",
        "/api/v1/auth/password-reset",
        json!({"email":email}),
    )
    .await;
    // PostgreSQL adapter seam: expiration and at-rest retention are deliberately not exposed as secrets over HTTP.
    let stored:(Vec<u8>,Vec<u8>)=sqlx::query_as("SELECT r.token_hash,m.ciphertext FROM labos_threejs_core.password_resets r JOIN labos_threejs_core.password_reset_mail m ON m.reset_id=r.id WHERE r.user_id=$1::uuid").bind(&owner.id).fetch_one(&pool).await.unwrap();
    assert_eq!(stored.0.len(), 32);
    assert!(
        !stored
            .1
            .windows(email.len())
            .any(|bytes| bytes == email.as_bytes())
    );
    sqlx::query("UPDATE labos_threejs_core.password_resets SET expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1::uuid").bind(&owner.id).execute(&pool).await.unwrap();
    labos_threejs_app::modules::identity::password_reset_maintenance(pool.clone())
        .schedule()
        .await
        .unwrap();
    let remaining: i64 =
        sqlx::query_scalar("SELECT count(*) FROM labos_threejs_core.password_reset_mail")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(remaining, 0);
    let worker = labos_threejs_app::modules::jobs::Worker::new(
        pool.clone(),
        vec![reset.handler(pool.clone())],
        Default::default(),
    );
    assert!(worker.run_once().await.unwrap());
    let search: Value = reqwest::Client::new()
        .get(format!(
            "{}/api/v1/search",
            std::env::var("MAILPIT_HTTP_URL").unwrap()
        ))
        .query(&[("query", format!("to:{email}"))])
        .send()
        .await
        .expect("capture query failed")
        .json()
        .await
        .expect("capture response failed");
    assert!(search["messages"].as_array().unwrap().is_empty());
    assert_eq!(
        request(
            &app,
            &owner,
            "POST",
            "/api/v1/auth/password-reset",
            json!({"email":email})
        )
        .await
        .status(),
        StatusCode::ACCEPTED
    );
    assert!(worker.run_once().await.unwrap());
    let token = captured_token(&email).await;
    sqlx::query("UPDATE labos_threejs_core.password_resets SET expires_at=clock_timestamp()-interval '1 second' WHERE user_id=$1::uuid").bind(&owner.id).execute(&pool).await.unwrap();
    assert_eq!(
        request(
            &app,
            &owner,
            "POST",
            "/api/v1/auth/password-reset/complete",
            json!({"token":token,"password":"expired-new-test-password"})
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        login(&app, &email, "a-long-test-password").await.status(),
        StatusCode::OK
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn concurrent_token_consumers_have_one_winner_and_audit_failure_rolls_back_credentials_and_sessions(
    pool: PgPool,
) {
    let (app, reset) = configured(pool.clone()).await;
    let email = format!("atomic-{}@example.test", uuid::Uuid::now_v7());
    let owner = register(&app, &email).await;
    request(
        &app,
        &owner,
        "POST",
        "/api/v1/auth/password-reset",
        json!({"email":email}),
    )
    .await;
    let worker = labos_threejs_app::modules::jobs::Worker::new(
        pool.clone(),
        vec![reset.handler(pool.clone())],
        Default::default(),
    );
    assert!(worker.run_once().await.unwrap());
    let token = captured_token(&email).await;
    sqlx::raw_sql("CREATE FUNCTION reject_reset_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='identity.password.reset' THEN RAISE EXCEPTION 'test reset audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_reset_audit BEFORE INSERT ON labos_threejs_core.audit_events FOR EACH ROW EXECUTE FUNCTION reject_reset_audit();").execute(&pool).await.unwrap();
    let input = json!({"token":token,"password":"a-new-long-test-password"});
    assert_eq!(
        request(
            &app,
            &owner,
            "POST",
            "/api/v1/auth/password-reset/complete",
            input.clone()
        )
        .await
        .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        request(&app, &owner, "GET", "/api/v1/auth/session", json!(null))
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        login(&app, &email, "a-long-test-password").await.status(),
        StatusCode::OK
    );
    sqlx::query("DROP TRIGGER reject_reset_audit ON labos_threejs_core.audit_events")
        .execute(&pool)
        .await
        .unwrap();
    let (one, two) = tokio::join!(
        request(
            &app,
            &owner,
            "POST",
            "/api/v1/auth/password-reset/complete",
            input.clone()
        ),
        request(
            &app,
            &owner,
            "POST",
            "/api/v1/auth/password-reset/complete",
            input
        )
    );
    let statuses = [one.status(), two.status()];
    assert_eq!(
        statuses
            .iter()
            .filter(|&&status| status == StatusCode::NO_CONTENT)
            .count(),
        1
    );
    assert_eq!(
        statuses
            .iter()
            .filter(|&&status| status == StatusCode::UNAUTHORIZED)
            .count(),
        1
    );
    assert_eq!(
        request(&app, &owner, "GET", "/api/v1/auth/session", json!(null))
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        login(&app, &email, "a-new-long-test-password")
            .await
            .status(),
        StatusCode::OK
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn disabling_a_member_revokes_issued_links_and_suppresses_queued_delivery_even_after_reactivation(
    pool: PgPool,
) {
    let (app, reset) = configured(pool.clone()).await;
    let owner = register(
        &app,
        &format!("admin-{}@example.test", uuid::Uuid::now_v7()),
    )
    .await;
    let email = format!("disabled-{}@example.test", uuid::Uuid::now_v7());
    let member = register(&app, &email).await;
    request(
        &app,
        &member,
        "POST",
        "/api/v1/auth/password-reset",
        json!({"email":email}),
    )
    .await;
    let worker = labos_threejs_app::modules::jobs::Worker::new(
        pool.clone(),
        vec![reset.handler(pool.clone())],
        Default::default(),
    );
    assert!(worker.run_once().await.unwrap());
    let token = captured_token(&email).await;
    sqlx::query("UPDATE labos_threejs_core.password_resets SET created_at=clock_timestamp()-interval '2 minutes' WHERE user_id=$1::uuid").bind(&member.id).execute(&pool).await.unwrap();
    request(
        &app,
        &member,
        "POST",
        "/api/v1/auth/password-reset",
        json!({"email":email}),
    )
    .await;
    let path = format!("/api/v1/organization/members/{}", member.id);
    assert_eq!(
        request(
            &app,
            &owner,
            "PUT",
            &path,
            json!({"role":"member","active":false,"version":1})
        )
        .await
        .status(),
        StatusCode::OK
    );
    assert!(worker.run_once().await.unwrap());
    assert_eq!(
        request(
            &app,
            &owner,
            "PUT",
            &path,
            json!({"role":"member","active":true,"version":2})
        )
        .await
        .status(),
        StatusCode::OK
    );
    assert_eq!(
        request(
            &app,
            &owner,
            "POST",
            "/api/v1/auth/password-reset/complete",
            json!({"token":token,"password":"reactivated-new-password"})
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    let search: Value = reqwest::Client::new()
        .get(format!(
            "{}/api/v1/search",
            std::env::var("MAILPIT_HTTP_URL").unwrap()
        ))
        .query(&[("query", format!("to:{email}"))])
        .send()
        .await
        .expect("capture query failed")
        .json()
        .await
        .expect("capture response failed");
    assert_eq!(search["messages"].as_array().unwrap().len(), 1);
    let materials: i64 =
        sqlx::query_scalar("SELECT count(*) FROM labos_threejs_core.password_reset_mail")
            .fetch_one(&pool)
            .await
            .unwrap();
    assert_eq!(materials, 0);
}

#[sqlx::test(migrations = "../../migrations")]
async fn real_smtp_failures_retry_or_stop_without_affecting_registration(pool: PgPool) {
    use labos_threejs_app::modules::{
        identity::{PasswordReset, ResetPolicy},
        mail::MailService,
    };
    let mut settings = labos_threejs_platform::mail::SmtpSettings::from_env()
        .unwrap()
        .unwrap();
    settings.port = std::env::var("MAIL_CHAOS_SMTP_PORT")
        .unwrap()
        .parse()
        .unwrap();
    let key = hex::decode(std::env::var("MAIL_ENCRYPTION_KEY").unwrap()).unwrap();
    let reset = PasswordReset::new(
        MailService::new(settings, &key, 1).unwrap(),
        ResetPolicy::default(),
    )
    .unwrap();
    let app = labos_threejs_app::compose_routes_with_options(
        pool.clone(),
        Default::default(),
        Router::new(),
        labos_threejs_app::openapi(),
        labos_threejs_app::CoreOptions {
            password_reset: Some(reset.clone()),
            ..Default::default()
        },
    );
    let email = format!("chaos-{}@example.test", uuid::Uuid::now_v7());
    let owner = register(&app, &email).await;
    let client = reqwest::Client::new();
    let base = std::env::var("MAIL_CHAOS_HTTP_URL").unwrap();
    assert!(
        client
            .put(format!("{base}/api/v1/chaos"))
            .json(&json!({"Recipient":{"ErrorCode":451,"Probability":100}}))
            .send()
            .await
            .expect("capture control failed")
            .status()
            .is_success()
    );
    assert_eq!(
        request(
            &app,
            &owner,
            "POST",
            "/api/v1/auth/password-reset",
            json!({"email":email})
        )
        .await
        .status(),
        StatusCode::ACCEPTED
    );
    let worker = labos_threejs_app::modules::jobs::Worker::new(
        pool.clone(),
        vec![reset.handler(pool.clone())],
        Default::default(),
    );
    assert!(worker.run_once().await.unwrap());
    let jobs = data(request(&app, &owner, "GET", "/api/v1/jobs", json!(null)).await).await;
    assert_eq!(jobs["data"][0]["status"], "retry_wait");
    assert_eq!(jobs["data"][0]["last_error"], "mail.smtp_transient");
    assert!(!jobs.to_string().contains(&email));
    register(
        &app,
        &format!("still-registers-{}@example.test", uuid::Uuid::now_v7()),
    )
    .await;
    assert!(
        client
            .put(format!("{base}/api/v1/chaos"))
            .json(&json!({}))
            .send()
            .await
            .expect("capture control failed")
            .status()
            .is_success()
    );
    sqlx::query("UPDATE labos_threejs_core.jobs SET scheduled_at=clock_timestamp() WHERE kind='identity.password_reset'").execute(&pool).await.unwrap();
    assert!(worker.run_once().await.unwrap());
    let jobs = data(request(&app, &owner, "GET", "/api/v1/jobs", json!(null)).await).await;
    assert_eq!(jobs["data"][0]["status"], "succeeded");
    assert!(
        client
            .put(format!("{base}/api/v1/chaos"))
            .json(&json!({"Recipient":{"ErrorCode":550,"Probability":100}}))
            .send()
            .await
            .expect("capture control failed")
            .status()
            .is_success()
    );
    sqlx::query("UPDATE labos_threejs_core.password_resets SET created_at=clock_timestamp()-interval '2 minutes' WHERE user_id=$1::uuid").bind(&owner.id).execute(&pool).await.unwrap();
    request(
        &app,
        &owner,
        "POST",
        "/api/v1/auth/password-reset",
        json!({"email":email}),
    )
    .await;
    assert!(worker.run_once().await.unwrap());
    let jobs = data(request(&app, &owner, "GET", "/api/v1/jobs", json!(null)).await).await;
    assert_eq!(jobs["data"][0]["status"], "failed");
    assert_eq!(jobs["data"][0]["last_error"], "mail.smtp_rejected");
    assert!(
        client
            .put(format!("{base}/api/v1/chaos"))
            .json(&json!({}))
            .send()
            .await
            .expect("capture control failed")
            .status()
            .is_success()
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn a_login_using_the_old_hash_cannot_issue_a_session_after_password_reset(pool: PgPool) {
    let (app, reset) = configured(pool.clone()).await;
    let email = format!("race-{}@example.test", uuid::Uuid::now_v7());
    let owner = register(&app, &email).await;
    request(
        &app,
        &owner,
        "POST",
        "/api/v1/auth/password-reset",
        json!({"email":email}),
    )
    .await;
    let worker = labos_threejs_app::modules::jobs::Worker::new(
        pool.clone(),
        vec![reset.handler(pool.clone())],
        Default::default(),
    );
    assert!(worker.run_once().await.unwrap());
    let token = captured_token(&email).await;
    // Real row-lock barrier: queue the reset first, then let login verify the still-visible old hash.
    let mut gate = pool.begin().await.unwrap();
    sqlx::query(
        "SELECT user_id FROM labos_threejs_core.credentials WHERE user_id=$1::uuid FOR UPDATE",
    )
    .bind(&owner.id)
    .execute(&mut *gate)
    .await
    .unwrap();
    let resetting = tokio::spawn({
        let app = app.clone();
        async move {
            request(
                &app,
                &owner,
                "POST",
                "/api/v1/auth/password-reset/complete",
                json!({"token":token,"password":"replacement-race-password"}),
            )
            .await
        }
    });
    async fn waiters(pool: &PgPool) -> i64 {
        sqlx::query_scalar("SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%labos_threejs_core.credentials%'").fetch_one(pool).await.unwrap()
    }
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while waiters(&pool).await < 1 {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("reset should reach the credential lock");
    let logging_in = tokio::spawn({
        let app = app.clone();
        async move { login(&app, &email, "a-long-test-password").await }
    });
    tokio::time::timeout(std::time::Duration::from_secs(3), async {
        while !logging_in.is_finished() && waiters(&pool).await < 2 {
            tokio::time::sleep(std::time::Duration::from_millis(5)).await;
        }
    })
    .await
    .expect("login should finish verification before opening the barrier");
    gate.commit().await.unwrap();
    assert_eq!(resetting.await.unwrap().status(), StatusCode::NO_CONTENT);
    assert_eq!(logging_in.await.unwrap().status(), StatusCode::UNAUTHORIZED);
}

#[sqlx::test(migrations = "../../migrations")]
async fn requested_language_sets_the_delivered_language_and_link_hint_across_retries(pool: PgPool) {
    use labos_threejs_app::modules::{
        identity::{PasswordReset, ResetPolicy},
        mail::MailService,
    };
    let key = hex::decode(std::env::var("MAIL_ENCRYPTION_KEY").unwrap()).unwrap();
    let service = |port: u16| {
        let mut settings = labos_threejs_platform::mail::SmtpSettings::from_env()
            .unwrap()
            .unwrap();
        settings.port = port;
        PasswordReset::new(
            MailService::new(settings, &key, 1).unwrap(),
            ResetPolicy::default(),
        )
        .unwrap()
    };
    // A port with no listener fails the first attempt transiently, without
    // touching the shared chaos capture other tests exercise.
    let dead_port = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    };
    let reset = service(dead_port);
    let app = labos_threejs_app::compose_routes_with_options(
        pool.clone(),
        Default::default(),
        Router::new(),
        labos_threejs_app::openapi(),
        labos_threejs_app::CoreOptions {
            password_reset: Some(reset.clone()),
            ..Default::default()
        },
    );
    let en_email = format!("reset-en-{}@example.test", uuid::Uuid::now_v7());
    let en_owner = register(&app, &en_email).await;
    assert_eq!(
        request(
            &app,
            &en_owner,
            "POST",
            "/api/v1/auth/password-reset",
            json!({"email":en_email,"locale":"en"}),
        )
        .await
        .status(),
        StatusCode::ACCEPTED
    );
    let broken = labos_threejs_app::modules::jobs::Worker::new(
        pool.clone(),
        vec![reset.handler(pool.clone())],
        Default::default(),
    );
    assert!(broken.run_once().await.unwrap());
    let jobs = data(request(&app, &en_owner, "GET", "/api/v1/jobs", json!(null)).await).await;
    assert_eq!(jobs["data"][0]["status"], "retry_wait");
    assert_eq!(jobs["data"][0]["last_error"], "mail.smtp_unavailable");
    // The retried delivery keeps the language captured at request time.
    let delivering = service(
        labos_threejs_platform::mail::SmtpSettings::from_env()
            .unwrap()
            .unwrap()
            .port,
    );
    let worker = labos_threejs_app::modules::jobs::Worker::new(
        pool.clone(),
        vec![delivering.handler(pool.clone())],
        Default::default(),
    );
    sqlx::query("UPDATE labos_threejs_core.jobs SET scheduled_at=clock_timestamp() WHERE kind='identity.password_reset'")
        .execute(&pool)
        .await
        .unwrap();
    assert!(worker.run_once().await.unwrap());
    let mailpit = std::env::var("MAILPIT_HTTP_URL").unwrap();
    let en_message = captured_message(&mailpit, &en_email).await;
    assert_eq!(en_message["Subject"], "Reset your password");
    let en_text = en_message["Text"].as_str().unwrap();
    assert!(en_text.contains("one-time link"), "english body: {en_text}");
    let en_link = reset_link_of(&en_message);
    assert!(
        en_link.ends_with("&lang=en"),
        "link carries the non-sensitive language hint: {en_link}"
    );
    // Old clients omit the field and keep the original Chinese delivery without a hint.
    let zh_email = format!("reset-zh-{}@example.test", uuid::Uuid::now_v7());
    let zh_owner = register(&app, &zh_email).await;
    assert_eq!(
        request(
            &app,
            &zh_owner,
            "POST",
            "/api/v1/auth/password-reset",
            json!({"email":zh_email}),
        )
        .await
        .status(),
        StatusCode::ACCEPTED
    );
    assert!(worker.run_once().await.unwrap());
    let zh_message = captured_message(&mailpit, &zh_email).await;
    assert_eq!(zh_message["Subject"], "重置密码");
    let zh_text = zh_message["Text"].as_str().unwrap();
    assert!(zh_text.contains("一次性链接"), "zh body: {zh_text}");
    let zh_link = reset_link_of(&zh_message);
    assert!(
        !zh_link.contains('&'),
        "old-style requests keep the original hint-free link: {zh_link}"
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn cooldown_merges_cross_language_requests_and_keeps_the_first_language(pool: PgPool) {
    let (app, reset) = configured(pool.clone()).await;
    let email = format!("cooldown-{}@example.test", uuid::Uuid::now_v7());
    let owner = register(&app, &email).await;
    let en = request(
        &app,
        &owner,
        "POST",
        "/api/v1/auth/password-reset",
        json!({"email":email,"locale":"en"}),
    )
    .await;
    let zh = request(
        &app,
        &owner,
        "POST",
        "/api/v1/auth/password-reset",
        json!({"email":email,"locale":"zh"}),
    )
    .await;
    assert_eq!(en.status(), StatusCode::ACCEPTED);
    assert_eq!(zh.status(), StatusCode::ACCEPTED);
    assert_eq!(data(en).await, data(zh).await);
    let resets: i64 = sqlx::query_scalar("SELECT count(*) FROM labos_threejs_core.password_resets")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(resets, 1, "the cooldown merges into the first request");
    let queued: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM labos_threejs_core.jobs WHERE kind='identity.password_reset'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(queued, 1);
    let worker = labos_threejs_app::modules::jobs::Worker::new(
        pool.clone(),
        vec![reset.handler(pool.clone())],
        Default::default(),
    );
    assert!(worker.run_once().await.unwrap());
    assert!(!worker.run_once().await.unwrap());
    let mailpit = std::env::var("MAILPIT_HTTP_URL").unwrap();
    let search = search_messages(&mailpit, &email).await;
    assert_eq!(search["messages"].as_array().unwrap().len(), 1);
    let message = captured_message(&mailpit, &email).await;
    assert_eq!(message["Subject"], "Reset your password");
    assert!(
        message["Text"].as_str().unwrap().contains("one-time link"),
        "the merged delivery keeps the first requested language"
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn an_unsupported_language_is_rejected_with_stable_validation_feedback(pool: PgPool) {
    let (app, _reset) = configured(pool.clone()).await;
    let owner = register(
        &app,
        &format!("locale-{}@example.test", uuid::Uuid::now_v7()),
    )
    .await;
    let response = request(
        &app,
        &owner,
        "POST",
        "/api/v1/auth/password-reset",
        json!({"email":"locale-owner@example.test","locale":"fr"}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(data(response).await["error"]["code"], "auth.invalid_input");
}
