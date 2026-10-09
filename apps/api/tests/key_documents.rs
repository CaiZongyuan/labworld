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
    let result = data(response).await;
    Browser {
        id: result["user"]["id"].as_str().unwrap().into(),
        cookie,
        csrf: result["csrf_token"].as_str().unwrap().into(),
    }
}
async fn request(app: &Router, actor: &Browser, method: &str, path: &str, body: Value) -> Response {
    request_key(
        app,
        actor,
        method,
        path,
        body,
        &uuid::Uuid::now_v7().to_string(),
    )
    .await
}
async fn request_key(
    app: &Router,
    actor: &Browser,
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
                .header("cookie", &actor.cookie)
                .header("x-csrf-token", &actor.csrf)
                .header("idempotency-key", key)
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap()
}

async fn bearer(app: &Router, method: &str, path: &str, secret: &str) -> Response {
    app.clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("authorization", format!("Bearer {secret}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
}
#[sqlx::test(migrations = "../../migrations")]
async fn key_scopes_intersect_the_creators_current_library_grants(pool: PgPool) {
    let app = labos_threejs_api::router(pool, Default::default());
    let owner = register(&app, "key-library-owner@example.com").await;
    let reader = register(&app, "key-library-reader@example.com").await;
    let doc = data(
        request(
            &app,
            &owner,
            "POST",
            "/api/v1/knowledge/documents",
            json!({"title":"Private", "markdown":"authorized text"}),
        )
        .await,
    )
    .await;
    let path = format!(
        "/api/v1/knowledge/documents/{}",
        doc["id"].as_str().unwrap()
    );
    let created = request(
        &app,
        &reader,
        "POST",
        "/api/v1/api-keys",
        json!({"name":"Document script", "scopes":["knowledge:read"], "expires_in_days":30}),
    )
    .await;
    assert_eq!(created.status(), StatusCode::CREATED);
    let key = data(created).await;
    let secret = key["secret"].as_str().unwrap();
    assert_eq!(
        bearer(&app, "GET", &path, secret).await.status(),
        StatusCode::NOT_FOUND
    );
    let grant = format!(
        "/api/v1/knowledge/bases/{}/grants/{}",
        doc["knowledge_base_id"].as_str().unwrap(),
        reader.id
    );
    assert_eq!(
        request(&app, &owner, "PUT", &grant, json!({"access":"editor"}))
            .await
            .status(),
        StatusCode::OK
    );
    let document = bearer(&app, "GET", &path, secret).await;
    assert_eq!(document.status(), StatusCode::OK);
    let document = data(document).await;
    assert_eq!(document["markdown"], "authorized text");
    assert_eq!(document["can_edit"], false);
    let page = data(
        bearer(
            &app,
            "GET",
            &format!(
                "/api/v1/knowledge/documents?knowledge_base_id={}",
                doc["knowledge_base_id"].as_str().unwrap()
            ),
            secret,
        )
        .await,
    )
    .await;
    assert_eq!(page["data"].as_array().unwrap().len(), 1);
    assert_eq!(page["can_create"], false);
    assert_eq!(
        bearer(&app, "GET", "/api/v1/profile", secret)
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        bearer(&app, "DELETE", &path, secret).await.status(),
        StatusCode::UNAUTHORIZED
    );
    let profile = data(
        request(
            &app,
            &reader,
            "POST",
            "/api/v1/api-keys",
            json!({"name":"Profile only", "scopes":["profile:read"], "expires_in_days":30}),
        )
        .await,
    )
    .await;
    assert_eq!(
        bearer(&app, "GET", &path, profile["secret"].as_str().unwrap())
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request(&app, &owner, "DELETE", &grant, json!(null))
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        bearer(&app, "GET", &path, secret).await.status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        bearer(
            &app,
            "GET",
            &format!(
                "/api/v1/knowledge/documents?knowledge_base_id={}",
                doc["knowledge_base_id"].as_str().unwrap()
            ),
            secret
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn a_real_http_script_reads_with_a_key_then_receives_unauthorized_after_revocation(
    pool: PgPool,
) {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let app = labos_threejs_api::router(
        pool,
        labos_threejs_platform::config::AuthSettings {
            origin: origin.clone(),
            ..Default::default()
        },
    );
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(5))
        .build()
        .unwrap();
    let response = client
        .post(format!("{origin}/api/v1/auth/register"))
        .header("origin", &origin)
        .json(&json!({"email":"http-key-script@example.com","password":"a-long-test-password"}))
        .send()
        .await
        .expect("registration transport failed");
    assert_eq!(response.status().as_u16(), 201);
    let cookie = response.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let identity: Value = response
        .json()
        .await
        .expect("registration response invalid");
    let csrf = identity["csrf_token"].as_str().unwrap();
    let response = client
        .post(format!("{origin}/api/v1/knowledge/documents"))
        .header("origin", &origin)
        .header("cookie", &cookie)
        .header("x-csrf-token", csrf)
        .header("idempotency-key", "script-document")
        .json(&json!({"title":"Script read", "markdown":"read via actual HTTP"}))
        .send()
        .await
        .expect("document transport failed");
    assert_eq!(response.status().as_u16(), 201);
    let document: Value = response.json().await.expect("document response invalid");
    let response = client
        .post(format!("{origin}/api/v1/api-keys"))
        .header("origin", &origin)
        .header("cookie", &cookie)
        .header("x-csrf-token", csrf)
        .json(&json!({"name":"Actual script","scopes":["knowledge:read"],"expires_in_days":30}))
        .send()
        .await
        .expect("key creation transport failed");
    assert_eq!(response.status().as_u16(), 201);
    let issued: Value = response.json().await.expect("key response invalid");
    let token = issued["secret"].as_str().unwrap();
    let document_url = format!(
        "{origin}/api/v1/knowledge/documents/{}",
        document["id"].as_str().unwrap()
    );
    let response = client
        .get(&document_url)
        .bearer_auth(token)
        .send()
        .await
        .expect("script transport failed");
    assert_eq!(response.status().as_u16(), 200);
    let read: Value = response.json().await.expect("read response invalid");
    assert_eq!(read["markdown"], "read via actual HTTP");
    let response = client
        .delete(format!(
            "{origin}/api/v1/api-keys/{}",
            issued["key"]["id"].as_str().unwrap()
        ))
        .header("origin", &origin)
        .header("cookie", &cookie)
        .header("x-csrf-token", csrf)
        .send()
        .await
        .expect("revocation transport failed");
    assert_eq!(response.status().as_u16(), 204);
    let response = client
        .get(&document_url)
        .bearer_auth(token)
        .send()
        .await
        .expect("denial transport failed");
    assert_eq!(response.status().as_u16(), 401);
    server.abort();
}
