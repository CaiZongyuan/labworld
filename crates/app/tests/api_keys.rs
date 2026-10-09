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

#[sqlx::test(migrations = "../../migrations")]
async fn a_key_secret_is_returned_only_by_creation_and_never_by_the_private_list(pool: PgPool) {
    let app = labos_threejs_app::router(pool);
    let owner = register(&app, "key-owner@example.com").await;
    let other = register(&app, "key-other@example.com").await;
    let response = request(
        &app,
        &owner,
        "POST",
        "/api/v1/api-keys",
        json!({"name":"My script", "scopes":["profile:read"], "expires_in_days":30}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    assert_eq!(response.headers()["cache-control"], "no-store");
    let created = data(response).await;
    let secret = created["secret"].as_str().unwrap();
    assert!(secret.len() >= 64);
    assert_eq!(created["key"]["name"], "My script");
    assert_eq!(created["key"]["scopes"], json!(["profile:read"]));
    assert_eq!(created["key"]["user_id"], owner.id);
    assert!(created["key"]["expires_at"].is_string());
    let list = data(request(&app, &owner, "GET", "/api/v1/api-keys", json!(null)).await).await;
    assert_eq!(list["data"].as_array().unwrap().len(), 1);
    assert_eq!(list["data"][0]["id"], created["key"]["id"]);
    assert!(!list.to_string().contains(secret));
    assert!(list["data"][0].get("secret_hash").is_none());
    assert!(list["data"][0].get("secret").is_none());
    assert_eq!(
        data(request(&app, &other, "GET", "/api/v1/api-keys", json!(null)).await).await["data"],
        json!([])
    );
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
async fn create_key(app: &Router, owner: &Browser) -> Value {
    let response = request(
        app,
        owner,
        "POST",
        "/api/v1/api-keys",
        json!({"name":"Profile script", "scopes":["profile:read"], "expires_in_days":30}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    data(response).await
}
#[sqlx::test(migrations = "../../migrations")]
async fn a_bearer_key_reads_only_its_current_profile_and_stops_after_owner_revocation(
    pool: PgPool,
) {
    let app = labos_threejs_app::router(pool);
    let owner = register(&app, "key-profile@example.com").await;
    let other = register(&app, "other-profile@example.com").await;
    let key = create_key(&app, &owner).await;
    let secret = key["secret"].as_str().unwrap();
    let profile = bearer(&app, "GET", "/api/v1/profile", secret).await;
    assert_eq!(profile.status(), StatusCode::OK);
    assert_eq!(data(profile).await["id"], owner.id);
    assert_eq!(
        bearer(&app, "GET", "/api/v1/api-keys", secret)
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        bearer(&app, "GET", "/api/v1/auth/session", secret)
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let privilege_attempt = app
        .clone()
        .oneshot(
            Request::put(format!("/api/v1/organization/members/{}", other.id))
                .header("authorization", format!("Bearer {secret}"))
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"role":"admin", "active":true, "version":1}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(privilege_attempt.status(), StatusCode::UNAUTHORIZED);
    let revoke = format!("/api/v1/api-keys/{}", key["key"]["id"].as_str().unwrap());
    assert_eq!(
        request(&app, &other, "DELETE", &revoke, json!(null))
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request(&app, &owner, "DELETE", &revoke, json!(null))
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        bearer(&app, "GET", "/api/v1/profile", secret)
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(&app, &owner, "DELETE", &revoke, json!(null))
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    let list = data(request(&app, &owner, "GET", "/api/v1/api-keys", json!(null)).await).await;
    assert!(list["data"][0]["revoked_at"].is_string());
    assert!(list["data"][0]["last_used_at"].is_string());
}

#[sqlx::test(migrations = "../../migrations")]
async fn key_inventory_has_available_scopes_and_bounded_owner_scoped_pages(pool: PgPool) {
    let app = labos_threejs_app::router(pool);
    let owner = register(&app, "key-pages@example.com").await;
    let other = register(&app, "key-pages-other@example.com").await;
    let scopes = request(&app, &owner, "GET", "/api/v1/api-keys/scopes", json!(null)).await;
    assert_eq!(scopes.status(), StatusCode::OK);
    let scopes = data(scopes).await;
    assert_eq!(scopes["data"][0]["id"], "profile:read");
    for _ in 0..3 {
        create_key(&app, &owner).await;
    }
    let first =
        data(request(&app, &owner, "GET", "/api/v1/api-keys?limit=2", json!(null)).await).await;
    assert_eq!(first["data"].as_array().unwrap().len(), 2);
    assert_eq!(first["has_more"], true);
    let cursor = first["next_cursor"].as_str().unwrap();
    let path = format!("/api/v1/api-keys?limit=2&cursor={cursor}");
    let second = data(request(&app, &owner, "GET", &path, json!(null)).await).await;
    assert_eq!(second["data"].as_array().unwrap().len(), 1);
    assert_ne!(first["data"][0]["id"], second["data"][0]["id"]);
    assert_eq!(
        request(&app, &other, "GET", &path, json!(null))
            .await
            .status(),
        StatusCode::BAD_REQUEST
    );
    for query in ["limit=0", "limit=101", "cursor=garbage"] {
        assert_eq!(
            request(
                &app,
                &owner,
                "GET",
                &format!("/api/v1/api-keys?{query}"),
                json!(null)
            )
            .await
            .status(),
            StatusCode::BAD_REQUEST
        );
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn expired_keys_and_disabled_creators_stop_working_and_invalid_bearer_never_falls_back_to_cookie(
    pool: PgPool,
) {
    let app = labos_threejs_app::router(pool.clone());
    let owner = register(&app, "control-keys@example.com").await;
    let member = register(&app, "disable-keys@example.com").await;
    let expired = create_key(&app, &member).await;
    let secret = expired["secret"].as_str().unwrap();
    assert_eq!(
        bearer(&app, "GET", "/api/v1/profile", secret)
            .await
            .status(),
        StatusCode::OK
    );
    sqlx::query("UPDATE labos_threejs_core.api_keys SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1::uuid").bind(expired["key"]["id"].as_str().unwrap()).execute(&pool).await.unwrap();
    assert_eq!(
        bearer(&app, "GET", "/api/v1/profile", secret)
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let active = create_key(&app, &member).await;
    let secret = active["secret"].as_str().unwrap();
    for invalid in [
        "invalid".to_owned(),
        secret[..secret.len() - 1].to_owned(),
        format!("{secret}0"),
        format!("{}g", &secret[..secret.len() - 1]),
    ] {
        let rejected = app
            .clone()
            .oneshot(
                Request::get("/api/v1/profile")
                    .header("cookie", &owner.cookie)
                    .header("authorization", format!("Bearer {invalid}"))
                    .body(Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(rejected.status(), StatusCode::UNAUTHORIZED);
    }
    let rejected = app
        .clone()
        .oneshot(
            Request::get("/api/v1/api-keys")
                .header("cookie", &owner.cookie)
                .header("authorization", format!("Bearer {secret}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(rejected.status(), StatusCode::UNAUTHORIZED);
    let path = format!("/api/v1/organization/members/{}", member.id);
    assert_eq!(
        request(
            &app,
            &owner,
            "PUT",
            &path,
            json!({"role":"member", "active":false, "version":1})
        )
        .await
        .status(),
        StatusCode::OK
    );
    let denied = bearer(&app, "GET", "/api/v1/profile", secret).await;
    assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
    assert!(!data(denied).await.to_string().contains(secret));
}

#[sqlx::test(migrations = "../../migrations")]
async fn key_mutations_require_csrf_and_audit_and_the_one_time_response_is_not_replayed(
    pool: PgPool,
) {
    let app = labos_threejs_app::router(pool.clone());
    let owner = register(&app, "atomic-keys@example.com").await;
    let input = json!({"name":"Atomic", "scopes":["profile:read"], "expires_in_days":30});
    let wrong_csrf = Browser {
        id: owner.id.clone(),
        cookie: owner.cookie.clone(),
        csrf: "wrong".into(),
    };
    assert_eq!(
        request(&app, &wrong_csrf, "POST", "/api/v1/api-keys", input.clone())
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    sqlx::raw_sql("CREATE FUNCTION reject_key_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action LIKE 'api_keys.%' THEN RAISE EXCEPTION 'test key audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_key_audit BEFORE INSERT ON labos_threejs_core.audit_events FOR EACH ROW EXECUTE FUNCTION reject_key_audit();").execute(&pool).await.unwrap();
    assert_eq!(
        request(&app, &owner, "POST", "/api/v1/api-keys", input.clone())
            .await
            .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        data(request(&app, &owner, "GET", "/api/v1/api-keys", json!(null)).await).await["data"],
        json!([])
    );
    sqlx::query("DROP TRIGGER reject_key_audit ON labos_threejs_core.audit_events")
        .execute(&pool)
        .await
        .unwrap();
    let first = data(
        request_key(
            &app,
            &owner,
            "POST",
            "/api/v1/api-keys",
            input.clone(),
            "not-a-secret-replay",
        )
        .await,
    )
    .await;
    let second = data(
        request_key(
            &app,
            &owner,
            "POST",
            "/api/v1/api-keys",
            input,
            "not-a-secret-replay",
        )
        .await,
    )
    .await;
    assert!(
        first["secret"] != second["secret"],
        "creating again must issue a fresh secret, never replay it"
    );
    assert_ne!(first["key"]["id"], second["key"]["id"]);
    let secret = first["secret"].as_str().unwrap();
    let revoke = format!("/api/v1/api-keys/{}", first["key"]["id"].as_str().unwrap());
    assert_eq!(
        request(&app, &wrong_csrf, "DELETE", &revoke, json!(null))
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    sqlx::query("CREATE TRIGGER reject_key_audit BEFORE INSERT ON labos_threejs_core.audit_events FOR EACH ROW EXECUTE FUNCTION reject_key_audit()").execute(&pool).await.unwrap();
    assert_eq!(
        request(&app, &owner, "DELETE", &revoke, json!(null))
            .await
            .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        bearer(&app, "GET", "/api/v1/profile", secret)
            .await
            .status(),
        StatusCode::OK
    );
    let events = data(
        request(
            &app,
            &owner,
            "GET",
            "/api/v1/audit-events?action=api_keys.create",
            json!(null),
        )
        .await,
    )
    .await;
    assert_eq!(events["data"].as_array().unwrap().len(), 2);
    assert!(!events.to_string().contains(secret));
    assert_eq!(events["data"][0]["metadata"], json!({}));
}

#[sqlx::test(migrations = "../../migrations")]
async fn key_creation_rejects_unknown_scopes_expiry_and_identity_overrides(pool: PgPool) {
    let app = labos_threejs_app::router(pool);
    let owner = register(&app, "validate-keys@example.com").await;
    for input in [
        json!({"name":" ","scopes":["profile:read"],"expires_in_days":30}),
        json!({"name":"Key","scopes":[],"expires_in_days":30}),
        json!({"name":"Key","scopes":["admin:write"],"expires_in_days":30}),
        json!({"name":"Key","scopes":["profile:read"],"expires_in_days":0}),
        json!({"name":"Key","scopes":["profile:read"],"expires_in_days":366}),
    ] {
        assert_eq!(
            request(&app, &owner, "POST", "/api/v1/api-keys", input)
                .await
                .status(),
            StatusCode::BAD_REQUEST
        );
    }
    assert_eq!(
        request(
            &app,
            &owner,
            "POST",
            "/api/v1/api-keys",
            json!({"name":"Key","scopes":["profile:read"],"expires_in_days":30,"user_id":owner.id})
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );
}
