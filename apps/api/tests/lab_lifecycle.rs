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
use tower::ServiceExt;

struct Member {
    cookie: String,
    csrf: String,
}
async fn data(response: Response) -> Value {
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}
async fn member(app: &Router) -> Member {
    let response = app.clone().oneshot(Request::post("/api/v1/auth/register")
        .header("origin", "http://127.0.0.1:5173").header("content-type", "application/json")
        .body(Body::from(json!({"email":format!("{}@example.test",uuid::Uuid::now_v7()),"password":"a-long-test-password"}).to_string())).unwrap()).await.unwrap();
    assert_eq!(response.status(), StatusCode::CREATED);
    let cookie = response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .into();
    Member {
        cookie,
        csrf: data(response).await["csrf_token"].as_str().unwrap().into(),
    }
}
async fn request(app: &Router, member: &Member, method: &str, path: &str, body: Value) -> Response {
    request_key(
        app,
        member,
        method,
        path,
        body,
        &uuid::Uuid::now_v7().to_string(),
    )
    .await
}
async fn request_key(
    app: &Router,
    member: &Member,
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
                .header("cookie", &member.cookie)
                .header("x-csrf-token", &member.csrf)
                .header("idempotency-key", key)
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap()
}
async fn device(app: &Router, member: &Member, definition: &str) -> (String, String) {
    let lab = data(
        request(
            app,
            member,
            "POST",
            "/api/v1/lab/labs",
            json!({"name":"Lifecycle lab"}),
        )
        .await,
    )
    .await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let response=request(app,member,"POST",&format!("/api/v1/lab/labs/{lab}/entities"),json!({"name":"Device A","definition_id":definition,"definition_version":"1.0","reality":"simulated","configuration":{},"representation_id":null})).await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let id = data(response).await["id"].as_str().unwrap().to_owned();
    (lab.clone(), format!("/api/v1/lab/labs/{lab}/entities/{id}"))
}

