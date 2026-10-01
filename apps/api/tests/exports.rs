use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
    response::Response,
};
use http_body_util::BodyExt;
use labos_threejs_app::modules::files::{FilePolicy, FileService};
use labos_threejs_platform::object_storage::{S3ObjectStorage, StorageSettings};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::sync::Arc;
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

async fn application(pool: PgPool) -> (Router, FileService) {
    let settings = StorageSettings {
        endpoint: std::env::var("S3_ENDPOINT").expect("run scripts/test-backend.mjs"),
        public_endpoint: std::env::var("S3_PUBLIC_ENDPOINT").unwrap(),
        region: "us-east-1".into(),
        bucket: format!("export-{}", uuid::Uuid::now_v7()),
        access_key: std::env::var("S3_ACCESS_KEY").unwrap(),
        secret_key: std::env::var("S3_SECRET_KEY").unwrap(),
    };
    let storage = Arc::new(S3ObjectStorage::new(&settings));
    storage
        .bootstrap(&settings.bucket, "http://127.0.0.1:5173")
        .await
        .unwrap();
    let files = FileService::new(storage, settings.bucket, FilePolicy::default());
    (
        labos_threejs_api::router_with_files(pool, Default::default(), Some(files.clone())),
        files,
    )
}

#[sqlx::test(migrations = "../../migrations")]
async fn requesting_an_export_keeps_one_request_time_snapshot_after_document_edits(pool: PgPool) {
    let (app, _) = application(pool).await;
    let writer = register(&app, "export-writer@example.com").await;
    let document = data(
        request(
            &app,
            &writer,
            "POST",
            "/api/v1/knowledge/documents",
            json!({"title":"请求时文档", "markdown":"原始内容"}),
        )
        .await,
    )
    .await;
    let document_id = document["id"].as_str().unwrap();
    let path = format!("/api/v1/knowledge/documents/{document_id}/exports");
    let first = request_key(&app, &writer, "POST", &path, json!({}), "snapshot-request").await;
    assert_eq!(first.status(), StatusCode::ACCEPTED);
    let first = data(first).await;
    assert_eq!(first["status"], "queued");
    assert_eq!(first["document_version"], 1);
    let edited = request(
        &app,
        &writer,
        "PUT",
        &format!("/api/v1/knowledge/documents/{document_id}"),
        json!({"title":"后续标题", "markdown":"后续内容", "version":1}),
    )
    .await;
    assert_eq!(edited.status(), StatusCode::OK);
    let replay =
        data(request_key(&app, &writer, "POST", &path, json!({}), "snapshot-request").await).await;
    assert_eq!(replay["id"], first["id"]);
    assert_eq!(replay["document_version"], 1);
    let listed = data(request(&app, &writer, "GET", &path, json!(null)).await).await;
    assert_eq!(listed["data"].as_array().unwrap().len(), 1);
    assert_eq!(listed["data"][0]["id"], first["id"]);
    assert!(!writer.id.is_empty());
}

