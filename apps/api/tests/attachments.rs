use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
    response::Response,
};
use http_body_util::BodyExt;
use labos_threejs_app::modules::files::{FilePolicy, FileService};
use labos_threejs_platform::object_storage::{
    ObjectInfo, ObjectLocation, ObjectStorage, S3ObjectStorage, SignedRequest, StorageError,
    StorageSettings, UploadHeaders,
};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use std::{
    sync::Arc,
    time::{Duration, SystemTime},
};
use tokio::sync::Notify;
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
async fn application(pool: PgPool) -> Router {
    application_with_gate(pool, None).await
}
async fn application_with_gate(pool: PgPool, gate: Option<Arc<CopyGate>>) -> Router {
    let settings = StorageSettings {
        endpoint: std::env::var("S3_ENDPOINT").expect("run scripts/test-backend.mjs"),
        public_endpoint: std::env::var("S3_PUBLIC_ENDPOINT").unwrap(),
        region: "us-east-1".into(),
        bucket: format!("http-{}", uuid::Uuid::now_v7()),
        access_key: std::env::var("S3_ACCESS_KEY").unwrap(),
        secret_key: std::env::var("S3_SECRET_KEY").unwrap(),
    };
    let storage = Arc::new(S3ObjectStorage::new(&settings));
    storage
        .bootstrap(&settings.bucket, "http://127.0.0.1:5173")
        .await
        .unwrap();
    let storage: Arc<dyn ObjectStorage> = match gate {
        Some(gate) => Arc::new(GatedStorage { storage, gate }),
        None => storage,
    };
    labos_threejs_api::router_with_files(
        pool,
        Default::default(),
        Some(FileService::new(
            storage,
            settings.bucket,
            FilePolicy::default(),
        )),
    )
}

#[derive(Default)]
struct CopyGate {
    started: Notify,
    release: Notify,
}
struct GatedStorage {
    storage: Arc<S3ObjectStorage>,
    gate: Arc<CopyGate>,
}
#[async_trait::async_trait]
impl ObjectStorage for GatedStorage {
    async fn presign_upload(
        &self,
        location: &ObjectLocation,
        headers: &UploadHeaders,
        deadline: SystemTime,
    ) -> Result<SignedRequest, StorageError> {
        self.storage
            .presign_upload(location, headers, deadline)
            .await
    }
    async fn delete(&self, location: &ObjectLocation) -> Result<(), StorageError> {
        self.storage.delete(location).await
    }
    async fn head(&self, location: &ObjectLocation) -> Result<ObjectInfo, StorageError> {
        self.storage.head(location).await
    }
    async fn copy_if_absent(
        &self,
        source: &ObjectLocation,
        etag: &str,
        target: &ObjectLocation,
    ) -> Result<(), StorageError> {
        self.gate.started.notify_one();
        self.gate.release.notified().await;
        self.storage.copy_if_absent(source, etag, target).await
    }
    async fn read(&self, location: &ObjectLocation, limit: u64) -> Result<Vec<u8>, StorageError> {
        self.storage.read(location, limit).await
    }
    async fn download_to(
        &self,
        location: &ObjectLocation,
        path: &std::path::Path,
        limit: u64,
    ) -> Result<labos_threejs_platform::object_storage::FileDigest, StorageError> {
        self.storage.download_to(location, path, limit).await
    }
    async fn put_file_if_absent(
        &self,
        location: &ObjectLocation,
        path: &std::path::Path,
        headers: &UploadHeaders,
    ) -> Result<(), StorageError> {
        self.storage
            .put_file_if_absent(location, path, headers)
            .await
    }
    async fn presign_download(
        &self,
        location: &ObjectLocation,
        disposition: &str,
        content_type: &str,
        ttl: Duration,
    ) -> Result<SignedRequest, StorageError> {
        self.storage
            .presign_download(location, disposition, content_type, ttl)
            .await
    }
}
async fn upload_bytes(upload: &Value, bytes: &[u8]) {
    let mut request = reqwest::Client::new()
        .put(upload["upload"]["url"].as_str().unwrap())
        .body(bytes.to_vec());
    for (name, value) in upload["upload"]["headers"].as_object().unwrap() {
        request = request.header(name, value.as_str().unwrap());
    }
    let response = request
        .send()
        .await
        .unwrap_or_else(|_| panic!("Signed upload transport failed"));
    assert!(response.status().is_success());
}

