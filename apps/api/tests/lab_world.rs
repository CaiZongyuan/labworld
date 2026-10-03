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