#[sqlx::test(migrations = "../../migrations")]
async fn archive_rejects_running_program_and_reserved_task_without_changing_the_world(
    pool: PgPool,
) {
    let runtime = DeviceRuntime::initialize(pool.clone()).await.unwrap();
    let app = labos_threejs_api::router(pool, Default::default());
    let _owner = member(&app).await;
    let member = member(&app).await;
    let (lab, path) = device(&app, &member, "centrifuge").await;
    let run = request(
        &app,
        &member,
        "POST",
        &format!("{path}/program/start"),
        json!({}),
    )
    .await;
    assert_eq!(run.status(), StatusCode::CREATED);
    let before = data(
        request(
            &app,
            &member,
            "GET",
            &format!("/api/v1/lab/labs/{lab}/world"),
            Value::Null,
        )
        .await,
    )
    .await;
    let rejected = request(&app, &member, "POST", &format!("{path}/archive"), json!({})).await;
    assert_eq!(rejected.status(), StatusCode::CONFLICT);
    assert_eq!(data(rejected).await["error"]["code"], "lab.entity_in_use");
    assert_eq!(
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
        .await,
        before
    );
    let command=request(&app,&member,"POST",&format!("{path}/actions"),json!({"capability":"centrifuge.start","parameters":{"rpm":500,"temperature":22,"duration_seconds":6}})).await;
    assert_eq!(command.status(), StatusCode::ACCEPTED);
    let before = data(request(&app, &member, "GET", &path, Value::Null).await).await;
    assert_eq!(before["task"]["status"], "pending");
    assert_eq!(
        request(&app, &member, "POST", &format!("{path}/archive"), json!({}))
            .await
            .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        request(
            &app,
            &member,
            "PUT",
            &format!("{path}/definition"),
            json!({"definition_id":"sensor","definition_version":"1.0","configuration":{}})
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        request(
            &app,
            &member,
            "POST",
            &format!("{path}/program/stop"),
            json!({})
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        data(request(&app, &member, "GET", &path, Value::Null).await).await,
        before
    );
    assert!(runtime.process_next().await.unwrap());
}

struct Clock(std::sync::atomic::AtomicI64);
impl labos_threejs_app::modules::lab::ObservationClock for Clock {
    fn now(&self) -> chrono::DateTime<chrono::Utc> {
        chrono::DateTime::from_timestamp(self.0.load(std::sync::atomic::Ordering::SeqCst), 0)
            .unwrap()
    }
}
#[sqlx::test(migrations = "../../migrations")]
async fn finished_task_requires_stop_program_before_archive_and_keeps_history(pool: PgPool) {
    let clock = std::sync::Arc::new(Clock(std::sync::atomic::AtomicI64::new(
        chrono::Utc::now().timestamp(),
    )));
    let runtime = DeviceRuntime::initialize_with_clock(pool.clone(), clock.clone())
        .await
        .unwrap();
    let app = labos_threejs_api::router(pool, Default::default());
    let _owner = member(&app).await;
    let member = member(&app).await;
    let (_, path) = device(&app, &member, "centrifuge").await;
    request(
        &app,
        &member,
        "POST",
        &format!("{path}/program/start"),
        json!({}),
    )
    .await;
    request(&app,&member,"POST",&format!("{path}/actions"),json!({"capability":"centrifuge.start","parameters":{"rpm":500,"temperature":22,"duration_seconds":6}})).await;
    runtime.process_next().await.unwrap();
    for seconds in [1, 6, 1] {
        clock
            .0
            .fetch_add(seconds, std::sync::atomic::Ordering::SeqCst);
        runtime.sample_due().await.unwrap();
    }
    let finished = data(request(&app, &member, "GET", &path, Value::Null).await).await;
    assert_eq!(finished["task"]["status"], "completed");
    assert_eq!(finished["task_result"]["status"], "completed");
    assert_eq!(
        request(&app, &member, "POST", &format!("{path}/archive"), json!({}))
            .await
            .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        request(
            &app,
            &member,
            "PUT",
            &format!("{path}/definition"),
            json!({"definition_id":"light","definition_version":"1.0","configuration":{}})
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        data(request(&app, &member, "GET", &path, Value::Null).await).await,
        finished
    );
    assert_eq!(
        request(
            &app,
            &member,
            "POST",
            &format!("{path}/program/stop"),
            json!({})
        )
        .await
        .status(),
        StatusCode::OK
    );
    let archived =
        data(request(&app, &member, "POST", &format!("{path}/archive"), json!({})).await).await;
    assert_eq!(archived["task"], finished["task"]);
    assert_eq!(archived["task_result"], finished["task_result"]);
    let task = data(
        request(
            &app,
            &member,
            "GET",
            &format!("{path}/tasks/{}", finished["task"]["id"].as_str().unwrap()),
            Value::Null,
        )
        .await,
    )
    .await;
    assert_eq!(task, finished["task"]);
    let history = format!(
        "{path}/history?record_type=task&from={}&to={}",
        (chrono::Utc::now() - chrono::Duration::hours(1))
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        (chrono::Utc::now() + chrono::Duration::hours(1))
            .to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
    );
    assert_eq!(
        data(request(&app, &member, "GET", &history, Value::Null).await).await["items"][0]["id"],
        finished["task"]["id"]
    );
    assert_eq!(
        request(&app, &member, "DELETE", &path, Value::Null)
            .await
            .status(),
        StatusCode::METHOD_NOT_ALLOWED
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn concurrent_program_start_and_lifecycle_changes_commit_only_valid_states(pool: PgPool) {
    let _runtime = DeviceRuntime::initialize(pool.clone()).await.unwrap();
    let app = labos_threejs_api::router(pool, Default::default());
    let _owner = member(&app).await;
    let member = member(&app).await;
    for operation in ["archive", "definition"] {
        let (_, path) = device(&app, &member, "light").await;
        let barrier = tokio::sync::Barrier::new(2);
        let start = async {
            barrier.wait().await;
            request(
                &app,
                &member,
                "POST",
                &format!("{path}/program/start"),
                json!({}),
            )
            .await
        };
        let change = async {
            barrier.wait().await;
            request(
                &app,
                &member,
                if operation == "archive" {
                    "POST"
                } else {
                    "PUT"
                },
                &format!("{path}/{operation}"),
                json!({"definition_id":"sensor","definition_version":"1.0","configuration":{}}),
            )
            .await
        };
        let (started, changed) = tokio::join!(start, change);
        let result = data(request(&app, &member, "GET", &path, Value::Null).await).await;
        if changed.status() == StatusCode::CONFLICT {
            assert_eq!(started.status(), StatusCode::CREATED);
            assert_eq!(result["definition_id"], "light");
            assert_eq!(result["archived_at"], Value::Null);
            assert_eq!(result["program_run"]["program_id"], "light.v1");
        } else {
            assert_eq!(changed.status(), StatusCode::OK);
            if operation == "archive" {
                assert_eq!(started.status(), StatusCode::CONFLICT);
                assert_eq!(result["program_run"], Value::Null);
            } else {
                assert_eq!(started.status(), StatusCode::CREATED);
                assert_eq!(result["definition_id"], "sensor");
                assert_eq!(result["program_run"]["program_id"], "sensor.v1");
            }
        }
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn member_and_agent_share_lifecycle_rules_and_rejected_writes_leave_data_unchanged(
    pool: PgPool,
) {
    let app = labos_threejs_api::router(pool, Default::default());
    let _owner = member(&app).await;
    let member = member(&app).await;
    let (lab, path) = device(&app, &member, "light").await;
    let key = data(
        request(
            &app,
            &member,
            "POST",
            "/api/v1/api-keys",
            json!({"name":"Lifecycle Agent","scopes":["lab:full"],"expires_in_days":1}),
        )
        .await,
    )
    .await;
    let bearer = |method: &str, url: String, body: Value, secret: String| {
        let app = app.clone();
        let method = method.to_owned();
        async move {
            app.oneshot(
                Request::builder()
                    .method(method.as_str())
                    .uri(url)
                    .header("authorization", format!("Bearer {secret}"))
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_string()))
                    .unwrap(),
            )
            .await
            .unwrap()
        }
    };
    let secret = key["secret"].as_str().unwrap().to_owned();
    let changed = bearer(
        "PUT",
        format!("{path}/definition"),
        json!({"definition_id":"sensor","definition_version":"1.0","configuration":{}}),
        secret.clone(),
    )
    .await;
    assert_eq!(changed.status(), StatusCode::OK);
    let before = data(
        request(
            &app,
            &member,
            "GET",
            &format!("/api/v1/lab/labs/{lab}/world"),
            Value::Null,
        )
        .await,
    )
    .await;
    for body in [
        json!({"definition_id":"sensor","definition_version":"99.0","configuration":{}}),
        json!({"definition_id":"sensor","definition_version":"1.0","configuration":{},"schema":{}}),
    ] {
        assert_eq!(
            request(&app, &member, "PUT", &format!("{path}/definition"), body)
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(
        bearer(
            "POST",
            format!("{path}/archive"),
            Value::Null,
            "invalid".into()
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    let no_csrf = app
        .clone()
        .oneshot(
            Request::post(format!("{path}/archive"))
                .header("cookie", &member.cookie)
                .header("origin", "http://127.0.0.1:5173")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(no_csrf.status(), StatusCode::FORBIDDEN);
    assert_eq!(
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
        .await,
        before
    );
    assert_eq!(
        bearer(
            "POST",
            format!("{path}/archive"),
            Value::Null,
            secret.clone()
        )
        .await
        .status(),
        StatusCode::OK
    );
    assert_eq!(
        bearer(
            "PUT",
            format!("{path}/definition"),
            json!({"definition_id":"light","definition_version":"1.0","configuration":{}}),
            secret
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn definition_changes_require_stopped_program_and_keep_old_run_meaning(pool: PgPool) {
    let runtime = DeviceRuntime::initialize(pool.clone()).await.unwrap();
    let app = labos_threejs_api::router(pool, Default::default());
    let _owner = member(&app).await;
    let member = member(&app).await;
    let (_, path) = device(&app, &member, "light").await;
    let run = data(
        request(
            &app,
            &member,
            "POST",
            &format!("{path}/program/start"),
            json!({}),
        )
        .await,
    )
    .await;
    let before = data(request(&app, &member, "GET", &path, Value::Null).await).await;
    let change = json!({"definition_id":"sensor","definition_version":"1.0","configuration":{"baseline_temperature":25}});
    assert_eq!(
        request(
            &app,
            &member,
            "PUT",
            &format!("{path}/definition"),
            change.clone()
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        data(request(&app, &member, "GET", &path, Value::Null).await).await,
        before
    );
    let stopped = data(
        request(
            &app,
            &member,
            "POST",
            &format!("{path}/program/stop"),
            json!({}),
        )
        .await,
    )
    .await;
    let changed = request(&app, &member, "PUT", &format!("{path}/definition"), change).await;
    assert_eq!(changed.status(), StatusCode::OK);
    let changed = data(changed).await;
    assert_eq!(changed["id"], before["id"]);
    assert_eq!(changed["definition_id"], "sensor");
    assert_eq!(changed["binding"]["program_id"], "sensor.v1");
    assert_ne!(changed["binding"]["id"], before["binding"]["id"]);
    assert_eq!(
        data(
            request(
                &app,
                &member,
                "GET",
                &format!("{path}/runs/{}", run["id"].as_str().unwrap()),
                Value::Null
            )
            .await
        )
        .await,
        stopped
    );
    assert_eq!(stopped["definition_id"], "light");
    assert_eq!(stopped["definition_version"], "1.0");
    assert_eq!(stopped["program_id"], "light.v1");
    let next = data(
        request(
            &app,
            &member,
            "POST",
            &format!("{path}/program/start"),
            json!({}),
        )
        .await,
    )
    .await;
    assert_eq!(next["definition_id"], "sensor");
    assert_ne!(next["source"], stopped["source"]);
    assert_eq!(
        runtime
            .observe(
                run["id"].as_str().unwrap(),
                labos_threejs_app::modules::lab::ObservationReport {
                    sequence: 1,
                    observed_at: None,
                    values: json!({"brightness":50}),
                    quality: "good".into()
                }
            )
            .await
            .unwrap(),
        labos_threejs_app::modules::lab::ObservationAcceptance::StaleRun
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn expired_command_receipts_survive_definition_change_and_archive(pool: PgPool) {
    let runtime = DeviceRuntime::initialize(pool.clone()).await.unwrap();
    let app = labos_threejs_api::router(pool.clone(), Default::default());
    let _owner = member(&app).await;
    let member = member(&app).await;
    let (lab, path) = device(&app, &member, "light").await;
    request(
        &app,
        &member,
        "POST",
        &format!("{path}/program/start"),
        json!({}),
    )
    .await;
    let input = json!({"capability":"light.set_power","parameters":{"on":true}});
    let command = data(
        request_key(
            &app,
            &member,
            "POST",
            &format!("{path}/actions"),
            input.clone(),
            "old-key",
        )
        .await,
    )
    .await;
    runtime.process_next().await.unwrap();
    request(
        &app,
        &member,
        "POST",
        &format!("{path}/program/stop"),
        json!({}),
    )
    .await;
    let maintenance =
        labos_threejs_app::modules::lab::HistoryMaintenance::new(pool, Default::default());
    assert_eq!(
        maintenance
            .cleanup(&lab, chrono::Utc::now() + chrono::Duration::days(31))
            .await
            .unwrap()
            .commands,
        1
    );
    assert_eq!(
        request(
            &app,
            &member,
            "GET",
            &format!("{path}/commands/{}", command["id"].as_str().unwrap()),
            Value::Null
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request(
            &app,
            &member,
            "PUT",
            &format!("{path}/definition"),
            json!({"definition_id":"sensor","definition_version":"1.0","configuration":{}})
        )
        .await
        .status(),
        StatusCode::OK
    );
    assert_eq!(
        request(&app, &member, "POST", &format!("{path}/archive"), json!({}))
            .await
            .status(),
        StatusCode::OK
    );
    let before = data(request(&app, &member, "GET", &path, Value::Null).await).await;
    assert_eq!(
        request_key(
            &app,
            &member,
            "POST",
            &format!("{path}/actions"),
            input,
            "old-key"
        )
        .await
        .status(),
        StatusCode::GONE
    );
    assert_eq!(
        request_key(
            &app,
            &member,
            "POST",
            &format!("{path}/actions"),
            json!({"capability":"light.set_power","parameters":{"on":false}}),
            "old-key"
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        data(request(&app, &member, "GET", &path, Value::Null).await).await,
        before
    );
}