#[sqlx::test(migrations = "../../migrations")]
async fn a_real_worker_exports_original_markdown_and_attachment_bytes(pool: PgPool) {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let (app, files) = application(pool.clone()).await;
    let writer = register(&app, "zip-writer@example.com").await;
    let document = data(
        request(
            &app,
            &writer,
            "POST",
            "/api/v1/knowledge/documents",
            json!({"title":"Snapshot", "markdown":"first version"}),
        )
        .await,
    )
    .await;
    let document_id = document["id"].as_str().unwrap();
    let document_path = format!("/api/v1/knowledge/documents/{document_id}");
    let bytes = b"original attachment";
    let upload = data(request(&app, &writer, "POST", &format!("{document_path}/uploads"), json!({"file_name":"notes.txt","content_type":"text/plain","size":bytes.len(),"sha256":hex::encode(Sha256::digest(bytes))})).await).await;
    let file_id = upload["upload_id"].as_str().unwrap();
    let mut put = reqwest::Client::new().put(upload["upload"]["url"].as_str().unwrap());
    for (name, value) in upload["upload"]["headers"].as_object().unwrap() {
        put = put.header(name, value.as_str().unwrap());
    }
    assert!(
        put.body(bytes.to_vec())
            .send()
            .await
            .expect("test upload transport failed")
            .status()
            .is_success()
    );
    assert_eq!(
        request(
            &app,
            &writer,
            "POST",
            &format!("{document_path}/uploads/{file_id}/complete"),
            json!({})
        )
        .await
        .status(),
        StatusCode::OK
    );
    let original = format!(
        "original [notes](attachment:{file_id})\n\n`attachment:{file_id}`\n\n[linked][ref]\n\n[ref]: attachment:{file_id}"
    );
    assert_eq!(
        request(
            &app,
            &writer,
            "PUT",
            &document_path,
            json!({"title":"Snapshot", "markdown":original,"version":1})
        )
        .await
        .status(),
        StatusCode::OK
    );
    let exported = data(
        request(
            &app,
            &writer,
            "POST",
            &format!("{document_path}/exports"),
            json!({}),
        )
        .await,
    )
    .await;
    let export_id = exported["id"].as_str().unwrap();
    assert_eq!(
        request(
            &app,
            &writer,
            "PUT",
            &document_path,
            json!({"title":"Later", "markdown":"later version","version":2})
        )
        .await
        .status(),
        StatusCode::OK
    );
    let lease = labos_threejs_app::modules::jobs::claim(&pool, &["knowledge.export"], "test-worker", 60)
        .await
        .unwrap()
        .unwrap();
    let running = data(
        request(
            &app,
            &writer,
            "GET",
            &format!("{document_path}/exports"),
            json!(null),
        )
        .await,
    )
    .await;
    assert_eq!(running["data"][0]["status"], "running");
    labos_threejs_app::modules::knowledge::process_export(
        &pool,
        &files,
        &Default::default(),
        &Default::default(),
        &lease,
    )
    .await
    .unwrap();
    let completed = data(
        request(
            &app,
            &writer,
            "GET",
            &format!("{document_path}/exports"),
            json!(null),
        )
        .await,
    )
    .await;
    assert_eq!(completed["data"][0]["status"], "succeeded");
    assert_eq!(completed["data"][0]["document_version"], 2);
    let capability = data(
        request(
            &app,
            &writer,
            "GET",
            &format!("{document_path}/exports/{export_id}/download"),
            json!(null),
        )
        .await,
    )
    .await;
    let zip_bytes = reqwest::Client::new()
        .get(capability["url"].as_str().unwrap())
        .send()
        .await
        .expect("test download transport failed")
        .bytes()
        .await
        .expect("test download body failed");
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(zip_bytes)).unwrap();
    assert_eq!(archive.len(), 2);
    let mut markdown = String::new();
    archive
        .by_name("document.md")
        .unwrap()
        .read_to_string(&mut markdown)
        .unwrap();
    assert_eq!(
        markdown,
        format!(
            "original [notes](attachments/{file_id}.txt)\n\n`attachment:{file_id}`\n\n[linked](attachments/{file_id}.txt)"
        )
    );
    let mut attachment = Vec::new();
    archive
        .by_name(&format!("attachments/{file_id}.txt"))
        .unwrap()
        .read_to_end(&mut attachment)
        .unwrap();
    assert_eq!(attachment, bytes);
}

#[sqlx::test(migrations = "../../migrations")]
async fn logging_out_the_initiating_credential_fails_the_queued_export(pool: PgPool) {
    let (app, files) = application(pool.clone()).await;
    let writer = register(&app, "revoked-export@example.com").await;
    let doc = data(
        request(
            &app,
            &writer,
            "POST",
            "/api/v1/knowledge/documents",
            json!({"title":"Secret", "markdown":"private"}),
        )
        .await,
    )
    .await;
    let path = format!(
        "/api/v1/knowledge/documents/{}/exports",
        doc["id"].as_str().unwrap()
    );
    let export = data(request(&app, &writer, "POST", &path, json!({})).await).await;
    assert_eq!(
        request(&app, &writer, "POST", "/api/v1/auth/logout", json!({}))
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    let worker = labos_threejs_app::modules::jobs::Worker::new(
        pool.clone(),
        vec![labos_threejs_app::modules::knowledge::export_handler(
            pool,
            files,
            Default::default(),
            Default::default(),
        )],
        Default::default(),
    );
    assert!(worker.run_once().await.unwrap());
    let login = app
        .clone()
        .oneshot(
            Request::post("/api/v1/auth/login")
                .header("origin", "http://127.0.0.1:5173")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"email":"revoked-export@example.com","password":"a-long-test-password"})
                        .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    let cookie = login.headers()["set-cookie"]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let user = data(login).await;
    let reader = Browser {
        id: writer.id,
        cookie,
        csrf: user["csrf_token"].as_str().unwrap().into(),
    };
    let status = data(
        request(
            &app,
            &reader,
            "GET",
            &format!("{path}/{}", export["id"].as_str().unwrap()),
            json!(null),
        )
        .await,
    )
    .await;
    assert_eq!(status["status"], "failed");
    assert_eq!(status["last_error"], "knowledge.export_credential_revoked");
    assert_eq!(status["can_download"], false);
}

