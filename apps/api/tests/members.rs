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
async fn json_body(response: Response) -> Value {
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
    let body = json_body(response).await;
    Browser {
        id: body["user"]["id"].as_str().unwrap().into(),
        cookie,
        csrf: body["csrf_token"].as_str().unwrap().into(),
    }
}
async fn get(app: &Router, actor: &Browser, path: &str) -> Response {
    app.clone()
        .oneshot(
            Request::get(path)
                .header("cookie", &actor.cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
}
async fn change(
    app: &Router,
    actor: &Browser,
    target: &Browser,
    role: &str,
    active: bool,
    version: i64,
) -> Response {
    app.clone()
        .oneshot(
            Request::put(format!("/api/v1/organization/members/{}", target.id))
                .header("origin", "http://127.0.0.1:5173")
                .header("content-type", "application/json")
                .header("cookie", &actor.cookie)
                .header("x-csrf-token", &actor.csrf)
                .body(Body::from(
                    json!({"role":role,"active":active,"version":version}).to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap()
}

#[sqlx::test(migrations = "../../migrations")]
async fn an_inflight_login_cannot_escape_a_concurrent_membership_disable(pool: PgPool) {
    let app = labos_threejs_api::router(pool.clone(), Default::default());
    let owner = register(&app, "owner@example.com").await;
    let member = register(&app, "member@example.com").await;
    sqlx::query("CREATE FUNCTION gate_session_insert() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_advisory_xact_lock(9090); RETURN NEW; END $$").execute(&pool).await.unwrap();
    sqlx::query("CREATE TRIGGER wait_session_insert BEFORE INSERT ON labos_threejs_core.sessions FOR EACH ROW EXECUTE FUNCTION gate_session_insert()").execute(&pool).await.unwrap();
    let mut gate = pool.begin().await.unwrap();
    sqlx::query("SELECT pg_advisory_xact_lock(9090)")
        .execute(&mut *gate)
        .await
        .unwrap();
    let login = app.clone().oneshot(
        Request::post("/api/v1/auth/login")
            .header("origin", "http://127.0.0.1:5173")
            .header("content-type", "application/json")
            .body(Body::from(
                json!({"email":"member@example.com","password":"a-long-test-password"}).to_string(),
            ))
            .unwrap(),
    );
    let disable = async {
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                let waiting: i64 = sqlx::query_scalar("SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event = 'advisory'").fetch_one(&pool).await.unwrap();
                if waiting > 0 { break; }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        }).await.expect("login reaches session insert");
        change(&app, &owner, &member, "member", false, 1).await
    };
    let release = async {
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                let waiting: i64 = sqlx::query_scalar("SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'").fetch_one(&pool).await.unwrap();
                if waiting >= 2 { break; }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        }).await.expect("disable waits for the login membership lock");
        gate.rollback().await.unwrap();
    };
    let (login, disabled, ()) = tokio::join!(login, disable, release);
    let login = login.unwrap();
    assert_eq!(login.status(), StatusCode::OK);
    assert_eq!(disabled.status(), StatusCode::OK);
    let cookie = login.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let session = json_body(login).await;
    let raced = Browser {
        id: member.id.clone(),
        cookie,
        csrf: session["csrf_token"].as_str().unwrap().into(),
    };
    assert_eq!(
        change(&app, &owner, &member, "member", true, 2)
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        get(&app, &raced, "/api/v1/auth/session").await.status(),
        StatusCode::UNAUTHORIZED
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn two_owners_concurrently_leaving_preserves_exactly_one_owner(pool: PgPool) {
    let app = labos_threejs_api::router(pool.clone(), Default::default());
    let a = register(&app, "owner-a@example.com").await;
    let b = register(&app, "owner-b@example.com").await;
    assert_eq!(
        change(&app, &a, &b, "owner", true, 1).await.status(),
        StatusCode::OK
    );
    let mut gate = pool.begin().await.unwrap();
    sqlx::query("SELECT id FROM labos_threejs_core.organizations WHERE id = 1 FOR UPDATE")
        .execute(&mut *gate)
        .await
        .unwrap();
    let release = async {
        tokio::time::timeout(std::time::Duration::from_secs(3), async {
            loop {
                let waiting: i64 = sqlx::query_scalar("SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'").fetch_one(&pool).await.unwrap();
                if waiting >= 2 { break; }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        }).await.expect("both owner changes must reach the coordination row");
        gate.rollback().await.unwrap();
    };
    let (first, second, ()) = tokio::join!(
        change(&app, &a, &a, "member", true, 1),
        change(&app, &b, &b, "member", true, 2),
        release
    );
    let statuses = [first.status(), second.status()];
    assert_eq!(statuses.iter().filter(|s| **s == StatusCode::OK).count(), 1);
    assert_eq!(
        statuses
            .iter()
            .filter(|s| **s == StatusCode::UNPROCESSABLE_ENTITY)
            .count(),
        1
    );
    let states = [
        json_body(get(&app, &a, "/api/v1/auth/session").await).await,
        json_body(get(&app, &b, "/api/v1/auth/session").await).await,
    ];
    assert_eq!(
        states
            .iter()
            .filter(|s| s["user"]["role"] == "owner")
            .count(),
        1
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn member_management_enforces_admin_and_member_boundaries(pool: PgPool) {
    let app = labos_threejs_api::router(pool, Default::default());
    let owner = register(&app, "owner@example.com").await;
    let admin = register(&app, "admin@example.com").await;
    let member = register(&app, "member@example.com").await;
    assert_eq!(
        change(&app, &owner, &admin, "admin", true, 1)
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        get(&app, &member, "/api/v1/organization/members")
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        change(&app, &member, &member, "admin", true, 1)
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        change(&app, &admin, &owner, "member", true, 1)
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        change(&app, &admin, &member, "owner", true, 1)
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    let page = json_body(get(&app, &admin, "/api/v1/organization/members?limit=1").await).await;
    assert_eq!(page["assignable_roles"], json!(["admin", "member"]));
    assert_eq!(page["data"][0]["can_edit"], false);
    let cursor = page["next_cursor"].as_str().unwrap();
    assert_eq!(
        get(
            &app,
            &owner,
            &format!("/api/v1/organization/members?cursor={cursor}")
        )
        .await
        .status(),
        StatusCode::BAD_REQUEST
    );
    let next = json_body(
        get(
            &app,
            &admin,
            &format!("/api/v1/organization/members?cursor={cursor}"),
        )
        .await,
    )
    .await;
    assert_eq!(next["data"].as_array().unwrap().len(), 2);
    assert_eq!(
        change(&app, &admin, &member, "member", false, 1)
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        get(&app, &member, "/api/v1/auth/session").await.status(),
        StatusCode::UNAUTHORIZED
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn a_failed_member_audit_rolls_back_role_active_state_and_session_revocation(pool: PgPool) {
    let app = labos_threejs_api::router(pool.clone(), Default::default());
    let owner = register(&app, "owner@example.com").await;
    let member = register(&app, "member@example.com").await;
    sqlx::query("CREATE FUNCTION reject_member_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'organization.member.update' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$").execute(&pool).await.unwrap();
    sqlx::query("CREATE TRIGGER fail_member_audit BEFORE INSERT ON labos_threejs_core.audit_events FOR EACH ROW EXECUTE FUNCTION reject_member_audit()").execute(&pool).await.unwrap();
    assert_eq!(
        change(&app, &owner, &member, "admin", false, 1)
            .await
            .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        json_body(get(&app, &member, "/api/v1/auth/session").await).await["user"]["role"],
        "member"
    );
    sqlx::query("DROP TRIGGER fail_member_audit ON labos_threejs_core.audit_events")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        change(&app, &owner, &member, "admin", true, 1)
            .await
            .status(),
        StatusCode::OK
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn disabling_and_reenabling_a_member_never_revives_their_old_session(pool: PgPool) {
    let app = labos_threejs_api::router(pool, Default::default());
    let owner = register(&app, "owner@example.com").await;
    let member = register(&app, "member@example.com").await;
    assert_eq!(
        change(&app, &owner, &member, "member", false, 1)
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        get(&app, &member, "/api/v1/auth/session").await.status(),
        StatusCode::UNAUTHORIZED
    );
    let duplicate = app
        .clone()
        .oneshot(
            Request::post("/api/v1/auth/register")
                .header("origin", "http://127.0.0.1:5173")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"email":"MEMBER@example.com","password":"a-different-password"})
                        .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(duplicate.status(), StatusCode::CONFLICT);
    assert_eq!(
        change(&app, &owner, &member, "member", true, 2)
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        get(&app, &member, "/api/v1/auth/session").await.status(),
        StatusCode::UNAUTHORIZED
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn the_last_active_owner_cannot_be_disabled_or_demoted(pool: PgPool) {
    let app = labos_threejs_api::router(pool, Default::default());
    let owner = register(&app, "owner@example.com").await;
    let demoted = change(&app, &owner, &owner, "member", true, 1).await;
    assert_eq!(demoted.status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        json_body(demoted).await["error"]["code"],
        "organization.last_owner"
    );
    assert_eq!(
        change(&app, &owner, &owner, "owner", false, 1)
            .await
            .status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        json_body(get(&app, &owner, "/api/v1/auth/session").await).await["user"]["role"],
        "owner"
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn owner_lists_members_and_promotes_an_admin_with_version_protection(pool: PgPool) {
    let app = labos_threejs_api::router(pool, Default::default());
    let owner = register(&app, "owner@example.com").await;
    let member = register(&app, "member@example.com").await;
    let listed = get(&app, &owner, "/api/v1/organization/members").await;
    assert_eq!(listed.status(), StatusCode::OK);
    let page = json_body(listed).await;
    assert_eq!(page["data"].as_array().unwrap().len(), 2);
    assert_eq!(
        page["assignable_roles"],
        json!(["owner", "admin", "member"])
    );
    let promoted = change(&app, &owner, &member, "admin", true, 1).await;
    assert_eq!(promoted.status(), StatusCode::OK);
    assert_eq!(json_body(promoted).await["version"], 2);
    assert_eq!(
        json_body(get(&app, &member, "/api/v1/auth/session").await).await["user"]["role"],
        "admin"
    );
    assert_eq!(
        change(&app, &owner, &member, "member", true, 1)
            .await
            .status(),
        StatusCode::CONFLICT
    );
}
