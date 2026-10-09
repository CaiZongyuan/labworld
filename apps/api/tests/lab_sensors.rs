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
fn report(sequence: i64, values: Value, observed_at: Option<DateTime<Utc>>) -> ObservationReport {
    ObservationReport {
        sequence,
        values,
        observed_at,
        quality: "uncertain".into(),
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn heartbeat_and_duplicates_do_not_refresh_measurements_and_expiry_is_versioned(
    pool: PgPool,
) {
    let clock = Clock::new();
    let runtime = DeviceRuntime::initialize_with_clock(pool.clone(), clock.clone())
        .await
        .unwrap();
    let app = labos_threejs_api::router(pool, Default::default());
    let member = member(&app).await;
    let (lab, entities) = sensors(&app, &member).await;
    let run = start(&app, &member, &entities[0]).await;
    let binding = entities[0]["binding"]["id"].as_str().unwrap();
    let run = run["id"].as_str().unwrap();
    let sink = runtime.observation_sink();
    assert_eq!(
        sink.report(binding, run, report(1, json!({"temperature":21.5}), None))
            .await
            .unwrap(),
        ObservationAcceptance::Applied
    );
    let first = data(request(&app, &member, "GET", &path(&entities[0]), Value::Null).await).await;
    let property = &first["observation"]["properties"]["temperature"];
    assert_eq!(property["observed_at"], Value::Null);
    assert_eq!(property["received_at"], json!(clock.now()));
    assert_eq!(property["freshness"], "source_time_unknown");
    assert_eq!(property["quality"], "uncertain");
    clock.advance(4);
    assert_eq!(
        sink.report(
            binding,
            run,
            report(
                2,
                json!({}),
                Some(clock.now() + chrono::Duration::seconds(100))
            )
        )
        .await
        .unwrap(),
        ObservationAcceptance::Applied
    );
    assert_eq!(
        sink.report(
            binding,
            run,
            report(1, json!({"temperature":99}), Some(clock.now()))
        )
        .await
        .unwrap(),
        ObservationAcceptance::OutOfOrder
    );
    assert_eq!(
        data(request(&app, &member, "GET", &path(&entities[0]), Value::Null).await).await["observation"],
        first["observation"]
    );
    assert_eq!(runtime.expire_due().await.unwrap(), 0);
    let world_path = format!("/api/v1/lab/labs/{lab}/world");
    let before = data(request(&app, &member, "GET", &world_path, Value::Null).await).await;
    clock.advance(1);
    assert_eq!(runtime.expire_due().await.unwrap(), 1);
    let expired = data(request(&app, &member, "GET", &world_path, Value::Null).await).await;
    assert!(
        expired["version"].as_str().unwrap().parse::<u64>().unwrap()
            > before["version"].as_str().unwrap().parse().unwrap()
    );
    assert_eq!(
        expired["lab"]["layout_version"],
        before["lab"]["layout_version"]
    );
    let expired = &expired["entities"][0]["observation"];
    assert_eq!(expired["properties"]["temperature"]["freshness"], "stale");
    assert_eq!(expired["values"], first["observation"]["values"]);
    assert_eq!(expired["received_at"], first["observation"]["received_at"]);
    assert_eq!(expired["observed_at"], Value::Null);
    assert_eq!(runtime.expire_due().await.unwrap(), 0);
    let fixed = data(request(&app, &member, "GET", &world_path, Value::Null).await).await;
    clock.advance(1);
    assert_eq!(runtime.expire_due().await.unwrap(), 0);
    assert_eq!(
        data(request(&app, &member, "GET", &world_path, Value::Null).await).await,
        fixed
    );
    assert_eq!(
        sink.report(
            binding,
            run,
            report(
                3,
                json!({"temperature":22}),
                Some(clock.now() - chrono::Duration::seconds(5))
            )
        )
        .await
        .unwrap(),
        ObservationAcceptance::Applied
    );
    let recovered =
        data(request(&app, &member, "GET", &path(&entities[0]), Value::Null).await).await;
    let property = &recovered["observation"]["properties"]["temperature"];
    assert_eq!(property["value"], 22);
    assert_eq!(property["freshness"], "current");
    assert_ne!(property["observed_at"], property["received_at"]);
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
                    json!({"email":"sensors@example.test","password":"a-long-test-password"})
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
    app.clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("origin", "http://127.0.0.1:5173")
                .header("content-type", "application/json")
                .header("cookie", &member.cookie)
                .header("x-csrf-token", &member.csrf)
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap()
}
async fn sensors(app: &Router, member: &Member) -> (String, Vec<Value>) {
    let lab = data(
        request(
            app,
            member,
            "POST",
            "/api/v1/lab/labs",
            json!({"name":"Temperature lab"}),
        )
        .await,
    )
    .await["id"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut entities = Vec::new();
    for (name, baseline) in [("Sensor A", 20), ("Sensor B", 25)] {
        let response=request(app,member,"POST",&format!("/api/v1/lab/labs/{lab}/entities"),json!({"name":name,"definition_id":"sensor","definition_version":"1.0","reality":"simulated","configuration":{"baseline_temperature":baseline},"representation_id":null})).await;
        assert_eq!(response.status(), StatusCode::CREATED);
        entities.push(data(response).await);
    }
    (lab, entities)
}
fn path(entity: &Value) -> String {
    format!(
        "/api/v1/lab/labs/{}/entities/{}",
        entity["lab_id"].as_str().unwrap(),
        entity["id"].as_str().unwrap()
    )
}
async fn start(app: &Router, member: &Member, entity: &Value) -> Value {
    let response = request(
        app,
        member,
        "POST",
        &format!("{}/program/start", path(entity)),
        json!({}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    data(response).await
}

#[sqlx::test(migrations = "../../migrations")]
async fn two_backend_temperature_sources_sample_independently(pool: PgPool) {
    let clock = Clock::new();
    let runtime = DeviceRuntime::initialize_with_clock(pool.clone(), clock.clone())
        .await
        .unwrap();
    let app = labos_threejs_api::router(pool, Default::default());
    let member = member(&app).await;
    let (_, entities) = sensors(&app, &member).await;
    for entity in &entities {
        assert_eq!(entity["observation"], Value::Null);
        assert_eq!(entity["binding"]["program_id"], "sensor.v1");
        start(&app, &member, entity).await;
    }
    assert_eq!(runtime.sample_due().await.unwrap(), 2);
    let mut measurements = Vec::new();
    for entity in &entities {
        let current = data(request(&app, &member, "GET", &path(entity), Value::Null).await).await;
        let measurement = &current["observation"]["properties"]["temperature"];
        assert_eq!(measurement["unit"], "degC");
        assert_eq!(measurement["quality"], "good");
        assert_eq!(measurement["freshness"], "current");
        assert_eq!(measurement["source"], entity["binding"]["source"]);
        assert_eq!(measurement["binding_id"], entity["binding"]["id"]);
        assert!(measurement["observed_at"].is_string());
        assert!(measurement["received_at"].is_string());
        assert_eq!(
            current["observation"]["values"]["temperature"],
            measurement["value"]
        );
        measurements.push(measurement.clone());
    }
    assert_ne!(measurements[0]["value"], measurements[1]["value"]);
    assert_ne!(measurements[0]["run_id"], measurements[1]["run_id"]);
    assert_eq!(runtime.sample_due().await.unwrap(), 0);
    clock.advance(1);
    assert_eq!(runtime.sample_due().await.unwrap(), 2);
    for (entity, measurement) in entities.iter().zip(measurements) {
        let current = data(request(&app, &member, "GET", &path(entity), Value::Null).await).await;
        assert_eq!(current["observation"]["sequence"], 2);
        assert_ne!(
            current["observation"]["properties"]["temperature"]["value"],
            measurement["value"]
        );
        assert_ne!(
            current["observation"]["received_at"],
            measurement["received_at"]
        );
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn stopping_retains_values_and_recovery_rejects_retired_sources(pool: PgPool) {
    let clock = Clock::new();
    let runtime = DeviceRuntime::initialize_with_clock(pool.clone(), clock.clone())
        .await
        .unwrap();
    let app = labos_threejs_api::router(pool.clone(), Default::default());
    let member = member(&app).await;
    let (_, entities) = sensors(&app, &member).await;
    let old = start(&app, &member, &entities[0]).await;
    runtime.sample_due().await.unwrap();
    let before = data(request(&app, &member, "GET", &path(&entities[0]), Value::Null).await).await;
    let binding = entities[0]["binding"]["id"].as_str().unwrap();
    let stopped = request(
        &app,
        &member,
        "POST",
        &format!("{}/program/stop", path(&entities[0])),
        json!({}),
    )
    .await;
    assert_eq!(stopped.status(), StatusCode::OK);
    clock.advance(5);
    assert_eq!(runtime.sample_due().await.unwrap(), 0);
    assert_eq!(runtime.expire_due().await.unwrap(), 1);
    let retained =
        data(request(&app, &member, "GET", &path(&entities[0]), Value::Null).await).await;
    assert_eq!(
        retained["observation"]["values"],
        before["observation"]["values"]
    );
    assert_eq!(
        retained["observation"]["properties"]["temperature"]["freshness"],
        "stale"
    );
    let current = start(&app, &member, &entities[0]).await;
    assert_ne!(current["id"], old["id"]);
    assert_eq!(
        data(request(&app, &member, "GET", &path(&entities[0]), Value::Null).await).await["observation"],
        retained["observation"]
    );
    assert_eq!(runtime.sample_due().await.unwrap(), 1);
    let recovered =
        data(request(&app, &member, "GET", &path(&entities[0]), Value::Null).await).await;
    assert_eq!(recovered["observation"]["run_id"], current["id"]);
    assert_eq!(recovered["observation"]["sequence"], 1);
    assert_eq!(
        recovered["observation"]["properties"]["temperature"]["freshness"],
        "current"
    );
    let sink = runtime.observation_sink();
    assert_eq!(
        sink.report(
            binding,
            old["id"].as_str().unwrap(),
            report(999, json!({"temperature":99}), Some(clock.now()))
        )
        .await
        .unwrap(),
        ObservationAcceptance::StaleRun
    );
    assert_eq!(
        sink.report(
            entities[1]["binding"]["id"].as_str().unwrap(),
            current["id"].as_str().unwrap(),
            report(999, json!({"temperature":99}), Some(clock.now()))
        )
        .await
        .unwrap(),
        ObservationAcceptance::StaleRun
    );
    assert_eq!(
        data(request(&app, &member, "GET", &path(&entities[0]), Value::Null).await).await["observation"],
        recovered["observation"]
    );
    let replacement = DeviceRuntime::initialize_with_clock(pool, clock.clone())
        .await
        .unwrap();
    let interrupted =
        data(request(&app, &member, "GET", &path(&entities[0]), Value::Null).await).await;
    assert_eq!(interrupted["program_run"]["status"], "interrupted");
    assert_eq!(
        interrupted["observation"]["values"],
        recovered["observation"]["values"]
    );
    assert_eq!(
        sink.report(
            binding,
            current["id"].as_str().unwrap(),
            report(999, json!({"temperature":99}), Some(clock.now()))
        )
        .await
        .unwrap(),
        ObservationAcceptance::StaleRun
    );
    assert_eq!(replacement.sample_due().await.unwrap(), 0);
    let new = start(&app, &member, &entities[0]).await;
    replacement.sample_due().await.unwrap();
    assert_eq!(
        data(request(&app, &member, "GET", &path(&entities[0]), Value::Null).await).await["observation"]
            ["run_id"],
        new["id"]
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn members_and_agents_read_the_same_measurement_and_cannot_overwrite_it(pool: PgPool) {
    let runtime = DeviceRuntime::initialize(pool.clone()).await.unwrap();
    let app = labos_threejs_api::router(pool, Default::default());
    let member = member(&app).await;
    let (_, entities) = sensors(&app, &member).await;
    start(&app, &member, &entities[0]).await;
    runtime.sample_due().await.unwrap();
    let before = data(request(&app, &member, "GET", &path(&entities[0]), Value::Null).await).await;
    let key = request(
        &app,
        &member,
        "POST",
        "/api/v1/api-keys",
        json!({"name":"Sensor Agent","scopes":["lab:full"],"expires_in_days":1}),
    )
    .await;
    assert_eq!(key.status(), StatusCode::CREATED);
    let secret = data(key).await["secret"].as_str().unwrap().to_owned();
    let agent = |method: &str, body: Value| {
        Request::builder()
            .method(method)
            .uri(path(&entities[0]))
            .header("authorization", format!("Bearer {secret}"))
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .unwrap()
    };
    assert_eq!(
        data(
            app.clone()
                .oneshot(agent("GET", Value::Null))
                .await
                .unwrap()
        )
        .await,
        before
    );
    let invalid =
        json!({"name":"Sensor A","configuration":{},"observation":{"values":{"temperature":99}}});
    let member_rejection =
        request(&app, &member, "PATCH", &path(&entities[0]), invalid.clone()).await;
    let agent_rejection = app.clone().oneshot(agent("PATCH", invalid)).await.unwrap();
    assert_eq!(member_rejection.status(), StatusCode::BAD_REQUEST);
    assert_eq!(agent_rejection.status(), member_rejection.status());
    assert_eq!(
        data(agent_rejection).await["error"]["code"],
        data(member_rejection).await["error"]["code"]
    );
    assert_eq!(
        data(request(&app, &member, "GET", &path(&entities[0]), Value::Null).await).await,
        before
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn partial_reports_preserve_other_properties_and_order_each_property(pool: PgPool) {
    let clock = Clock::new();
    let runtime = DeviceRuntime::initialize_with_clock(pool.clone(), clock.clone())
        .await
        .unwrap();
    let app = labos_threejs_api::router(pool, Default::default());
    let member = member(&app).await;
    let (lab, _) = sensors(&app, &member).await;
    let entity=data(request(&app,&member,"POST",&format!("/api/v1/lab/labs/{lab}/entities"),json!({"name":"Partial light","definition_id":"light","definition_version":"1.0","reality":"simulated","configuration":{},"representation_id":null})).await).await;
    let run = start(&app, &member, &entity).await;
    let run = run["id"].as_str().unwrap();
    let report = |sequence, values, time: &str| ObservationReport {
        sequence,
        values,
        observed_at: Some(time.parse().unwrap()),
        quality: "good".into(),
    };
    assert_eq!(
        runtime
            .observe(
                run,
                report(
                    1,
                    json!({"on":true,"brightness":60}),
                    "2026-10-03T06:00:00Z"
                )
            )
            .await
            .unwrap(),
        ObservationAcceptance::Applied
    );
    let before = data(request(&app, &member, "GET", &path(&entity), Value::Null).await).await;
    clock.advance(4);
    assert_eq!(
        runtime
            .observe(
                run,
                report(2, json!({"brightness":70}), "2026-10-03T06:00:10Z")
            )
            .await
            .unwrap(),
        ObservationAcceptance::Applied
    );
    let partial = data(request(&app, &member, "GET", &path(&entity), Value::Null).await).await;
    assert_eq!(
        partial["observation"]["values"],
        json!({"on":true,"brightness":70})
    );
    assert_eq!(
        partial["observation"]["properties"]["on"],
        before["observation"]["properties"]["on"]
    );
    clock.advance(1);
    assert_eq!(runtime.expire_due().await.unwrap(), 1);
    let aged = data(request(&app, &member, "GET", &path(&entity), Value::Null).await).await;
    assert_eq!(
        aged["observation"]["properties"]["on"]["freshness"],
        "stale"
    );
    assert_eq!(
        aged["observation"]["properties"]["brightness"]["freshness"],
        "current"
    );
    assert_eq!(
        runtime
            .observe(run, report(3, json!({"on":false}), "2026-10-03T06:00:01Z"))
            .await
            .unwrap(),
        ObservationAcceptance::Applied
    );
    let updated = data(request(&app, &member, "GET", &path(&entity), Value::Null).await).await;
    assert_eq!(
        updated["observation"]["values"],
        json!({"on":false,"brightness":70})
    );
    assert_eq!(
        updated["observation"]["properties"]["brightness"],
        partial["observation"]["properties"]["brightness"]
    );
    assert_eq!(
        runtime
            .observe(
                run,
                report(4, json!({"brightness":10}), "2026-10-03T06:00:09Z")
            )
            .await
            .unwrap(),
        ObservationAcceptance::OutOfOrder
    );
    assert_eq!(
        data(request(&app, &member, "GET", &path(&entity), Value::Null).await).await["observation"],
        updated["observation"]
    );
}