#[sqlx::test(migrations = "../../migrations")]
async fn an_audit_failure_rolls_back_the_export_snapshot_and_job(pool: PgPool) {
    let (app, files) = application(pool.clone()).await;
    let writer = register(&app, "export-rollback@example.com").await;
    let doc = data(
        request(
            &app,
            &writer,
            "POST",
            "/api/v1/knowledge/documents",
            json!({"title":"Atomic", "markdown":"text"}),
        )
        .await,
    )
    .await;
    let path = format!(
        "/api/v1/knowledge/documents/{}/exports",
        doc["id"].as_str().unwrap()
    );
    sqlx::raw_sql("CREATE FUNCTION reject_export_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'knowledge.export.request' THEN RAISE EXCEPTION 'test audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_export_audit BEFORE INSERT ON labos_threejs_core.audit_events FOR EACH ROW EXECUTE FUNCTION reject_export_audit();").execute(&pool).await.unwrap();
    assert_eq!(
        request_key(&app, &writer, "POST", &path, json!({}), "rollback-key")
            .await
            .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    let page = data(request(&app, &writer, "GET", &path, json!(null)).await).await;
    assert!(page["data"].as_array().unwrap().is_empty());
    let worker = labos_threejs_app::modules::jobs::Worker::new(
        pool.clone(),
        vec![labos_threejs_app::modules::knowledge::export_handler(
            pool.clone(),
            files,
            Default::default(),
            Default::default(),
        )],
        Default::default(),
    );
    assert!(!worker.run_once().await.unwrap());
    sqlx::query("DROP TRIGGER reject_export_audit ON labos_threejs_core.audit_events")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        request_key(&app, &writer, "POST", &path, json!({}), "rollback-key")
            .await
            .status(),
        StatusCode::ACCEPTED
    );
    assert!(worker.run_once().await.unwrap());
    let page = data(request(&app, &writer, "GET", &path, json!(null)).await).await;
    assert_eq!(page["data"][0]["status"], "succeeded");
}

