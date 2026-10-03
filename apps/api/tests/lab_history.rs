use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
    response::Response,
};
use chrono::{DateTime, Utc};
use http_body_util::BodyExt;
use labos_threejs_app::modules::lab::{DeviceRuntime, ObservationClock, ObservationReport};
use labos_threejs_app::modules::lab::{HistoryMaintenance, RetentionPolicy};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};
use tower::ServiceExt;

#[sqlx::test(migrations = "../../migrations")]
async fn even_the_latest_ended_task_expires_with_a_new_world_version(pool: PgPool) {
    let clock = Clock::new();
    let runtime = DeviceRuntime::initialize_with_clock(pool.clone(), clock.clone())
        .await
        .unwrap();
    let app = labos_threejs_api::router(pool.clone(), Default::default());
    let member = member(&app).await;
    let path = entity(&app, &member, "centrifuge").await;
    let lab = path.split('/').nth(5).unwrap();
    request(
        &app,
        &member,
        "POST",
        &format!("{path}/program/start"),
        json!({}),
    )
    .await;
    let command=data(request(&app,&member,"POST",&format!("{path}/actions"),json!({"capability":"centrifuge.start","parameters":{"rpm":6000,"temperature":22,"duration_seconds":6}})).await).await;
    runtime.process_next().await.unwrap();
    for seconds in [2, 6, 2] {
        clock.advance(seconds);
        runtime.sample_due().await.unwrap();
    }
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
    let device = &before["entities"][0];
    assert_eq!(device["task"]["status"], "completed");
    let maintenance = HistoryMaintenance::new(pool, RetentionPolicy::default());
    assert_eq!(
        maintenance
            .cleanup(lab, Utc::now() + chrono::Duration::days(31))
            .await
            .unwrap()
            .tasks,
        1
    );
    let after = data(
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
    assert!(
        after["version"].as_str().unwrap().parse::<u64>().unwrap()
            > before["version"].as_str().unwrap().parse().unwrap()
    );
    assert_eq!(after["entities"][0]["task"], Value::Null);
    assert_eq!(after["entities"][0]["task_result"], Value::Null);
    for field in [
        "id",
        "configuration",
        "binding",
        "program_run",
        "observation",
    ] {
        assert_eq!(after["entities"][0][field], device[field]);
    }
    for suffix in [
        format!("commands/{}", command["id"].as_str().unwrap()),
        format!("tasks/{}", device["task"]["id"].as_str().unwrap()),
        format!("results/{}", device["task_result"]["id"].as_str().unwrap()),
    ] {
        assert_eq!(
            request(
                &app,
                &member,
                "GET",
                &format!("{path}/{suffix}"),
                Value::Null
            )
            .await
            .status(),
            StatusCode::NOT_FOUND
        );
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn a_short_policy_keeps_the_exact_receive_time_boundary_and_cursor_scope(pool: PgPool) {
    assert!(RetentionPolicy::new(0, 1).is_err());
    assert!(RetentionPolicy::new(1, 31536001).is_err());
    let clock = Clock::new();
    let runtime = DeviceRuntime::initialize_with_clock(pool.clone(), clock.clone())
        .await
        .unwrap();
    let app = labos_threejs_api::router(pool.clone(), Default::default());
    let member = member(&app).await;
    let path = entity(&app, &member, "sensor").await;
    let lab = path.split('/').nth(5).unwrap();
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
    let from = clock.now();
    for sequence in 1..=3 {
        runtime
            .observe(
                run["id"].as_str().unwrap(),
                ObservationReport {
                    sequence,
                    values: json!({"temperature":sequence}),
                    observed_at: None,
                    quality: "uncertain".into(),
                },
            )
            .await
            .unwrap();
        clock.advance(1);
    }
    let before = data(request(&app, &member, "GET", &path, Value::Null).await).await;
    let cleanup = HistoryMaintenance::new(pool, RetentionPolicy::new(2, 30).unwrap())
        .cleanup(lab, clock.now())
        .await
        .unwrap();
    assert_eq!(cleanup.observations, 1);
    assert_eq!(
        data(request(&app, &member, "GET", &path, Value::Null).await).await,
        before
    );
    let url = query(&path, "observation", from, clock.now(), "limit=1");
    let page = data(request(&app, &member, "GET", &url, Value::Null).await).await;
    assert_eq!(page["items"][0]["data"]["values"]["temperature"], 3);
    assert_eq!(page["gap"], true);
    let cursor = page["next_cursor"].as_str().unwrap();
    let next = data(
        request(
            &app,
            &member,
            "GET",
            &query(
                &path,
                "observation",
                from,
                clock.now(),
                &format!("limit=1&cursor={cursor}"),
            ),
            Value::Null,
        )
        .await,
    )
    .await;
    assert_eq!(next["items"][0]["data"]["values"]["temperature"], 2);
    assert_eq!(next["next_cursor"], Value::Null);
    for url in [
        query(
            &path,
            "event",
            from,
            clock.now(),
            &format!("cursor={cursor}"),
        ),
        query(
            &path,
            "observation",
            from,
            from + chrono::Duration::days(32),
            "limit=1",
        ),
        query(&path, "observation", clock.now(), from, "limit=1"),
    ] {
        assert_eq!(
            request(&app, &member, "GET", &url, Value::Null)
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
    }
    let no_csrf = app
        .clone()
        .oneshot(
            Request::post(format!("/api/v1/lab/labs/{lab}/history/cleanup"))
                .header("cookie", &member.cookie)
                .header("origin", "http://127.0.0.1:5173")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(no_csrf.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        data(request(&app, &member, "GET", &path, Value::Null).await).await,
        before
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn same_time_reports_page_without_duplicates_and_bound_the_response(pool: PgPool) {
    let clock = Clock::new();
    let runtime = DeviceRuntime::initialize_with_clock(pool.clone(), clock.clone())
        .await
        .unwrap();
    let app = labos_threejs_api::router(pool, Default::default());
    let member = member(&app).await;
    let path = entity(&app, &member, "sensor").await;
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
    for sequence in 1..=101 {
        runtime
            .observe(
                run["id"].as_str().unwrap(),
                ObservationReport {
                    sequence,
                    values: json!({"temperature":sequence}),
                    observed_at: Some(clock.now()),
                    quality: "good".into(),
                },
            )
            .await
            .unwrap();
    }
    runtime
        .observe(
            run["id"].as_str().unwrap(),
            ObservationReport {
                sequence: 101,
                values: json!({"temperature":999}),
                observed_at: Some(clock.now()),
                quality: "good".into(),
            },
        )
        .await
        .unwrap();
    let from = clock.now() - chrono::Duration::seconds(1);
    let to = clock.now() + chrono::Duration::seconds(1);
    let mut cursor = None;
    let mut ids = std::collections::BTreeSet::new();
    loop {
        let url = query(
            &path,
            "observation",
            from,
            to,
            &format!(
                "limit=100{}",
                cursor
                    .as_ref()
                    .map(|c| format!("&cursor={c}"))
                    .unwrap_or_default()
            ),
        );
        let page = data(request(&app, &member, "GET", &url, Value::Null).await).await;
        assert!(serde_json::to_vec(&page).unwrap().len() <= 262144);
        let items = page["items"].as_array().unwrap();
        assert!(items.len() <= 100);
        for item in items {
            assert!(ids.insert(item["id"].as_str().unwrap().to_owned()));
            assert_ne!(item["data"]["values"]["temperature"], 999);
        }
        cursor = page["next_cursor"].as_str().map(str::to_owned);
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(ids.len(), 101);
}

#[sqlx::test(migrations = "../../migrations")]
async fn ended_commands_expire_on_their_own_boundary_while_a_later_task_result_remains(
    pool: PgPool,
) {
    let clock = Clock::new();
    let runtime = DeviceRuntime::initialize_with_clock(pool.clone(), clock.clone())
        .await
        .unwrap();
    let app = labos_threejs_api::router(pool.clone(), Default::default());
    let member = member(&app).await;
    let path = entity(&app, &member, "centrifuge").await;
    let lab = path.split('/').nth(5).unwrap();
    request(
        &app,
        &member,
        "POST",
        &format!("{path}/program/start"),
        json!({}),
    )
    .await;
    clock.advance(100);
    let command=data(request(&app,&member,"POST",&format!("{path}/actions"),json!({"capability":"centrifuge.start","parameters":{"rpm":6000,"temperature":22,"duration_seconds":6}})).await).await;
    runtime.process_next().await.unwrap();
    for seconds in [2, 6, 2] {
        clock.advance(seconds);
        runtime.sample_due().await.unwrap();
    }
    let current = data(request(&app, &member, "GET", &path, Value::Null).await).await;
    assert_eq!(current["task"]["status"], "completed");
    let cleaned = HistoryMaintenance::new(pool, RetentionPolicy::new(86400, 30).unwrap())
        .cleanup(lab, clock.now() + chrono::Duration::seconds(25))
        .await
        .unwrap();
    assert_eq!(cleaned.tasks, 0);
    assert_eq!(cleaned.commands, 1);
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
    let task = data(
        request(
            &app,
            &member,
            "GET",
            &format!("{path}/tasks/{}", command["task_id"].as_str().unwrap()),
            Value::Null,
        )
        .await,
    )
    .await;
    assert_eq!(task["command_id"], command["id"]);
    assert_eq!(task["status"], "completed");
    assert_eq!(
        request(
            &app,
            &member,
            "GET",
            &format!("{path}/results/{}", task["result_id"].as_str().unwrap()),
            Value::Null
        )
        .await
        .status(),
        StatusCode::OK
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn an_expired_request_key_never_executes_again_and_different_parameters_still_conflict(
    pool: PgPool,
) {
    let clock = Clock::new();
    let runtime = DeviceRuntime::initialize_with_clock(pool.clone(), clock.clone())
        .await
        .unwrap();
    let app = labos_threejs_api::router(pool.clone(), Default::default());
    let member = member(&app).await;
    let path = entity(&app, &member, "centrifuge").await;
    let lab = path.split('/').nth(5).unwrap();
    request(
        &app,
        &member,
        "POST",
        &format!("{path}/program/start"),
        json!({}),
    )
    .await;
    let key = "expired-start-key";
    let parameters = json!({"capability":"centrifuge.start","parameters":{"rpm":6000,"temperature":22,"duration_seconds":6}});
    let response = request_with_key(
        &app,
        &member,
        "POST",
        &format!("{path}/actions"),
        parameters.clone(),
        key,
    )
    .await;
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    let command = data(response).await;
    runtime.process_next().await.unwrap();
    for seconds in [2, 6, 2] {
        clock.advance(seconds);
        runtime.sample_due().await.unwrap();
    }
    HistoryMaintenance::new(pool, RetentionPolicy::default())
        .cleanup(lab, Utc::now() + chrono::Duration::days(31))
        .await
        .unwrap();
    let before = data(request(&app, &member, "GET", &path, Value::Null).await).await;
    assert_eq!(before["task"], Value::Null);
    let retry = request_with_key(
        &app,
        &member,
        "POST",
        &format!("{path}/actions"),
        parameters.clone(),
        key,
    )
    .await;
    assert_eq!(retry.status(), StatusCode::GONE);
    assert_eq!(data(retry).await["error"]["code"], "lab.command_expired");
    let equivalent = json!({"parameters":{"duration_seconds":6.0,"temperature":22.0,"rpm":6000.0},"capability":"centrifuge.start"});
    assert_eq!(
        request_with_key(
            &app,
            &member,
            "POST",
            &format!("{path}/actions"),
            equivalent,
            key
        )
        .await
        .status(),
        StatusCode::GONE
    );
    let mut changed = parameters;
    changed["parameters"]["rpm"] = json!(7000);
    let conflict = request_with_key(
        &app,
        &member,
        "POST",
        &format!("{path}/actions"),
        changed,
        key,
    )
    .await;
    assert_eq!(conflict.status(), StatusCode::CONFLICT);
    assert_eq!(
        data(conflict).await["error"]["code"],
        "idempotency.conflict"
    );
    assert!(!runtime.process_next().await.unwrap());
    assert_eq!(
        data(request(&app, &member, "GET", &path, Value::Null).await).await,
        before
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
}

#[sqlx::test(migrations = false)]
async fn upgrading_pre_receipt_commands_keeps_their_keys_after_cleanup(pool: PgPool) {
    use sqlx::migrate::Migrate;
    let migrations = sqlx::migrate!("../../migrations");
    let mut connection = pool.acquire().await.unwrap();
    connection.ensure_migrations_table().await.unwrap();
    for migration in migrations.iter().filter(|migration| migration.version < 27) {
        connection.apply(migration).await.unwrap();
    }
    drop(connection);
    let app = labos_threejs_api::router(pool.clone(), Default::default());
    let member = member(&app).await;
    let path = entity(&app, &member, "light").await;
    let lab = path.split('/').nth(5).unwrap();
    let entity_id = path.split('/').nth(7).unwrap();
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
    let actor = data(request(&app, &member, "GET", "/api/v1/auth/session", Value::Null).await)
        .await["user"]["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let command = uuid::Uuid::now_v7().to_string();
    // Provision a legacy fixture before the receipt schema exists; assertions use HTTP and production maintenance.
    sqlx::query("INSERT INTO lab.device_commands(id,entity_id,run_id,actor_id,actor_source,request_key,capability,parameters,status,result) VALUES($1::uuid,$2::uuid,$3::uuid,$4::uuid,'member','legacy-key','light.set_power',$5,'failed',$6)").bind(&command).bind(entity_id).bind(run["id"].as_str().unwrap()).bind(actor).bind(json!({"on":true})).bind(json!({"reason":"execution_uncertain"})).execute(&pool).await.unwrap();
    migrations.run(&pool).await.unwrap();
    assert_eq!(
        request(
            &app,
            &member,
            "GET",
            &format!("{path}/commands/{command}"),
            Value::Null
        )
        .await
        .status(),
        StatusCode::OK
    );
    HistoryMaintenance::new(pool, RetentionPolicy::default())
        .cleanup(lab, Utc::now() + chrono::Duration::days(31))
        .await
        .unwrap();
    assert_eq!(
        request(
            &app,
            &member,
            "GET",
            &format!("{path}/commands/{command}"),
            Value::Null
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    let body = json!({"capability":"light.set_power","parameters":{"on":true}});
    assert_eq!(
        request_with_key(
            &app,
            &member,
            "POST",
            &format!("{path}/actions"),
            body,
            "legacy-key"
        )
        .await
        .status(),
        StatusCode::GONE
    );
    let different = json!({"capability":"light.set_power","parameters":{"on":false}});
    assert_eq!(
        request_with_key(
            &app,
            &member,
            "POST",
            &format!("{path}/actions"),
            different,
            "legacy-key"
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn cleanup_and_a_concurrent_retry_cannot_leave_a_key_available_for_new_execution(
    pool: PgPool,
) {
    let clock = Clock::new();
    let runtime = DeviceRuntime::initialize_with_clock(pool.clone(), clock.clone())
        .await
        .unwrap();
    let app = labos_threejs_api::router(pool.clone(), Default::default());
    let member = member(&app).await;
    let path = entity(&app, &member, "centrifuge").await;
    let lab = path.split('/').nth(5).unwrap();
    request(
        &app,
        &member,
        "POST",
        &format!("{path}/program/start"),
        json!({}),
    )
    .await;
    let body = json!({"capability":"centrifuge.start","parameters":{"rpm":6000,"temperature":22,"duration_seconds":6}});
    let key = "cleanup-race-key";
    let command = data(
        request_with_key(
            &app,
            &member,
            "POST",
            &format!("{path}/actions"),
            body.clone(),
            key,
        )
        .await,
    )
    .await;
    runtime.process_next().await.unwrap();
    for seconds in [2, 6, 2] {
        clock.advance(seconds);
        runtime.sample_due().await.unwrap();
    }
    let barrier = tokio::sync::Barrier::new(2);
    let maintenance = HistoryMaintenance::new(pool, RetentionPolicy::default());
    let retry = async {
        barrier.wait().await;
        request_with_key(
            &app,
            &member,
            "POST",
            &format!("{path}/actions"),
            body.clone(),
            key,
        )
        .await
    };
    let cleanup = async {
        barrier.wait().await;
        maintenance
            .cleanup(lab, Utc::now() + chrono::Duration::days(31))
            .await
            .unwrap()
    };
    let (response, _) = tokio::join!(retry, cleanup);
    match response.status() {
        StatusCode::ACCEPTED => assert_eq!(data(response).await["id"], command["id"]),
        StatusCode::GONE => {}
        status => panic!("unexpected retry status: {status}"),
    }
    assert_eq!(
        request_with_key(&app, &member, "POST", &format!("{path}/actions"), body, key)
            .await
            .status(),
        StatusCode::GONE
    );
    assert!(!runtime.process_next().await.unwrap());
    assert_eq!(
        data(request(&app, &member, "GET", &path, Value::Null).await).await["task"],
        Value::Null
    );
}

struct Clock(AtomicI64);
impl Clock {
    fn new() -> Arc<Self> {
        Arc::new(Self(AtomicI64::new(Utc::now().timestamp() - 10)))
    }
    fn advance(&self, seconds: i64) {
        self.0.fetch_add(seconds, Ordering::SeqCst);
    }
}
impl ObservationClock for Clock {
    fn now(&self) -> DateTime<Utc> {
        DateTime::from_timestamp(self.0.load(Ordering::SeqCst), 0).unwrap()
    }
}
struct Member {
    cookie: String,
    csrf: String,
}
async fn data(response: Response) -> Value {
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}
async fn member(app: &Router) -> Member {
    let response = app
        .clone()
        .oneshot(
            Request::post("/api/v1/auth/register")
                .header("origin", "http://127.0.0.1:5173")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"email":"history@example.test","password":"a-long-test-password"})
                        .to_string(),
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
    Member {
        cookie,
        csrf: data(response).await["csrf_token"].as_str().unwrap().into(),
    }
}
async fn request(app: &Router, member: &Member, method: &str, path: &str, body: Value) -> Response {
    request_with_key(
        app,
        member,
        method,
        path,
        body,
        &uuid::Uuid::now_v7().to_string(),
    )
    .await
}
async fn request_with_key(
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
async fn entity(app: &Router, member: &Member, definition: &str) -> String {
    let lab = data(
        request(
            app,
            member,
            "POST",
            "/api/v1/lab/labs",
            json!({"name":"History lab"}),
        )
        .await,
    )
    .await;
    let lab = lab["id"].as_str().unwrap();
    let entity=data(request(app,member,"POST",&format!("/api/v1/lab/labs/{lab}/entities"),json!({"name":"History device","definition_id":definition,"definition_version":"1.0","reality":"simulated","configuration":{},"representation_id":null})).await).await;
    format!(
        "/api/v1/lab/labs/{lab}/entities/{}",
        entity["id"].as_str().unwrap()
    )
}
fn query(path: &str, kind: &str, from: DateTime<Utc>, to: DateTime<Utc>, extra: &str) -> String {
    format!(
        "{path}/history?record_type={kind}&from={}&to={}&{extra}",
        from.to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        to.to_rfc3339_opts(chrono::SecondsFormat::Secs, true)
    )
}

#[sqlx::test(migrations = "../../migrations")]
async fn raw_reports_have_source_and_receive_times_with_bound_pagination(pool: PgPool) {
    let clock = Clock::new();
    let runtime = DeviceRuntime::initialize_with_clock(pool.clone(), clock.clone())
        .await
        .unwrap();
    let app = labos_threejs_api::router(pool, Default::default());
    let member = member(&app).await;
    let path = entity(&app, &member, "sensor").await;
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
    let from = clock.now();
    for sequence in 1..=3 {
        runtime
            .observe(
                run["id"].as_str().unwrap(),
                ObservationReport {
                    sequence,
                    values: json!({"temperature":20+sequence}),
                    observed_at: Some(clock.now() - chrono::Duration::seconds(2)),
                    quality: "good".into(),
                },
            )
            .await
            .unwrap();
        clock.advance(1);
    }
    let url = query(&path, "observation", from, clock.now(), "limit=2");
    let response = request(&app, &member, "GET", &url, Value::Null).await;
    assert_eq!(response.status(), StatusCode::OK);
    let page = data(response).await;
    assert_eq!(page["items"].as_array().unwrap().len(), 2);
    assert_eq!(page["items"][0]["data"]["values"]["temperature"], 23);
    assert_ne!(
        page["items"][0]["observed_at"],
        page["items"][0]["received_at"]
    );
    assert_eq!(
        page["items"][0]["data"]["properties"]["temperature"]["unit"],
        "degC"
    );
    let next = query(
        &path,
        "observation",
        from,
        clock.now(),
        &format!("limit=2&cursor={}", page["next_cursor"].as_str().unwrap()),
    );
    let next = data(request(&app, &member, "GET", &next, Value::Null).await).await;
    assert_eq!(next["items"].as_array().unwrap().len(), 1);
    assert_eq!(next["items"][0]["data"]["values"]["temperature"], 21);
    assert_eq!(next["next_cursor"], Value::Null);
    assert_eq!(
        request(
            &app,
            &member,
            "GET",
            &query(&path, "observation", from, clock.now(), "limit=101"),
            Value::Null
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn cleanup_marks_irrecoverable_gaps_and_preserves_current_properties_and_active_tasks(
    pool: PgPool,
) {
    let clock = Clock::new();
    let runtime = DeviceRuntime::initialize_with_clock(pool.clone(), clock.clone())
        .await
        .unwrap();
    let app = labos_threejs_api::router(pool.clone(), Default::default());
    let member = member(&app).await;
    let path = entity(&app, &member, "centrifuge").await;
    let lab = path.split('/').nth(5).unwrap();
    request(
        &app,
        &member,
        "POST",
        &format!("{path}/program/start"),
        json!({}),
    )
    .await;
    let from = clock.now() - chrono::Duration::seconds(1);
    let first=data(request(&app,&member,"POST",&format!("{path}/actions"),json!({"capability":"centrifuge.start","parameters":{"rpm":6000,"temperature":4,"duration_seconds":6}})).await).await;
    runtime.process_next().await.unwrap();
    for seconds in [9, 6, 2] {
        clock.advance(seconds);
        runtime.sample_due().await.unwrap();
    }
    let completed = data(request(&app, &member, "GET", &path, Value::Null).await).await;
    assert_eq!(completed["task"]["status"], "completed");
    let to = Utc::now() + chrono::Duration::minutes(1);
    for kind in ["command", "task", "event"] {
        let response = request(
            &app,
            &member,
            "GET",
            &query(&path, kind, from, to, "limit=100"),
            Value::Null,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        assert!(!data(response).await["items"].as_array().unwrap().is_empty());
    }
    let active=data(request(&app,&member,"POST",&format!("{path}/actions"),json!({"capability":"centrifuge.start","parameters":{"rpm":6000,"temperature":4,"duration_seconds":3600}})).await).await;
    runtime.process_next().await.unwrap();
    clock.advance(6);
    runtime.expire_due().await.unwrap();
    let before = data(request(&app, &member, "GET", &path, Value::Null).await).await;
    let policy = RetentionPolicy::default();
    assert_eq!(policy.observation_seconds, 86400);
    assert_eq!(policy.record_seconds, 2592000);
    let maintenance = HistoryMaintenance::new(pool.clone(), policy);
    let future = Utc::now() + chrono::Duration::days(31);
    let cleaned = maintenance.cleanup(lab, future).await.unwrap();
    assert!(cleaned.observations > 0);
    assert!(cleaned.tasks > 0);
    assert!(cleaned.events > 0);
    let retained = data(request(&app, &member, "GET", &path, Value::Null).await).await;
    assert_eq!(retained, before);
    assert_eq!(retained["task"]["id"], active["task_id"]);
    assert_eq!(
        retained["observation"]["properties"]["temperature"]["freshness"],
        "stale"
    );
    let page = data(
        request(
            &app,
            &member,
            "GET",
            &query(&path, "observation", from, to, "limit=100"),
            Value::Null,
        )
        .await,
    )
    .await;
    assert!(page["gap"].as_bool().unwrap());
    assert!(page["items"].as_array().unwrap().is_empty());
    let commands = data(
        request(
            &app,
            &member,
            "GET",
            &query(&path, "command", from, to, "limit=100"),
            Value::Null,
        )
        .await,
    )
    .await;
    assert_eq!(commands["items"].as_array().unwrap().len(), 1);
    assert_eq!(commands["items"][0]["data"]["task_id"], active["task_id"]);
    assert_eq!(
        request(
            &app,
            &member,
            "GET",
            &format!("{path}/tasks/{}", first["task_id"].as_str().unwrap()),
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
            "GET",
            &format!("{path}/tasks/{}", active["task_id"].as_str().unwrap()),
            Value::Null
        )
        .await
        .status(),
        StatusCode::OK
    );
    assert_eq!(
        request(
            &app,
            &member,
            "POST",
            &format!("/api/v1/lab/labs/{lab}/history/cleanup"),
            json!({})
        )
        .await
        .status(),
        StatusCode::OK
    );
}