#[sqlx::test(migrations = "../../migrations")]
async fn completion_rechecks_grants_after_object_io(pool: PgPool) {
    let gate = Arc::new(CopyGate::default());
    let app = application_with_gate(pool, Some(gate.clone())).await;
    let owner = register(&app, "owner@example.com").await;
    let editor = register(&app, "editor@example.com").await;
    let document = data(
        request(
            &app,
            &editor,
            "POST",
            "/api/v1/knowledge/documents",
            json!({"title":"撤权期间完成","markdown":"正文"}),
        )
        .await,
    )
    .await;
    let doc = document["id"].as_str().unwrap();
    let grant = format!(
        "/api/v1/knowledge/bases/{}/grants/{}",
        document["knowledge_base_id"].as_str().unwrap(),
        editor.id
    );
    let bytes = b"copied but never published";
    let upload = data(request(&app, &editor, "POST", &format!("/api/v1/knowledge/documents/{doc}/uploads"), json!({"file_name":"revoked.txt","content_type":"text/plain","size":bytes.len(),"sha256":hex::encode(Sha256::digest(bytes))})).await).await;
    upload_bytes(&upload, bytes).await;
    let path = format!(
        "/api/v1/knowledge/documents/{doc}/uploads/{}/complete",
        upload["upload_id"].as_str().unwrap()
    );
    let revoke = async {
        tokio::time::timeout(Duration::from_secs(5), gate.started.notified())
            .await
            .expect("copy reached the external storage boundary");
        assert_eq!(
            request(&app, &owner, "DELETE", &grant, Value::Null)
                .await
                .status(),
            StatusCode::NO_CONTENT
        );
        gate.release.notify_one();
    };
    let (completed, ()) = tokio::join!(request(&app, &editor, "POST", &path, Value::Null), revoke);
    assert_eq!(completed.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        data(
            request(
                &app,
                &owner,
                "GET",
                &format!("/api/v1/knowledge/documents/{doc}/attachments"),
                Value::Null
            )
            .await
        )
        .await["data"],
        json!([])
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn a_session_expiring_during_copy_cannot_publish(pool: PgPool) {
    let gate = Arc::new(CopyGate::default());
    let app = application_with_gate(pool.clone(), Some(gate.clone())).await;
    let owner = register(&app, "owner@example.com").await;
    let editor = register(&app, "editor@example.com").await;
    let document = data(
        request(
            &app,
            &editor,
            "POST",
            "/api/v1/knowledge/documents",
            json!({"title":"会话过期","markdown":"正文"}),
        )
        .await,
    )
    .await;
    let doc = document["id"].as_str().unwrap();
    let bytes = b"copy while session expires";
    let upload = data(request(&app, &editor, "POST", &format!("/api/v1/knowledge/documents/{doc}/uploads"), json!({"file_name":"expired.txt","content_type":"text/plain","size":bytes.len(),"sha256":hex::encode(Sha256::digest(bytes))})).await).await;
    upload_bytes(&upload, bytes).await;
    let path = format!(
        "/api/v1/knowledge/documents/{doc}/uploads/{}/complete",
        upload["upload_id"].as_str().unwrap()
    );
    let expire = async {
        tokio::time::timeout(Duration::from_secs(5), gate.started.notified())
            .await
            .unwrap();
        sqlx::query("UPDATE labos_threejs_core.sessions SET expires_at = clock_timestamp() - interval '1 second' WHERE user_id = $1::uuid").bind(&editor.id).execute(&pool).await.unwrap();
        gate.release.notify_one();
    };
    let (completed, ()) = tokio::join!(request(&app, &editor, "POST", &path, Value::Null), expire);
    assert_eq!(completed.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        data(
            request(
                &app,
                &owner,
                "GET",
                &format!("/api/v1/knowledge/documents/{doc}/attachments"),
                Value::Null
            )
            .await
        )
        .await["data"],
        json!([])
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn a_disappearing_source_document_cannot_be_published_after_copy(pool: PgPool) {
    deletion_during_copy(pool, false).await;
}
#[sqlx::test(migrations = "../../migrations")]
async fn a_deleted_base_prevents_its_in_flight_upload_from_publishing(pool: PgPool) {
    deletion_during_copy(pool, true).await;
}
async fn deletion_during_copy(pool: PgPool, remove_base: bool) {
    let gate = Arc::new(CopyGate::default());
    let app = application_with_gate(pool.clone(), Some(gate.clone())).await;
    let editor = register(&app, "editor@example.com").await;
    let document = data(
        request(
            &app,
            &editor,
            "POST",
            "/api/v1/knowledge/documents",
            json!({"title":"源资源消失","markdown":"正文"}),
        )
        .await,
    )
    .await;
    let doc = document["id"].as_str().unwrap();
    let bytes = b"copy with no remaining source";
    let upload = data(request(&app, &editor, "POST", &format!("/api/v1/knowledge/documents/{doc}/uploads"), json!({"file_name":"removed.txt","content_type":"text/plain","size":bytes.len(),"sha256":hex::encode(Sha256::digest(bytes))})).await).await;
    upload_bytes(&upload, bytes).await;
    let path = format!(
        "/api/v1/knowledge/documents/{doc}/uploads/{}/complete",
        upload["upload_id"].as_str().unwrap()
    );
    let remove_source = async {
        tokio::time::timeout(Duration::from_secs(5), gate.started.notified())
            .await
            .unwrap();
        let source = if remove_base {
            format!(
                "/api/v1/knowledge/bases/{}",
                document["knowledge_base_id"].as_str().unwrap()
            )
        } else {
            format!("/api/v1/knowledge/documents/{doc}")
        };
        assert_eq!(
            request(&app, &editor, "DELETE", &source, Value::Null)
                .await
                .status(),
            StatusCode::NO_CONTENT
        );
        gate.release.notify_one();
    };
    let (completed, ()) = tokio::join!(
        request(&app, &editor, "POST", &path, Value::Null),
        remove_source
    );
    assert_eq!(completed.status(), StatusCode::NOT_FOUND);
    let mut connection = pool.acquire().await.unwrap();
    assert!(
        labos_threejs_app::modules::files::ready_info(
            &mut connection,
            &[upload["upload_id"].as_str().unwrap().to_owned()]
        )
        .await
        .unwrap()
        .is_empty()
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn failed_publication_audit_keeps_the_upload_recoverable(pool: PgPool) {
    let app = application(pool.clone()).await;
    let editor = register(&app, "editor@example.com").await;
    let document = data(
        request(
            &app,
            &editor,
            "POST",
            "/api/v1/knowledge/documents",
            json!({"title":"原子发布","markdown":"正文"}),
        )
        .await,
    )
    .await;
    let doc = document["id"].as_str().unwrap();
    let bytes = b"publication must include audit";
    let upload = data(request(&app, &editor, "POST", &format!("/api/v1/knowledge/documents/{doc}/uploads"), json!({"file_name":"atomic.txt","content_type":"text/plain","size":bytes.len(),"sha256":hex::encode(Sha256::digest(bytes))})).await).await;
    upload_bytes(&upload, bytes).await;
    let path = format!(
        "/api/v1/knowledge/documents/{doc}/uploads/{}/complete",
        upload["upload_id"].as_str().unwrap()
    );
    sqlx::query("CREATE FUNCTION reject_attachment_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'knowledge.attachment.complete' THEN RAISE EXCEPTION 'audit unavailable'; END IF; RETURN NEW; END $$").execute(&pool).await.unwrap();
    sqlx::query("CREATE TRIGGER fail_attachment_audit BEFORE INSERT ON labos_threejs_core.audit_events FOR EACH ROW EXECUTE FUNCTION reject_attachment_audit()").execute(&pool).await.unwrap();
    assert_eq!(
        request(&app, &editor, "POST", &path, Value::Null)
            .await
            .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        data(
            request(
                &app,
                &editor,
                "GET",
                &format!("/api/v1/knowledge/documents/{doc}/attachments"),
                Value::Null
            )
            .await
        )
        .await["data"],
        json!([])
    );
    sqlx::query("DROP TRIGGER fail_attachment_audit ON labos_threejs_core.audit_events")
        .execute(&pool)
        .await
        .unwrap();
    assert_eq!(
        request(&app, &editor, "POST", &path, Value::Null)
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        data(
            request(
                &app,
                &editor,
                "GET",
                &format!("/api/v1/knowledge/documents/{doc}/attachments"),
                Value::Null
            )
            .await
        )
        .await["data"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn readers_can_download_but_cannot_complete_and_revocation_blocks_new_links(pool: PgPool) {
    let app = application(pool).await;
    let owner = register(&app, "owner@example.com").await;
    let editor = register(&app, "editor@example.com").await;
    let reader = register(&app, "reader@example.com").await;
    let outsider = register(&app, "outsider@example.com").await;
    let document = data(
        request(
            &app,
            &editor,
            "POST",
            "/api/v1/knowledge/documents",
            json!({"title":"附件继承权限","markdown":"正文"}),
        )
        .await,
    )
    .await;
    let other_document = data(
        request(
            &app,
            &editor,
            "POST",
            "/api/v1/knowledge/documents",
            json!({"title":"不同的文档","markdown":"正文"}),
        )
        .await,
    )
    .await;
    let doc = document["id"].as_str().unwrap();
    let grant = format!(
        "/api/v1/knowledge/bases/{}/grants/{}",
        document["knowledge_base_id"].as_str().unwrap(),
        reader.id
    );
    assert_eq!(
        request(&app, &owner, "PUT", &grant, json!({"access":"reader"}))
            .await
            .status(),
        StatusCode::OK
    );
    let bytes = b"protected attachment bytes";
    let input = json!({"file_name":"protected.txt","content_type":"text/plain","size":bytes.len(),"sha256":hex::encode(Sha256::digest(bytes))});
    let start = format!("/api/v1/knowledge/documents/{doc}/uploads");
    assert_eq!(
        request(&app, &reader, "POST", &start, input.clone())
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request(&app, &outsider, "POST", &start, input.clone())
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    let upload = data(request(&app, &editor, "POST", &start, input).await).await;
    upload_bytes(&upload, bytes).await;
    let id = upload["upload_id"].as_str().unwrap();
    let complete = format!("{start}/{id}/complete");
    assert_eq!(
        request(&app, &reader, "POST", &complete, Value::Null)
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        request(
            &app,
            &editor,
            "POST",
            &format!(
                "/api/v1/knowledge/documents/{}/uploads/{id}/complete",
                other_document["id"].as_str().unwrap()
            ),
            Value::Null
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request(&app, &editor, "POST", &complete, Value::Null)
            .await
            .status(),
        StatusCode::OK
    );
    let download = format!("/api/v1/knowledge/documents/{doc}/attachments/{id}/download");
    assert_eq!(
        request(&app, &outsider, "GET", &download, Value::Null)
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        request(
            &app,
            &editor,
            "GET",
            &format!(
                "/api/v1/knowledge/documents/{}/attachments/{id}/download",
                other_document["id"].as_str().unwrap()
            ),
            Value::Null
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    let signed = data(request(&app, &reader, "GET", &download, Value::Null).await).await;
    assert_eq!(
        request(&app, &owner, "DELETE", &grant, Value::Null)
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        request(&app, &reader, "GET", &download, Value::Null)
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    // Direct download capabilities remain usable within the explicitly declared short TTL.
    let response = reqwest::get(signed["url"].as_str().unwrap())
        .await
        .unwrap_or_else(|_| panic!("Signed download transport failed"));
    assert!(response.status().is_success());
    assert_eq!(
        response
            .bytes()
            .await
            .unwrap_or_else(|_| panic!("Signed download body failed"))
            .as_ref(),
        bytes
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn upload_identity_is_replayed_but_expiration_requires_a_new_resource(pool: PgPool) {
    let app = application(pool.clone()).await;
    let editor = register(&app, "editor@example.com").await;
    let document = data(
        request(
            &app,
            &editor,
            "POST",
            "/api/v1/knowledge/documents",
            json!({"title":"过期上传","markdown":"正文"}),
        )
        .await,
    )
    .await;
    let doc = document["id"].as_str().unwrap();
    let path = format!("/api/v1/knowledge/documents/{doc}/uploads");
    let input = json!({"file_name":"retry.txt","content_type":"text/plain","size":4,"sha256":hex::encode(Sha256::digest(b"data"))});
    let first =
        data(request_key(&app, &editor, "POST", &path, input.clone(), "stable-upload").await).await;
    let second =
        data(request_key(&app, &editor, "POST", &path, input.clone(), "stable-upload").await).await;
    assert_eq!(first["upload_id"], second["upload_id"]);
    let id = first["upload_id"].as_str().unwrap();
    sqlx::query("UPDATE labos_threejs_core.files SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1::uuid").bind(id).execute(&pool).await.unwrap();
    let expired = request_key(&app, &editor, "POST", &path, input.clone(), "stable-upload").await;
    assert_eq!(expired.status(), StatusCode::GONE);
    assert_eq!(data(expired).await["error"]["code"], "files.upload_expired");
    let expired_completion = request(
        &app,
        &editor,
        "POST",
        &format!("{path}/{id}/complete"),
        Value::Null,
    )
    .await;
    assert_eq!(expired_completion.status(), StatusCode::GONE);
    let restarted = request_key(&app, &editor, "POST", &path, input, "new-upload").await;
    assert_eq!(restarted.status(), StatusCode::CREATED);
    assert_ne!(data(restarted).await["upload_id"], first["upload_id"]);
}

#[sqlx::test(migrations = "../../migrations")]
async fn size_or_type_mismatch_is_rejected_without_publishing(pool: PgPool) {
    let app = application(pool).await;
    let editor = register(&app, "editor@example.com").await;
    let document = data(
        request(
            &app,
            &editor,
            "POST",
            "/api/v1/knowledge/documents",
            json!({"title":"校验失败","markdown":"正文"}),
        )
        .await,
    )
    .await;
    let doc = document["id"].as_str().unwrap();
    let bytes = b"plain content";
    for (name, content_type, size) in [
        ("wrong-size.txt", "text/plain", 1),
        ("wrong-type.png", "image/png", bytes.len()),
    ] {
        let upload = data(request(&app, &editor, "POST", &format!("/api/v1/knowledge/documents/{doc}/uploads"), json!({"file_name":name,"content_type":content_type,"size":size,"sha256":hex::encode(Sha256::digest(bytes))})).await).await;
        upload_bytes(&upload, bytes).await;
        let id = upload["upload_id"].as_str().unwrap();
        let completed = request(
            &app,
            &editor,
            "POST",
            &format!("/api/v1/knowledge/documents/{doc}/uploads/{id}/complete"),
            Value::Null,
        )
        .await;
        assert_eq!(completed.status(), StatusCode::UNPROCESSABLE_ENTITY);
        assert_eq!(
            data(completed).await["error"]["code"],
            "files.upload_rejected"
        );
        assert_eq!(
            request(
                &app,
                &editor,
                "GET",
                &format!("/api/v1/knowledge/documents/{doc}/attachments/{id}/download"),
                Value::Null
            )
            .await
            .status(),
            StatusCode::NOT_FOUND
        );
    }
    let listed = data(
        request(
            &app,
            &editor,
            "GET",
            &format!("/api/v1/knowledge/documents/{doc}/attachments"),
            Value::Null,
        )
        .await,
    )
    .await;
    assert_eq!(listed["data"], json!([]));
}

#[sqlx::test(migrations = "../../migrations")]
async fn concurrent_completions_publish_one_attachment_and_staging_replay_cannot_change_it(
    pool: PgPool,
) {
    let app = application(pool.clone()).await;
    let editor = register(&app, "editor@example.com").await;
    let document = data(
        request(
            &app,
            &editor,
            "POST",
            "/api/v1/knowledge/documents",
            json!({"title":"并发完成","markdown":"正文"}),
        )
        .await,
    )
    .await;
    let doc = document["id"].as_str().unwrap();
    let bytes = b"one published attachment";
    let upload = data(request(&app, &editor, "POST", &format!("/api/v1/knowledge/documents/{doc}/uploads"), json!({"file_name":"one.txt","content_type":"text/plain","size":bytes.len(),"sha256":hex::encode(Sha256::digest(bytes))})).await).await;
    upload_bytes(&upload, bytes).await;
    let id = upload["upload_id"].as_str().unwrap();
    let path = format!("/api/v1/knowledge/documents/{doc}/uploads/{id}/complete");
    let mut gate = pool.begin().await.unwrap();
    sqlx::query("LOCK TABLE knowledge.attachments IN SHARE MODE")
        .execute(&mut *gate)
        .await
        .unwrap();
    let release = async {
        tokio::time::timeout(std::time::Duration::from_secs(5), async {
            loop {
                let waiting: i64 = sqlx::query_scalar("SELECT count(*) FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'").fetch_one(&pool).await.unwrap();
                if waiting >= 2 { break; }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        }).await.expect("completion requests contend on publication");
        gate.rollback().await.unwrap();
    };
    let (a, b, ()) = tokio::join!(
        request(&app, &editor, "POST", &path, Value::Null),
        request(&app, &editor, "POST", &path, Value::Null),
        release
    );
    assert_eq!(a.status(), StatusCode::OK);
    assert_eq!(b.status(), StatusCode::OK);
    assert_eq!(data(a).await, data(b).await);
    upload_bytes(&upload, bytes).await;
    let capability = data(
        request(
            &app,
            &editor,
            "GET",
            &format!("/api/v1/knowledge/documents/{doc}/attachments/{id}/download"),
            Value::Null,
        )
        .await,
    )
    .await;
    let staged_url = reqwest::Url::parse(upload["upload"]["url"].as_str().unwrap()).unwrap();
    let final_url = reqwest::Url::parse(capability["url"].as_str().unwrap()).unwrap();
    assert!(
        staged_url.path() != final_url.path(),
        "publication uses a separate object"
    );
    let response = reqwest::get(final_url)
        .await
        .unwrap_or_else(|_| panic!("Signed download transport failed"));
    assert_eq!(
        response
            .bytes()
            .await
            .unwrap_or_else(|_| panic!("Signed download body failed"))
            .as_ref(),
        bytes
    );
    assert_eq!(
        data(
            request(
                &app,
                &editor,
                "GET",
                &format!("/api/v1/knowledge/documents/{doc}/attachments"),
                Value::Null
            )
            .await
        )
        .await["data"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn completion_publishes_once_and_download_returns_the_verified_bytes(pool: PgPool) {
    let app = application(pool).await;
    let editor = register(&app, "editor@example.com").await;
    let document = data(
        request(
            &app,
            &editor,
            "POST",
            "/api/v1/knowledge/documents",
            json!({"title":"完成附件","markdown":"正文"}),
        )
        .await,
    )
    .await;
    let id = document["id"].as_str().unwrap();
    let bytes = b"verified bytes from the published candidate";
    let uploaded = data(request(&app, &editor, "POST", &format!("/api/v1/knowledge/documents/{id}/uploads"), json!({"file_name":"笔记.txt","content_type":"text/plain","size":bytes.len(),"sha256":hex::encode(Sha256::digest(bytes))})).await).await;
    upload_bytes(&uploaded, bytes).await;
    let upload_id = uploaded["upload_id"].as_str().unwrap();
    let path = format!("/api/v1/knowledge/documents/{id}/uploads/{upload_id}/complete");
    let completed = request(&app, &editor, "POST", &path, Value::Null).await;
    assert_eq!(completed.status(), StatusCode::OK);
    let attachment = data(completed).await;
    assert_eq!(attachment["id"], upload_id);
    assert_eq!(attachment["size"], bytes.len());
    assert_eq!(attachment["sha256"], hex::encode(Sha256::digest(bytes)));
    let replay = request(&app, &editor, "POST", &path, Value::Null).await;
    assert_eq!(replay.status(), StatusCode::OK);
    assert_eq!(data(replay).await, attachment);
    let listed = data(
        request(
            &app,
            &editor,
            "GET",
            &format!("/api/v1/knowledge/documents/{id}/attachments"),
            Value::Null,
        )
        .await,
    )
    .await;
    assert_eq!(listed["data"].as_array().unwrap().len(), 1);
    let capability = request(
        &app,
        &editor,
        "GET",
        &format!("/api/v1/knowledge/documents/{id}/attachments/{upload_id}/download"),
        Value::Null,
    )
    .await;
    assert_eq!(capability.status(), StatusCode::OK);
    let capability = data(capability).await;
    let response = reqwest::Client::new()
        .get(capability["url"].as_str().unwrap())
        .send()
        .await
        .unwrap_or_else(|_| panic!("Signed download transport failed"));
    assert!(response.status().is_success());
    assert!(
        response.headers()["content-disposition"]
            .to_str()
            .unwrap()
            .starts_with("attachment;")
    );
    assert_eq!(response.headers()["cache-control"], "no-store");
    let actual = response
        .bytes()
        .await
        .unwrap_or_else(|_| panic!("Signed download body failed"));
    assert_eq!(actual.as_ref(), bytes);
}

#[sqlx::test(migrations = "../../migrations")]
async fn an_editor_uploads_to_staging_without_publishing_an_attachment(pool: PgPool) {
    let app = application(pool).await;
    register(&app, "owner@example.com").await;
    let editor = register(&app, "editor@example.com").await;
    let document = data(
        request(
            &app,
            &editor,
            "POST",
            "/api/v1/knowledge/documents",
            json!({"title":"附件测试","markdown":"正文"}),
        )
        .await,
    )
    .await;
    let id = document["id"].as_str().unwrap();
    let bytes = b"an actual RustFS attachment";
    let uploaded = request(&app, &editor, "POST", &format!("/api/v1/knowledge/documents/{id}/uploads"), json!({"file_name":"notes.txt","content_type":"text/plain","size":bytes.len(),"sha256":hex::encode(Sha256::digest(bytes))})).await;
    assert_eq!(uploaded.status(), StatusCode::CREATED);
    let uploaded = data(uploaded).await;
    assert!(uploaded["upload_id"].is_string());
    assert_eq!(uploaded["upload"]["method"], "PUT");
    upload_bytes(&uploaded, bytes).await;
    let listed = request(
        &app,
        &editor,
        "GET",
        &format!("/api/v1/knowledge/documents/{id}/attachments"),
        Value::Null,
    )
    .await;
    assert_eq!(listed.status(), StatusCode::OK);
    assert_eq!(data(listed).await["data"], json!([]));
}