#[sqlx::test(migrations = "../../migrations")]
async fn export_access_is_bound_to_the_requester_and_source_and_expired_results_stop_signing(
    pool: PgPool,
) {
    let (app, files) = application(pool.clone()).await;
    let owner = register(&app, "export-owner@example.com").await;
    let writer = register(&app, "export-private@example.com").await;
    let other = register(&app, "export-other@example.com").await;
    let doc = data(
        request(
            &app,
            &writer,
            "POST",
            "/api/v1/knowledge/documents",
            json!({"title":"Private", "markdown":"text"}),
        )
        .await,
    )
    .await;
    let document_id = doc["id"].as_str().unwrap();
    let path = format!("/api/v1/knowledge/documents/{document_id}/exports");
    assert_eq!(
        request(&app, &other, "POST", &path, json!({}))
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    let export = data(request(&app, &writer, "POST", &path, json!({})).await).await;
    let export_id = export["id"].as_str().unwrap();
    let download = format!("{path}/{export_id}/download");
    assert_eq!(
        request(&app, &writer, "GET", &download, json!(null))
            .await
            .status(),
        StatusCode::CONFLICT
    );
    let worker = labos_threejs_app::modules::jobs::Worker::new(
        pool.clone(),
        vec![labos_threejs_app::modules::knowledge::export_handler(
            pool.clone(),
            files,
            Default::default(),
            Default::default(),
        )],
        Default::default(),
    );
    assert!(worker.run_once().await.unwrap());
    assert_eq!(
        request(&app, &other, "GET", &download, json!(null))
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request(&app, &owner, "GET", &download, json!(null))
            .await
            .status(),
        StatusCode::OK
    );
    let grant = format!(
        "/api/v1/knowledge/bases/{}/grants/{}",
        doc["knowledge_base_id"].as_str().unwrap(),
        writer.id
    );
    assert_eq!(
        request(&app, &owner, "DELETE", &grant, json!(null))
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        request(&app, &owner, "GET", &download, json!(null))
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request(&app, &writer, "GET", &download, json!(null))
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request(&app, &owner, "PUT", &grant, json!({"access":"reader"}))
            .await
            .status(),
        StatusCode::OK
    );
    sqlx::query("UPDATE knowledge.exports SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1::uuid").bind(export_id).execute(&pool).await.unwrap();
    let info = data(
        request(
            &app,
            &writer,
            "GET",
            &format!("{path}/{export_id}"),
            json!(null),
        )
        .await,
    )
    .await;
    assert_eq!(info["status"], "expired");
    assert_eq!(info["can_download"], false);
    assert_eq!(
        request(&app, &writer, "GET", &download, json!(null))
            .await
            .status(),
        StatusCode::GONE
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn a_missing_snapshot_object_is_an_explicit_failed_export(pool: PgPool) {
    use sha2::{Digest, Sha256};
    let (app, files) = application(pool.clone()).await;
    let writer = register(&app, "missing-export@example.com").await;
    let doc = data(
        request(
            &app,
            &writer,
            "POST",
            "/api/v1/knowledge/documents",
            json!({"title":"Missing", "markdown":"text"}),
        )
        .await,
    )
    .await;
    let path = format!(
        "/api/v1/knowledge/documents/{}",
        doc["id"].as_str().unwrap()
    );
    let upload = data(request(&app, &writer, "POST", &format!("{path}/uploads"), json!({"file_name":"missing.txt","content_type":"text/plain","size":4,"sha256":hex::encode(Sha256::digest(b"data"))})).await).await;
    let file_id = upload["upload_id"].as_str().unwrap();
    let mut put = reqwest::Client::new().put(upload["upload"]["url"].as_str().unwrap());
    for (name, value) in upload["upload"]["headers"].as_object().unwrap() {
        put = put.header(name, value.as_str().unwrap());
    }
    assert!(
        put.body("data")
            .send()
            .await
            .expect("test upload transport failed")
            .status()
            .is_success()
    );
    assert_eq!(
        request(
            &app,
            &writer,
            "POST",
            &format!("{path}/uploads/{file_id}/complete"),
            json!({})
        )
        .await
        .status(),
        StatusCode::OK
    );
    // A controlled storage metadata fixture points to an actually absent RustFS object.
    sqlx::query("UPDATE labos_threejs_core.files SET ready_key = 'test-absent-object' WHERE id = $1::uuid")
        .bind(file_id)
        .execute(&pool)
        .await
        .unwrap();
    let export =
        data(request(&app, &writer, "POST", &format!("{path}/exports"), json!({})).await).await;
    let worker = labos_threejs_app::modules::jobs::Worker::new(
        pool.clone(),
        vec![labos_threejs_app::modules::knowledge::export_handler(
            pool,
            files,
            Default::default(),
            Default::default(),
        )],
        Default::default(),
    );
    assert!(worker.run_once().await.unwrap());
    let result = data(
        request(
            &app,
            &writer,
            "GET",
            &format!("{path}/exports/{}", export["id"].as_str().unwrap()),
            json!(null),
        )
        .await,
    )
    .await;
    assert_eq!(result["status"], "failed");
    assert_eq!(result["last_error"], "knowledge.export_input_missing");
    assert_eq!(result["can_download"], false);
}

#[sqlx::test(migrations = "../../migrations")]
async fn snapshot_and_zip_size_limits_produce_controlled_failures(pool: PgPool) {
    let (default_app, files) = application(pool.clone()).await;
    let writer = register(&default_app, "export-limits@example.com").await;
    let doc = data(
        request(
            &default_app,
            &writer,
            "POST",
            "/api/v1/knowledge/documents",
            json!({"title":"Bounded", "markdown":"x".repeat(4096)}),
        )
        .await,
    )
    .await;
    let path = format!(
        "/api/v1/knowledge/documents/{}/exports",
        doc["id"].as_str().unwrap()
    );
    let auth = labos_threejs_platform::config::AuthSettings::default();
    let routes = labos_threejs_app::modules::knowledge::router_with_policy(
        pool.clone(),
        auth.clone(),
        Some(files.clone()),
        labos_threejs_app::modules::knowledge::ExportPolicy {
            max_input_bytes: 1024,
            ..Default::default()
        },
    );
    let limited = labos_threejs_app::compose_routes(pool.clone(), auth, routes, labos_threejs_api::openapi());
    assert_eq!(
        request(&limited, &writer, "POST", &path, json!({}))
            .await
            .status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
    assert!(
        labos_threejs_app::modules::jobs::claim(&pool, &["knowledge.export"], "test-limits", 60)
            .await
            .unwrap()
            .is_none()
    );
    let export = data(request(&default_app, &writer, "POST", &path, json!({})).await).await;
    let worker = labos_threejs_app::modules::jobs::Worker::new(
        pool.clone(),
        vec![labos_threejs_app::modules::knowledge::export_handler(
            pool,
            files,
            Default::default(),
            labos_threejs_app::modules::knowledge::ExportPolicy {
                max_output_bytes: 1024,
                ..Default::default()
            },
        )],
        Default::default(),
    );
    assert!(worker.run_once().await.unwrap());
    let info = data(
        request(
            &default_app,
            &writer,
            "GET",
            &format!("{path}/{}", export["id"].as_str().unwrap()),
            json!(null),
        )
        .await,
    )
    .await;
    assert_eq!(info["status"], "failed");
    assert_eq!(info["can_download"], false);
}

#[sqlx::test(migrations = "../../migrations")]
async fn new_exports_appear_on_the_first_page_after_twenty_history_entries(pool: PgPool) {
    let (app, _) = application(pool).await;
    let writer = register(&app, "export-history@example.com").await;
    let doc = data(
        request(
            &app,
            &writer,
            "POST",
            "/api/v1/knowledge/documents",
            json!({"title":"History","markdown":"text"}),
        )
        .await,
    )
    .await;
    let path = format!(
        "/api/v1/knowledge/documents/{}/exports",
        doc["id"].as_str().unwrap()
    );
    let mut latest = Value::Null;
    for _ in 0..21 {
        latest = data(request(&app, &writer, "POST", &path, json!({})).await).await;
    }
    let page = data(
        request(
            &app,
            &writer,
            "GET",
            &format!("{path}?limit=20"),
            json!(null),
        )
        .await,
    )
    .await;
    assert_eq!(page["data"][0]["id"], latest["id"]);
    assert_eq!(page["data"].as_array().unwrap().len(), 20);
    assert_eq!(page["has_more"], true);
    let cursor = page["next_cursor"].as_str().unwrap();
    let second = data(
        request(
            &app,
            &writer,
            "GET",
            &format!("{path}?limit=20&cursor={cursor}"),
            json!(null),
        )
        .await,
    )
    .await;
    assert_eq!(second["data"].as_array().unwrap().len(), 1);
    assert_ne!(second["data"][0]["id"], latest["id"]);
}

#[sqlx::test(migrations = "../../migrations")]
async fn a_real_export_notifies_its_requester_once_and_the_notice_cannot_bypass_source_access(
    pool: PgPool,
) {
    let (app, files) = application(pool.clone()).await;
    let actor = register(&app, "notified-export@example.com").await;
    let doc = data(
        request(
            &app,
            &actor,
            "POST",
            "/api/v1/knowledge/documents",
            json!({"title":"Private title never copied into inbox", "markdown":"secret"}),
        )
        .await,
    )
    .await;
    let document_path = format!(
        "/api/v1/knowledge/documents/{}",
        doc["id"].as_str().unwrap()
    );
    let exports = format!("{document_path}/exports");
    let export =
        data(request_key(&app, &actor, "POST", &exports, json!({}), "notify-export").await).await;
    let worker = labos_threejs_app::modules::jobs::Worker::new(
        pool.clone(),
        vec![labos_threejs_app::modules::knowledge::export_handler(
            pool,
            files,
            Default::default(),
            Default::default(),
        )],
        Default::default(),
    );
    assert!(worker.run_once().await.unwrap());
    assert_eq!(
        data(request_key(&app, &actor, "POST", &exports, json!({}), "notify-export").await).await["id"],
        export["id"]
    );
    assert!(!worker.run_once().await.unwrap());
    let notices =
        data(request(&app, &actor, "GET", "/api/v1/notifications", json!(null)).await).await;
    assert_eq!(notices["data"].as_array().unwrap().len(), 1);
    let notice = &notices["data"][0];
    assert_eq!(notice["subject"], "文档导出");
    assert_eq!(notice["outcome"], "succeeded");
    assert_eq!(notice["target"]["kind"], "knowledge.export");
    assert_eq!(notice["target"]["resource_id"], export["id"]);
    assert_eq!(notice["target"]["context"]["document_id"], doc["id"]);
    assert!(!notice.to_string().contains("secret"));
    let result = format!("{exports}/{}", export["id"].as_str().unwrap());
    assert_eq!(
        request(&app, &actor, "GET", &result, json!(null))
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        request(&app, &actor, "DELETE", &document_path, json!(null))
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        request(&app, &actor, "GET", &result, json!(null))
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request(
            &app,
            &actor,
            "GET",
            &format!("{result}/download"),
            json!(null)
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        data(request(&app, &actor, "GET", "/api/v1/notifications", json!(null)).await).await,
        notices
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn notification_publication_failure_rolls_back_export_result_and_recovers_without_duplicates(
    pool: PgPool,
) {
    let (app, files) = application(pool.clone()).await;
    let actor = register(&app, "atomic-notice@example.com").await;
    let doc = data(
        request(
            &app,
            &actor,
            "POST",
            "/api/v1/knowledge/documents",
            json!({"title":"Atomic", "markdown":"text"}),
        )
        .await,
    )
    .await;
    let exports = format!(
        "/api/v1/knowledge/documents/{}/exports",
        doc["id"].as_str().unwrap()
    );
    let export = data(request(&app, &actor, "POST", &exports, json!({})).await).await;
    sqlx::raw_sql("CREATE FUNCTION reject_notice() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test notification failure'; END $$; CREATE TRIGGER reject_notice BEFORE INSERT ON labos_threejs_core.notifications FOR EACH ROW EXECUTE FUNCTION reject_notice();").execute(&pool).await.unwrap();
    let worker = labos_threejs_app::modules::jobs::Worker::new(
        pool.clone(),
        vec![labos_threejs_app::modules::knowledge::export_handler(
            pool.clone(),
            files,
            Default::default(),
            Default::default(),
        )],
        Default::default(),
    );
    assert!(worker.run_once().await.unwrap());
    let result = format!("{exports}/{}", export["id"].as_str().unwrap());
    let after = data(request(&app, &actor, "GET", &result, json!(null)).await).await;
    assert_eq!(after["status"], "retry_wait");
    assert_eq!(after["can_download"], false);
    assert_eq!(
        request(
            &app,
            &actor,
            "GET",
            &format!("{result}/download"),
            json!(null)
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        data(request(&app, &actor, "GET", "/api/v1/notifications", json!(null)).await).await["data"],
        json!([])
    );
    sqlx::query("DROP TRIGGER reject_notice ON labos_threejs_core.notifications")
        .execute(&pool)
        .await
        .unwrap();
    sqlx::query("UPDATE labos_threejs_core.jobs SET scheduled_at = clock_timestamp() WHERE kind = 'knowledge.export'").execute(&pool).await.unwrap();
    assert!(worker.run_once().await.unwrap());
    let after = data(request(&app, &actor, "GET", &result, json!(null)).await).await;
    assert_eq!(after["status"], "succeeded");
    assert_eq!(after["can_download"], true);
    assert_eq!(
        data(request(&app, &actor, "GET", "/api/v1/notifications", json!(null)).await).await["unread_count"],
        1
    );
    assert!(!worker.run_once().await.unwrap());
}

#[sqlx::test(migrations = "../../migrations")]
async fn deleted_export_sources_still_produce_a_failure_notice_without_a_resource_leak(
    pool: PgPool,
) {
    let (app, files) = application(pool.clone()).await;
    let actor = register(&app, "deleted-notice@example.com").await;
    let doc = data(
        request(
            &app,
            &actor,
            "POST",
            "/api/v1/knowledge/documents",
            json!({"title":"Private removed title", "markdown":"text"}),
        )
        .await,
    )
    .await;
    let path = format!(
        "/api/v1/knowledge/documents/{}",
        doc["id"].as_str().unwrap()
    );
    request(&app, &actor, "POST", &format!("{path}/exports"), json!({})).await;
    assert_eq!(
        request(&app, &actor, "DELETE", &path, json!(null))
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    let worker = labos_threejs_app::modules::jobs::Worker::new(
        pool.clone(),
        vec![labos_threejs_app::modules::knowledge::document_cleanup_handler(
            pool.clone(),
        )],
        Default::default(),
    );
    assert!(worker.run_once().await.unwrap());
    let worker = labos_threejs_app::modules::jobs::Worker::new(
        pool.clone(),
        vec![labos_threejs_app::modules::knowledge::export_handler(
            pool,
            files,
            Default::default(),
            Default::default(),
        )],
        Default::default(),
    );
    assert!(worker.run_once().await.unwrap());
    let notices =
        data(request(&app, &actor, "GET", "/api/v1/notifications", json!(null)).await).await;
    assert_eq!(notices["data"].as_array().unwrap().len(), 1);
    assert_eq!(notices["data"][0]["outcome"], "failed");
    assert_eq!(notices["data"][0]["subject"], "文档导出");
}

#[sqlx::test(migrations = "../../migrations")]
async fn export_completion_audit_identifies_the_actual_job_and_original_request(pool: PgPool) {
    let (app, files) = application(pool.clone()).await;
    let actor = register(&app, "audit-export@example.com").await;
    let doc = data(
        request(
            &app,
            &actor,
            "POST",
            "/api/v1/knowledge/documents",
            json!({"title":"Audit export", "markdown":"private-body"}),
        )
        .await,
    )
    .await;
    let response = request(
        &app,
        &actor,
        "POST",
        &format!(
            "/api/v1/knowledge/documents/{}/exports",
            doc["id"].as_str().unwrap()
        ),
        json!({}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::ACCEPTED);
    let request_id = response.headers()["x-request-id"]
        .to_str()
        .unwrap()
        .to_owned();
    let export = data(response).await;
    let worker = labos_threejs_app::modules::jobs::Worker::new(
        pool.clone(),
        vec![labos_threejs_app::modules::knowledge::export_handler(
            pool,
            files,
            Default::default(),
            Default::default(),
        )],
        Default::default(),
    );
    assert!(worker.run_once().await.unwrap());
    let page = data(
        request(
            &app,
            &actor,
            "GET",
            &format!(
                "/api/v1/audit-events?correlation_id={request_id}&action=knowledge.export.complete"
            ),
            json!(null),
        )
        .await,
    )
    .await;
    assert_eq!(page["data"].as_array().unwrap().len(), 1);
    let event = &page["data"][0];
    assert_eq!(event["resource_id"], export["id"]);
    assert_eq!(event["resource_type"], "knowledge.export");
    assert_eq!(event["actor_id"], actor.id);
    assert_eq!(event["request_id"], Value::Null);
    assert_eq!(event["trace_id"], Value::Null);
    let job_id = event["job_id"].as_str().unwrap();
    let job = data(
        request(
            &app,
            &actor,
            "GET",
            &format!("/api/v1/jobs/{job_id}"),
            json!(null),
        )
        .await,
    )
    .await;
    assert_eq!(job["job"]["kind"], "knowledge.export");
    assert_eq!(job["job"]["status"], "succeeded");
    assert_eq!(job["job"]["correlation_id"], request_id);
    let by_job = data(
        request(
            &app,
            &actor,
            "GET",
            &format!("/api/v1/audit-events?job_id={job_id}"),
            json!(null),
        )
        .await,
    )
    .await;
    assert_eq!(by_job["data"][0]["id"], event["id"]);
}
