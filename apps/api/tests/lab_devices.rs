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
    cookie: String,
    csrf: String,
}
async fn data(response: Response) -> Value {
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}
async fn register(app: &Router) -> Browser {
    let response = app
        .clone()
        .oneshot(
            Request::post("/api/v1/auth/register")
                .header("origin", "http://127.0.0.1:5173")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"email":"lights@example.test","password":"a-long-test-password"})
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
    let value = data(response).await;
    Browser {
        cookie,
        csrf: value["csrf_token"].as_str().unwrap().into(),
    }
}
async fn request(
    app: &Router,
    actor: &Browser,
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
                .header("cookie", &actor.cookie)
                .header("x-csrf-token", &actor.csrf)
                .header("idempotency-key", key)
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap()
}
async fn lights(app: &Router, actor: &Browser) -> (String, Vec<String>) {
    let lab = data(
        request(
            app,
            actor,
            "POST",
            "/api/v1/lab/labs",
            "",
            json!({"name":"Lighting lab"}),
        )
        .await,
    )
    .await;
    let lab = lab["id"].as_str().unwrap().to_owned();
    let mut entities = Vec::new();
    for (name, brightness) in [("Light A", 70), ("Light B", 20)] {
        let response = request(app, actor, "POST", &format!("/api/v1/lab/labs/{lab}/entities"), "", json!({"name":name,"definition_id":"light","definition_version":"1.0","reality":"simulated","configuration":{"brightness":brightness},"representation_id":null})).await;
        assert_eq!(response.status(), StatusCode::CREATED);
        entities.push(data(response).await["id"].as_str().unwrap().to_owned());
    }
    (lab, entities)
}
fn entity(lab: &str, entity: &str) -> String {
    format!("/api/v1/lab/labs/{lab}/entities/{entity}")
}

