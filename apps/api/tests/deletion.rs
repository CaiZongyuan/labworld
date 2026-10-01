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
use sha2::{Digest, Sha256};
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
    application_with_failure(pool, None).await
}
async fn application_with_failure(
    pool: PgPool,
    fail: Option<Arc<std::sync::atomic::AtomicBool>>,
) -> (Router, FileService) {
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
    let storage: Arc<dyn labos_threejs_platform::object_storage::ObjectStorage> = match fail {
        Some(fail) => Arc::new(DeleteFailure { storage, fail }),
        None => storage,
    };
    let files = FileService::new(storage, settings.bucket, FilePolicy::default());
    (
        labos_threejs_api::router_with_files(pool, Default::default(), Some(files.clone())),
        files,
    )
}

async fn upload(app: &Router, actor: &Browser, path: &str) -> String {
    let upload=data(request(app,actor,"POST",&format!("{path}/uploads"),json!({"file_name":"remove.txt","content_type":"text/plain","size":3,"sha256":hex::encode(Sha256::digest(b"old"))})).await).await;
    let id = upload["upload_id"].as_str().unwrap().to_owned();
    let mut put = reqwest::Client::new().put(upload["upload"]["url"].as_str().unwrap());
    for (name, value) in upload["upload"]["headers"].as_object().unwrap() {
        put = put.header(name, value.as_str().unwrap());
    }
    assert!(
        put.body("old")
            .send()
            .await
            .expect("test upload transport failed")
            .status()
            .is_success()
    );
    assert_eq!(
        request(
            app,
            actor,
            "POST",
            &format!("{path}/uploads/{id}/complete"),
            json!({})
        )
        .await
        .status(),
        StatusCode::OK
    );
    id
}
#[sqlx::test(migrations = "../../migrations")]
async fn deleted_attachments_are_immediately_invisible_and_worker_removes_the_actual_object(
    pool: PgPool,
) {
    let (app, files) = application(pool.clone()).await;
    let writer = register(&app, "attachment-delete@example.com").await;
    let doc = data(
        request(
            &app,
            &writer,
            "POST",
            "/api/v1/knowledge/documents",
            json!({"title":"Delete","markdown":"text"}),
        )
        .await,
    )
    .await;
    let path = format!(
        "/api/v1/knowledge/documents/{}",
        doc["id"].as_str().unwrap()
    );
    let file_id = upload(&app, &writer, &path).await;
    let capability = data(
        request(
            &app,
            &writer,
            "GET",
            &format!("{path}/attachments/{file_id}/download"),
            json!(null),
        )
        .await,
    )
    .await;
    let old_url = capability["url"].as_str().unwrap();
    assert_eq!(
        request(
            &app,
            &writer,
            "DELETE",
            &format!("{path}/attachments/{file_id}"),
            json!(null)
        )
        .await
        .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        request(
            &app,
            &writer,
            "GET",
            &format!("{path}/attachments/{file_id}/download"),
            json!(null)
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    let listed = data(
        request(
            &app,
            &writer,
            "GET",
            &format!("{path}/attachments"),
            json!(null),
        )
        .await,
    )
    .await;
    assert!(listed["data"].as_array().unwrap().is_empty());
    assert_eq!(
        reqwest::Client::new()
            .get(old_url)
            .send()
            .await
            .expect("test signed download failed")
            .status(),
        StatusCode::OK
    );
    let worker = labos_threejs_app::modules::jobs::Worker::new(
        pool.clone(),
        vec![labos_threejs_app::modules::files::cleanup_handler(pool, files)],
        Default::default(),
    );
    assert!(worker.run_once().await.unwrap());
    assert_eq!(
        reqwest::Client::new()
            .get(old_url)
            .send()
            .await
            .expect("test signed download failed")
            .status(),
        StatusCode::NOT_FOUND
    );
    assert!(!writer.id.is_empty());
}

#[sqlx::test(migrations = "../../migrations")]
async fn deletion_audit_failure_keeps_the_attachment_visible_and_does_not_enqueue_cleanup(
    pool: PgPool,
) {
    let (app, files) = application(pool.clone()).await;
    let owner = register(&app, "delete-rollback@example.com").await;
    let doc = data(
        request(
            &app,
            &owner,
            "POST",
            "/api/v1/knowledge/documents",
            json!({"title":"Keep","markdown":"text"}),
        )
        .await,
    )
    .await;
    let path = format!(
        "/api/v1/knowledge/documents/{}",
        doc["id"].as_str().unwrap()
    );
    let id = upload(&app, &owner, &path).await;
    sqlx::raw_sql("CREATE FUNCTION reject_attachment_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'knowledge.attachment.delete' THEN RAISE EXCEPTION 'test audit failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_attachment_delete BEFORE INSERT ON labos_threejs_core.audit_events FOR EACH ROW EXECUTE FUNCTION reject_attachment_delete();").execute(&pool).await.unwrap();
    assert_eq!(
        request(
            &app,
            &owner,
            "DELETE",
            &format!("{path}/attachments/{id}"),
            json!(null)
        )
        .await
        .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    let listed = data(
        request(
            &app,
            &owner,
            "GET",
            &format!("{path}/attachments"),
            json!(null),
        )
        .await,
    )
    .await;
    assert_eq!(listed["data"][0]["id"], id);
    assert_eq!(
        request(
            &app,
            &owner,
            "GET",
            &format!("{path}/attachments/{id}/download"),
            json!(null)
        )
        .await
        .status(),
        StatusCode::OK
    );
    let worker = labos_threejs_app::modules::jobs::Worker::new(
        pool.clone(),
        vec![labos_threejs_app::modules::files::cleanup_handler(pool, files)],
        Default::default(),
    );
    assert!(!worker.run_once().await.unwrap());
}

#[sqlx::test(migrations = "../../migrations")]
async fn attachment_deletion_requires_editor_access_and_the_correct_source_association(
    pool: PgPool,
) {
    let (app, _) = application(pool.clone()).await;
    let owner = register(&app, "delete-owner@example.com").await;
    let reader = register(&app, "delete-reader@example.com").await;
    let doc = data(
        request(
            &app,
            &owner,
            "POST",
            "/api/v1/knowledge/documents",
            json!({"title":"Permissions","markdown":"text"}),
        )
        .await,
    )
    .await;
    let other = data(
        request(
            &app,
            &owner,
            "POST",
            "/api/v1/knowledge/documents",
            json!({"title":"Other","markdown":"text"}),
        )
        .await,
    )
    .await;
    let path = format!(
        "/api/v1/knowledge/documents/{}",
        doc["id"].as_str().unwrap()
    );
    let id = upload(&app, &owner, &path).await;
    let grant = format!(
        "/api/v1/knowledge/bases/{}/grants/{}",
        doc["knowledge_base_id"].as_str().unwrap(),
        reader.id
    );
    assert_eq!(
        request(&app, &owner, "PUT", &grant, json!({"access":"reader"}))
            .await
            .status(),
        StatusCode::OK
    );
    let permissions = data(
        request(
            &app,
            &reader,
            "GET",
            &format!("{path}/attachments"),
            json!(null),
        )
        .await,
    )
    .await;
    assert_eq!(permissions["can_delete"], false);
    let without_storage = labos_threejs_api::router(pool, Default::default());
    let permissions = data(
        request(
            &without_storage,
            &owner,
            "GET",
            &format!("{path}/attachments"),
            json!(null),
        )
        .await,
    )
    .await;
    assert_eq!(permissions["can_upload"], false);
    assert_eq!(permissions["can_delete"], true);
    assert_eq!(
        request(
            &app,
            &reader,
            "DELETE",
            &format!("{path}/attachments/{id}"),
            json!(null)
        )
        .await
        .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request(
            &app,
            &owner,
            "DELETE",
            &format!(
                "/api/v1/knowledge/documents/{}/attachments/{id}",
                other["id"].as_str().unwrap()
            ),
            json!(null)
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request(&app, &owner, "PUT", &grant, json!({"access":"editor"}))
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        request(
            &app,
            &reader,
            "DELETE",
            &format!("{path}/attachments/{id}"),
            json!(null)
        )
        .await
        .status(),
        StatusCode::NO_CONTENT
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn deleting_a_document_hides_its_exports_and_cannot_replay_the_deleted_creation_body(
    pool: PgPool,
) {
    let (app, files) = application(pool.clone()).await;
    let writer = register(&app, "document-delete@example.com").await;
    let input = json!({"title":"Remove document","markdown":"private body"});
    let doc = data(
        request_key(
            &app,
            &writer,
            "POST",
            "/api/v1/knowledge/documents",
            input.clone(),
            "create-once",
        )
        .await,
    )
    .await;
    let path = format!(
        "/api/v1/knowledge/documents/{}",
        doc["id"].as_str().unwrap()
    );
    let attachment = upload(&app, &writer, &path).await;
    let export =
        data(request(&app, &writer, "POST", &format!("{path}/exports"), json!({})).await).await;
    let exporter = labos_threejs_app::modules::jobs::Worker::new(
        pool.clone(),
        vec![labos_threejs_app::modules::knowledge::export_handler(
            pool.clone(),
            files.clone(),
            Default::default(),
            Default::default(),
        )],
        Default::default(),
    );
    assert!(exporter.run_once().await.unwrap());
    let download_path = format!("{path}/exports/{}/download", export["id"].as_str().unwrap());
    let exported = data(request(&app, &writer, "GET", &download_path, json!(null)).await).await;
    let attached = data(
        request(
            &app,
            &writer,
            "GET",
            &format!("{path}/attachments/{attachment}/download"),
            json!(null),
        )
        .await,
    )
    .await;
    assert_eq!(
        request(&app, &writer, "DELETE", &path, json!(null))
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        request(&app, &writer, "GET", &path, json!(null))
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request(&app, &writer, "GET", &download_path, json!(null))
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request_key(
            &app,
            &writer,
            "POST",
            "/api/v1/knowledge/documents",
            input,
            "create-once"
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    let listed = data(
        request(
            &app,
            &writer,
            "GET",
            "/api/v1/knowledge/documents",
            json!(null),
        )
        .await,
    )
    .await;
    assert!(listed["data"].as_array().unwrap().is_empty());
    let cleanup = labos_threejs_app::modules::jobs::Worker::new(
        pool.clone(),
        vec![
            labos_threejs_app::modules::files::cleanup_handler(pool.clone(), files),
            labos_threejs_app::modules::knowledge::document_cleanup_handler(pool),
        ],
        Default::default(),
    );
    for _ in 0..10 {
        if !cleanup.run_once().await.unwrap() {
            break;
        }
    }
    for capability in [attached, exported] {
        assert_eq!(
            reqwest::Client::new()
                .get(capability["url"].as_str().unwrap())
                .send()
                .await
                .expect("test signed read failed")
                .status(),
            StatusCode::NOT_FOUND
        );
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn an_administrator_deletes_a_personal_base_without_implicit_recreation(pool: PgPool) {
    let (app, files) = application(pool.clone()).await;
    let owner = register(&app, "base-delete-owner@example.com").await;
    let writer = register(&app, "base-delete-writer@example.com").await;
    let doc = data(
        request(
            &app,
            &writer,
            "POST",
            "/api/v1/knowledge/documents",
            json!({"title":"First","markdown":"text"}),
        )
        .await,
    )
    .await;
    let other = data(
        request(
            &app,
            &writer,
            "POST",
            "/api/v1/knowledge/documents",
            json!({"title":"Second","markdown":"text"}),
        )
        .await,
    )
    .await;
    let path = format!(
        "/api/v1/knowledge/documents/{}",
        doc["id"].as_str().unwrap()
    );
    let file = upload(&app, &writer, &path).await;
    let signed = data(
        request(
            &app,
            &writer,
            "GET",
            &format!("{path}/attachments/{file}/download"),
            json!(null),
        )
        .await,
    )
    .await;
    let base = format!(
        "/api/v1/knowledge/bases/{}",
        doc["knowledge_base_id"].as_str().unwrap()
    );
    assert_eq!(
        request(&app, &writer, "DELETE", &base, json!(null))
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request(&app, &owner, "DELETE", &base, json!(null))
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    for document in [&doc, &other] {
        assert_eq!(
            request(
                &app,
                &owner,
                "GET",
                &format!(
                    "/api/v1/knowledge/documents/{}",
                    document["id"].as_str().unwrap()
                ),
                json!(null)
            )
            .await
            .status(),
            StatusCode::NOT_FOUND
        );
    }
    assert_eq!(
        request(&app, &writer, "GET", &base, json!(null))
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    let page = data(
        request(
            &app,
            &writer,
            "GET",
            "/api/v1/knowledge/documents",
            json!(null),
        )
        .await,
    )
    .await;
    assert_eq!(page["can_create"], false);
    assert!(page["data"].as_array().unwrap().is_empty());
    assert_eq!(
        request(
            &app,
            &writer,
            "POST",
            "/api/v1/knowledge/documents",
            json!({"title":"Must not recreate","markdown":"text"})
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    let worker = labos_threejs_app::modules::jobs::Worker::new(
        pool.clone(),
        vec![
            labos_threejs_app::modules::files::cleanup_handler(pool.clone(), files),
            labos_threejs_app::modules::knowledge::document_cleanup_handler(pool.clone()),
            labos_threejs_app::modules::knowledge::base_cleanup_handler(pool),
        ],
        Default::default(),
    );
    for _ in 0..10 {
        if !worker.run_once().await.unwrap() {
            break;
        }
    }
    assert_eq!(
        reqwest::Client::new()
            .get(signed["url"].as_str().unwrap())
            .send()
            .await
            .expect("test signed read failed")
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request(
            &app,
            &writer,
            "POST",
            "/api/v1/knowledge/documents",
            json!({"title":"Still removed","markdown":"text"})
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn expired_uploads_keep_their_error_and_late_objects_are_removed_by_a_recorded_rescan(
    pool: PgPool,
) {
    use labos_threejs_app::modules::jobs::Worker;
    use labos_threejs_platform::object_storage::{ObjectLocation, ObjectStorage, StorageError};
    let (app, files) = application(pool.clone()).await;
    let writer = register(&app, "expired-cleanup@example.com").await;
    let doc = data(
        request(
            &app,
            &writer,
            "POST",
            "/api/v1/knowledge/documents",
            json!({"title":"Expire","markdown":"text"}),
        )
        .await,
    )
    .await;
    let path = format!(
        "/api/v1/knowledge/documents/{}",
        doc["id"].as_str().unwrap()
    );
    let pending=data(request(&app,&writer,"POST",&format!("{path}/uploads"),json!({"file_name":"pending.txt","content_type":"text/plain","size":3,"sha256":hex::encode(Sha256::digest(b"old"))})).await).await;
    let file = pending["upload_id"].as_str().unwrap();
    let capability = &pending["upload"];
    let url = reqwest::Url::parse(capability["url"].as_str().unwrap()).unwrap();
    let (bucket, key) = url.path().trim_start_matches('/').split_once('/').unwrap();
    let location = ObjectLocation {
        bucket: bucket.into(),
        key: key.into(),
    };
    let storage = S3ObjectStorage::new(&StorageSettings {
        endpoint: std::env::var("S3_ENDPOINT").unwrap(),
        public_endpoint: std::env::var("S3_PUBLIC_ENDPOINT").unwrap(),
        region: "us-east-1".into(),
        bucket: bucket.into(),
        access_key: std::env::var("S3_ACCESS_KEY").unwrap(),
        secret_key: std::env::var("S3_SECRET_KEY").unwrap(),
    });
    async fn send_bytes(capability: &Value) {
        let mut put = reqwest::Client::new().put(capability["url"].as_str().unwrap());
        for (name, value) in capability["headers"].as_object().unwrap() {
            put = put.header(name, value.as_str().unwrap());
        }
        assert!(
            put.body("old")
                .send()
                .await
                .expect("test staging write failed")
                .status()
                .is_success()
        );
    }
    send_bytes(capability).await;
    // Control the application expiry clock; the previously authorized storage write is retained.
    sqlx::query("UPDATE labos_threejs_core.files SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1::uuid").bind(file).execute(&pool).await.unwrap();
    let maintenance = labos_threejs_app::modules::files::cleanup_maintenance(pool.clone());
    maintenance.schedule().await.unwrap();
    let worker = Worker::new(
        pool.clone(),
        vec![
            labos_threejs_app::modules::files::cleanup_handler(pool.clone(), files.clone()),
            labos_threejs_app::modules::files::rescan_handler(pool.clone(), files),
        ],
        Default::default(),
    );
    assert!(worker.run_once().await.unwrap());
    assert!(matches!(
        storage.head(&location).await,
        Err(StorageError::NotFound)
    ));
    let expired = request(
        &app,
        &writer,
        "POST",
        &format!("{path}/uploads/{file}/complete"),
        json!({}),
    )
    .await;
    assert_eq!(expired.status(), StatusCode::GONE);
    assert_eq!(data(expired).await["error"]["code"], "files.upload_expired");
    // Model accepted bytes arriving after the first cleanup; the durable location must survive.
    send_bytes(capability).await;
    assert_eq!(storage.head(&location).await.unwrap().size, 3);
    sqlx::query("UPDATE labos_threejs_core.object_cleanup SET next_probe_at = clock_timestamp() - interval '1 second' WHERE file_id = $1::uuid").bind(file).execute(&pool).await.unwrap();
    maintenance.schedule().await.unwrap();
    assert!(worker.run_once().await.unwrap());
    assert!(matches!(
        storage.head(&location).await,
        Err(StorageError::NotFound)
    ));
}

#[sqlx::test(migrations = "../../migrations")]
async fn expired_exports_keep_a_summary_while_the_snapshot_and_zip_are_cleaned(pool: PgPool) {
    let (app, files) = application(pool.clone()).await;
    let writer = register(&app, "export-cleanup@example.com").await;
    let doc = data(
        request(
            &app,
            &writer,
            "POST",
            "/api/v1/knowledge/documents",
            json!({"title":"Export expiry","markdown":"short lived snapshot"}),
        )
        .await,
    )
    .await;
    let path = format!(
        "/api/v1/knowledge/documents/{}/exports",
        doc["id"].as_str().unwrap()
    );
    let export = data(request(&app, &writer, "POST", &path, json!({})).await).await;
    let id = export["id"].as_str().unwrap();
    let worker = labos_threejs_app::modules::jobs::Worker::new(
        pool.clone(),
        vec![
            labos_threejs_app::modules::knowledge::export_handler(
                pool.clone(),
                files.clone(),
                Default::default(),
                Default::default(),
            ),
            labos_threejs_app::modules::files::cleanup_handler(pool.clone(), files),
        ],
        Default::default(),
    );
    assert!(worker.run_once().await.unwrap());
    let signed = data(
        request(
            &app,
            &writer,
            "GET",
            &format!("{path}/{id}/download"),
            json!(null),
        )
        .await,
    )
    .await;
    sqlx::query("UPDATE knowledge.exports SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1::uuid").bind(id).execute(&pool).await.unwrap();
    labos_threejs_app::modules::knowledge::export_maintenance(pool.clone())
        .schedule()
        .await
        .unwrap();
    let summary =
        data(request(&app, &writer, "GET", &format!("{path}/{id}"), json!(null)).await).await;
    assert_eq!(summary["status"], "expired");
    assert_eq!(summary["can_download"], false);
    assert!(worker.run_once().await.unwrap());
    assert_eq!(
        reqwest::Client::new()
            .get(signed["url"].as_str().unwrap())
            .send()
            .await
            .expect("test signed read failed")
            .status(),
        StatusCode::NOT_FOUND
    );
    // Retention is a database storage contract, separate from the public expired summary.
    let retained:bool=sqlx::query_scalar("SELECT snapshot IS NOT NULL OR file_id IS NOT NULL FROM knowledge.exports WHERE id = $1::uuid").bind(id).fetch_one(&pool).await.unwrap();
    assert!(!retained);
}

#[sqlx::test(migrations = "../../migrations")]
async fn deleting_a_snapshot_attachment_makes_the_queued_export_fail_explicitly(pool: PgPool) {
    let (app, files) = application(pool.clone()).await;
    let writer = register(&app, "snapshot-delete@example.com").await;
    let doc = data(
        request(
            &app,
            &writer,
            "POST",
            "/api/v1/knowledge/documents",
            json!({"title":"Snapshot input","markdown":"text"}),
        )
        .await,
    )
    .await;
    let path = format!(
        "/api/v1/knowledge/documents/{}",
        doc["id"].as_str().unwrap()
    );
    let file = upload(&app, &writer, &path).await;
    let export =
        data(request(&app, &writer, "POST", &format!("{path}/exports"), json!({})).await).await;
    assert_eq!(
        request(
            &app,
            &writer,
            "DELETE",
            &format!("{path}/attachments/{file}"),
            json!(null)
        )
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
    let status = data(
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
    assert_eq!(status["status"], "failed");
    assert_eq!(status["last_error"], "knowledge.export_input_missing");
    assert_eq!(status["can_download"], false);
}

struct DeleteFailure {
    storage: Arc<S3ObjectStorage>,
    fail: Arc<std::sync::atomic::AtomicBool>,
}
#[async_trait::async_trait]
impl labos_threejs_platform::object_storage::ObjectStorage for DeleteFailure {
    async fn delete(
        &self,
        location: &labos_threejs_platform::object_storage::ObjectLocation,
    ) -> Result<(), labos_threejs_platform::object_storage::StorageError> {
        if self.fail.load(std::sync::atomic::Ordering::SeqCst) {
            return Err(labos_threejs_platform::object_storage::StorageError::Unavailable);
        }
        self.storage.delete(location).await
    }
    async fn presign_upload(
        &self,
        location: &labos_threejs_platform::object_storage::ObjectLocation,
        headers: &labos_threejs_platform::object_storage::UploadHeaders,
        deadline: std::time::SystemTime,
    ) -> Result<
        labos_threejs_platform::object_storage::SignedRequest,
        labos_threejs_platform::object_storage::StorageError,
    > {
        self.storage
            .presign_upload(location, headers, deadline)
            .await
    }
    async fn head(
        &self,
        location: &labos_threejs_platform::object_storage::ObjectLocation,
    ) -> Result<
        labos_threejs_platform::object_storage::ObjectInfo,
        labos_threejs_platform::object_storage::StorageError,
    > {
        self.storage.head(location).await
    }
    async fn copy_if_absent(
        &self,
        source: &labos_threejs_platform::object_storage::ObjectLocation,
        etag: &str,
        target: &labos_threejs_platform::object_storage::ObjectLocation,
    ) -> Result<(), labos_threejs_platform::object_storage::StorageError> {
        self.storage.copy_if_absent(source, etag, target).await
    }
    async fn read(
        &self,
        location: &labos_threejs_platform::object_storage::ObjectLocation,
        limit: u64,
    ) -> Result<Vec<u8>, labos_threejs_platform::object_storage::StorageError> {
        self.storage.read(location, limit).await
    }
    async fn download_to(
        &self,
        location: &labos_threejs_platform::object_storage::ObjectLocation,
        path: &std::path::Path,
        limit: u64,
    ) -> Result<
        labos_threejs_platform::object_storage::FileDigest,
        labos_threejs_platform::object_storage::StorageError,
    > {
        self.storage.download_to(location, path, limit).await
    }
    async fn put_file_if_absent(
        &self,
        location: &labos_threejs_platform::object_storage::ObjectLocation,
        path: &std::path::Path,
        headers: &labos_threejs_platform::object_storage::UploadHeaders,
    ) -> Result<(), labos_threejs_platform::object_storage::StorageError> {
        self.storage
            .put_file_if_absent(location, path, headers)
            .await
    }
    async fn presign_download(
        &self,
        location: &labos_threejs_platform::object_storage::ObjectLocation,
        disposition: &str,
        content_type: &str,
        ttl: std::time::Duration,
    ) -> Result<
        labos_threejs_platform::object_storage::SignedRequest,
        labos_threejs_platform::object_storage::StorageError,
    > {
        self.storage
            .presign_download(location, disposition, content_type, ttl)
            .await
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn cleanup_failure_keeps_its_budget_and_an_operator_can_resume_it_with_a_new_worker(
    pool: PgPool,
) {
    let fail = Arc::new(std::sync::atomic::AtomicBool::new(true));
    let (app, files) = application_with_failure(pool.clone(), Some(fail.clone())).await;
    let owner = register(&app, "cleanup-retry@example.com").await;
    let doc = data(
        request(
            &app,
            &owner,
            "POST",
            "/api/v1/knowledge/documents",
            json!({"title":"Retry cleanup","markdown":"text"}),
        )
        .await,
    )
    .await;
    let path = format!(
        "/api/v1/knowledge/documents/{}",
        doc["id"].as_str().unwrap()
    );
    let file = upload(&app, &owner, &path).await;
    let signed = data(
        request(
            &app,
            &owner,
            "GET",
            &format!("{path}/attachments/{file}/download"),
            json!(null),
        )
        .await,
    )
    .await;
    assert_eq!(
        request(
            &app,
            &owner,
            "DELETE",
            &format!("{path}/attachments/{file}"),
            json!(null)
        )
        .await
        .status(),
        StatusCode::NO_CONTENT
    );
    let worker = labos_threejs_app::modules::jobs::Worker::new(
        pool.clone(),
        vec![labos_threejs_app::modules::files::cleanup_handler(
            pool.clone(),
            files.clone(),
        )],
        Default::default(),
    );
    assert!(worker.run_once().await.unwrap());
    let page = data(
        request(
            &app,
            &owner,
            "GET",
            "/api/v1/jobs?status=retry_wait",
            json!(null),
        )
        .await,
    )
    .await;
    let job = page["data"][0]["id"].as_str().unwrap();
    for _ in 1..5 {
        sqlx::query("UPDATE labos_threejs_core.jobs SET scheduled_at = clock_timestamp() - interval '1 second' WHERE id = $1::uuid").bind(job).execute(&pool).await.unwrap();
        assert!(worker.run_once().await.unwrap());
    }
    let failed = data(
        request(
            &app,
            &owner,
            "GET",
            &format!("/api/v1/jobs/{job}"),
            json!(null),
        )
        .await,
    )
    .await;
    assert_eq!(failed["job"]["status"], "failed");
    assert_eq!(failed["job"]["attempts"], 5);
    labos_threejs_app::modules::files::cleanup_maintenance(pool.clone())
        .schedule()
        .await
        .unwrap();
    assert!(!worker.run_once().await.unwrap());
    assert_eq!(
        reqwest::Client::new()
            .get(signed["url"].as_str().unwrap())
            .send()
            .await
            .expect("test signed read failed")
            .status(),
        StatusCode::OK
    );
    fail.store(false, std::sync::atomic::Ordering::SeqCst);
    assert_eq!(
        request(
            &app,
            &owner,
            "POST",
            &format!("/api/v1/jobs/{job}/retry"),
            json!({})
        )
        .await
        .status(),
        StatusCode::ACCEPTED
    );
    let replacement = labos_threejs_app::modules::jobs::Worker::new(
        pool.clone(),
        vec![labos_threejs_app::modules::files::cleanup_handler(pool, files)],
        Default::default(),
    );
    assert!(replacement.run_once().await.unwrap());
    assert_eq!(
        reqwest::Client::new()
            .get(signed["url"].as_str().unwrap())
            .send()
            .await
            .expect("test signed read failed")
            .status(),
        StatusCode::NOT_FOUND
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn old_cleanup_and_staging_collection_never_delete_a_new_ready_attachment(pool: PgPool) {
    let (app, files) = application(pool.clone()).await;
    let owner = register(&app, "new-file-protection@example.com").await;
    let doc = data(
        request(
            &app,
            &owner,
            "POST",
            "/api/v1/knowledge/documents",
            json!({"title":"Keep newer file","markdown":"text"}),
        )
        .await,
    )
    .await;
    let path = format!(
        "/api/v1/knowledge/documents/{}",
        doc["id"].as_str().unwrap()
    );
    let old = upload(&app, &owner, &path).await;
    assert_eq!(
        request(
            &app,
            &owner,
            "DELETE",
            &format!("{path}/attachments/{old}"),
            json!(null)
        )
        .await
        .status(),
        StatusCode::NO_CONTENT
    );
    let newer = upload(&app, &owner, &path).await;
    assert_ne!(old, newer);
    let worker = labos_threejs_app::modules::jobs::Worker::new(
        pool.clone(),
        vec![
            labos_threejs_app::modules::files::cleanup_handler(pool.clone(), files.clone()),
            labos_threejs_app::modules::files::rescan_handler(pool.clone(), files),
        ],
        Default::default(),
    );
    assert!(worker.run_once().await.unwrap());
    sqlx::query("UPDATE labos_threejs_core.object_cleanup SET next_probe_at = clock_timestamp() - interval '1 second' WHERE file_id = $1::uuid").bind(&old).execute(&pool).await.unwrap();
    sqlx::query("UPDATE labos_threejs_core.files SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1::uuid").bind(&newer).execute(&pool).await.unwrap();
    labos_threejs_app::modules::files::cleanup_maintenance(pool.clone())
        .schedule()
        .await
        .unwrap();
    for _ in 0..10 {
        if !worker.run_once().await.unwrap() {
            break;
        }
    }
    let signed = data(
        request(
            &app,
            &owner,
            "GET",
            &format!("{path}/attachments/{newer}/download"),
            json!(null),
        )
        .await,
    )
    .await;
    let bytes = reqwest::Client::new()
        .get(signed["url"].as_str().unwrap())
        .send()
        .await
        .expect("test signed read failed")
        .bytes()
        .await
        .expect("test read body failed");
    assert_eq!(bytes.as_ref(), b"old");
    let page = data(
        request(
            &app,
            &owner,
            "GET",
            "/api/v1/jobs?status=succeeded",
            json!(null),
        )
        .await,
    )
    .await;
    assert!(
        page["data"]
            .as_array()
            .unwrap()
            .iter()
            .any(|job| job["kind"] == "files.rescan")
    );
}
