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
    let value = data(response).await;
    Browser {
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

async fn bearer(app: &Router, token: &str, method: &str, path: &str, body: Value) -> Response {
    app.clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap()
}

#[sqlx::test(migrations = "../../migrations")]
async fn layout_save_compares_versions_and_removing_a_node_keeps_the_entity(pool: PgPool) {
    let app = labos_threejs_api::router(pool, Default::default());
    let actor = register(&app, "layout-owner@example.test").await;
    let other = register(&app, "layout-member@example.test").await;
    let lab = data(
        request(
            &app,
            &actor,
            "POST",
            "/api/v1/lab/labs",
            json!({"name":"Layout lab"}),
        )
        .await,
    )
    .await;
    let lab_id = lab["id"].as_str().unwrap();
    let entity = data(request(&app, &actor, "POST", &format!("/api/v1/lab/labs/{lab_id}/entities"), json!({"name":"Beaker","definition_id":"labware","definition_version":"1.0","reality":"simulated","configuration":{},"representation_id":null})).await).await;
    let world_path = format!("/api/v1/lab/labs/{lab_id}/world");
    let layout_path = format!("/api/v1/lab/labs/{lab_id}/layout");
    let before = data(request(&app, &actor, "GET", &world_path, Value::Null).await).await;
    let mut node = before["nodes"][0].clone();
    node.as_object_mut().unwrap().remove("lab_id");
    node["placement"] = json!({"position":[2,0.9,3],"rotation":[0,1.5,0],"scale":[2,2,2]});
    let draft = json!({"expected_version":1,"nodes":[node]});
    let saved = request(&app, &actor, "PUT", &layout_path, draft.clone()).await;
    assert_eq!(saved.status(), StatusCode::OK);
    let saved = data(saved).await;
    assert_eq!(saved["layout_version"], 2);
    let conflict = request(&app, &other, "PUT", &layout_path, draft).await;
    assert_eq!(conflict.status(), StatusCode::CONFLICT);
    assert_eq!(data(conflict).await["error"]["code"], "lab.layout_conflict");
    let opened = data(request(&app, &other, "GET", &world_path, Value::Null).await).await;
    assert_eq!(
        opened["nodes"][0]["placement"]["position"],
        json!([2.0, 0.9, 3.0])
    );
    assert_eq!(opened["entities"][0], entity);
    assert_eq!(
        request(
            &app,
            &actor,
            "PUT",
            &layout_path,
            json!({"expected_version":2,"nodes":[]})
        )
        .await
        .status(),
        StatusCode::OK
    );
    let empty = data(request(&app, &other, "GET", &world_path, Value::Null).await).await;
    assert_eq!(empty["nodes"], json!([]));
    assert_eq!(empty["entities"][0]["id"], entity["id"]);
    let key = data(
        request(
            &app,
            &other,
            "POST",
            "/api/v1/api-keys",
            json!({"name":"Layout Agent","scopes":["lab:full"],"expires_in_days":1}),
        )
        .await,
    )
    .await;
    let replacement = json!({"id":uuid::Uuid::now_v7().to_string(),"entity_id":entity["id"],"representation_id":null,"placement":{"position":[1,0,0],"rotation":[0,0,0],"scale":[1,1,1]}});
    assert_eq!(
        bearer(
            &app,
            key["secret"].as_str().unwrap(),
            "PUT",
            &layout_path,
            json!({"expected_version":3,"nodes":[replacement.clone()]})
        )
        .await
        .status(),
        StatusCode::OK
    );
    let restored = data(request(&app, &actor, "GET", &world_path, Value::Null).await).await;
    assert_eq!(restored["nodes"][0]["entity_id"], entity["id"]);
    let mut invalid = replacement;
    invalid["entity_id"] = json!(uuid::Uuid::now_v7().to_string());
    assert_eq!(
        request(
            &app,
            &actor,
            "PUT",
            &layout_path,
            json!({"expected_version":4,"nodes":[invalid]})
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );
    assert_eq!(
        restored,
        data(request(&app, &actor, "GET", &world_path, Value::Null).await).await
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn copying_an_entity_creates_a_new_identity_with_the_frozen_definition_and_configuration(
    pool: PgPool,
) {
    let app = labos_threejs_api::router(pool, Default::default());
    let actor = register(&app, "copies@example.test").await;
    let lab = data(
        request(
            &app,
            &actor,
            "POST",
            "/api/v1/lab/labs",
            json!({"name":"Copies"}),
        )
        .await,
    )
    .await;
    let lab_id = lab["id"].as_str().unwrap();
    let source=data(request(&app,&actor,"POST",&format!("/api/v1/lab/labs/{lab_id}/entities"),json!({"name":"Beaker A","definition_id":"labware","definition_version":"1.0","reality":"simulated","configuration":{"label":"rack A"},"representation_id":null})).await).await;
    let copy_path = format!(
        "/api/v1/lab/labs/{lab_id}/entities/{}/copies",
        source["id"].as_str().unwrap()
    );
    let input = json!({"expected_version":1,"name":"Beaker B","placement":{"position":[2,0.9,0],"rotation":[0,0,0],"scale":[1,1,1]}});
    let response = request(&app, &actor, "POST", &copy_path, input.clone()).await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let copied = data(response).await;
    assert_ne!(source["id"], copied["id"]);
    assert_eq!(copied["name"], "Beaker B");
    for field in [
        "definition",
        "definition_id",
        "definition_version",
        "configuration",
        "representation_id",
        "reality",
    ] {
        assert_eq!(copied[field], source[field]);
    }
    assert_eq!(copied["observation"], Value::Null);
    assert_eq!(copied["program_run"], Value::Null);
    let world_path = format!("/api/v1/lab/labs/{lab_id}/world");
    let before = data(request(&app, &actor, "GET", &world_path, Value::Null).await).await;
    assert_eq!(before["entities"].as_array().unwrap().len(), 2);
    assert_eq!(before["nodes"].as_array().unwrap().len(), 2);
    assert_eq!(before["nodes"][1]["entity_id"], copied["id"]);
    assert_eq!(before["relationships"], json!([]));
    assert_eq!(
        request(&app, &actor, "POST", &copy_path, input)
            .await
            .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        before,
        data(request(&app, &actor, "GET", &world_path, Value::Null).await).await
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn concurrent_saves_accept_one_version_and_invalid_or_unauthorized_layouts_leave_data_unchanged(
    pool: PgPool,
) {
    let app = labos_threejs_api::router(pool, Default::default());
    let _owner = register(&app, "layout-boundaries-owner@example.test").await;
    let member = register(&app, "layout-boundaries-member@example.test").await;
    let other = register(&app, "layout-boundaries-other@example.test").await;
    let lab = data(
        request(
            &app,
            &member,
            "POST",
            "/api/v1/lab/labs",
            json!({"name":"Layout boundaries"}),
        )
        .await,
    )
    .await;
    let lab_id = lab["id"].as_str().unwrap();
    let registered=data(request(&app,&member,"POST",&format!("/api/v1/lab/labs/{lab_id}/entities"),json!({"name":"Bench","definition_id":"bench","definition_version":"1.0","reality":"simulated","configuration":{},"representation_id":null})).await).await;
    let world_path = format!("/api/v1/lab/labs/{lab_id}/world");
    let layout_path = format!("/api/v1/lab/labs/{lab_id}/layout");
    let original = data(request(&app, &member, "GET", &world_path, Value::Null).await).await;
    let mut node = original["nodes"][0].clone();
    node.as_object_mut().unwrap().remove("lab_id");
    let body = json!({"expected_version":1,"nodes":[node.clone()]});
    let (one, two) = tokio::join!(
        request(&app, &member, "PUT", &layout_path, body.clone()),
        request(&app, &other, "PUT", &layout_path, body)
    );
    let mut statuses = [one.status(), two.status()];
    statuses.sort();
    assert_eq!(statuses, [StatusCode::OK, StatusCode::CONFLICT]);
    let before = data(request(&app, &member, "GET", &world_path, Value::Null).await).await;
    let mut bad_scale = node.clone();
    bad_scale["placement"]["scale"] = json!([0, 1, 1]);
    let mut bad_position = node.clone();
    bad_position["placement"]["position"] = json!([10001, 0, 0]);
    let mut missing_representation = node.clone();
    missing_representation["representation_id"] = json!(uuid::Uuid::now_v7().to_string());
    for nodes in [
        json!([node.clone(), node.clone()]),
        json!([bad_scale]),
        json!([bad_position]),
        json!([missing_representation]),
    ] {
        assert_eq!(
            request(
                &app,
                &member,
                "PUT",
                &layout_path,
                json!({"expected_version":2,"nodes":nodes})
            )
            .await
            .status(),
            StatusCode::BAD_REQUEST
        );
    }
    let spoofed = json!({"expected_version":2,"nodes":[node.clone()],"relationships":[{"id":uuid::Uuid::now_v7().to_string(),"source_id":registered["id"],"target_id":registered["id"],"kind":"contains","registered_by":registered["created_by"]}]});
    assert_eq!(
        request(&app, &member, "PUT", &layout_path, spoofed)
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    let body = json!({"expected_version":2,"nodes":[]});
    let no_csrf = app
        .clone()
        .oneshot(
            Request::put(&layout_path)
                .header("origin", "http://127.0.0.1:5173")
                .header("cookie", &member.cookie)
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(no_csrf.status(), StatusCode::FORBIDDEN);
    assert_eq!(
        bearer(&app, "invalid", "PUT", &layout_path, body.clone())
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let key = data(
        request(
            &app,
            &member,
            "POST",
            "/api/v1/api-keys",
            json!({"name":"Layout revoked key","scopes":["lab:full"],"expires_in_days":1}),
        )
        .await,
    )
    .await;
    request(
        &app,
        &member,
        "DELETE",
        &format!("/api/v1/api-keys/{}", key["key"]["id"].as_str().unwrap()),
        Value::Null,
    )
    .await;
    assert_eq!(
        bearer(
            &app,
            key["secret"].as_str().unwrap(),
            "PUT",
            &layout_path,
            body
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        before,
        data(request(&app, &other, "GET", &world_path, Value::Null).await).await
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn members_and_agent_register_independent_entities_and_reopen_the_same_world(pool: PgPool) {
    let app = labos_threejs_api::router(pool, Default::default());
    let _owner = register(&app, "world-owner@example.test").await;
    let member = register(&app, "world-member@example.test").await;
    let other = register(&app, "world-other@example.test").await;
    let created = request(
        &app,
        &member,
        "POST",
        "/api/v1/lab/labs",
        json!({"name":"Shared lab"}),
    )
    .await;
    assert_eq!(created.status(), StatusCode::CREATED);
    let lab = data(created).await;
    let path = format!("/api/v1/lab/labs/{}/entities", lab["id"].as_str().unwrap());
    let input = json!({"name":"Robot A","definition_id":"robot","definition_version":"1.0","reality":"simulated","configuration":{},"representation_id":null});
    let created = request(&app, &member, "POST", &path, input.clone()).await;
    assert_eq!(created.status(), StatusCode::CREATED);
    let first = data(created).await;
    let mut second_input = input;
    second_input["name"] = json!("Robot B");
    let second = data(request(&app, &other, "POST", &path, second_input).await).await;
    assert_ne!(first["id"], second["id"]);
    assert_eq!(first["definition"]["version"], "1.0");
    assert_eq!(first["observation"], Value::Null);
    assert_eq!(first["binding"], Value::Null);
    let world_path = format!("/api/v1/lab/labs/{}/world", lab["id"].as_str().unwrap());
    let opened = data(request(&app, &other, "GET", &world_path, Value::Null).await).await;
    assert_eq!(opened["entities"].as_array().unwrap().len(), 2);
    assert_eq!(opened["nodes"].as_array().unwrap().len(), 2);
    assert_ne!(opened["nodes"][0]["id"], opened["nodes"][0]["entity_id"]);
    let key = data(
        request(
            &app,
            &member,
            "POST",
            "/api/v1/api-keys",
            json!({"name":"World Agent","scopes":["lab:full"],"expires_in_days":1}),
        )
        .await,
    )
    .await;
    let agent_world = data(
        bearer(
            &app,
            key["secret"].as_str().unwrap(),
            "GET",
            &world_path,
            Value::Null,
        )
        .await,
    )
    .await;
    assert_eq!(opened, agent_world);
    let labs = data(
        bearer(
            &app,
            key["secret"].as_str().unwrap(),
            "GET",
            "/api/v1/lab/labs",
            Value::Null,
        )
        .await,
    )
    .await;
    assert_eq!(labs["data"][0]["id"], lab["id"]);
}

#[sqlx::test(migrations = "../../migrations")]
async fn explicit_relationships_keep_manual_provenance_and_reject_cycles_without_changes(
    pool: PgPool,
) {
    let app = labos_threejs_api::router(pool, Default::default());
    let actor = register(&app, "relations@example.test").await;
    let other = register(&app, "relations-other@example.test").await;
    let identity =
        data(request(&app, &actor, "GET", "/api/v1/auth/session", Value::Null).await).await;
    let lab = data(
        request(
            &app,
            &actor,
            "POST",
            "/api/v1/lab/labs",
            json!({"name":"Relations"}),
        )
        .await,
    )
    .await;
    let lab_id = lab["id"].as_str().unwrap();
    let mut ids = Vec::new();
    for (name, definition, reality) in [
        ("Bench", "bench", "simulated"),
        ("Beaker", "labware", "simulated"),
        ("Sim Robot", "robot", "simulated"),
        ("Physical Robot", "robot", "physical"),
    ] {
        let entity = data(request(&app,&actor,"POST",&format!("/api/v1/lab/labs/{lab_id}/entities"),json!({"name":name,"definition_id":definition,"definition_version":"1.0","reality":reality,"configuration":{},"representation_id":null})).await).await;
        ids.push(entity["id"].as_str().unwrap().to_owned());
    }
    let world_path = format!("/api/v1/lab/labs/{lab_id}/world");
    let layout_path = format!("/api/v1/lab/labs/{lab_id}/layout");
    let world = data(request(&app, &actor, "GET", &world_path, Value::Null).await).await;
    let nodes = world["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|node| {
            let mut node = node.clone();
            node.as_object_mut().unwrap().remove("lab_id");
            node
        })
        .collect::<Vec<_>>();
    let location = json!({"id":uuid::Uuid::now_v7().to_string(),"source_id":ids[1],"target_id":ids[0],"kind":"located_in"});
    let simulation = json!({"id":uuid::Uuid::now_v7().to_string(),"source_id":ids[2],"target_id":ids[3],"kind":"simulates"});
    let saved = request(&app,&actor,"PUT",&layout_path,json!({"expected_version":4,"nodes":nodes,"relationships":[location.clone(),simulation.clone()]})).await;
    assert_eq!(saved.status(), StatusCode::OK);
    let saved = data(saved).await;
    for relation in saved["relationships"].as_array().unwrap() {
        assert_eq!(relation["source"], "manual");
        assert_eq!(relation["registered_by"], identity["user"]["id"]);
        assert!(relation["registered_at"].is_string());
    }
    let mut moved = nodes.clone();
    moved[1]["placement"]["position"] = json!([3.0, 0.0, 2.0]);
    let moved = request(&app,&other,"PUT",&layout_path,json!({"expected_version":5,"nodes":moved,"relationships":[location.clone(),simulation.clone()]})).await;
    assert_eq!(moved.status(), StatusCode::OK);
    assert_eq!(data(moved).await["relationships"], saved["relationships"]);
    let before = data(request(&app, &actor, "GET", &world_path, Value::Null).await).await;
    let cycle = json!({"id":uuid::Uuid::now_v7().to_string(),"source_id":ids[1],"target_id":ids[0],"kind":"contains"});
    for relations in [
        json!([location.clone(), cycle]),
        json!([{"id":uuid::Uuid::now_v7().to_string(),"source_id":ids[1],"target_id":ids[1],"kind":"contains"}]),
        json!([{"id":uuid::Uuid::now_v7().to_string(),"source_id":ids[1],"target_id":ids[2],"kind":"located_in"}]),
        json!([{"id":uuid::Uuid::now_v7().to_string(),"source_id":ids[3],"target_id":ids[2],"kind":"simulates"}]),
        json!([{"id":uuid::Uuid::now_v7().to_string(),"source_id":ids[1],"target_id":uuid::Uuid::now_v7().to_string(),"kind":"located_in"}]),
    ] {
        assert_eq!(
            request(
                &app,
                &other,
                "PUT",
                &layout_path,
                json!({"expected_version":6,"nodes":nodes,"relationships":relations})
            )
            .await
            .status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            before,
            data(request(&app, &actor, "GET", &world_path, Value::Null).await).await
        );
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn world_filters_declarations_and_rejects_robot_actions_without_inventing_observations(
    pool: PgPool,
) {
    let app = labos_threejs_api::router(pool, Default::default());
    let actor = register(&app, "robot-world@example.test").await;
    let key = data(
        request(
            &app,
            &actor,
            "POST",
            "/api/v1/api-keys",
            json!({"name":"World Agent","scopes":["lab:full"],"expires_in_days":1}),
        )
        .await,
    )
    .await;
    let token = key["secret"].as_str().unwrap();
    let created = bearer(
        &app,
        token,
        "POST",
        "/api/v1/lab/labs",
        json!({"name":"Robot lab"}),
    )
    .await;
    assert_eq!(created.status(), StatusCode::CREATED);
    let lab = data(created).await;
    let lab_id = lab["id"].as_str().unwrap();
    let path = format!("/api/v1/lab/labs/{lab_id}/entities");
    for (name, definition, reality) in [
        ("Simulated robot", "robot", "simulated"),
        ("Physical robot", "robot", "physical"),
        ("Bench", "bench", "simulated"),
    ] {
        assert_eq!(bearer(&app, token, "POST", &path, json!({"name":name,"definition_id":definition,"definition_version":"1.0","reality":reality,"configuration":{},"representation_id":null})).await.status(), StatusCode::CREATED);
    }
    let world_path = format!("/api/v1/lab/labs/{lab_id}/world");
    let filtered = data(
        request(
            &app,
            &actor,
            "GET",
            &format!("{world_path}?kind=robot&capability=robot.pick&state=unknown"),
            Value::Null,
        )
        .await,
    )
    .await;
    assert_eq!(filtered["entities"].as_array().unwrap().len(), 2);
    let robots = filtered["entities"].as_array().unwrap();
    assert_ne!(robots[0]["id"], robots[1]["id"]);
    for robot in robots {
        assert_eq!(robot["observation"], Value::Null);
        assert_eq!(robot["binding"], Value::Null);
        for capability in ["robot.move", "robot.pick", "robot.place"] {
            let status = robot["capabilities"]
                .as_array()
                .unwrap()
                .iter()
                .find(|entry| entry["id"] == capability)
                .unwrap();
            assert_eq!(status["definition_supported"], true);
            assert_eq!(status["binding_implemented"], false);
            assert_eq!(status["executable"], false);
            assert_eq!(status["reason"], "binding_not_implemented");
            let action = format!(
                "/api/v1/lab/labs/{lab_id}/entities/{}/actions",
                robot["id"].as_str().unwrap()
            );
            let response = bearer(
                &app,
                token,
                "POST",
                &action,
                json!({"capability":capability,"parameters":{}}),
            )
            .await;
            assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
            assert_eq!(
                data(response).await["error"]["code"],
                "lab.capability_not_implemented"
            );
        }
    }
    let after = data(
        request(
            &app,
            &actor,
            "GET",
            &format!("{world_path}?kind=robot&capability=robot.pick&state=unknown"),
            Value::Null,
        )
        .await,
    )
    .await;
    assert_eq!(filtered, after);
}

#[sqlx::test(migrations = "../../migrations")]
async fn references_configuration_and_credentials_are_checked_before_world_changes(pool: PgPool) {
    let app = labos_threejs_api::router(pool, Default::default());
    let actor = register(&app, "references@example.test").await;
    let lab = data(
        request(
            &app,
            &actor,
            "POST",
            "/api/v1/lab/labs",
            json!({"name":"References"}),
        )
        .await,
    )
    .await;
    let lab_id = lab["id"].as_str().unwrap();
    let path = format!("/api/v1/lab/labs/{lab_id}/entities");
    let mut input = json!({"name":"Bench","definition_id":"bench","definition_version":"missing","reality":"simulated","configuration":{},"representation_id":null});
    assert_eq!(
        request(&app, &actor, "POST", &path, input.clone())
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    input["definition_version"] = json!("1.0");
    input["representation_id"] = json!(uuid::Uuid::now_v7().to_string());
    assert_eq!(
        request(&app, &actor, "POST", &path, input.clone())
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    let world_path = format!("/api/v1/lab/labs/{lab_id}/world");
    let empty = data(request(&app, &actor, "GET", &world_path, Value::Null).await).await;
    assert_eq!(empty["entities"], json!([]));
    assert_eq!(empty["lab"]["layout_version"], 0);
    input["representation_id"] = Value::Null;
    let first = data(request(&app, &actor, "POST", &path, input).await).await;
    let entity_path = format!("{path}/{}", first["id"].as_str().unwrap());
    let configured = data(
        request(
            &app,
            &actor,
            "PATCH",
            &entity_path,
            json!({"name":"Bench A","configuration":{"label":"north"}}),
        )
        .await,
    )
    .await;
    assert_eq!(configured["id"], first["id"]);
    assert_eq!(configured["definition"], first["definition"]);
    assert_eq!(configured["configuration"], json!({"label":"north"}));
    let node_path = format!("/api/v1/lab/labs/{lab_id}/nodes");
    let node = json!({"entity_id":first["id"],"representation_id":null,"placement":{"position":[3,0,0],"rotation":[0,0,0],"scale":[1,1,1]}});
    let added = request(&app, &actor, "POST", &node_path, node.clone()).await;
    assert_eq!(added.status(), StatusCode::CREATED);
    let second_lab = data(
        request(
            &app,
            &actor,
            "POST",
            "/api/v1/lab/labs",
            json!({"name":"Other lab"}),
        )
        .await,
    )
    .await;
    assert_eq!(
        request(
            &app,
            &actor,
            "POST",
            &format!(
                "/api/v1/lab/labs/{}/nodes",
                second_lab["id"].as_str().unwrap()
            ),
            node
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );
    let mut invalid_node = json!({"entity_id":first["id"],"representation_id":null,"placement":{"position":[0,0,0],"rotation":[0,0,0],"scale":[0,1,1]}});
    assert_eq!(
        request(&app, &actor, "POST", &node_path, invalid_node.clone())
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    invalid_node["placement"]["scale"] = json!([1, 1, 1]);
    invalid_node["representation_id"] = json!(uuid::Uuid::now_v7().to_string());
    assert_eq!(
        request(&app, &actor, "POST", &node_path, invalid_node)
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    let before = data(request(&app, &actor, "GET", &world_path, Value::Null).await).await;
    assert_eq!(before["entities"].as_array().unwrap().len(), 1);
    assert_eq!(before["nodes"].as_array().unwrap().len(), 2);
    assert_eq!(before["lab"]["layout_version"], 2);
    let no_csrf = app.clone().oneshot(Request::post(&path).header("origin","http://127.0.0.1:5173").header("cookie",&actor.cookie).header("content-type","application/json").body(Body::from(json!({"name":"Denied","definition_id":"bench","definition_version":"1.0","reality":"simulated","configuration":{}}).to_string())).unwrap()).await.unwrap();
    assert_eq!(no_csrf.status(), StatusCode::FORBIDDEN);
    let bad_bearer = app
        .clone()
        .oneshot(
            Request::patch(&entity_path)
                .header("authorization", "Bearer invalid")
                .header("cookie", &actor.cookie)
                .header("x-csrf-token", &actor.csrf)
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"name":"Denied","configuration":{}}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(bad_bearer.status(), StatusCode::UNAUTHORIZED);
    let key = data(
        request(
            &app,
            &actor,
            "POST",
            "/api/v1/api-keys",
            json!({"name":"Revoked","scopes":["lab:full"],"expires_in_days":1}),
        )
        .await,
    )
    .await;
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
    assert_eq!(
        bearer(
            &app,
            key["secret"].as_str().unwrap(),
            "PATCH",
            &entity_path,
            json!({"name":"Denied","configuration":{}})
        )
        .await
        .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        before,
        data(request(&app, &actor, "GET", &world_path, Value::Null).await).await
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn concurrent_browser_refreshes_do_not_fail_world_snapshots(pool: PgPool) {
    let app = labos_threejs_api::router(pool, Default::default());
    let actor = register(&app, "concurrent-world@example.test").await;
    let lab = data(
        request(
            &app,
            &actor,
            "POST",
            "/api/v1/lab/labs",
            json!({"name":"Concurrent lab"}),
        )
        .await,
    )
    .await;
    let world = format!("/api/v1/lab/labs/{}/world", lab["id"].as_str().unwrap());
    for _ in 0..20 {
        let (snapshot, session, labs, definitions) = tokio::join!(
            request(&app, &actor, "GET", &world, Value::Null),
            request(&app, &actor, "GET", "/api/v1/auth/session", Value::Null),
            request(&app, &actor, "GET", "/api/v1/lab/labs", Value::Null),
            request(
                &app,
                &actor,
                "GET",
                "/api/v1/lab/asset-definitions",
                Value::Null
            )
        );
        assert_eq!(session.status(), StatusCode::OK);
        assert_eq!(labs.status(), StatusCode::OK);
        assert_eq!(definitions.status(), StatusCode::OK);
        assert_eq!(snapshot.status(), StatusCode::OK);
        assert_eq!(data(snapshot).await["lab"]["id"], lab["id"]);
    }
}
