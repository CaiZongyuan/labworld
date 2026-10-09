use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
    response::Response,
};
use http_body_util::BodyExt;
use labos_threejs_app::modules::lab::DeviceRuntime;
use serde_json::{Value, json};
use sqlx::PgPool;
use std::future::IntoFuture;
use tower::ServiceExt;

const PROGRESS: &str = "/api/v1/lab/guides/lab-onboarding/1.0/progress";

fn empty_context() -> Value {
    json!({"lab_id":null,"entity_id":null,"node_id":null,"business_attempt":null})
}

#[sqlx::test(migrations = "../../migrations")]
async fn generated_sdk_reads_and_writes_the_same_members_progress_over_real_http(pool: PgPool) {
    let app = labos_threejs_api::router(pool, Default::default());
    let owner = register(&app, "sdk-guide-owner@example.test", "owner").await;
    let member = register(&app, "sdk-guide-member@example.test", "member").await;
    let lab = create_lab(&app, &owner, "SDK guide lab").await;
    let (context, before) = light_context(&app, &owner, &lab).await;
    let attempt = uuid::Uuid::now_v7().to_string();
    assert_eq!(
        request(
            &app,
            &member,
            "PUT",
            PROGRESS,
            progress_input(0, "in_progress", "select_entity", &attempt, context.clone())
        )
        .await
        .status(),
        StatusCode::OK
    );
    let key = credential(&app, &member, "lab:full").await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (shutdown, stopped) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(
        axum::serve(listener, app.clone())
            .with_graceful_shutdown(async move {
                let _ = stopped.await;
            })
            .into_future(),
    );
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let mut facts = Vec::new();
    for (label, environment, value) in [
        ("member", "LAB_SESSION_COOKIE", member.cookie.as_str()),
        ("agent", "LAB_API_KEY", key["secret"].as_str().unwrap()),
    ] {
        let mut child = tokio::process::Command::new("node");
        child
            .current_dir(&root)
            .arg("examples/lab/guide-progress.mjs")
            .env_remove("LAB_API_KEY")
            .env_remove("LAB_SESSION_COOKIE")
            .env_remove("LAB_SESSION_CSRF")
            .env(environment, value)
            .env("LAB_API_BASE", format!("http://{address}"))
            .env("LAB_GUIDE_WRITE", "1")
            .kill_on_drop(true);
        if label == "member" {
            child.env("LAB_SESSION_CSRF", &member.csrf);
        }
        let output = tokio::time::timeout(std::time::Duration::from_secs(30), child.output())
            .await
            .unwrap()
            .unwrap();
        assert!(
            output.status.success(),
            "{label} generated SDK example failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        let result: Value = serde_json::from_slice(&output.stdout).unwrap();
        assert_eq!(result["saved"]["context"], context);
        assert_eq!(result["saved"]["guide_attempt_id"], attempt);
        assert_eq!(result["saved"]["status"], "paused");
        assert_eq!(result["recovered"]["progress"], result["saved"]);
        facts.push(result);
    }
    let _ = shutdown.send(());
    server.await.unwrap().unwrap();
    assert_eq!(facts[0]["saved"]["revision"], 2);
    assert_eq!(facts[1]["read"]["progress"], facts[0]["saved"]);
    assert_eq!(facts[1]["saved"]["revision"], 3);
    assert_eq!(
        before,
        data(
            request(
                &app,
                &member,
                "GET",
                &format!("/api/v1/lab/labs/{lab}/world"),
                Value::Null
            )
            .await
        )
        .await
    );
    println!(
        "Actual generated guide SDK Member/Agent GET/PUT/400/409/recovery passed; listener {address} stopped"
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn renamed_or_archived_targets_and_removed_nodes_keep_the_original_progress_context(
    pool: PgPool,
) {
    let app = labos_threejs_api::router(pool, Default::default());
    let owner = register(&app, "target-owner@example.test", "owner").await;
    let member = register(&app, "target-member@example.test", "member").await;
    let lab = create_lab(&app, &owner, "Unavailable targets lab").await;
    let (context, world) = light_context(&app, &owner, &lab).await;
    let attempt = uuid::Uuid::now_v7().to_string();
    let response = request(
        &app,
        &member,
        "PUT",
        PROGRESS,
        progress_input(0, "in_progress", "select_entity", &attempt, context.clone()),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let saved = data(response).await;
    let entity_path = format!(
        "/api/v1/lab/labs/{lab}/entities/{}",
        context["entity_id"].as_str().unwrap()
    );
    assert_eq!(
        request(
            &app,
            &owner,
            "PATCH",
            &entity_path,
            json!({"name":"Renamed shared target","configuration":{}})
        )
        .await
        .status(),
        StatusCode::OK
    );
    assert_eq!(
        saved,
        data(request(&app, &member, "GET", PROGRESS, Value::Null).await).await["progress"]
    );
    assert_eq!(
        request(
            &app,
            &owner,
            "PUT",
            &format!("/api/v1/lab/labs/{lab}/layout"),
            json!({"expected_version":world["lab"]["layout_version"],"nodes":[]})
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
            &format!("{entity_path}/archive"),
            json!({})
        )
        .await
        .status(),
        StatusCode::OK
    );
    let world_path = format!("/api/v1/lab/labs/{lab}/world");
    let unavailable = data(request(&app, &owner, "GET", &world_path, Value::Null).await).await;
    assert_eq!(unavailable["nodes"], json!([]));
    assert!(unavailable["entities"][0]["archived_at"].as_str().is_some());
    assert_eq!(
        saved,
        data(request(&app, &member, "GET", PROGRESS, Value::Null).await).await["progress"]
    );
    let response = request(
        &app,
        &member,
        "PUT",
        PROGRESS,
        progress_input(1, "paused", "select_entity", &attempt, context.clone()),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let paused = data(response).await;
    assert_eq!(paused["context"], context);
    assert_eq!(
        unavailable,
        data(request(&app, &owner, "GET", &world_path, Value::Null).await).await
    );
    let mut forged = context.clone();
    forged["node_id"] = json!(uuid::Uuid::now_v7().to_string());
    assert_eq!(
        request(
            &app,
            &member,
            "PUT",
            PROGRESS,
            progress_input(2, "paused", "select_entity", &attempt, forged)
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        paused,
        data(request(&app, &member, "GET", PROGRESS, Value::Null).await).await["progress"]
    );
    let (other_context, other_world) = light_context(&app, &owner, &lab).await;
    let mut mismatched = context.clone();
    mismatched["node_id"] = other_context["node_id"].clone();
    assert_eq!(
        request(
            &app,
            &member,
            "PUT",
            PROGRESS,
            progress_input(2, "paused", "select_entity", &attempt, mismatched)
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );
    let response = request(
        &app,
        &member,
        "PUT",
        PROGRESS,
        progress_input(2, "completed", "complete", &attempt, context.clone()),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let completed = data(response).await;
    assert_eq!(completed["context"], context);
    assert_eq!(
        completed,
        data(request(&app, &member, "GET", PROGRESS, Value::Null).await).await["progress"]
    );
    assert_eq!(
        other_world,
        data(request(&app, &owner, "GET", &world_path, Value::Null).await).await
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn old_versions_remain_readable_and_require_an_explicit_new_version_start(pool: PgPool) {
    let app = labos_threejs_api::router(pool.clone(), Default::default());
    register(&app, "version-owner@example.test", "owner").await;
    let member = register(&app, "version-member@example.test", "member").await;
    let old_attempt = uuid::Uuid::now_v7().to_string();
    sqlx::query("INSERT INTO lab.guide_progress(actor_id,guide_id,guide_version,revision,status,step,guide_attempt_id,context) VALUES($1::uuid,'lab-onboarding','0.9',7,'completed','legacy_finished',$2::uuid,$3)")
        .bind(&member.id).bind(&old_attempt).bind(empty_context()).execute(&pool).await.unwrap();
    let old_path = "/api/v1/lab/guides/lab-onboarding/0.9/progress";
    let response = request(&app, &member, "GET", old_path, Value::Null).await;
    assert_eq!(response.status(), StatusCode::OK);
    let old = data(response).await;
    assert_eq!(old["compatibility"], "unsupported");
    assert_eq!(old["current_guide_version"], "1.0");
    assert_eq!(old["progress"]["guide_version"], "0.9");
    assert_eq!(old["progress"]["status"], "completed");
    assert_eq!(old["progress"]["step"], "legacy_finished");
    assert_eq!(old["progress"]["guide_attempt_id"], old_attempt);
    let current = data(request(&app, &member, "GET", PROGRESS, Value::Null).await).await;
    assert_eq!(current["compatibility"], "restart_required");
    assert_eq!(current["progress"]["status"], "not_started");
    assert_eq!(current["progress"]["revision"], 0);
    assert_eq!(current["previous_progress"], old["progress"]);
    assert_eq!(
        current,
        data(request(&app, &member, "GET", PROGRESS, Value::Null).await).await
    );
    let refused = request(
        &app,
        &member,
        "PUT",
        old_path,
        progress_input(7, "completed", "complete", &old_attempt, empty_context()),
    )
    .await;
    assert_eq!(refused.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        data(refused).await["error"]["code"],
        "lab.guide_version_unsupported"
    );
    let new_attempt = uuid::Uuid::now_v7().to_string();
    let response = request(
        &app,
        &member,
        "PUT",
        PROGRESS,
        progress_input(
            0,
            "in_progress",
            "create_lab",
            &new_attempt,
            empty_context(),
        ),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let saved = data(response).await;
    let restored = data(request(&app, &member, "GET", PROGRESS, Value::Null).await).await;
    assert_eq!(restored["compatibility"], "compatible");
    assert_eq!(restored["progress"], saved);
    assert_eq!(restored["previous_progress"], Value::Null);
    assert_eq!(
        old,
        data(request(&app, &member, "GET", old_path, Value::Null).await).await
    );
    let unknown = request(
        &app,
        &member,
        "GET",
        "/api/v1/lab/guides/lab-onboarding/2.0/progress",
        Value::Null,
    )
    .await;
    assert_eq!(unknown.status(), StatusCode::OK);
    let unknown = data(unknown).await;
    assert_eq!(unknown["compatibility"], "unsupported");
    assert_eq!(unknown["progress"]["revision"], 0);
    assert_eq!(
        request(
            &app,
            &member,
            "GET",
            "/api/v1/lab/guides/another-guide/1.0/progress",
            Value::Null
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn concurrent_progress_saves_compare_revisions_and_recover_after_conflict(pool: PgPool) {
    let app = labos_threejs_api::router(pool, Default::default());
    register(&app, "revision-owner@example.test", "owner").await;
    let member = register(&app, "revision-member@example.test", "member").await;
    let attempt = uuid::Uuid::now_v7().to_string();
    let saved = request(
        &app,
        &member,
        "PUT",
        PROGRESS,
        progress_input(0, "in_progress", "create_lab", &attempt, empty_context()),
    )
    .await;
    assert_eq!(saved.status(), StatusCode::OK);
    let (first, second) = tokio::join!(
        request(
            &app,
            &member,
            "PUT",
            PROGRESS,
            progress_input(1, "paused", "register_light", &attempt, empty_context())
        ),
        request(
            &app,
            &member,
            "PUT",
            PROGRESS,
            progress_input(1, "in_progress", "select_entity", &attempt, empty_context())
        )
    );
    let results = [first.status(), second.status()];
    assert_eq!(
        results
            .iter()
            .filter(|status| **status == StatusCode::OK)
            .count(),
        1
    );
    assert_eq!(
        results
            .iter()
            .filter(|status| **status == StatusCode::CONFLICT)
            .count(),
        1
    );
    let restored = data(request(&app, &member, "GET", PROGRESS, Value::Null).await).await;
    assert_eq!(restored["progress"]["revision"], 2);
    let response = request(
        &app,
        &member,
        "PUT",
        PROGRESS,
        progress_input(1, "completed", "complete", &attempt, empty_context()),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert_eq!(
        data(response).await["error"]["code"],
        "lab.guide_progress_conflict"
    );
    assert_eq!(
        restored,
        data(request(&app, &member, "GET", PROGRESS, Value::Null).await).await
    );
    let response = request(
        &app,
        &member,
        "PUT",
        PROGRESS,
        progress_input(2, "paused", "save_layout", &attempt, empty_context()),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let recovered = data(response).await;
    assert_eq!(recovered["revision"], 3);
    assert_eq!(recovered["status"], "paused");
    assert_eq!(
        recovered,
        data(request(&app, &member, "GET", PROGRESS, Value::Null).await).await["progress"]
    );
}

struct Browser {
    cookie: String,
    csrf: String,
    id: String,
}

async fn data(response: Response) -> Value {
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}

async fn register(app: &Router, email: &str, role: &str) -> Browser {
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
    let session = data(response).await;
    assert_eq!(session["user"]["role"], role);
    Browser {
        cookie,
        csrf: session["csrf_token"].as_str().unwrap().into(),
        id: session["user"]["id"].as_str().unwrap().into(),
    }
}

async fn request(
    app: &Router,
    browser: &Browser,
    method: &str,
    path: &str,
    body: Value,
) -> Response {
    app.clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("origin", "http://127.0.0.1:5173")
                .header("content-type", "application/json")
                .header("cookie", &browser.cookie)
                .header("x-csrf-token", &browser.csrf)
                .header("idempotency-key", uuid::Uuid::now_v7().to_string())
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap()
}

async fn agent(app: &Router, secret: &str, method: &str, path: &str, body: Value) -> Response {
    app.clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("authorization", format!("Bearer {secret}"))
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap()
}

async fn login(app: &Router, email: &str) -> Browser {
    let response = app
        .clone()
        .oneshot(
            Request::post("/api/v1/auth/login")
                .header("origin", "http://127.0.0.1:5173")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"email":email,"password":"a-long-test-password"}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::OK);
    let cookie = response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let session = data(response).await;
    assert_eq!(session["user"]["role"], "member");
    Browser {
        cookie,
        csrf: session["csrf_token"].as_str().unwrap().into(),
        id: session["user"]["id"].as_str().unwrap().into(),
    }
}

async fn credential(app: &Router, member: &Browser, scope: &str) -> Value {
    let response = request(
        app,
        member,
        "POST",
        "/api/v1/api-keys",
        json!({"name":"Guide credential","scopes":[scope],"expires_in_days":1}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    data(response).await
}

#[sqlx::test(migrations = "../../migrations")]
async fn rejected_credentials_and_csrf_preserve_personal_progress_and_allow_authenticated_recovery(
    pool: PgPool,
) {
    let app = labos_threejs_api::router(pool.clone(), Default::default());
    let owner = register(&app, "auth-guide-owner@example.test", "owner").await;
    let member = register(&app, "auth-guide-member@example.test", "member").await;
    let lab = create_lab(&app, &owner, "Authentication guide lab").await;
    let (context, before) = light_context(&app, &owner, &lab).await;
    let attempt = uuid::Uuid::now_v7().to_string();
    let response = request(
        &app,
        &member,
        "PUT",
        PROGRESS,
        progress_input(0, "paused", "select_entity", &attempt, context.clone()),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let saved = data(response).await;
    let input = progress_input(1, "in_progress", "edit_placement", &attempt, context);
    let response = app
        .clone()
        .oneshot(
            Request::put(PROGRESS)
                .header("origin", "http://127.0.0.1:5173")
                .header("cookie", &member.cookie)
                .header("content-type", "application/json")
                .body(Body::from(input.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::FORBIDDEN);
    for method in ["GET", "PUT"] {
        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .method(method)
                    .uri(PROGRESS)
                    .header("cookie", &member.cookie)
                    .header("x-csrf-token", &member.csrf)
                    .header("origin", "http://127.0.0.1:5173")
                    .header("authorization", "Bearer invalid")
                    .header("content-type", "application/json")
                    .body(Body::from(input.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
    }
    let wrong_scope = credential(&app, &member, "profile:read").await;
    for method in ["GET", "PUT"] {
        assert_eq!(
            agent(
                &app,
                wrong_scope["secret"].as_str().unwrap(),
                method,
                PROGRESS,
                input.clone()
            )
            .await
            .status(),
            StatusCode::FORBIDDEN
        );
    }
    let expired = credential(&app, &member, "lab:full").await;
    sqlx::query("UPDATE labos_threejs_core.api_keys SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1::uuid")
        .bind(expired["key"]["id"].as_str().unwrap()).execute(&pool).await.unwrap();
    let revoked = credential(&app, &member, "lab:full").await;
    assert_eq!(
        request(
            &app,
            &member,
            "DELETE",
            &format!(
                "/api/v1/api-keys/{}",
                revoked["key"]["id"].as_str().unwrap()
            ),
            Value::Null
        )
        .await
        .status(),
        StatusCode::NO_CONTENT
    );
    for key in [&expired, &revoked] {
        for method in ["GET", "PUT"] {
            assert_eq!(
                agent(
                    &app,
                    key["secret"].as_str().unwrap(),
                    method,
                    PROGRESS,
                    input.clone()
                )
                .await
                .status(),
                StatusCode::UNAUTHORIZED
            );
        }
    }
    assert_eq!(
        saved,
        data(request(&app, &member, "GET", PROGRESS, Value::Null).await).await["progress"]
    );
    assert_eq!(
        before,
        data(
            request(
                &app,
                &owner,
                "GET",
                &format!("/api/v1/lab/labs/{lab}/world"),
                Value::Null
            )
            .await
        )
        .await
    );
    assert_eq!(
        request(&app, &member, "POST", "/api/v1/auth/logout", json!({}))
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    for method in ["GET", "PUT"] {
        assert_eq!(
            request(&app, &member, method, PROGRESS, input.clone())
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
    }
    let recovered = login(&app, "auth-guide-member@example.test").await;
    assert_eq!(
        saved,
        data(request(&app, &recovered, "GET", PROGRESS, Value::Null).await).await["progress"]
    );
    let active = credential(&app, &recovered, "lab:full").await;
    let membership_path = format!("/api/v1/organization/members/{}", member.id);
    assert_eq!(
        request(
            &app,
            &owner,
            "PUT",
            &membership_path,
            json!({"role":"member","active":false,"version":1})
        )
        .await
        .status(),
        StatusCode::OK
    );
    for method in ["GET", "PUT"] {
        assert_eq!(
            request(&app, &recovered, method, PROGRESS, input.clone())
                .await
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            agent(
                &app,
                active["secret"].as_str().unwrap(),
                method,
                PROGRESS,
                input.clone()
            )
            .await
            .status(),
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(
        request(
            &app,
            &owner,
            "PUT",
            &membership_path,
            json!({"role":"member","active":true,"version":2})
        )
        .await
        .status(),
        StatusCode::OK
    );
    let recovered = login(&app, "auth-guide-member@example.test").await;
    assert_eq!(
        saved,
        data(request(&app, &recovered, "GET", PROGRESS, Value::Null).await).await["progress"]
    );
    let response = request(&app, &recovered, "PUT", PROGRESS, input).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(data(response).await["revision"], 2);
    assert_eq!(
        before,
        data(
            request(
                &app,
                &owner,
                "GET",
                &format!("/api/v1/lab/labs/{lab}/world"),
                Value::Null
            )
            .await
        )
        .await
    );
}

fn progress_input(revision: i64, status: &str, step: &str, attempt: &str, context: Value) -> Value {
    json!({"expected_revision":revision,"status":status,"step":step,
        "guide_attempt_id":attempt,"context":context})
}

#[sqlx::test(migrations = "../../migrations")]
async fn persistence_failure_rolls_back_progress_and_recovery_never_changes_device_records(
    pool: PgPool,
) {
    let runtime = DeviceRuntime::initialize(pool.clone()).await.unwrap();
    let app = labos_threejs_api::router(pool.clone(), Default::default());
    register(&app, "rollback-owner@example.test", "owner").await;
    let member = register(&app, "rollback-member@example.test", "member").await;
    let lab = create_lab(&app, &member, "Rollback guide lab").await;
    let (context, _) = light_context(&app, &member, &lab).await;
    let path = format!(
        "/api/v1/lab/labs/{lab}/entities/{}",
        context["entity_id"].as_str().unwrap()
    );
    assert_eq!(
        request(
            &app,
            &member,
            "POST",
            &format!("{path}/program/start"),
            json!({})
        )
        .await
        .status(),
        StatusCode::CREATED
    );
    assert_eq!(
        request(
            &app,
            &member,
            "POST",
            &format!("{path}/actions"),
            json!({"capability":"light.set_power","parameters":{"on":true}})
        )
        .await
        .status(),
        StatusCode::ACCEPTED
    );
    assert!(runtime.process_next().await.unwrap());
    let centrifuge = data(request(&app,&member,"POST",&format!("/api/v1/lab/labs/{lab}/entities"),json!({"name":"Guide centrifuge","definition_id":"centrifuge","definition_version":"1.0","reality":"simulated","configuration":{},"representation_id":null})).await).await;
    let centrifuge_path = format!(
        "/api/v1/lab/labs/{lab}/entities/{}",
        centrifuge["id"].as_str().unwrap()
    );
    assert_eq!(
        request(
            &app,
            &member,
            "POST",
            &format!("{centrifuge_path}/program/start"),
            json!({})
        )
        .await
        .status(),
        StatusCode::CREATED
    );
    assert_eq!(request(&app,&member,"POST",&format!("{centrifuge_path}/actions"),json!({"capability":"centrifuge.start","parameters":{"rpm":6000,"temperature":22,"duration_seconds":6}})).await.status(),StatusCode::ACCEPTED);
    assert!(runtime.process_next().await.unwrap());
    let world_path = format!("/api/v1/lab/labs/{lab}/world");
    let before = data(request(&app, &member, "GET", &world_path, Value::Null).await).await;
    assert!(
        before["entities"]
            .as_array()
            .unwrap()
            .iter()
            .any(|entity| entity["task"].is_object())
    );
    let now = chrono::Utc::now();
    let records_path = format!(
        "/api/v1/lab/labs/{lab}/records?from={}&to={}&limit=100",
        (now - chrono::Duration::hours(1)).to_rfc3339_opts(chrono::SecondsFormat::Nanos, true),
        (now + chrono::Duration::hours(1)).to_rfc3339_opts(chrono::SecondsFormat::Nanos, true)
    );
    let records_before =
        data(request(&app, &member, "GET", &records_path, Value::Null).await).await;
    assert_eq!(
        records_before["items"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|record| record["record_type"] == "command")
            .count(),
        2
    );
    let attempt = uuid::Uuid::now_v7().to_string();
    let response = request(
        &app,
        &member,
        "PUT",
        PROGRESS,
        progress_input(0, "paused", "verify_observation", &attempt, context.clone()),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let saved = data(response).await;
    sqlx::raw_sql("CREATE FUNCTION public.reject_guide_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='lab.guide_progress.save' THEN RAISE EXCEPTION 'injected progress audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_guide_audit BEFORE INSERT ON labos_threejs_core.audit_events FOR EACH ROW EXECUTE FUNCTION public.reject_guide_audit();")
        .execute(&pool).await.unwrap();
    let finish = progress_input(1, "completed", "complete", &attempt, context);
    let response = request(&app, &member, "PUT", PROGRESS, finish.clone()).await;
    assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    assert_eq!(data(response).await["error"]["code"], "lab.unavailable");
    assert_eq!(
        saved,
        data(request(&app, &member, "GET", PROGRESS, Value::Null).await).await["progress"]
    );
    assert_eq!(
        before,
        data(request(&app, &member, "GET", &world_path, Value::Null).await).await
    );
    assert_eq!(
        records_before["items"],
        data(request(&app, &member, "GET", &records_path, Value::Null).await).await["items"]
    );
    sqlx::raw_sql("DROP TRIGGER reject_guide_audit ON labos_threejs_core.audit_events; DROP FUNCTION public.reject_guide_audit();").execute(&pool).await.unwrap();
    let response = request(&app, &member, "PUT", PROGRESS, finish).await;
    assert_eq!(response.status(), StatusCode::OK);
    let completed = data(response).await;
    assert_eq!(completed["status"], "completed");
    assert_eq!(completed["revision"], 2);
    for _ in 0..2 {
        assert_eq!(
            completed,
            data(request(&app, &member, "GET", PROGRESS, Value::Null).await).await["progress"]
        );
    }
    assert_eq!(
        before,
        data(request(&app, &member, "GET", &world_path, Value::Null).await).await
    );
    assert_eq!(
        records_before["items"],
        data(request(&app, &member, "GET", &records_path, Value::Null).await).await["items"]
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn invalid_learning_state_and_forged_ownership_or_receipts_preserve_progress_and_world(
    pool: PgPool,
) {
    let app = labos_threejs_api::router(pool, Default::default());
    register(&app, "input-owner@example.test", "owner").await;
    let member = register(&app, "input-member@example.test", "member").await;
    let lab = create_lab(&app, &member, "Input guide lab").await;
    let (context, before) = light_context(&app, &member, &lab).await;
    let attempt = uuid::Uuid::now_v7().to_string();
    let response = request(
        &app,
        &member,
        "PUT",
        PROGRESS,
        progress_input(0, "paused", "select_entity", &attempt, context.clone()),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let saved = data(response).await;
    let valid = progress_input(1, "in_progress", "edit_placement", &attempt, context);
    let mut cases = Vec::new();
    let mut invalid = valid.clone();
    invalid["status"] = json!("completed");
    cases.push(invalid);
    for (field, value) in [
        ("status", json!("not_started")),
        ("step", json!("14")),
        ("step", json!("complete")),
        ("guide_attempt_id", Value::Null),
        ("expected_revision", json!(-1)),
        ("guide_attempt_id", json!("translated object name")),
    ] {
        let mut invalid = valid.clone();
        invalid[field] = value;
        cases.push(invalid);
    }
    for field in [
        "owner",
        "actor_id",
        "receipt_id",
        "receipt",
        "committed_context",
    ] {
        let mut invalid = valid.clone();
        invalid[field] = json!(member.id);
        cases.push(invalid);
    }
    let mut invalid = valid.clone();
    invalid["context"]["receipt_id"] = json!(member.id);
    cases.push(invalid);
    for key in ["", "contains a space", &"a".repeat(129)] {
        let mut invalid = valid.clone();
        invalid["context"]["business_attempt"]["request_key"] = json!(key);
        cases.push(invalid);
    }
    for invalid in cases {
        let response = request(&app, &member, "PUT", PROGRESS, invalid.clone()).await;
        assert_eq!(
            response.status(),
            StatusCode::BAD_REQUEST,
            "accepted invalid progress: {invalid}"
        );
        assert_eq!(
            saved,
            data(request(&app, &member, "GET", PROGRESS, Value::Null).await).await["progress"]
        );
        assert_eq!(
            before,
            data(
                request(
                    &app,
                    &member,
                    "GET",
                    &format!("/api/v1/lab/labs/{lab}/world"),
                    Value::Null
                )
                .await
            )
            .await
        );
    }
    let response = request(&app, &member, "PUT", PROGRESS, valid).await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(data(response).await["revision"], 2);
}

async fn create_lab(app: &Router, member: &Browser, name: &str) -> String {
    let response = request(
        app,
        member,
        "POST",
        "/api/v1/lab/labs",
        json!({"name":name}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    data(response).await["id"].as_str().unwrap().into()
}

async fn light_context(app: &Router, member: &Browser, lab: &str) -> (Value, Value) {
    let response = request(
        app,
        member,
        "POST",
        &format!("/api/v1/lab/labs/{lab}/entities"),
        json!({"name":"Shared light","definition_id":"light","definition_version":"1.0",
            "reality":"simulated","configuration":{},"representation_id":null}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let entity = data(response).await;
    let world = data(
        request(
            app,
            member,
            "GET",
            &format!("/api/v1/lab/labs/{lab}/world"),
            Value::Null,
        )
        .await,
    )
    .await;
    let node = world["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|node| node["entity_id"] == entity["id"])
        .unwrap();
    (
        json!({"lab_id":lab,"entity_id":entity["id"],"node_id":node["id"],
        "business_attempt":{"operation":"register_entity","target_lab_id":lab,"request_key":"shared-context-attempt"}}),
        world,
    )
}

#[sqlx::test(migrations = "../../migrations")]
async fn shared_world_contexts_are_validated_and_progress_belongs_to_the_current_user(
    pool: PgPool,
) {
    let app = labos_threejs_api::router(pool, Default::default());
    let owner = register(&app, "contexts-owner@example.test", "owner").await;
    let first = register(&app, "contexts-first@example.test", "member").await;
    let second = register(&app, "contexts-second@example.test", "member").await;
    let lab = create_lab(&app, &owner, "Shared guide lab").await;
    let other_lab = create_lab(&app, &owner, "Other guide lab").await;
    let (context, before) = light_context(&app, &owner, &lab).await;
    let other_path = format!("/api/v1/lab/labs/{other_lab}/world");
    let other_before = data(request(&app, &first, "GET", &other_path, Value::Null).await).await;
    let first_attempt = uuid::Uuid::now_v7().to_string();
    let second_attempt = uuid::Uuid::now_v7().to_string();
    let response = request(
        &app,
        &first,
        "PUT",
        PROGRESS,
        progress_input(
            0,
            "paused",
            "select_entity",
            &first_attempt,
            context.clone(),
        ),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let first_saved = data(response).await;
    let initial_second = data(request(&app, &second, "GET", PROGRESS, Value::Null).await).await;
    assert_eq!(initial_second["progress"]["status"], "not_started");
    assert_eq!(initial_second["progress"]["revision"], 0);
    let response = request(
        &app,
        &second,
        "PUT",
        PROGRESS,
        progress_input(
            0,
            "in_progress",
            "edit_placement",
            &second_attempt,
            context.clone(),
        ),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let second_saved = data(response).await;
    assert_eq!(
        first_saved,
        data(request(&app, &first, "GET", PROGRESS, Value::Null).await).await["progress"]
    );
    let credential = data(
        request(
            &app,
            &first,
            "POST",
            "/api/v1/api-keys",
            json!({"name":"Guide Agent","scopes":["lab:full"],"expires_in_days":1}),
        )
        .await,
    )
    .await;
    let secret = credential["secret"].as_str().unwrap();
    assert_eq!(
        first_saved,
        data(agent(&app, secret, "GET", PROGRESS, Value::Null).await).await["progress"]
    );
    let response = agent(
        &app,
        secret,
        "PUT",
        PROGRESS,
        progress_input(
            1,
            "in_progress",
            "edit_placement",
            &first_attempt,
            context.clone(),
        ),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let current_first = data(response).await;
    assert_eq!(current_first["revision"], 2);
    assert_eq!(
        current_first,
        data(request(&app, &first, "GET", PROGRESS, Value::Null).await).await["progress"]
    );
    assert_eq!(
        second_saved,
        data(request(&app, &second, "GET", PROGRESS, Value::Null).await).await["progress"]
    );
    let mut wrong = context;
    wrong["lab_id"] = json!(other_lab);
    wrong["business_attempt"]["target_lab_id"] = json!(other_lab);
    let response = request(
        &app,
        &first,
        "PUT",
        PROGRESS,
        progress_input(2, "paused", "select_entity", &first_attempt, wrong),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        data(response).await["error"]["code"],
        "lab.invalid_reference"
    );
    assert_eq!(
        current_first,
        data(request(&app, &first, "GET", PROGRESS, Value::Null).await).await["progress"]
    );
    assert_eq!(
        before,
        data(
            request(
                &app,
                &first,
                "GET",
                &format!("/api/v1/lab/labs/{lab}/world"),
                Value::Null
            )
            .await
        )
        .await
    );
    assert_eq!(
        other_before,
        data(request(&app, &first, "GET", &other_path, Value::Null).await).await
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn a_member_saves_and_recovers_initial_progress_without_a_lab_or_a_submitted_business_attempt(
    pool: PgPool,
) {
    let app = labos_threejs_api::router(pool, Default::default());
    register(&app, "guide-owner@example.test", "owner").await;
    let member = register(&app, "guide-member@example.test", "member").await;
    let labs_before =
        data(request(&app, &member, "GET", "/api/v1/lab/labs", Value::Null).await).await;
    assert_eq!(labs_before["data"], json!([]));

    let response = request(&app, &member, "GET", PROGRESS, Value::Null).await;
    assert_eq!(response.status(), StatusCode::OK);
    let initial = data(response).await;
    assert_eq!(initial["current_guide_version"], "1.0");
    assert_eq!(initial["compatibility"], "compatible");
    assert_eq!(initial["previous_progress"], Value::Null);
    let empty = json!({
        "guide_id":"lab-onboarding", "guide_version":"1.0", "revision":0,
        "status":"not_started", "step":null, "guide_attempt_id":null,
        "context":{"lab_id":null,"entity_id":null,"node_id":null,"business_attempt":null},
        "updated_at":null
    });
    assert_eq!(initial["progress"], empty);
    assert_eq!(
        initial,
        data(request(&app, &member, "GET", PROGRESS, Value::Null).await).await
    );

    let attempt = uuid::Uuid::now_v7().to_string();
    let context = json!({
        "lab_id":null,"entity_id":null,"node_id":null,
        "business_attempt":{
            "operation":"create_lab","target_lab_id":null,
            "request_key":"unsubmitted-initial-attempt"
        }
    });
    let response = request(
        &app,
        &member,
        "PUT",
        PROGRESS,
        json!({
            "expected_revision":0,"status":"in_progress","step":"create_lab",
            "guide_attempt_id":attempt,"context":context
        }),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let saved = data(response).await;
    assert_eq!(saved["revision"], 1);
    assert_eq!(saved["status"], "in_progress");
    assert_eq!(saved["step"], "create_lab");
    assert_eq!(saved["guide_attempt_id"], attempt);
    assert_eq!(saved["context"], context);
    assert!(saved["updated_at"].as_str().is_some());
    let restored = data(request(&app, &member, "GET", PROGRESS, Value::Null).await).await;
    assert_eq!(restored["progress"], saved);
    assert_eq!(
        labs_before,
        data(request(&app, &member, "GET", "/api/v1/lab/labs", Value::Null).await).await
    );
}
