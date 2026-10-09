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
async fn register(app: &Router) -> Browser {
    register_email(app, "sync@example.test").await
}
async fn register_email(app: &Router, email: &str) -> Browser {
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
    let value = data(response).await;
    Browser {
        id: value["user"]["id"].as_str().unwrap().into(),
        cookie,
        csrf: value["csrf_token"].as_str().unwrap().into(),
    }
}
async fn request(app: &Router, actor: &Browser, method: &str, path: &str, body: Value) -> Response {
    app.clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("origin", "http://127.0.0.1:5173")
                .header("content-type", "application/json")
                .header("cookie", &actor.cookie)
                .header("x-csrf-token", &actor.csrf)
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap()
}
async fn frame(body: &mut Body) -> Value {
    loop {
        let frame = tokio::time::timeout(std::time::Duration::from_secs(5), body.frame())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        let Ok(bytes) = frame.into_data() else {
            continue;
        };
        let text = std::str::from_utf8(&bytes).unwrap();
        assert!(bytes.len() <= 1024 * 1024 + 8);
        if let Some(line) = text.lines().find_map(|line| line.strip_prefix("data: ")) {
            return serde_json::from_str(line).unwrap();
        }
    }
}

async fn shared_lab(app: &Router, actor: &Browser) -> String {
    data(
        request(
            app,
            actor,
            "POST",
            "/api/v1/lab/labs",
            json!({"name":"Shared world"}),
        )
        .await,
    )
    .await["id"]
        .as_str()
        .unwrap()
        .into()
}
async fn subscribe(app: &Router, actor: &Browser, lab: &str) -> Body {
    let response = request(
        app,
        actor,
        "GET",
        &format!("/api/v1/lab/labs/{lab}/world/subscribe"),
        Value::Null,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    response.into_body()
}
async fn agent_subscribe(app: &Router, secret: &str, lab: &str) -> Response {
    app.clone()
        .oneshot(
            Request::get(format!("/api/v1/lab/labs/{lab}/world/subscribe"))
                .header("authorization", format!("Bearer {secret}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
}
async fn ended(body: &mut Body) {
    loop {
        let event = frame(body).await;
        if event["type"] == "access_ended" {
            break;
        }
        assert!(matches!(
            event["type"].as_str(),
            Some("heartbeat" | "runtime_status")
        ));
    }
    assert!(body.frame().await.is_none());
}

#[sqlx::test(migrations = "../../migrations")]
async fn revoked_and_expired_agent_credentials_terminate_existing_subscriptions(pool: PgPool) {
    let app = labos_threejs_api::router(pool.clone(), Default::default());
    let actor = register(&app).await;
    let lab = shared_lab(&app, &actor).await;
    for expire in [false, true] {
        let key = data(
            request(
                &app,
                &actor,
                "POST",
                "/api/v1/api-keys",
                json!({"name":"Observer","scopes":["lab:full"],"expires_in_days":1}),
            )
            .await,
        )
        .await;
        let secret = key["secret"].as_str().unwrap();
        let mut body = agent_subscribe(&app, secret, &lab).await.into_body();
        assert_eq!(frame(&mut body).await["type"], "snapshot");
        if expire {
            // Explicit credential clock boundary, reached through the real subscription.
            sqlx::query("UPDATE labos_threejs_core.api_keys SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1::uuid").bind(key["key"]["id"].as_str().unwrap()).execute(&pool).await.unwrap();
        } else {
            assert_eq!(
                request(
                    &app,
                    &actor,
                    "DELETE",
                    &format!("/api/v1/api-keys/{}", key["key"]["id"].as_str().unwrap()),
                    Value::Null
                )
                .await
                .status(),
                StatusCode::NO_CONTENT
            );
        }
        ended(&mut body).await;
        assert_eq!(
            agent_subscribe(&app, secret, &lab).await.status(),
            StatusCode::UNAUTHORIZED
        );
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn access_revoked_before_the_first_frame_cannot_reveal_a_queued_snapshot(pool: PgPool) {
    let app = labos_threejs_api::router(pool, Default::default());
    let actor = register(&app).await;
    let lab = shared_lab(&app, &actor).await;
    let mut stream = subscribe(&app, &actor, &lab).await;
    assert_eq!(
        request(&app, &actor, "POST", "/api/v1/auth/logout", json!({}))
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(frame(&mut stream).await, json!({"type":"access_ended"}));
    assert!(stream.frame().await.is_none());
}

#[sqlx::test(migrations = "../../migrations")]
async fn logout_and_inactive_membership_end_existing_member_and_agent_access(pool: PgPool) {
    let app = labos_threejs_api::router(pool, Default::default());
    let owner = register(&app).await;
    let member = register_email(&app, "member-sync@example.test").await;
    let lab = shared_lab(&app, &member).await;
    let mut browser = subscribe(&app, &member, &lab).await;
    assert_eq!(frame(&mut browser).await["type"], "snapshot");
    let key = data(
        request(
            &app,
            &member,
            "POST",
            "/api/v1/api-keys",
            json!({"name":"Observer","scopes":["lab:full"],"expires_in_days":1}),
        )
        .await,
    )
    .await;
    let mut agent = agent_subscribe(&app, key["secret"].as_str().unwrap(), &lab)
        .await
        .into_body();
    assert_eq!(frame(&mut agent).await["type"], "snapshot");
    let members = data(
        request(
            &app,
            &owner,
            "GET",
            "/api/v1/organization/members",
            Value::Null,
        )
        .await,
    )
    .await;
    let version = members["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["user_id"] == member.id)
        .unwrap()["version"]
        .clone();
    assert_eq!(
        request(
            &app,
            &owner,
            "PUT",
            &format!("/api/v1/organization/members/{}", member.id),
            json!({"role":"member","active":false,"version":version})
        )
        .await
        .status(),
        StatusCode::OK
    );
    ended(&mut browser).await;
    ended(&mut agent).await;
    let mut owner_stream = subscribe(&app, &owner, &lab).await;
    assert_eq!(frame(&mut owner_stream).await["type"], "snapshot");
    assert_eq!(
        request(&app, &owner, "POST", "/api/v1/auth/logout", json!({}))
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    ended(&mut owner_stream).await;
}

#[sqlx::test(migrations = "../../migrations")]
async fn a_slow_client_discards_its_bounded_queue_and_receives_an_explicit_resync(pool: PgPool) {
    let app = labos_threejs_api::router(pool, Default::default());
    let actor = register(&app).await;
    let lab = shared_lab(&app, &actor).await;
    let mut slow = subscribe(&app, &actor, &lab).await;
    let mut witness = subscribe(&app, &actor, &lab).await;
    assert_eq!(frame(&mut witness).await["type"], "snapshot");
    // Each public heartbeat synchronizes one polling interval; no arbitrary sleep.
    for _ in 0..20 {
        frame(&mut witness).await;
    }
    let resync = frame(&mut slow).await;
    assert_eq!(resync, json!({"type":"resync","reason":"slow_client"}));
    assert!(slow.frame().await.is_none());
    drop(witness);
    let mut restored = subscribe(&app, &actor, &lab).await;
    assert_eq!(frame(&mut restored).await["type"], "snapshot");
}

#[sqlx::test(migrations = "../../migrations")]
async fn world_versions_cover_lower_sequences_on_other_entities_and_new_run_generations(
    pool: PgPool,
) {
    use labos_threejs_app::modules::lab::{
        DeviceRuntime, ObservationAcceptance, ObservationReport,
    };
    let runtime = DeviceRuntime::initialize(pool.clone()).await.unwrap();
    let app = labos_threejs_api::router(pool.clone(), Default::default());
    let actor = register(&app).await;
    let lab = shared_lab(&app, &actor).await;
    let path = format!("/api/v1/lab/labs/{lab}");
    let mut runs = Vec::new();
    for name in ["Light A", "Light B"] {
        let entity=data(request(&app,&actor,"POST",&format!("{path}/entities"),json!({"name":name,"definition_id":"light","definition_version":"1.0","reality":"simulated","configuration":{},"representation_id":null})).await).await;
        let id = entity["id"].as_str().unwrap().to_owned();
        let run = data(
            request(
                &app,
                &actor,
                "POST",
                &format!("{path}/entities/{id}/program/start"),
                json!({}),
            )
            .await,
        )
        .await;
        runs.push((id, run["id"].as_str().unwrap().to_owned()));
    }
    let report = |sequence, brightness| ObservationReport {
        sequence,
        values: json!({"on":true,"brightness":brightness}),
        observed_at: Some("2026-10-03T06:00:00Z".parse().unwrap()),
        quality: "good".into(),
    };
    assert_eq!(
        runtime.observe(&runs[0].1, report(30, 80)).await.unwrap(),
        ObservationAcceptance::Applied
    );
    let before =
        data(request(&app, &actor, "GET", &format!("{path}/world"), Value::Null).await).await;
    assert_eq!(
        runtime.observe(&runs[1].1, report(1, 20)).await.unwrap(),
        ObservationAcceptance::Applied
    );
    let current =
        data(request(&app, &actor, "GET", &format!("{path}/world"), Value::Null).await).await;
    assert!(
        current["version"].as_str().unwrap().parse::<u64>().unwrap()
            > before["version"].as_str().unwrap().parse::<u64>().unwrap()
    );
    assert_eq!(current["entities"][0]["observation"]["sequence"], 30);
    assert_eq!(current["entities"][1]["observation"]["sequence"], 1);
    assert_eq!(
        runtime.observe(&runs[0].1, report(29, 0)).await.unwrap(),
        ObservationAcceptance::OutOfOrder
    );
    assert_eq!(
        current,
        data(request(&app, &actor, "GET", &format!("{path}/world"), Value::Null).await).await
    );
    let replacement = DeviceRuntime::initialize(pool).await.unwrap();
    let run = data(
        request(
            &app,
            &actor,
            "POST",
            &format!("{path}/entities/{}/program/start", runs[0].0),
            json!({}),
        )
        .await,
    )
    .await;
    assert_ne!(run["id"], runs[0].1);
    assert_eq!(
        replacement
            .observe(run["id"].as_str().unwrap(), report(1, 45))
            .await
            .unwrap(),
        ObservationAcceptance::Applied
    );
    let latest =
        data(request(&app, &actor, "GET", &format!("{path}/world"), Value::Null).await).await;
    assert!(
        latest["version"].as_str().unwrap().parse::<u64>().unwrap()
            > current["version"].as_str().unwrap().parse::<u64>().unwrap()
    );
    assert_eq!(
        latest["entities"][0]["observation"]["values"]["brightness"],
        45
    );
    assert_eq!(latest["entities"][0]["observation"]["run_id"], run["id"]);
}

#[sqlx::test(migrations = "../../migrations")]
async fn service_availability_is_explicit_and_does_not_change_same_version_world_facts(
    pool: PgPool,
) {
    use labos_threejs_app::modules::lab::{self, DeviceRuntime, RuntimeAvailability};
    let availability = RuntimeAvailability::default();
    let app = labos_threejs_app::compose_routes_with_options(
        pool.clone(),
        Default::default(),
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
    let lab = shared_lab(&app, &actor).await;
    let path = format!("/api/v1/lab/labs/{lab}");
    let entity=data(request(&app,&actor,"POST",&format!("{path}/entities"),json!({"name":"Light A","definition_id":"light","definition_version":"1.0","reality":"simulated","configuration":{},"representation_id":null})).await).await;
    let entity_path = format!("{path}/entities/{}", entity["id"].as_str().unwrap());
    let unavailable = request(&app, &actor, "GET", &format!("{path}/world"), Value::Null).await;
    assert_eq!(unavailable.headers()["x-lab-runtime"], "unavailable");
    let before = data(unavailable).await;
    let mut stream = subscribe(&app, &actor, &lab).await;
    frame(&mut stream).await;
    assert_eq!(
        frame(&mut stream).await,
        json!({"type":"runtime_status","available":false})
    );
    let runtime = DeviceRuntime::initialize_with_availability(pool, availability)
        .await
        .unwrap();
    loop {
        let event = frame(&mut stream).await;
        if event["type"] == "runtime_status" {
            assert_eq!(event["available"], true);
            break;
        }
    }
    let world = request(&app, &actor, "GET", &format!("{path}/world"), Value::Null).await;
    let entity = request(&app, &actor, "GET", &entity_path, Value::Null).await;
    assert_eq!(world.headers()["x-lab-runtime"], "ready");
    assert_eq!(entity.headers()["x-lab-runtime"], "ready");
    let world = data(world).await;
    assert_eq!(
        world["entities"][0]["capabilities"],
        data(entity).await["capabilities"]
    );
    assert_eq!(world["entities"], before["entities"]);
    drop(runtime);
    let unavailable = request(&app, &actor, "GET", &format!("{path}/world"), Value::Null).await;
    assert_eq!(unavailable.headers()["x-lab-runtime"], "unavailable");
    assert_eq!(data(unavailable).await, world);
}

#[sqlx::test(migrations = "../../migrations")]
async fn snapshot_handoff_observes_a_change_made_before_the_client_reads_the_snapshot(
    pool: PgPool,
) {
    let app = labos_threejs_api::router(pool, Default::default());
    let actor = register(&app).await;
    let lab = data(
        request(
            &app,
            &actor,
            "POST",
            "/api/v1/lab/labs",
            json!({"name":"Shared world"}),
        )
        .await,
    )
    .await;
    let lab = lab["id"].as_str().unwrap();
    let path = format!("/api/v1/lab/labs/{lab}");
    let response = request(
        &app,
        &actor,
        "GET",
        &format!("{path}/world/subscribe"),
        Value::Null,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert!(
        response.headers()["content-type"]
            .to_str()
            .unwrap()
            .starts_with("text/event-stream")
    );
    let mut body = response.into_body();
    let entity = data(request(&app, &actor, "POST", &format!("{path}/entities"), json!({"name":"Light A","definition_id":"light","definition_version":"1.0","reality":"simulated","configuration":{},"representation_id":null})).await).await;
    let initial = frame(&mut body).await;
    assert_eq!(initial["type"], "snapshot");
    assert_eq!(initial["world"]["entities"], json!([]));
    let version = initial["world"]["version"]
        .as_str()
        .unwrap()
        .parse::<u64>()
        .unwrap();
    loop {
        let update = frame(&mut body).await;
        if update["type"] != "update" {
            continue;
        }
        assert_eq!(update["base_version"], initial["world"]["version"]);
        assert!(update["version"].as_str().unwrap().parse::<u64>().unwrap() > version);
        assert!(
            update["changes"]
                .as_array()
                .unwrap()
                .iter()
                .any(|change| change["collection"] == "entities"
                    && change["id"] == entity["id"]
                    && change["patch"]["name"] == "Light A")
        );
        break;
    }
    let current =
        data(request(&app, &actor, "GET", &format!("{path}/world"), Value::Null).await).await;
    let reconnected = request(
        &app,
        &actor,
        "GET",
        &format!("{path}/world/subscribe"),
        Value::Null,
    )
    .await;
    let snapshot = frame(&mut reconnected.into_body()).await;
    assert_eq!(snapshot["world"], current);
}

#[sqlx::test(migrations = "../../migrations")]
async fn an_oversized_initial_snapshot_is_rejected_with_a_public_payload_limit(pool: PgPool) {
    let app = labos_threejs_api::router(pool, Default::default());
    let actor = register(&app).await;
    let lab = shared_lab(&app, &actor).await;
    for index in 0..150 {
        let result=request(&app,&actor,"POST",&format!("/api/v1/lab/labs/{lab}/entities"),json!({"name":format!("Object {index}"),"definition_id":"bench","definition_version":"1.0","reality":"simulated","configuration":{"description":"x".repeat(7900)},"representation_id":null})).await;
        assert_eq!(result.status(), StatusCode::CREATED);
    }
    let response = request(
        &app,
        &actor,
        "GET",
        &format!("/api/v1/lab/labs/{lab}/world/subscribe"),
        Value::Null,
    )
    .await;
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(
        data(response).await["error"]["code"],
        "lab.snapshot_too_large"
    );
}