#[sqlx::test(migrations = "../../migrations")]
async fn layout_saves_preserve_running_devices_and_observations_do_not_conflict_with_the_draft(
    pool: PgPool,
) {
    let runtime = labos_threejs_app::modules::lab::DeviceRuntime::initialize(pool.clone())
        .await
        .unwrap();
    let app = labos_threejs_api::router(pool, Default::default());
    let actor = register(&app).await;
    let (lab, ids) = lights(&app, &actor).await;
    let path = entity(&lab, &ids[0]);
    let world_path = format!("/api/v1/lab/labs/{lab}/world");
    let draft = data(request(&app, &actor, "GET", &world_path, "", Value::Null).await).await;
    let mut nodes = draft["nodes"].as_array().unwrap().clone();
    for node in &mut nodes {
        node.as_object_mut().unwrap().remove("lab_id");
    }
    nodes[0]["placement"]["position"] = json!([2.0, 0.0, 3.0]);
    assert_eq!(
        request(
            &app,
            &actor,
            "POST",
            &format!("{path}/program/start"),
            "",
            json!({})
        )
        .await
        .status(),
        StatusCode::CREATED
    );
    assert_eq!(
        request(
            &app,
            &actor,
            "POST",
            &format!("{path}/actions"),
            "layout-power",
            json!({"capability":"light.set_power","parameters":{"on":true}})
        )
        .await
        .status(),
        StatusCode::ACCEPTED
    );
    assert!(runtime.process_next().await.unwrap());
    let running = data(request(&app, &actor, "GET", &path, "", Value::Null).await).await;
    assert_eq!(
        running["observation"]["values"],
        json!({"on":true,"brightness":70})
    );
    let saved = request(
        &app,
        &actor,
        "PUT",
        &format!("/api/v1/lab/labs/{lab}/layout"),
        "",
        json!({"expected_version":2,"nodes":nodes,"relationships":[]}),
    )
    .await;
    assert_eq!(saved.status(), StatusCode::OK);
    assert_eq!(data(saved).await["layout_version"], 3);
    assert_eq!(
        running,
        data(request(&app, &actor, "GET", &path, "", Value::Null).await).await
    );
    request(
        &app,
        &actor,
        "POST",
        &format!("{path}/actions"),
        "layout-brightness",
        json!({"capability":"light.set_brightness","parameters":{"brightness":35}}),
    )
    .await;
    assert!(runtime.process_next().await.unwrap());
    let updated = data(request(&app, &actor, "GET", &world_path, "", Value::Null).await).await;
    assert_eq!(updated["lab"]["layout_version"], 3);
    assert_eq!(
        updated["nodes"][0]["placement"]["position"],
        json!([2.0, 0.0, 3.0])
    );
    assert_eq!(
        updated["entities"][0]["observation"]["values"]["brightness"],
        35
    );
    let copied=request(&app,&actor,"POST",&format!("{path}/copies"),"",json!({"expected_version":3,"name":"New independent light","placement":{"position":[4,0,0],"rotation":[0,0,0],"scale":[1,1,1]}})).await;
    assert_eq!(copied.status(), StatusCode::CREATED);
    let copied = data(copied).await;
    assert_ne!(copied["binding"]["id"], running["binding"]["id"]);
    assert_eq!(copied["observation"], Value::Null);
    assert_eq!(copied["program_run"], Value::Null);
    assert_eq!(
        data(request(&app, &actor, "GET", &path, "", Value::Null).await).await["program_run"]["id"],
        running["program_run"]["id"]
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn unknown_source_times_do_not_erase_the_last_known_ordering_watermark(pool: PgPool) {
    use labos_threejs_app::modules::lab::{
        DeviceRuntime, ObservationAcceptance, ObservationReport,
    };
    let runtime = DeviceRuntime::initialize(pool.clone()).await.unwrap();
    let app = labos_threejs_api::router(pool, Default::default());
    let actor = register(&app).await;
    let (lab, ids) = lights(&app, &actor).await;
    let path = entity(&lab, &ids[0]);
    let run = data(
        request(
            &app,
            &actor,
            "POST",
            &format!("{path}/program/start"),
            "",
            json!({}),
        )
        .await,
    )
    .await;
    let run = run["id"].as_str().unwrap();
    let report = |sequence, observed_at, brightness| ObservationReport {
        sequence,
        observed_at,
        values: json!({"on":true,"brightness":brightness}),
        quality: "good".into(),
    };
    let known = "2026-10-03T06:00:00Z".parse().unwrap();
    assert_eq!(
        runtime
            .observe(run, report(1, Some(known), 60))
            .await
            .unwrap(),
        ObservationAcceptance::Applied
    );
    assert_eq!(
        runtime.observe(run, report(2, None, 70)).await.unwrap(),
        ObservationAcceptance::Applied
    );
    let unknown = data(request(&app, &actor, "GET", &path, "", Value::Null).await).await;
    assert_eq!(unknown["observation"]["observed_at"], Value::Null);
    assert_eq!(unknown["observation"]["freshness"], "source_time_unknown");
    let earlier = "2026-10-03T05:59:59Z".parse().unwrap();
    assert_eq!(
        runtime
            .observe(run, report(3, Some(earlier), 10))
            .await
            .unwrap(),
        ObservationAcceptance::OutOfOrder
    );
    assert_eq!(
        data(request(&app, &actor, "GET", &path, "", Value::Null).await).await["observation"],
        unknown["observation"]
    );
    let later = "2026-10-03T06:00:01Z".parse().unwrap();
    assert_eq!(
        runtime
            .observe(run, report(3, Some(later), 80))
            .await
            .unwrap(),
        ObservationAcceptance::Applied
    );
    assert_eq!(
        data(request(&app, &actor, "GET", &path, "", Value::Null).await).await["observation"]["values"]
            ["brightness"],
        80
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn unavailable_runtime_rejects_start_and_commands_until_initialization_succeeds(
    pool: PgPool,
) {
    use labos_threejs_app::modules::lab::{self, DeviceRuntime, RuntimeAvailability};
    let availability = RuntimeAvailability::default();
    let auth = Default::default();
    let app = labos_threejs_app::compose_routes_with_options(
        pool.clone(),
        auth,
        lab::router_with_runtime(
            pool.clone(),
            Default::default(),
            None,
            Some(availability.clone()),
        ),
        labos_threejs_api::openapi(),
        labos_threejs_app::CoreOptions {
            api_key_scopes: vec![lab::api_key_scope()],
            ..Default::default()
        },
    );
    let actor = register(&app).await;
    let (lab, ids) = lights(&app, &actor).await;
    let path = entity(&lab, &ids[0]);
    for (suffix, key, body) in [
        ("program/start", "", json!({})),
        (
            "actions",
            "unavailable",
            json!({"capability":"light.set_power","parameters":{"on":true}}),
        ),
    ] {
        let rejected = request(&app, &actor, "POST", &format!("{path}/{suffix}"), key, body).await;
        assert_eq!(rejected.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(
            data(rejected).await["error"]["code"],
            "lab.runtime_unavailable"
        );
    }
    let before = data(request(&app, &actor, "GET", &path, "", Value::Null).await).await;
    assert_eq!(before["program_run"], Value::Null);
    assert_eq!(before["observation"], Value::Null);
    let runtime = DeviceRuntime::initialize_with_availability(pool, availability)
        .await
        .unwrap();
    assert_eq!(
        request(
            &app,
            &actor,
            "POST",
            &format!("{path}/program/start"),
            "",
            json!({})
        )
        .await
        .status(),
        StatusCode::CREATED
    );
    let running = data(request(&app, &actor, "GET", &path, "", Value::Null).await).await;
    for _ in 0..3 {
        assert!(!runtime.process_next().await.unwrap());
    }
    assert_eq!(
        data(request(&app, &actor, "GET", &path, "", Value::Null).await).await["program_run"]["id"],
        running["program_run"]["id"]
    );
    assert_eq!(
        request(
            &app,
            &actor,
            "POST",
            &format!("{path}/actions"),
            "unavailable",
            json!({"capability":"light.set_power","parameters":{"on":true}})
        )
        .await
        .status(),
        StatusCode::ACCEPTED
    );
    assert!(runtime.process_next().await.unwrap());
    assert_eq!(
        data(request(&app, &actor, "GET", &path, "", Value::Null).await).await["observation"]["values"]
            ["on"],
        true
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn configuration_is_snapshotted_per_run_and_commands_do_not_change_layout_versions(
    pool: PgPool,
) {
    let runtime = labos_threejs_app::modules::lab::DeviceRuntime::initialize(pool.clone())
        .await
        .unwrap();
    let app = labos_threejs_api::router(pool, Default::default());
    let actor = register(&app).await;
    let (lab, ids) = lights(&app, &actor).await;
    let path = entity(&lab, &ids[0]);
    assert_eq!(
        request(
            &app,
            &actor,
            "POST",
            &format!("{path}/program/start"),
            "",
            json!({})
        )
        .await
        .status(),
        StatusCode::CREATED
    );
    request(
        &app,
        &actor,
        "POST",
        &format!("{path}/actions"),
        "original",
        json!({"capability":"light.set_power","parameters":{"on":true}}),
    )
    .await;
    runtime.process_next().await.unwrap();
    let changed = request(
        &app,
        &actor,
        "PATCH",
        &path,
        "",
        json!({"name":"Light A","configuration":{"brightness":10}}),
    )
    .await;
    assert_eq!(changed.status(), StatusCode::OK);
    request(
        &app,
        &actor,
        "POST",
        &format!("{path}/actions"),
        "active",
        json!({"capability":"light.set_power","parameters":{"on":false}}),
    )
    .await;
    runtime.process_next().await.unwrap();
    assert_eq!(
        data(request(&app, &actor, "GET", &path, "", Value::Null).await).await["observation"]["values"]
            ["brightness"],
        70
    );
    request(
        &app,
        &actor,
        "POST",
        &format!("{path}/program/stop"),
        "",
        json!({}),
    )
    .await;
    let next = data(
        request(
            &app,
            &actor,
            "POST",
            &format!("{path}/program/start"),
            "",
            json!({}),
        )
        .await,
    )
    .await;
    assert_eq!(next["configuration"]["brightness"], 10);
    request(
        &app,
        &actor,
        "POST",
        &format!("{path}/actions"),
        "next",
        json!({"capability":"light.set_power","parameters":{"on":true}}),
    )
    .await;
    runtime.process_next().await.unwrap();
    assert_eq!(
        data(request(&app, &actor, "GET", &path, "", Value::Null).await).await["observation"]["values"]
            ["brightness"],
        10
    );
    assert_eq!(
        data(
            request(
                &app,
                &actor,
                "GET",
                &format!("/api/v1/lab/labs/{lab}/world"),
                "",
                Value::Null
            )
            .await
        )
        .await["lab"]["layout_version"],
        2
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn a_pre_execution_definition_snapshot_stays_pinned_when_its_light_binding_starts(
    pool: PgPool,
) {
    let app = labos_threejs_api::router(pool.clone(), Default::default());
    let actor = register(&app).await;
    let (lab, ids) = lights(&app, &actor).await;
    let path = entity(&lab, &ids[0]);
    let created = data(request(&app, &actor, "GET", &path, "", Value::Null).await).await;
    // Arrange a persisted #3 snapshot, before execution metadata existed.
    let mut historical = created["definition"].clone();
    for capability in historical["capabilities"].as_array_mut().unwrap() {
        capability.as_object_mut().unwrap().remove("version");
        capability.as_object_mut().unwrap().remove("result");
        capability["implemented"] = json!(false);
        if let Some(brightness) =
            capability["parameters"]["properties"]["brightness"].as_object_mut()
        {
            brightness.remove("unit");
        }
    }
    sqlx::query("UPDATE lab.entities SET definition=$2 WHERE id=$1::uuid")
        .bind(&ids[0])
        .bind(historical)
        .execute(&pool)
        .await
        .unwrap();
    let before = data(request(&app, &actor, "GET", &path, "", Value::Null).await).await;
    assert_eq!(
        before["definition"]["capabilities"][0]["implemented"],
        false
    );
    assert_eq!(
        before["capabilities"][1]["result"]["meaning"],
        "applied_by_device_program"
    );
    assert_eq!(
        before["capabilities"][1]["parameters"]["properties"]["brightness"]["unit"],
        "percent"
    );
    assert_eq!(
        request(
            &app,
            &actor,
            "POST",
            &format!("{path}/program/start"),
            "",
            json!({})
        )
        .await
        .status(),
        StatusCode::CREATED
    );
    let after = data(request(&app, &actor, "GET", &path, "", Value::Null).await).await;
    assert_eq!(after["definition"], before["definition"]);
    assert_eq!(after["definition_version"], "1.0");
    assert_eq!(after["capabilities"][1]["definition_supported"], true);
    assert_eq!(after["capabilities"][1]["binding_implemented"], true);
    assert_eq!(after["capabilities"][1]["executable"], true);
}

async fn agent(
    app: &Router,
    token: &str,
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
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .header("idempotency-key", key)
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap()
}
#[sqlx::test(migrations = "../../migrations")]
async fn members_and_agents_share_typed_capabilities_rejections_and_durable_idempotency(
    pool: PgPool,
) {
    let runtime = labos_threejs_app::modules::lab::DeviceRuntime::initialize(pool.clone())
        .await
        .unwrap();
    let app = labos_threejs_api::router(pool, Default::default());
    let actor = register(&app).await;
    let key = data(
        request(
            &app,
            &actor,
            "POST",
            "/api/v1/api-keys",
            "",
            json!({"name":"Lighting Agent","scopes":["lab:full"],"expires_in_days":1}),
        )
        .await,
    )
    .await;
    let token = key["secret"].as_str().unwrap();
    let (lab, ids) = lights(&app, &actor).await;
    let path = entity(&lab, &ids[0]);
    let actions = format!("{path}/actions");
    let initial = data(request(&app, &actor, "GET", &path, "", Value::Null).await).await;
    let capability = &initial["capabilities"][1];
    assert_eq!(capability["version"], "1.0");
    assert_eq!(
        capability["parameters"]["properties"]["brightness"]["unit"],
        "percent"
    );
    assert_eq!(capability["result"]["meaning"], "applied_by_device_program");
    assert_eq!(capability["binding_implemented"], true);
    assert_eq!(capability["executable"], false);
    let power = json!({"capability":"light.set_power","parameters":{"on":true}});
    for response in [
        request(&app, &actor, "POST", &actions, "stopped", power.clone()).await,
        agent(&app, token, "POST", &actions, "stopped", power.clone()).await,
    ] {
        assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            data(response).await["error"]["code"],
            "lab.program_not_running"
        );
    }
    assert_eq!(
        agent(
            &app,
            token,
            "POST",
            &format!("{path}/program/start"),
            "",
            json!({})
        )
        .await
        .status(),
        StatusCode::CREATED
    );
    for params in [
        json!({"brightness":101}),
        json!({"brightness":"50"}),
        json!({"brightness":50,"extra":1}),
    ] {
        let input = json!({"capability":"light.set_brightness","parameters":params});
        for response in [
            request(&app, &actor, "POST", &actions, "invalid", input.clone()).await,
            agent(&app, token, "POST", &actions, "invalid", input).await,
        ] {
            assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
            assert_eq!(
                data(response).await["error"]["code"],
                "lab.invalid_parameters"
            );
        }
    }
    let (one, two) = tokio::join!(
        agent(&app, token, "POST", &actions, "same", power.clone()),
        agent(&app, token, "POST", &actions, "same", power.clone())
    );
    assert_eq!(one.status(), StatusCode::ACCEPTED);
    assert_eq!(two.status(), StatusCode::ACCEPTED);
    let one = data(one).await;
    let two = data(two).await;
    assert_eq!(one, two);
    assert_eq!(one["actor_source"], "agent");
    assert!(runtime.process_next().await.unwrap());
    assert!(!runtime.process_next().await.unwrap());
    let retry = data(agent(&app, token, "POST", &actions, "same", power.clone()).await).await;
    assert_eq!(retry["id"], one["id"]);
    assert_eq!(retry["status"], "succeeded");
    let conflict = agent(
        &app,
        token,
        "POST",
        &actions,
        "same",
        json!({"capability":"light.set_power","parameters":{"on":false}}),
    )
    .await;
    assert_eq!(conflict.status(), StatusCode::CONFLICT);
    assert_eq!(
        data(conflict).await["error"]["code"],
        "idempotency.conflict"
    );
    assert_eq!(
        data(request(&app, &actor, "GET", &path, "", Value::Null).await).await["observation"]["sequence"],
        1
    );
    let decimal = json!({"capability":"light.set_brightness","parameters":{"brightness":35.0}});
    let accepted = data(agent(&app, token, "POST", &actions, "numeric", decimal).await).await;
    let equivalent = agent(
        &app,
        token,
        "POST",
        &actions,
        "numeric",
        json!({"capability":"light.set_brightness","parameters":{"brightness":35}}),
    )
    .await;
    assert_eq!(equivalent.status(), StatusCode::ACCEPTED);
    assert_eq!(data(equivalent).await["id"], accepted["id"]);
    assert_eq!(
        agent(&app, "invalid-key", "POST", &actions, "invalid-auth", power)
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        data(request(&app, &actor, "GET", &path, "", Value::Null).await).await["observation"]["sequence"],
        1
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn observations_keep_source_time_order_and_survive_stops_and_interrupted_runs(pool: PgPool) {
    use labos_threejs_app::modules::lab::{
        DeviceRuntime, ObservationAcceptance, ObservationReport,
    };
    let runtime = DeviceRuntime::initialize(pool.clone()).await.unwrap();
    let app = labos_threejs_api::router(pool.clone(), Default::default());
    let actor = register(&app).await;
    let (lab, ids) = lights(&app, &actor).await;
    let path = entity(&lab, &ids[0]);
    let first = data(
        request(
            &app,
            &actor,
            "POST",
            &format!("{path}/program/start"),
            "",
            json!({}),
        )
        .await,
    )
    .await;
    let first_id = first["id"].as_str().unwrap();
    let report = |sequence, observed_at, brightness| ObservationReport {
        sequence,
        observed_at,
        values: json!({"on":true,"brightness":brightness}),
        quality: "good".into(),
    };
    assert_eq!(
        runtime
            .observe(first_id, report(1, None, 45))
            .await
            .unwrap(),
        ObservationAcceptance::Applied
    );
    let unknown_time = data(request(&app, &actor, "GET", &path, "", Value::Null).await).await;
    assert_eq!(unknown_time["observation"]["observed_at"], Value::Null);
    assert!(unknown_time["observation"]["received_at"].is_string());
    assert!(unknown_time["observation"]["updated_at"].is_string());
    assert_eq!(
        unknown_time["observation"]["freshness"],
        "source_time_unknown"
    );
    let time = "2026-10-03T06:00:00Z".parse().unwrap();
    assert_eq!(
        runtime
            .observe(first_id, report(2, Some(time), 60))
            .await
            .unwrap(),
        ObservationAcceptance::Applied
    );
    for sequence in [1, 2] {
        assert_eq!(
            runtime
                .observe(first_id, report(sequence, Some(time), 10))
                .await
                .unwrap(),
            ObservationAcceptance::OutOfOrder
        );
    }
    let earlier = "2026-10-03T05:59:59Z".parse().unwrap();
    assert_eq!(
        runtime
            .observe(first_id, report(3, Some(earlier), 15))
            .await
            .unwrap(),
        ObservationAcceptance::OutOfOrder
    );
    let current = data(request(&app, &actor, "GET", &path, "", Value::Null).await).await;
    assert_eq!(current["observation"]["values"]["brightness"], 60);
    let stopped = data(
        request(
            &app,
            &actor,
            "POST",
            &format!("{path}/program/stop"),
            "",
            json!({}),
        )
        .await,
    )
    .await;
    assert_eq!(stopped["status"], "stopped");
    assert_eq!(
        runtime
            .observe(first_id, report(4, Some(time), 5))
            .await
            .unwrap(),
        ObservationAcceptance::StaleRun
    );
    let after_stop = data(request(&app, &actor, "GET", &path, "", Value::Null).await).await;
    assert_eq!(
        after_stop["observation"]["values"],
        current["observation"]["values"]
    );
    assert_eq!(
        after_stop["observation"]["observed_at"],
        current["observation"]["observed_at"]
    );
    assert_eq!(after_stop["observation"]["freshness"], "stopped");
    let second = data(
        request(
            &app,
            &actor,
            "POST",
            &format!("{path}/program/start"),
            "",
            json!({}),
        )
        .await,
    )
    .await;
    assert_ne!(first["id"], second["id"]);
    let accepted = data(
        request(
            &app,
            &actor,
            "POST",
            &format!("{path}/actions"),
            "interrupted",
            json!({"capability":"light.set_power","parameters":{"on":false}}),
        )
        .await,
    )
    .await;
    let restarted = DeviceRuntime::initialize(pool).await.unwrap();
    let interrupted = data(request(&app, &actor, "GET", &path, "", Value::Null).await).await;
    assert_eq!(interrupted["program_run"]["status"], "interrupted");
    assert_eq!(
        interrupted["observation"]["values"],
        current["observation"]["values"]
    );
    assert_eq!(
        interrupted["capabilities"][0]["reason"],
        "program_not_running"
    );
    let query = format!("{path}/commands/{}", accepted["id"].as_str().unwrap());
    assert_eq!(
        data(request(&app, &actor, "GET", &query, "", Value::Null).await).await["status"],
        "unknown"
    );
    let retry = data(
        request(
            &app,
            &actor,
            "POST",
            &format!("{path}/actions"),
            "interrupted",
            json!({"capability":"light.set_power","parameters":{"on":false}}),
        )
        .await,
    )
    .await;
    assert_eq!(retry["id"], accepted["id"]);
    assert_eq!(retry["status"], "unknown");
    assert!(!restarted.process_next().await.unwrap());
    let third = data(
        request(
            &app,
            &actor,
            "POST",
            &format!("{path}/program/start"),
            "",
            json!({}),
        )
        .await,
    )
    .await;
    assert_eq!(
        runtime
            .observe(third["id"].as_str().unwrap(), report(10, Some(time), 1))
            .await
            .unwrap(),
        ObservationAcceptance::StaleRun
    );
    assert_eq!(
        restarted
            .observe(second["id"].as_str().unwrap(), report(10, Some(time), 1))
            .await
            .unwrap(),
        ObservationAcceptance::StaleRun
    );
    assert_eq!(
        restarted
            .observe(third["id"].as_str().unwrap(), report(1, None, 80))
            .await
            .unwrap(),
        ObservationAcceptance::Applied
    );
    assert_eq!(
        data(request(&app, &actor, "GET", &path, "", Value::Null).await).await["observation"]["values"]
            ["brightness"],
        80
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn backend_program_executes_power_and_brightness_independently(pool: PgPool) {
    let runtime = labos_threejs_app::modules::lab::DeviceRuntime::initialize(pool.clone())
        .await
        .unwrap();
    let app = labos_threejs_api::router(pool, Default::default());
    let actor = register(&app).await;
    let (lab, ids) = lights(&app, &actor).await;
    for id in &ids {
        assert_eq!(
            request(
                &app,
                &actor,
                "POST",
                &format!("{}/program/start", entity(&lab, id)),
                "",
                json!({})
            )
            .await
            .status(),
            StatusCode::CREATED
        );
    }
    for (id, action, parameters, key) in [
        (&ids[0], "light.set_power", json!({"on":true}), "power-a"),
        (
            &ids[0],
            "light.set_brightness",
            json!({"brightness":35}),
            "brightness-a",
        ),
        (&ids[1], "light.set_power", json!({"on":true}), "power-b"),
    ] {
        let path = entity(&lab, id);
        let accepted = data(
            request(
                &app,
                &actor,
                "POST",
                &format!("{path}/actions"),
                key,
                json!({"capability":action,"parameters":parameters}),
            )
            .await,
        )
        .await;
        assert!(runtime.process_next().await.unwrap());
        let completed = data(
            request(
                &app,
                &actor,
                "GET",
                &format!("{path}/commands/{}", accepted["id"].as_str().unwrap()),
                "",
                Value::Null,
            )
            .await,
        )
        .await;
        assert_eq!(completed["status"], "succeeded");
        assert_eq!(completed["result"]["meaning"], "applied_by_device_program");
    }
    let a = data(request(&app, &actor, "GET", &entity(&lab, &ids[0]), "", Value::Null).await).await;
    let b = data(request(&app, &actor, "GET", &entity(&lab, &ids[1]), "", Value::Null).await).await;
    assert_eq!(
        a["observation"]["values"],
        json!({"on":true,"brightness":35})
    );
    assert_eq!(
        b["observation"]["values"],
        json!({"on":true,"brightness":20})
    );
    assert_ne!(a["observation"]["source"], b["observation"]["source"]);
    assert_eq!(a["observation"]["quality"], "good");
    assert_eq!(a["observation"]["freshness"], "current");
    assert!(a["observation"]["observed_at"].is_string());
    assert!(!runtime.process_next().await.unwrap());
    assert_eq!(
        request(
            &app,
            &actor,
            "POST",
            &format!("{}/actions", entity(&lab, &ids[0])),
            "off-a",
            json!({"capability":"light.set_power","parameters":{"on":false}})
        )
        .await
        .status(),
        StatusCode::ACCEPTED
    );
    runtime.process_next().await.unwrap();
    assert_eq!(
        data(request(&app, &actor, "GET", &entity(&lab, &ids[0]), "", Value::Null).await).await["observation"]
            ["values"],
        json!({"on":false,"brightness":35})
    );
    assert_eq!(
        data(request(&app, &actor, "GET", &entity(&lab, &ids[1]), "", Value::Null).await).await["observation"],
        b["observation"]
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn accepted_commands_do_not_fabricate_observations_and_each_light_has_its_own_run(
    pool: PgPool,
) {
    let app = labos_threejs_api::router(pool, Default::default());
    let actor = register(&app).await;
    let (lab, ids) = lights(&app, &actor).await;
    let mut runs = Vec::new();
    for id in &ids {
        let path = entity(&lab, id);
        let initial = data(request(&app, &actor, "GET", &path, "", Value::Null).await).await;
        assert_eq!(initial["observation"], Value::Null);
        let response = request(
            &app,
            &actor,
            "POST",
            &format!("{path}/program/start"),
            "",
            json!({}),
        )
        .await;
        assert_eq!(response.status(), StatusCode::CREATED);
        let run = data(response).await;
        assert_eq!(run["status"], "running");
        runs.push(run["id"].clone());
        let running = data(request(&app, &actor, "GET", &path, "", Value::Null).await).await;
        assert_eq!(running["binding"]["program_id"], "light.v1");
        assert_eq!(running["capabilities"][0]["binding_implemented"], true);
        assert_eq!(running["capabilities"][0]["executable"], true);
        let response = request(
            &app,
            &actor,
            "POST",
            &format!("{path}/actions"),
            "turn-on",
            json!({"capability":"light.set_power","parameters":{"on":true}}),
        )
        .await;
        assert_eq!(response.status(), StatusCode::ACCEPTED);
        let command = data(response).await;
        assert_eq!(command["status"], "accepted");
        assert_eq!(command["run_id"], run["id"]);
        assert_eq!(command["parameters"], json!({"on":true}));
        assert!(command["actor_id"].is_string());
        let queried = data(
            request(
                &app,
                &actor,
                "GET",
                &format!("{path}/commands/{}", command["id"].as_str().unwrap()),
                "",
                Value::Null,
            )
            .await,
        )
        .await;
        assert_eq!(queried, command);
        assert_eq!(
            data(request(&app, &actor, "GET", &path, "", Value::Null).await).await["observation"],
            Value::Null
        );
    }
    assert_ne!(runs[0], runs[1]);
}
