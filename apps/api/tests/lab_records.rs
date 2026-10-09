use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
    response::Response,
};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use chrono::{DateTime, Utc};
use http_body_util::BodyExt;
use labos_threejs_app::modules::lab::{DeviceRuntime, RetentionPolicy};
use serde_json::{Value, json};
use sqlx::PgPool;
use tower::ServiceExt;

struct Member {
    cookie: String,
    csrf: String,
    id: String,
}

async fn data(response: Response) -> Value {
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}

async fn register(app: &Router, email: &str) -> Member {
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
    Member {
        cookie,
        csrf: session["csrf_token"].as_str().unwrap().into(),
        id: session["user"]["id"].as_str().unwrap().into(),
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
                .header("idempotency-key", uuid::Uuid::now_v7().to_string())
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap()
}

async fn lab(app: &Router, member: &Member) -> String {
    let response = request(
        app,
        member,
        "POST",
        "/api/v1/lab/labs",
        json!({"name":"Records lab"}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    data(response).await["id"].as_str().unwrap().into()
}

async fn device(app: &Router, member: &Member, lab: &str, definition: &str) -> String {
    let response = request(
        app,
        member,
        "POST",
        &format!("/api/v1/lab/labs/{lab}/entities"),
        json!({"name":"Records device","definition_id":definition,"definition_version":"1.0","reality":"simulated","configuration":{},"representation_id":null}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    data(response).await["id"].as_str().unwrap().into()
}

fn records(lab: &str, from: DateTime<Utc>, to: DateTime<Utc>, extra: &str) -> String {
    format!(
        "/api/v1/lab/labs/{lab}/records?from={}&to={}&{extra}",
        from.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true),
        to.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true),
    )
}

fn centrifuge_action() -> Value {
    json!({"capability":"centrifuge.start","parameters":{"rpm":6000,"temperature":22,"duration_seconds":6}})
}

async fn centrifuge_task(app: &Router, member: &Member, path: &str) -> (Value, Value) {
    let run = request(
        app,
        member,
        "POST",
        &format!("{path}/program/start"),
        json!({}),
    )
    .await;
    assert_eq!(run.status(), StatusCode::CREATED);
    let run = data(run).await;
    let command = request(
        app,
        member,
        "POST",
        &format!("{path}/actions"),
        centrifuge_action(),
    )
    .await;
    assert_eq!(command.status(), StatusCode::ACCEPTED);
    (run, data(command).await)
}

#[sqlx::test(migrations = "../../migrations")]
async fn a_member_reads_four_record_categories_with_original_identities(pool: PgPool) {
    let runtime = DeviceRuntime::initialize(pool.clone()).await.unwrap();
    let app = labos_threejs_api::router(pool, Default::default());
    register(&app, "records-owner@example.test").await;
    let member = register(&app, "records-member@example.test").await;
    let lab = lab(&app, &member).await;
    let entity = device(&app, &member, &lab, "centrifuge").await;
    let path = format!("/api/v1/lab/labs/{lab}/entities/{entity}");
    let (run, command) = centrifuge_task(&app, &member, &path).await;
    runtime.process_next().await.unwrap();
    let now = Utc::now();
    let response = request(
        &app,
        &member,
        "GET",
        &records(
            &lab,
            now - chrono::Duration::hours(1),
            now + chrono::Duration::hours(1),
            "limit=100",
        ),
        Value::Null,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let page = data(response).await;
    let items = page["items"].as_array().unwrap();
    for kind in ["command", "task", "event", "run"] {
        assert!(
            items.iter().any(|item| item["record_type"] == kind),
            "missing {kind}"
        );
    }
    assert!(
        items
            .iter()
            .all(|item| item["entity_id"] == entity && item["run_id"] == run["id"])
    );
    for pair in items.windows(2) {
        let key = |item: &Value| {
            (
                DateTime::parse_from_rfc3339(item["recorded_at"].as_str().unwrap()).unwrap(),
                item["record_type"].as_str().unwrap().to_owned(),
                item["id"].as_str().unwrap().to_owned(),
            )
        };
        assert!(
            key(&pair[0]) > key(&pair[1]),
            "mixed records need a descending total order"
        );
    }
    let command_record = items
        .iter()
        .find(|item| item["record_type"] == "command")
        .unwrap();
    assert_eq!(command_record["id"], command["id"]);
    assert_eq!(command_record["actor_id"], member.id);
    assert_eq!(command_record["actor_source"], "member");
    let task = items
        .iter()
        .find(|item| item["record_type"] == "task")
        .unwrap();
    assert_eq!(task["id"], command["task_id"]);
    assert_eq!(task["command_id"], command["id"]);
    assert_eq!(task["actor_id"], member.id);
    let run_record = items
        .iter()
        .find(|item| item["record_type"] == "run")
        .unwrap();
    assert_eq!(run_record["recorded_at"], run["started_at"]);
    assert_eq!(run_record["actor_id"], member.id);
    assert_eq!(run_record["actor_source"], "unknown");
    assert_eq!(run_record["actor_role"], "initiator");
}

#[sqlx::test(migrations = "../../migrations")]
async fn tied_mixed_records_page_once_with_a_fixed_upper_bound_and_bound_filters(pool: PgPool) {
    let runtime = DeviceRuntime::initialize(pool.clone()).await.unwrap();
    let app = labos_threejs_api::router(pool.clone(), Default::default());
    register(&app, "records-owner@example.test").await;
    let member = register(&app, "records-member@example.test").await;
    let stopper = register(&app, "records-stopper@example.test").await;
    let lab = lab(&app, &member).await;
    let entity = device(&app, &member, &lab, "centrifuge").await;
    let path = format!("/api/v1/lab/labs/{lab}/entities/{entity}");
    let (run, command) = centrifuge_task(&app, &member, &path).await;
    runtime.process_next().await.unwrap();
    let at = DateTime::from_timestamp(Utc::now().timestamp() - 30, 123456000).unwrap();
    sqlx::query("UPDATE lab.program_runs SET started_at=$1 WHERE id=$2::uuid")
        .bind(at)
        .bind(run["id"].as_str().unwrap())
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE lab.device_commands SET created_at=$1,updated_at=$1,status='succeeded' WHERE id=$2::uuid").bind(at).bind(command["id"].as_str().unwrap()).execute(&pool).await.unwrap();
    sqlx::query("UPDATE lab.device_tasks SET created_at=$1,ended_at=$1,status='completed' WHERE id=$2::uuid").bind(at).bind(command["task_id"].as_str().unwrap()).execute(&pool).await.unwrap();
    sqlx::query("DELETE FROM lab.device_events WHERE entity_id=$1::uuid")
        .bind(&entity)
        .execute(&pool)
        .await
        .unwrap();
    let mut event_ids = Vec::new();
    for id in 1..=3 {
        let id = uuid::Uuid::from_u128(id).to_string();
        sqlx::query("INSERT INTO lab.device_events(id,entity_id,run_id,occurred_at,received_at,data) VALUES($1::uuid,$2::uuid,$3::uuid,$4,$4,$5)")
            .bind(&id).bind(&entity).bind(run["id"].as_str().unwrap()).bind(at)
            .bind(json!({"record_type":"command","record_id":command["id"],"status":"succeeded","actor_id":member.id,"actor_source":"member"})).execute(&pool).await.unwrap();
        event_ids.push(id);
    }
    let from = at - chrono::Duration::seconds(1);
    let to = Utc::now() + chrono::Duration::hours(1);
    let first = data(
        request(
            &app,
            &member,
            "GET",
            &records(&lab, from, to, "limit=2"),
            Value::Null,
        )
        .await,
    )
    .await;
    assert_eq!(first["items"][0]["id"], command["task_id"]);
    assert_eq!(first["items"][1]["id"], run["id"]);
    assert!(
        first["next_cursor"].is_string(),
        "another mixed page must have a cursor"
    );
    let original_upper = first["query_upper_bound"].clone();
    let first_cursor = first["next_cursor"].as_str().unwrap();
    let mut forged: Value =
        serde_json::from_slice(&URL_SAFE_NO_PAD.decode(first_cursor).unwrap()).unwrap();
    forged["id"] = json!(uuid::Uuid::nil().to_string());
    let wrong_identity = URL_SAFE_NO_PAD.encode(serde_json::to_vec(&forged).unwrap());
    let rejected = request(
        &app,
        &member,
        "GET",
        &records(&lab, from, to, &format!("limit=2&cursor={wrong_identity}")),
        Value::Null,
    )
    .await;
    assert_eq!(
        rejected.status(),
        StatusCode::BAD_REQUEST,
        "a decoded cursor must identify an actual boundary record"
    );
    let stopped = request(
        &app,
        &stopper,
        "POST",
        &format!("{path}/program/stop"),
        json!({}),
    )
    .await;
    assert_eq!(stopped.status(), StatusCode::OK);
    let stopped = data(stopped).await;
    assert_eq!(stopped["started_at"], json!(at));
    let mut all: Vec<String> = first["items"]
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item["id"].as_str().unwrap().into())
        .collect();
    let mut cursor = Some(first_cursor.to_owned());
    while let Some(value) = cursor {
        let response = request(
            &app,
            &member,
            "GET",
            &records(&lab, from, to, &format!("limit=2&cursor={value}")),
            Value::Null,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let page = data(response).await;
        assert_eq!(page["query_upper_bound"], original_upper);
        all.extend(
            page["items"]
                .as_array()
                .unwrap()
                .iter()
                .map(|item| item["id"].as_str().unwrap().to_owned()),
        );
        cursor = page["next_cursor"].as_str().map(str::to_owned);
    }
    assert_eq!(
        all,
        vec![
            command["task_id"].as_str().unwrap().to_owned(),
            run["id"].as_str().unwrap().to_owned(),
            event_ids[2].clone(),
            event_ids[1].clone(),
            event_ids[0].clone(),
            command["id"].as_str().unwrap().to_owned()
        ]
    );
    for extra in [
        format!("limit=2&record_type=event&cursor={first_cursor}"),
        format!("limit=2&entity_id={entity}&cursor={first_cursor}"),
        "cursor=malformed".into(),
    ] {
        assert_eq!(
            request(
                &app,
                &member,
                "GET",
                &records(&lab, from, to, &extra),
                Value::Null
            )
            .await
            .status(),
            StatusCode::BAD_REQUEST
        );
    }
    let events = data(
        request(
            &app,
            &member,
            "GET",
            &records(&lab, from, to, "record_type=event&limit=100"),
            Value::Null,
        )
        .await,
    )
    .await;
    let stop_event = &events["items"][0];
    assert_eq!(stop_event["summary"], "program_stopped");
    assert_eq!(stop_event["actor_id"], Value::Null);
    assert_eq!(stop_event["actor_role"], "unknown");
    assert_eq!(stop_event["actor_source"], "unknown");
    assert!(stop_event["data"].get("actor_id").is_none());
    let run_page = data(
        request(
            &app,
            &member,
            "GET",
            &records(&lab, from, to, "record_type=run"),
            Value::Null,
        )
        .await,
    )
    .await;
    assert_eq!(run_page["items"][0]["recorded_at"], json!(at));
    assert_eq!(run_page["items"][0]["state"], "stopped");
    assert_eq!(run_page["items"][0]["ended_at"], stopped["ended_at"]);
    assert_eq!(run_page["items"][0]["actor_id"], member.id);
    assert_ne!(run_page["items"][0]["actor_id"], stopper.id);
}

#[sqlx::test(migrations = "../../migrations")]
async fn archived_records_keep_unknown_task_initiators_and_actual_category_retention(pool: PgPool) {
    let runtime = DeviceRuntime::initialize(pool.clone()).await.unwrap();
    let policy = RetentionPolicy::new(2, 60).unwrap();
    let routes = labos_threejs_app::modules::lab::router_with_retention(
        pool.clone(),
        Default::default(),
        None,
        None,
        policy,
    );
    let app = labos_threejs_app::compose_routes_with_options(
        pool.clone(),
        Default::default(),
        routes,
        labos_threejs_api::openapi(),
        Default::default(),
    );
    let member = register(&app, "records-owner@example.test").await;
    let lab = lab(&app, &member).await;
    let entity = device(&app, &member, &lab, "centrifuge").await;
    let path = format!("/api/v1/lab/labs/{lab}/entities/{entity}");
    let (run, command) = centrifuge_task(&app, &member, &path).await;
    runtime.process_next().await.unwrap();
    let now = DateTime::from_timestamp(Utc::now().timestamp(), 0).unwrap();
    let old = now - chrono::Duration::seconds(120);
    let captured = now - chrono::Duration::seconds(200);
    sqlx::query("UPDATE lab.entities SET created_at=$1 WHERE id=$2::uuid")
        .bind(captured)
        .bind(&entity)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE lab.history_bounds SET captured_since=$1 WHERE entity_id=$2::uuid")
        .bind(captured)
        .bind(&entity)
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE lab.program_runs SET started_at=$1 WHERE id=$2::uuid")
        .bind(old)
        .bind(run["id"].as_str().unwrap())
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE lab.device_commands SET created_at=$1,updated_at=$1,status='succeeded' WHERE id=$2::uuid").bind(old).bind(command["id"].as_str().unwrap()).execute(&pool).await.unwrap();
    sqlx::query("UPDATE lab.device_tasks SET created_at=$1,ended_at=$2,status='completed' WHERE id=$3::uuid").bind(old).bind(now).bind(command["task_id"].as_str().unwrap()).execute(&pool).await.unwrap();
    let stopped = request(
        &app,
        &member,
        "POST",
        &format!("{path}/program/stop"),
        json!({}),
    )
    .await;
    assert_eq!(stopped.status(), StatusCode::OK);
    let archive = request(&app, &member, "POST", &format!("{path}/archive"), json!({})).await;
    assert_eq!(archive.status(), StatusCode::OK);
    let cleaned = request(
        &app,
        &member,
        "POST",
        &format!("/api/v1/lab/labs/{lab}/history/cleanup"),
        json!({}),
    )
    .await;
    assert_eq!(cleaned.status(), StatusCode::OK);
    assert_eq!(data(cleaned).await["commands"], 1);
    let from = now - chrono::Duration::seconds(250);
    let to = now + chrono::Duration::hours(1);
    let response = request(
        &app,
        &member,
        "GET",
        &records(&lab, from, to, &format!("entity_id={entity}&limit=100")),
        Value::Null,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let page = data(response).await;
    let items = page["items"].as_array().unwrap();
    let task = items
        .iter()
        .find(|item| item["record_type"] == "task")
        .unwrap();
    assert_eq!(task["command_id"], command["id"]);
    assert_eq!(task["actor_id"], Value::Null);
    assert_eq!(task["actor_source"], "unknown");
    assert_eq!(task["actor_role"], "unknown");
    assert!(items.iter().all(|item| item["archived_at"].is_string()));
    assert!(
        items
            .iter()
            .any(|item| item["record_type"] == "run" && item["id"] == run["id"])
    );
    assert_eq!(page["retention"]["observation_seconds"], 2);
    assert_eq!(page["retention"]["record_seconds"], 60);
    let coverage = page["coverage"].as_array().unwrap();
    assert_eq!(coverage.len(), 4);
    let task_coverage = coverage
        .iter()
        .find(|row| row["record_type"] == "task")
        .unwrap();
    assert_eq!(task_coverage["retention_seconds"], 60);
    assert_eq!(task_coverage["preserves_unfinished"], true);
    assert_eq!(task_coverage["captured_since"], json!(captured));
    assert!(task_coverage["cleaned_before"].is_string());
    assert!(
        task_coverage["gaps"]
            .as_array()
            .unwrap()
            .iter()
            .any(|gap| gap["reason"] == "retention")
    );
    let run_coverage = coverage
        .iter()
        .find(|row| row["record_type"] == "run")
        .unwrap();
    assert_eq!(run_coverage["retention_seconds"], Value::Null);
    assert_eq!(run_coverage["cleaned_before"], Value::Null);
    assert_eq!(run_coverage["oldest_record_at"], json!(old));
    let raw = request(
        &app,
        &member,
        "GET",
        &format!(
            "{path}/history?record_type=observation&from={}&to={}",
            from.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true),
            to.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true)
        ),
        Value::Null,
    )
    .await;
    assert_eq!(raw.status(), StatusCode::OK);
}

#[sqlx::test(migrations = "../../migrations")]
async fn nanosecond_half_open_filters_use_the_persisted_record_time(pool: PgPool) {
    DeviceRuntime::initialize(pool.clone()).await.unwrap();
    let app = labos_threejs_api::router(pool, Default::default());
    let member = register(&app, "records-owner@example.test").await;
    let lab = lab(&app, &member).await;
    let entity = device(&app, &member, &lab, "light").await;
    let path = format!("/api/v1/lab/labs/{lab}/entities/{entity}");
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
    let at: DateTime<Utc> = run["started_at"].as_str().unwrap().parse().unwrap();
    for (from, to, count) in [
        (at, at + chrono::Duration::nanoseconds(1), 1),
        (at - chrono::Duration::nanoseconds(1), at, 0),
        (
            at + chrono::Duration::nanoseconds(1),
            at + chrono::Duration::microseconds(1),
            0,
        ),
    ] {
        let response = request(
            &app,
            &member,
            "GET",
            &records(&lab, from, to, "record_type=run"),
            Value::Null,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let page = data(response).await;
        assert_eq!(
            page["items"].as_array().unwrap().len(),
            count,
            "half-open {from}..{to}"
        );
        if count == 1 {
            assert_eq!(page["items"][0]["recorded_at"], run["started_at"]);
            assert_eq!(page["coverage"][0]["oldest_record_at"], run["started_at"]);
        }
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn response_bytes_bound_each_page_and_reject_an_oversized_record_without_writing_world(
    pool: PgPool,
) {
    DeviceRuntime::initialize(pool.clone()).await.unwrap();
    let app = labos_threejs_api::router(pool.clone(), Default::default());
    let member = register(&app, "records-owner@example.test").await;
    let lab = lab(&app, &member).await;
    let entity = device(&app, &member, &lab, "light").await;
    let path = format!("/api/v1/lab/labs/{lab}/entities/{entity}");
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
    sqlx::query("INSERT INTO lab.device_commands(id,entity_id,run_id,actor_id,actor_source,request_key,capability,parameters,status,result) SELECT gen_random_uuid(),$1::uuid,$2::uuid,$3::uuid,'member','budget-'||i,'light.set_power','{\"on\":true}'::jsonb,'succeeded',jsonb_build_object('detail',repeat('x',12000)) FROM generate_series(1,101) i")
        .bind(&entity).bind(run["id"].as_str().unwrap()).bind(&member.id).execute(&pool).await.unwrap();
    let from = Utc::now() - chrono::Duration::hours(1);
    let to = Utc::now() + chrono::Duration::hours(1);
    let mut cursor = None;
    let mut ids = Vec::new();
    let mut pages = Vec::new();
    loop {
        let extra = format!(
            "record_type=command&limit=100{}",
            cursor
                .as_ref()
                .map_or(String::new(), |cursor| format!("&cursor={cursor}"))
        );
        let response = request(
            &app,
            &member,
            "GET",
            &records(&lab, from, to, &extra),
            Value::Null,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        assert!(
            bytes.len() <= 256 * 1024,
            "page bytes {} exceed 256KiB",
            bytes.len()
        );
        let page: Value = serde_json::from_slice(&bytes).unwrap();
        let items = page["items"].as_array().unwrap();
        assert!(items.len() <= 100);
        pages.push(json!({"bytes":bytes.len(),"items":items.len()}));
        ids.extend(
            items
                .iter()
                .map(|item| item["id"].as_str().unwrap().to_owned()),
        );
        cursor = page["next_cursor"].as_str().map(str::to_owned);
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(ids.len(), 101);
    assert_eq!(
        ids.iter().collect::<std::collections::HashSet<_>>().len(),
        101
    );
    assert!(pages.len() > 1);
    sqlx::query("UPDATE lab.device_commands SET result=jsonb_build_object('detail',repeat('x',300000)) WHERE id=$1::uuid").bind(&ids[0]).execute(&pool).await.unwrap();
    let world = format!("/api/v1/lab/labs/{lab}/world");
    let before = data(request(&app, &member, "GET", &world, Value::Null).await).await;
    let response = request(
        &app,
        &member,
        "GET",
        &records(&lab, from, to, "record_type=command&limit=100"),
        Value::Null,
    )
    .await;
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(
        data(response).await["error"]["code"],
        "lab.records_too_large"
    );
    let recovered = request(
        &app,
        &member,
        "GET",
        &records(&lab, from, to, "record_type=run"),
        Value::Null,
    )
    .await;
    assert_eq!(recovered.status(), StatusCode::OK);
    assert_eq!(data(recovered).await["items"][0]["id"], run["id"]);
    assert_eq!(
        data(request(&app, &member, "GET", &world, Value::Null).await).await,
        before
    );
    if let Ok(directory) = std::env::var("LAB_RECORDS_EVIDENCE_DIR") {
        std::fs::write(
            std::path::Path::new(&directory).join("response-byte-measurements.json"),
            serde_json::to_vec_pretty(&pages).unwrap(),
        )
        .unwrap();
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn members_and_agents_read_same_facts_and_rejections_preserve_world_and_records(
    pool: PgPool,
) {
    let runtime = DeviceRuntime::initialize(pool.clone()).await.unwrap();
    let app = labos_threejs_api::router(pool.clone(), Default::default());
    let owner = register(&app, "records-owner@example.test").await;
    let member = register(&app, "records-member@example.test").await;
    let lab_id = lab(&app, &member).await;
    let entity = device(&app, &member, &lab_id, "centrifuge").await;
    let other_lab = lab(&app, &member).await;
    let foreign_entity = device(&app, &member, &other_lab, "light").await;
    let key_response = request(
        &app,
        &member,
        "POST",
        "/api/v1/api-keys",
        json!({"name":"Records Agent","scopes":["lab:full"],"expires_in_days":1}),
    )
    .await;
    assert_eq!(key_response.status(), StatusCode::CREATED);
    let key = data(key_response).await;
    let secret = key["secret"].as_str().unwrap();
    let path = format!("/api/v1/lab/labs/{lab_id}/entities/{entity}");
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
    let command = agent(
        &app,
        secret,
        "POST",
        &format!("{path}/actions"),
        centrifuge_action(),
    )
    .await;
    assert_eq!(command.status(), StatusCode::ACCEPTED);
    let command = data(command).await;
    runtime.process_next().await.unwrap();
    let from = Utc::now() - chrono::Duration::hours(1);
    let to = Utc::now() + chrono::Duration::hours(1);
    let url = records(&lab_id, from, to, "limit=100");
    let member_page = data(request(&app, &member, "GET", &url, Value::Null).await).await;
    let agent_response = agent(&app, secret, "GET", &url, Value::Null).await;
    assert_eq!(agent_response.status(), StatusCode::OK);
    assert_eq!(data(agent_response).await["items"], member_page["items"]);
    let task = member_page["items"]
        .as_array()
        .unwrap()
        .iter()
        .find(|item| item["record_type"] == "task")
        .unwrap();
    assert_eq!(task["command_id"], command["id"]);
    assert_eq!(task["actor_source"], "agent");
    assert_eq!(task["actor_id"], member.id);
    let world = format!("/api/v1/lab/labs/{lab_id}/world");
    let before = data(request(&app, &owner, "GET", &world, Value::Null).await).await;
    let first = data(
        request(
            &app,
            &member,
            "GET",
            &records(&lab_id, from, to, "limit=1"),
            Value::Null,
        )
        .await,
    )
    .await;
    let cursor = first["next_cursor"].as_str().unwrap();
    for extra in [
        "limit=0",
        "limit=101",
        "record_type=observation",
        "entity_id=invalid",
        "cursor=invalid",
        "unknown=value",
    ] {
        assert_eq!(
            request(
                &app,
                &member,
                "GET",
                &records(&lab_id, from, to, extra),
                Value::Null
            )
            .await
            .status(),
            StatusCode::BAD_REQUEST
        );
    }
    for (url, status) in [
        (
            records(&lab_id, from, from + chrono::Duration::days(32), ""),
            StatusCode::BAD_REQUEST,
        ),
        (records(&lab_id, to, from, ""), StatusCode::BAD_REQUEST),
        (
            records(&lab_id, from, to, &format!("entity_id={foreign_entity}")),
            StatusCode::NOT_FOUND,
        ),
        (
            records(&other_lab, from, to, &format!("limit=1&cursor={cursor}")),
            StatusCode::BAD_REQUEST,
        ),
    ] {
        assert_eq!(
            request(&app, &member, "GET", &url, Value::Null)
                .await
                .status(),
            status
        );
    }
    let scoped = data(
        request(
            &app,
            &member,
            "POST",
            "/api/v1/api-keys",
            json!({"name":"Wrong scope","scopes":["knowledge:read"],"expires_in_days":1}),
        )
        .await,
    )
    .await;
    assert_eq!(
        agent(
            &app,
            scoped["secret"].as_str().unwrap(),
            "GET",
            &url,
            Value::Null
        )
        .await
        .status(),
        StatusCode::FORBIDDEN
    );
    let revoked = request(
        &app,
        &member,
        "DELETE",
        &format!("/api/v1/api-keys/{}", key["key"]["id"].as_str().unwrap()),
        Value::Null,
    )
    .await;
    assert_eq!(revoked.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        agent(&app, secret, "GET", &url, Value::Null).await.status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        agent(&app, "invalid", "GET", &url, Value::Null)
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(&app, &member, "POST", "/api/v1/auth/logout", json!({}))
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        request(&app, &member, "GET", &url, Value::Null)
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        data(request(&app, &owner, "GET", &world, Value::Null).await).await,
        before
    );
    assert_eq!(
        data(request(&app, &owner, "GET", &url, Value::Null).await).await["items"],
        member_page["items"]
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn generated_sdk_example_reads_mixed_pages_and_nanosecond_windows_over_member_and_agent_http(
    pool: PgPool,
) {
    use std::future::IntoFuture;
    let runtime = DeviceRuntime::initialize(pool.clone()).await.unwrap();
    let app = labos_threejs_api::router(pool, Default::default());
    register(&app, "records-owner@example.test").await;
    let member = register(&app, "records-member@example.test").await;
    let lab_id = lab(&app, &member).await;
    let entity = device(&app, &member, &lab_id, "centrifuge").await;
    let path = format!("/api/v1/lab/labs/{lab_id}/entities/{entity}");
    let (run, command) = centrifuge_task(&app, &member, &path).await;
    runtime.process_next().await.unwrap();
    let credential = data(
        request(
            &app,
            &member,
            "POST",
            "/api/v1/api-keys",
            json!({"name":"Records SDK","scopes":["lab:full"],"expires_in_days":1}),
        )
        .await,
    )
    .await;
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let (shutdown, stopped) = tokio::sync::oneshot::channel();
    let server = tokio::spawn(
        axum::serve(listener, app)
            .with_graceful_shutdown(async move {
                let _ = stopped.await;
            })
            .into_future(),
    );
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let at: DateTime<Utc> = run["started_at"].as_str().unwrap().parse().unwrap();
    let mut facts = Vec::new();
    for (label, environment, value) in [
        ("member", "LAB_SESSION_COOKIE", member.cookie.as_str()),
        (
            "agent",
            "LAB_API_KEY",
            credential["secret"].as_str().unwrap(),
        ),
    ] {
        let offset =
            chrono::FixedOffset::east_opt(if label == "agent" { 8 * 3600 } else { 0 }).unwrap();
        let mut pages = Vec::new();
        for (from, to, kind, limit) in [
            (
                at - chrono::Duration::hours(1),
                at + chrono::Duration::hours(1),
                None,
                100,
            ),
            (
                at - chrono::Duration::hours(1),
                at + chrono::Duration::hours(1),
                None,
                2,
            ),
            (at, at + chrono::Duration::nanoseconds(1), Some("run"), 100),
        ] {
            let mut child = tokio::process::Command::new("node");
            child
                .current_dir(&root)
                .arg("examples/lab/query-records.mjs")
                .env_remove("LAB_API_KEY")
                .env_remove("LAB_SESSION_COOKIE")
                .env_remove("LAB_RECORD_TYPE")
                .env(environment, value)
                .env("LAB_API_BASE", format!("http://{address}"))
                .env("LAB_ID", &lab_id)
                .env("LAB_ENTITY_ID", &entity)
                .env("LAB_RECORDS_FROM", from.with_timezone(&offset).to_rfc3339())
                .env("LAB_RECORDS_TO", to.with_timezone(&offset).to_rfc3339())
                .env("LAB_RECORDS_LIMIT", limit.to_string())
                .kill_on_drop(true);
            if let Some(kind) = kind {
                child.env("LAB_RECORD_TYPE", kind);
            }
            let output = tokio::time::timeout(std::time::Duration::from_secs(30), child.output())
                .await
                .unwrap()
                .unwrap();
            assert!(
                output.status.success(),
                "{label} SDK example failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            let result: Value = serde_json::from_slice(&output.stdout).unwrap();
            if kind.is_some() {
                assert_eq!(result["pages"][0]["items"].as_array().unwrap().len(), 1);
                assert_eq!(
                    result["pages"][0]["items"][0]["recorded_at"],
                    run["started_at"]
                );
            } else if limit == 2 {
                assert_eq!(result["pages"].as_array().unwrap().len(), 2);
                assert_eq!(result["pages"][0]["items"].as_array().unwrap().len(), 2);
                assert_eq!(result["pages"][1]["items"].as_array().unwrap().len(), 2);
                assert_eq!(
                    result["pages"][0]["query_upper_bound"],
                    result["pages"][1]["query_upper_bound"]
                );
            } else {
                let items = result["pages"][0]["items"].as_array().unwrap();
                for category in ["command", "task", "event", "run"] {
                    assert!(items.iter().any(|item| item["record_type"] == category));
                }
                assert!(items.iter().any(|item|item["record_type"]=="command" && item["id"]==command["id"]));
            }
            pages.push(
                result["pages"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|page| page["items"].clone())
                    .collect::<Vec<_>>(),
            );
        }
        facts.push(pages);
    }
    let _ = shutdown.send(());
    let _ = server.await;
    assert_eq!(facts[0], facts[1]);
    println!(
        "Actual generated SDK example passed for Member and Agent; listener {address} stopped"
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn legacy_events_with_missing_state_or_source_do_not_invent_actor_facts(pool: PgPool) {
    DeviceRuntime::initialize(pool.clone()).await.unwrap();
    let app = labos_threejs_api::router(pool.clone(), Default::default());
    let member = register(&app, "records-owner@example.test").await;
    let lab_id = lab(&app, &member).await;
    let entity = device(&app, &member, &lab_id, "light").await;
    let path = format!("/api/v1/lab/labs/{lab_id}/entities/{entity}");
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
    let old_events = [
        (
            uuid::Uuid::from_u128(41),
            json!({"record_type":"program","actor_id":member.id}),
        ),
        (
            uuid::Uuid::from_u128(42),
            json!({"record_type":"command","actor_id":member.id,"status":"succeeded","actor_source":"legacy"}),
        ),
    ];
    for (id, event) in &old_events {
        sqlx::query("INSERT INTO lab.device_events(id,entity_id,run_id,occurred_at,data) VALUES($1::uuid,$2::uuid,$3::uuid,now(),$4)")
            .bind(id.to_string()).bind(&entity).bind(run["id"].as_str().unwrap()).bind(event).execute(&pool).await.unwrap();
    }
    let now = Utc::now();
    let page = data(
        request(
            &app,
            &member,
            "GET",
            &records(
                &lab_id,
                now - chrono::Duration::hours(1),
                now + chrono::Duration::hours(1),
                "record_type=event&limit=100",
            ),
            Value::Null,
        )
        .await,
    )
    .await;
    let items = page["items"].as_array().unwrap();
    let program = items
        .iter()
        .find(|item| item["id"] == old_events[0].0.to_string())
        .unwrap();
    assert_eq!(program["actor_id"], Value::Null);
    assert_eq!(program["actor_role"], "unknown");
    assert_eq!(program["actor_source"], "unknown");
    let command = items
        .iter()
        .find(|item| item["id"] == old_events[1].0.to_string())
        .unwrap();
    assert_eq!(command["actor_id"], member.id);
    assert_eq!(command["actor_role"], "initiator");
    assert_eq!(command["actor_source"], "unknown");
    assert!(
        items
            .iter()
            .all(|item| item["data"].get("actor_id").is_none())
    );
}
