use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
    response::Response,
};
use chrono::{DateTime, Utc};
use http_body_util::BodyExt;
use labos_threejs_app::modules::lab::{
    DeviceRuntime, ObservationAcceptance, ObservationClock, ObservationReport,
};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};
use tower::ServiceExt;

struct Member {
    cookie: String,
    csrf: String,
}
struct Clock(AtomicI64);
impl Clock {
    fn new() -> Arc<Self> {
        Arc::new(Self(AtomicI64::new(1_791_014_400)))
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
                    json!({"email":"centrifuges@example.test","password":"a-long-test-password"})
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
async fn request(
    app: &Router,
    member: &Member,
    method: &str,
    path: &str,
    key: &str,
    body: Value,
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
async fn centrifuges(app: &Router, member: &Member) -> Vec<String> {
    let lab = data(
        request(
            app,
            member,
            "POST",
            "/api/v1/lab/labs",
            "",
            json!({"name":"Centrifuge lab"}),
        )
        .await,
    )
    .await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut paths = Vec::new();
    for (name, temperature) in [("Centrifuge A", 22), ("Centrifuge B", 15)] {
        let response=request(app,member,"POST",&format!("/api/v1/lab/labs/{lab}/entities"),"",json!({"name":name,"definition_id":"centrifuge","definition_version":"1.0","reality":"simulated","configuration":{"initial_temperature":temperature},"representation_id":null})).await;
        assert_eq!(response.status(), StatusCode::CREATED);
        let entity = data(response).await;
        paths.push(format!(
            "/api/v1/lab/labs/{lab}/entities/{}",
            entity["id"].as_str().unwrap()
        ));
    }
    paths
}
fn parameters() -> Value {
    json!({"rpm":6000,"temperature":4,"duration_seconds":6})
}
async fn start_task(app: &Router, member: &Member, path: &str, key: &str) -> Value {
    let response = request(
        app,
        member,
        "POST",
        &format!("{path}/actions"),
        key,
        json!({"capability":"centrifuge.start","parameters":parameters()}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    data(response).await
}

#[sqlx::test(migrations = "../../migrations")]
async fn start_reserves_one_fixed_task_and_busy_retries_keep_the_same_identity(pool: PgPool) {
    let clock = Clock::new();
    let runtime = DeviceRuntime::initialize_with_clock(pool.clone(), clock)
        .await
        .unwrap();
    let app = labos_threejs_api::router(pool, Default::default());
    let member = member(&app).await;
    let paths = centrifuges(&app, &member).await;
    let run = data(
        request(
            &app,
            &member,
            "POST",
            &format!("{}/program/start", paths[0]),
            "",
            json!({}),
        )
        .await,
    )
    .await;
    let command = start_task(&app, &member, &paths[0], "start-one").await;
    assert_eq!(command["status"], "accepted");
    assert_eq!(command["run_id"], run["id"]);
    assert!(command["task_id"].is_string());
    let task_path = format!(
        "{}/tasks/{}",
        paths[0],
        command["task_id"].as_str().unwrap()
    );
    let task = data(request(&app, &member, "GET", &task_path, "", Value::Null).await).await;
    assert_eq!(task["status"], "pending");
    assert_eq!(task["parameters"], parameters());
    assert!(task["result_id"].is_string());
    assert_eq!(
        start_task(&app, &member, &paths[0], "start-one").await,
        command
    );
    let busy = request(
        &app,
        &member,
        "POST",
        &format!("{}/actions", paths[0]),
        "start-two",
        json!({"capability":"centrifuge.start","parameters":parameters()}),
    )
    .await;
    assert_eq!(busy.status(), StatusCode::CONFLICT);
    assert_eq!(data(busy).await["error"]["code"], "lab.device_busy");
    assert!(runtime.process_next().await.unwrap());
    let task = data(request(&app, &member, "GET", &task_path, "", Value::Null).await).await;
    assert_eq!(task["status"], "preparing");
    assert_eq!(task["elapsed_seconds"], 0.0);
    assert_eq!(
        data(request(&app, &member, "GET", &paths[1], "", Value::Null).await).await["task"],
        Value::Null
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn only_time_at_speed_and_temperature_counts_and_completion_waits_for_idle(pool: PgPool) {
    let clock = Clock::new();
    let runtime = DeviceRuntime::initialize_with_clock(pool.clone(), clock.clone())
        .await
        .unwrap();
    let app = labos_threejs_api::router(pool, Default::default());
    let member = member(&app).await;
    let paths = centrifuges(&app, &member).await;
    data(
        request(
            &app,
            &member,
            "POST",
            &format!("{}/program/start", paths[0]),
            "",
            json!({}),
        )
        .await,
    )
    .await;
    let command = start_task(&app, &member, &paths[0], "timed-start").await;
    runtime.process_next().await.unwrap();
    clock.advance(2);
    runtime.sample_due().await.unwrap();
    let preparing = data(request(&app, &member, "GET", &paths[0], "", Value::Null).await).await;
    assert_eq!(preparing["observation"]["values"]["speed"], 6000.0);
    assert_eq!(preparing["observation"]["values"]["temperature"], 18.0);
    assert_eq!(preparing["task"]["elapsed_seconds"], 0.0);
    assert_eq!(preparing["task"]["status"], "preparing");
    data(
        request(
            &app,
            &member,
            "PATCH",
            &paths[0],
            "",
            json!({"name":"Centrifuge A","configuration":{"initial_temperature":30,"rpm":1000}}),
        )
        .await,
    )
    .await;
    clock.advance(7);
    runtime.sample_due().await.unwrap();
    let ready = data(request(&app, &member, "GET", &paths[0], "", Value::Null).await).await;
    assert_eq!(ready["task"]["parameters"], parameters());
    assert_eq!(ready["task"]["status"], "running");
    assert_eq!(ready["task"]["elapsed_seconds"], 0.0);
    assert_eq!(ready["task"]["timer_started_at"], json!(clock.now()));
    clock.advance(5);
    runtime.sample_due().await.unwrap();
    let running = data(request(&app, &member, "GET", &paths[0], "", Value::Null).await).await;
    assert_eq!(running["task"]["elapsed_seconds"], 5.0);
    assert_eq!(running["task_result"]["status"], "pending");
    clock.advance(1);
    runtime.sample_due().await.unwrap();
    let slowing = data(request(&app, &member, "GET", &paths[0], "", Value::Null).await).await;
    assert_eq!(slowing["task"]["status"], "decelerating");
    assert_eq!(slowing["observation"]["values"]["speed"], 6000.0);
    assert_eq!(slowing["task_result"]["status"], "pending");
    clock.advance(2);
    runtime.sample_due().await.unwrap();
    let finished = data(request(&app, &member, "GET", &paths[0], "", Value::Null).await).await;
    assert_eq!(finished["task"]["status"], "completed");
    assert_eq!(finished["task"]["id"], command["task_id"]);
    assert_eq!(finished["task"]["elapsed_seconds"], 6.0);
    assert_eq!(finished["observation"]["values"]["phase"], "idle");
    assert_eq!(finished["observation"]["values"]["speed"], 0.0);
    assert_eq!(finished["task_result"]["status"], "completed");
    assert_eq!(
        finished["observation"]["properties"]["speed"]["unit"],
        "rpm"
    );
    let result = data(
        request(
            &app,
            &member,
            "GET",
            &format!(
                "{}/results/{}",
                paths[0],
                finished["task"]["result_id"].as_str().unwrap()
            ),
            "",
            Value::Null,
        )
        .await,
    )
    .await;
    assert_eq!(result, finished["task_result"]);
}

#[sqlx::test(migrations = "../../migrations")]
async fn stop_decelerates_to_cancelled_without_affecting_the_other_instance(pool: PgPool) {
    let clock = Clock::new();
    let runtime = DeviceRuntime::initialize_with_clock(pool.clone(), clock.clone())
        .await
        .unwrap();
    let app = labos_threejs_api::router(pool, Default::default());
    let member = member(&app).await;
    let paths = centrifuges(&app, &member).await;
    for path in &paths {
        data(
            request(
                &app,
                &member,
                "POST",
                &format!("{path}/program/start"),
                "",
                json!({}),
            )
            .await,
        )
        .await;
        start_task(&app, &member, path, "independent-start").await;
        runtime.process_next().await.unwrap();
    }
    clock.advance(9);
    runtime.sample_due().await.unwrap();
    let busy = request(
        &app,
        &member,
        "POST",
        &format!("{}/program/stop", paths[0]),
        "",
        json!({}),
    )
    .await;
    assert_eq!(busy.status(), StatusCode::CONFLICT);
    let stop = request(
        &app,
        &member,
        "POST",
        &format!("{}/actions", paths[0]),
        "stop-one",
        json!({"capability":"centrifuge.stop","parameters":{}}),
    )
    .await;
    assert_eq!(stop.status(), StatusCode::ACCEPTED);
    let stop = data(stop).await;
    runtime.process_next().await.unwrap();
    let slowing = data(request(&app, &member, "GET", &paths[0], "", Value::Null).await).await;
    assert_eq!(slowing["task"]["status"], "decelerating");
    assert_eq!(slowing["task_result"]["status"], "pending");
    assert_eq!(stop["task_id"], slowing["task"]["id"]);
    clock.advance(1);
    runtime.sample_due().await.unwrap();
    let middle = data(request(&app, &member, "GET", &paths[0], "", Value::Null).await).await;
    assert_eq!(middle["observation"]["values"]["speed"], 3000.0);
    assert_eq!(middle["task_result"]["status"], "pending");
    clock.advance(1);
    runtime.sample_due().await.unwrap();
    let cancelled = data(request(&app, &member, "GET", &paths[0], "", Value::Null).await).await;
    assert_eq!(cancelled["task"]["status"], "cancelled");
    assert_eq!(cancelled["task"]["elapsed_seconds"], 0.0);
    assert_eq!(cancelled["task_result"]["status"], "cancelled");
    assert_eq!(cancelled["observation"]["values"]["phase"], "idle");
    let other = data(request(&app, &member, "GET", &paths[1], "", Value::Null).await).await;
    assert_eq!(other["task"]["status"], "running");
    assert_eq!(other["task"]["elapsed_seconds"], 2.0);
    assert_ne!(other["binding"]["id"], cancelled["binding"]["id"]);
}

#[sqlx::test(migrations = "../../migrations")]
async fn fault_or_uncertain_report_can_never_produce_a_completed_task(pool: PgPool) {
    let clock = Clock::new();
    let runtime = DeviceRuntime::initialize_with_clock(pool.clone(), clock.clone())
        .await
        .unwrap();
    let app = labos_threejs_api::router(pool, Default::default());
    let member = member(&app).await;
    let paths = centrifuges(&app, &member).await;
    for (path, quality, outcome) in [
        (&paths[0], "bad", "failed"),
        (&paths[1], "uncertain", "unknown"),
    ] {
        let run = data(
            request(
                &app,
                &member,
                "POST",
                &format!("{path}/program/start"),
                "",
                json!({}),
            )
            .await,
        )
        .await;
        start_task(&app, &member, path, "fault-start").await;
        runtime.process_next().await.unwrap();
        clock.advance(9);
        runtime.sample_due().await.unwrap();
        let entity = data(request(&app, &member, "GET", path, "", Value::Null).await).await;
        assert_eq!(
            runtime
                .observation_sink()
                .report(
                    entity["binding"]["id"].as_str().unwrap(),
                    run["id"].as_str().unwrap(),
                    ObservationReport {
                        sequence: entity["observation"]["sequence"].as_i64().unwrap() + 1,
                        values: json!({"speed":6000.0,"temperature":4.0}),
                        observed_at: Some(clock.now()),
                        quality: quality.into()
                    }
                )
                .await
                .unwrap(),
            ObservationAcceptance::Applied
        );
        clock.advance(2);
        runtime.sample_due().await.unwrap();
        let failed = data(request(&app, &member, "GET", path, "", Value::Null).await).await;
        assert_eq!(failed["task"]["status"], outcome);
        assert_eq!(failed["task_result"]["status"], outcome);
        assert_eq!(failed["observation"]["values"]["phase"], "idle");
        assert_ne!(failed["task_result"]["reason"], Value::Null);
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn new_generation_retains_interrupted_task_and_rejects_the_retired_source(pool: PgPool) {
    let clock = Clock::new();
    let runtime = DeviceRuntime::initialize_with_clock(pool.clone(), clock.clone())
        .await
        .unwrap();
    let app = labos_threejs_api::router(pool.clone(), Default::default());
    let member = member(&app).await;
    let paths = centrifuges(&app, &member).await;
    let old_run = data(
        request(
            &app,
            &member,
            "POST",
            &format!("{}/program/start", paths[0]),
            "",
            json!({}),
        )
        .await,
    )
    .await;
    let command = start_task(&app, &member, &paths[0], "interrupted-start").await;
    runtime.process_next().await.unwrap();
    clock.advance(3);
    runtime.sample_due().await.unwrap();
    let before = data(request(&app, &member, "GET", &paths[0], "", Value::Null).await).await;
    let restarted = DeviceRuntime::initialize_with_clock(pool, clock.clone())
        .await
        .unwrap();
    let interrupted = data(request(&app, &member, "GET", &paths[0], "", Value::Null).await).await;
    assert_eq!(interrupted["program_run"]["id"], old_run["id"]);
    assert_eq!(interrupted["program_run"]["status"], "interrupted");
    assert_eq!(interrupted["task"]["id"], command["task_id"]);
    assert_eq!(interrupted["task"]["status"], "interrupted");
    assert_eq!(interrupted["task"]["parameters"], parameters());
    assert_eq!(interrupted["task_result"]["status"], "interrupted");
    assert_eq!(
        interrupted["observation"]["values"],
        before["observation"]["values"]
    );
    assert_eq!(restarted.sample_due().await.unwrap(), 0);
    let new_run = data(
        request(
            &app,
            &member,
            "POST",
            &format!("{}/program/start", paths[0]),
            "",
            json!({}),
        )
        .await,
    )
    .await;
    assert_ne!(new_run["id"], old_run["id"]);
    assert_eq!(
        runtime
            .observation_sink()
            .report(
                before["binding"]["id"].as_str().unwrap(),
                old_run["id"].as_str().unwrap(),
                ObservationReport {
                    sequence: 999,
                    values: json!({"speed":15000.0}),
                    observed_at: Some(clock.now()),
                    quality: "good".into()
                }
            )
            .await
            .unwrap(),
        ObservationAcceptance::StaleRun
    );
    restarted.sample_due().await.unwrap();
    let current = data(request(&app, &member, "GET", &paths[0], "", Value::Null).await).await;
    assert_eq!(current["observation"]["values"]["speed"], 0.0);
    assert_eq!(current["task_result"]["status"], "interrupted");
    let old = data(
        request(
            &app,
            &member,
            "GET",
            &format!("{}/runs/{}", paths[0], old_run["id"].as_str().unwrap()),
            "",
            Value::Null,
        )
        .await,
    )
    .await;
    assert_eq!(old["status"], "interrupted");
}

#[sqlx::test(migrations = "../../migrations")]
async fn stop_preserves_counted_time_between_samples_and_cancels_before_idle(pool: PgPool) {
    let clock = Clock::new();
    let runtime = DeviceRuntime::initialize_with_clock(pool.clone(), clock.clone())
        .await
        .unwrap();
    let app = labos_threejs_api::router(pool, Default::default());
    let member = member(&app).await;
    let paths = centrifuges(&app, &member).await;
    data(
        request(
            &app,
            &member,
            "POST",
            &format!("{}/program/start", paths[0]),
            "",
            json!({}),
        )
        .await,
    )
    .await;
    start_task(&app, &member, &paths[0], "stop-between-samples").await;
    runtime.process_next().await.unwrap();
    clock.advance(9);
    runtime.sample_due().await.unwrap();
    clock.advance(3);
    request(
        &app,
        &member,
        "POST",
        &format!("{}/actions", paths[0]),
        "stop-between",
        json!({"capability":"centrifuge.stop","parameters":{}}),
    )
    .await;
    runtime.process_next().await.unwrap();
    clock.advance(2);
    runtime.sample_due().await.unwrap();
    let cancelled = data(request(&app, &member, "GET", &paths[0], "", Value::Null).await).await;
    assert_eq!(cancelled["task"]["status"], "cancelled");
    assert_eq!(cancelled["task"]["elapsed_seconds"], 3.0);
    start_task(&app, &member, &paths[0], "stop-in-deceleration").await;
    runtime.process_next().await.unwrap();
    clock.advance(2);
    runtime.sample_due().await.unwrap();
    clock.advance(6);
    runtime.sample_due().await.unwrap();
    let slowing = data(request(&app, &member, "GET", &paths[0], "", Value::Null).await).await;
    assert_eq!(slowing["task"]["status"], "decelerating");
    request(
        &app,
        &member,
        "POST",
        &format!("{}/actions", paths[0]),
        "cancel-deceleration",
        json!({"capability":"centrifuge.stop","parameters":{}}),
    )
    .await;
    runtime.process_next().await.unwrap();
    clock.advance(2);
    runtime.sample_due().await.unwrap();
    let cancelled = data(request(&app, &member, "GET", &paths[0], "", Value::Null).await).await;
    assert_eq!(cancelled["task_result"]["status"], "cancelled");
}

#[sqlx::test(migrations = "../../migrations")]
async fn a_rejected_execution_report_keeps_command_and_task_results_uncertain(pool: PgPool) {
    let clock = Clock::new();
    let runtime = DeviceRuntime::initialize_with_clock(pool.clone(), clock.clone())
        .await
        .unwrap();
    let app = labos_threejs_api::router(pool, Default::default());
    let member = member(&app).await;
    let paths = centrifuges(&app, &member).await;
    let run = data(
        request(
            &app,
            &member,
            "POST",
            &format!("{}/program/start", paths[0]),
            "",
            json!({}),
        )
        .await,
    )
    .await;
    let command = start_task(&app, &member, &paths[0], "uncertain-execution").await;
    assert_eq!(
        runtime
            .observe(
                run["id"].as_str().unwrap(),
                ObservationReport {
                    sequence: 1,
                    values: json!({"speed":0,"temperature":22,"phase":"idle"}),
                    observed_at: Some(clock.now() + chrono::Duration::seconds(1)),
                    quality: "good".into()
                }
            )
            .await
            .unwrap(),
        ObservationAcceptance::Applied
    );
    assert!(runtime.process_next().await.is_err());
    let command = data(
        request(
            &app,
            &member,
            "GET",
            &format!("{}/commands/{}", paths[0], command["id"].as_str().unwrap()),
            "",
            Value::Null,
        )
        .await,
    )
    .await;
    assert_eq!(command["status"], "unknown");
    clock.advance(2);
    runtime.sample_due().await.unwrap();
    let entity = data(request(&app, &member, "GET", &paths[0], "", Value::Null).await).await;
    assert_eq!(entity["task_result"]["status"], "unknown");
    assert_eq!(entity["task_result"]["reason"], "execution_uncertain");
    assert_eq!(entity["observation"]["values"]["phase"], "idle");
    assert!(!runtime.process_next().await.unwrap());
}

#[sqlx::test(migrations = "../../migrations")]
async fn task_record_queries_reject_invalid_path_identities_without_changing_the_task(
    pool: PgPool,
) {
    let runtime = DeviceRuntime::initialize(pool.clone()).await.unwrap();
    let app = labos_threejs_api::router(pool, Default::default());
    let member = member(&app).await;
    let paths = centrifuges(&app, &member).await;
    let run = data(
        request(
            &app,
            &member,
            "POST",
            &format!("{}/program/start", paths[0]),
            "",
            json!({}),
        )
        .await,
    )
    .await;
    let command = start_task(&app, &member, &paths[0], "invalid-query").await;
    runtime.process_next().await.unwrap();
    let entity = data(request(&app, &member, "GET", &paths[0], "", Value::Null).await).await;
    for suffix in [
        format!("tasks/{}", command["task_id"].as_str().unwrap()),
        format!("results/{}", entity["task_result"]["id"].as_str().unwrap()),
        format!("runs/{}", run["id"].as_str().unwrap()),
    ] {
        for path in [
            format!(
                "/api/v1/lab/labs/invalid/entities/{}/{suffix}",
                entity["id"].as_str().unwrap()
            ),
            format!(
                "/api/v1/lab/labs/{}/entities/invalid/{suffix}",
                entity["lab_id"].as_str().unwrap()
            ),
        ] {
            let response = request(&app, &member, "GET", &path, "", Value::Null).await;
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        }
    }
    assert_eq!(
        data(request(&app, &member, "GET", &paths[0], "", Value::Null).await).await["task"],
        entity["task"]
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn repeated_stop_commands_cannot_discard_deceleration_progress(pool: PgPool) {
    let clock = Clock::new();
    let runtime = DeviceRuntime::initialize_with_clock(pool.clone(), clock.clone())
        .await
        .unwrap();
    let app = labos_threejs_api::router(pool, Default::default());
    let member = member(&app).await;
    let paths = centrifuges(&app, &member).await;
    data(
        request(
            &app,
            &member,
            "POST",
            &format!("{}/program/start", paths[0]),
            "",
            json!({}),
        )
        .await,
    )
    .await;
    start_task(&app, &member, &paths[0], "repeated-stop-start").await;
    runtime.process_next().await.unwrap();
    clock.advance(9);
    runtime.sample_due().await.unwrap();
    request(
        &app,
        &member,
        "POST",
        &format!("{}/actions", paths[0]),
        "stop-1",
        json!({"capability":"centrifuge.stop","parameters":{}}),
    )
    .await;
    runtime.process_next().await.unwrap();
    clock.advance(1);
    request(
        &app,
        &member,
        "POST",
        &format!("{}/actions", paths[0]),
        "stop-2",
        json!({"capability":"centrifuge.stop","parameters":{}}),
    )
    .await;
    runtime.process_next().await.unwrap();
    let stopped = data(request(&app, &member, "GET", &paths[0], "", Value::Null).await).await;
    assert_eq!(
        stopped["observation"]["properties"]["speed"]["observed_at"],
        json!(clock.now() - chrono::Duration::seconds(1))
    );
    runtime.sample_due().await.unwrap();
    let middle = data(request(&app, &member, "GET", &paths[0], "", Value::Null).await).await;
    assert_eq!(middle["observation"]["values"]["speed"], 3000.0);
    clock.advance(1);
    assert_eq!(
        runtime
            .observe(
                middle["program_run"]["id"].as_str().unwrap(),
                ObservationReport {
                    sequence: middle["observation"]["sequence"].as_i64().unwrap() + 1,
                    values: json!({"temperature":4}),
                    observed_at: Some(clock.now()),
                    quality: "bad".into()
                }
            )
            .await
            .unwrap(),
        ObservationAcceptance::Applied
    );
    runtime.sample_due().await.unwrap();
    let failed = data(request(&app, &member, "GET", &paths[0], "", Value::Null).await).await;
    assert_eq!(failed["task_result"]["status"], "failed");
    assert_eq!(failed["observation"]["values"]["speed"], 0.0);
    assert_eq!(failed["observation"]["values"]["phase"], "idle");
}
