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
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
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

#[sqlx::test(migrations = "../../migrations")]
async fn upload_and_concurrent_completion_retries_publish_one_asset(pool: PgPool) {
    let app = application(pool).await;
    let actor = register(&app, "retry@example.test").await;
    let bytes = microscope();
    let input = json!({"name":"Retry microscope", "source":"Poly Haven", "license":"CC0", "version":"1.0",
        "file":{"file_name":"retry.glb","content_type":"model/gltf-binary","size":bytes.len(),"sha256":hex::encode(Sha256::digest(bytes))}});
    let first = data(
        request_key(
            &app,
            &actor,
            "POST",
            "/api/v1/lab/asset-uploads",
            input.clone(),
            "stable-retry",
        )
        .await,
    )
    .await;
    let second = data(
        request_key(
            &app,
            &actor,
            "POST",
            "/api/v1/lab/asset-uploads",
            input.clone(),
            "stable-retry",
        )
        .await,
    )
    .await;
    assert_eq!(first["upload_id"], second["upload_id"]);
    let mut changed = input;
    changed["name"] = json!("Different intent");
    assert_eq!(
        request_key(
            &app,
            &actor,
            "POST",
            "/api/v1/lab/asset-uploads",
            changed,
            "stable-retry"
        )
        .await
        .status(),
        StatusCode::CONFLICT
    );
    upload(&first, bytes).await;
    let complete = format!(
        "/api/v1/lab/asset-uploads/{}/complete",
        first["upload_id"].as_str().unwrap()
    );
    let (left, right) = tokio::join!(
        request(&app, &actor, "POST", &complete, Value::Null),
        request(&app, &actor, "POST", &complete, Value::Null)
    );
    assert_eq!(left.status(), StatusCode::OK);
    assert_eq!(right.status(), StatusCode::OK);
    assert_eq!(data(left).await, data(right).await);
    let page = data(request(&app, &actor, "GET", "/api/v1/lab/assets", Value::Null).await).await;
    assert_eq!(page["data"].as_array().unwrap().len(), 1);
}

async fn application(pool: PgPool) -> Router {
    application_with(pool, None, FilePolicy::default()).await.0
}

async fn application_with(
    pool: PgPool,
    gate: Option<Arc<CopyGate>>,
    policy: FilePolicy,
) -> (Router, FileService) {
    let settings = StorageSettings {
        endpoint: std::env::var("S3_ENDPOINT").expect("run scripts/test-backend.mjs"),
        public_endpoint: std::env::var("S3_PUBLIC_ENDPOINT").unwrap(),
        region: "us-east-1".into(),
        bucket: format!("lab-{}", uuid::Uuid::now_v7()),
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
    let files = FileService::new(storage, settings.bucket, policy);
    (
        labos_threejs_api::router_with_files(pool, Default::default(), Some(files.clone())),
        files,
    )
}

#[derive(Default)]
struct CopyGate {
    started: Notify,
    release: Notify,
    block: AtomicBool,
    fail: AtomicBool,
    corrupt: AtomicBool,
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
        if self.gate.block.swap(false, Ordering::SeqCst) {
            self.gate.started.notify_one();
            self.gate.release.notified().await;
        }
        if self.gate.fail.swap(false, Ordering::SeqCst) {
            return Err(StorageError::Unavailable);
        }
        self.storage.copy_if_absent(source, etag, target).await
    }
    async fn read(&self, location: &ObjectLocation, limit: u64) -> Result<Vec<u8>, StorageError> {
        let mut bytes = self.storage.read(location, limit).await?;
        if self.gate.corrupt.swap(false, Ordering::SeqCst)
            && let Some(first) = bytes.first_mut()
        {
            *first ^= 1;
        }
        Ok(bytes)
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

#[sqlx::test(migrations = "../../migrations")]
async fn revoked_agent_during_object_io_cannot_publish_but_member_can_retry(pool: PgPool) {
    let gate = Arc::new(CopyGate::default());
    gate.block.store(true, Ordering::SeqCst);
    let (app, _) = application_with(pool, Some(gate.clone()), FilePolicy::default()).await;
    let actor = register(&app, "inflight@example.test").await;
    let key = key(&app, &actor).await;
    let pending = start(&app, &actor, microscope()).await;
    upload(&pending, microscope()).await;
    let path = format!(
        "/api/v1/lab/asset-uploads/{}/complete",
        pending["upload_id"].as_str().unwrap()
    );
    let revoke = async {
        tokio::time::timeout(Duration::from_secs(5), gate.started.notified())
            .await
            .unwrap();
        let revoke = format!("/api/v1/api-keys/{}", key["key"]["id"].as_str().unwrap());
        assert_eq!(
            request(&app, &actor, "DELETE", &revoke, Value::Null)
                .await
                .status(),
            StatusCode::NO_CONTENT
        );
        gate.release.notify_one();
    };
    let (completed, ()) = tokio::join!(
        bearer(
            &app,
            key["secret"].as_str().unwrap(),
            "POST",
            &path,
            Value::Null
        ),
        revoke
    );
    assert_eq!(completed.status(), StatusCode::UNAUTHORIZED);
    assert_eq!(
        data(request(&app, &actor, "GET", "/api/v1/lab/assets", Value::Null).await).await["data"],
        json!([])
    );
    assert_eq!(
        request(&app, &actor, "POST", &path, Value::Null)
            .await
            .status(),
        StatusCode::OK
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn storage_failure_is_retryable_and_corrupt_bytes_are_never_published(pool: PgPool) {
    let gate = Arc::new(CopyGate::default());
    gate.fail.store(true, Ordering::SeqCst);
    let (app, _) = application_with(pool, Some(gate.clone()), FilePolicy::default()).await;
    let actor = register(&app, "storage@example.test").await;
    let pending = start(&app, &actor, microscope()).await;
    upload(&pending, microscope()).await;
    let path = format!(
        "/api/v1/lab/asset-uploads/{}/complete",
        pending["upload_id"].as_str().unwrap()
    );
    assert_eq!(
        request(&app, &actor, "POST", &path, Value::Null)
            .await
            .status(),
        StatusCode::SERVICE_UNAVAILABLE
    );
    assert_eq!(
        data(request(&app, &actor, "GET", "/api/v1/lab/assets", Value::Null).await).await["data"],
        json!([])
    );
    assert_eq!(
        request(&app, &actor, "POST", &path, Value::Null)
            .await
            .status(),
        StatusCode::OK
    );
    let corrupt = start(&app, &actor, microscope()).await;
    upload(&corrupt, microscope()).await;
    gate.corrupt.store(true, Ordering::SeqCst);
    let path = format!(
        "/api/v1/lab/asset-uploads/{}/complete",
        corrupt["upload_id"].as_str().unwrap()
    );
    assert_eq!(
        request(&app, &actor, "POST", &path, Value::Null)
            .await
            .status(),
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let page = data(request(&app, &actor, "GET", "/api/v1/lab/assets", Value::Null).await).await;
    assert_eq!(page["data"].as_array().unwrap().len(), 1);
}

#[sqlx::test(migrations = "../../migrations")]
async fn deleted_asset_bytes_are_reclaimed_by_the_existing_worker(pool: PgPool) {
    let (app, files) = application_with(pool.clone(), None, FilePolicy::default()).await;
    let actor = register(&app, "cleanup@example.test").await;
    let pending = start(&app, &actor, microscope()).await;
    upload(&pending, microscope()).await;
    let complete = format!(
        "/api/v1/lab/asset-uploads/{}/complete",
        pending["upload_id"].as_str().unwrap()
    );
    let asset = data(request(&app, &actor, "POST", &complete, Value::Null).await).await;
    let path = format!("/api/v1/lab/assets/{}", asset["id"].as_str().unwrap());
    let capability = data(
        request(
            &app,
            &actor,
            "GET",
            &format!("{path}/download"),
            Value::Null,
        )
        .await,
    )
    .await;
    assert_eq!(
        request(&app, &actor, "DELETE", &path, Value::Null)
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    let worker = labos_threejs_app::modules::jobs::Worker::new(
        pool.clone(),
        vec![labos_threejs_app::modules::files::cleanup_handler(
            pool, files,
        )],
        Default::default(),
    );
    assert!(worker.run_once().await.unwrap());
    let response = reqwest::get(capability["url"].as_str().unwrap())
        .await
        .unwrap_or_else(|_| panic!("Signed download transport failed"));
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(
        request(&app, &actor, "GET", &path, Value::Null)
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn deployment_file_limit_is_public_and_oversized_uploads_have_no_asset(pool: PgPool) {
    let policy = FilePolicy {
        max_bytes: 128,
        ..Default::default()
    };
    let (app, _) = application_with(pool, None, policy).await;
    let actor = register(&app, "limit@example.test").await;
    let page = data(request(&app, &actor, "GET", "/api/v1/lab/assets", Value::Null).await).await;
    assert_eq!(page["max_upload_bytes"], 128);
    let response = request(&app, &actor, "POST", "/api/v1/lab/asset-uploads", json!({"name":"Large", "source":"", "license":"", "version":"1.0", "file":{"file_name":"large.glb","content_type":"model/gltf-binary","size":129,"sha256":"00".repeat(32)}})).await;
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(
        data(request(&app, &actor, "GET", "/api/v1/lab/assets", Value::Null).await).await["data"],
        json!([])
    );
}

fn microscope() -> &'static [u8] {
    include_bytes!("../../web/public/lab-assets/models/industrial-microscope.glb")
}

#[sqlx::test(migrations = "../../migrations")]
async fn compressed_glb_assets_publish_without_rewriting_their_bytes(pool: PgPool) {
    let app = application(pool).await;
    let actor = register(&app, "compression@example.test").await;
    for bytes in [
        include_bytes!("../../../tests/fixtures/lab/cube-draco.glb").as_slice(),
        include_bytes!("../../../tests/fixtures/lab/cube-meshopt.glb").as_slice(),
        include_bytes!("../../../tests/fixtures/lab/cube-basis.glb").as_slice(),
    ] {
        let pending = start(&app, &actor, bytes).await;
        upload(&pending, bytes).await;
        let complete = format!(
            "/api/v1/lab/asset-uploads/{}/complete",
            pending["upload_id"].as_str().unwrap()
        );
        let response = request(&app, &actor, "POST", &complete, Value::Null).await;
        assert_eq!(response.status(), StatusCode::OK);
        let asset = data(response).await;
        let capability = data(
            request(
                &app,
                &actor,
                "GET",
                &format!(
                    "/api/v1/lab/assets/{}/download",
                    asset["id"].as_str().unwrap()
                ),
                Value::Null,
            )
            .await,
        )
        .await;
        let response = reqwest::get(capability["url"].as_str().unwrap())
            .await
            .unwrap_or_else(|_| panic!("Signed download transport failed"));
        assert_eq!(response.bytes().await.unwrap().as_ref(), bytes);
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn users_and_agents_query_versioned_builtin_definitions_and_robot_support(pool: PgPool) {
    let app = application(pool).await;
    let actor = register(&app, "definitions@example.test").await;
    let response = request(
        &app,
        &actor,
        "GET",
        "/api/v1/lab/asset-definitions",
        Value::Null,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let page = data(response).await;
    assert_eq!(page["data"].as_array().unwrap().len(), 8);
    let robot = page["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|definition| definition["id"] == "robot")
        .unwrap();
    assert_eq!(robot["version"], "1.0");
    assert_eq!(robot["category"], "robot");
    assert_eq!(robot["capabilities"][0]["implemented"], false);
    assert_eq!(robot["capabilities"][0]["parameters"]["type"], "object");
    let key = key(&app, &actor).await;
    let response = bearer(
        &app,
        key["secret"].as_str().unwrap(),
        "GET",
        "/api/v1/lab/asset-definitions/robot/1.0",
        Value::Null,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    assert_eq!(data(response).await, *robot);
    assert_eq!(
        request(
            &app,
            &actor,
            "GET",
            "/api/v1/lab/asset-definitions/robot/2.0",
            Value::Null
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
}

fn rewrite_glb(bytes: &[u8], edit: impl FnOnce(&mut Value)) -> Vec<u8> {
    let json_length = u32::from_le_bytes(bytes[12..16].try_into().unwrap()) as usize;
    let mut document: Value = serde_json::from_slice(&bytes[20..20 + json_length]).unwrap();
    edit(&mut document);
    let mut encoded = serde_json::to_vec(&document).unwrap();
    while !encoded.len().is_multiple_of(4) {
        encoded.push(b' ');
    }
    let length = 20 + encoded.len() + bytes.len() - 20 - json_length;
    let mut result = Vec::new();
    for value in [
        0x46546c67_u32,
        2,
        length as u32,
        encoded.len() as u32,
        0x4e4f534a,
    ] {
        result.extend_from_slice(&value.to_le_bytes());
    }
    result.extend(encoded);
    result.extend_from_slice(&bytes[20 + json_length..]);
    result
}

fn corrupt_payload(bytes: &[u8], view: impl FnOnce(&Value) -> usize) -> Vec<u8> {
    let json_length = u32::from_le_bytes(bytes[12..16].try_into().unwrap()) as usize;
    let document: Value = serde_json::from_slice(&bytes[20..20 + json_length]).unwrap();
    let view = &document["bufferViews"][view(&document)];
    let offset = 28 + json_length + view["byteOffset"].as_u64().unwrap_or(0) as usize;
    let length = view["byteLength"].as_u64().unwrap() as usize;
    let mut result = bytes.to_vec();
    result[offset..offset + length].fill(0);
    result
}

#[sqlx::test(migrations = "../../migrations")]
async fn malformed_accessors_are_rejected_without_a_decoder_panic(pool: PgPool) {
    let app = application(pool).await;
    let actor = register(&app, "accessors@example.test").await;
    let cube = include_bytes!("../../../tests/fixtures/lab/cube.glb");
    let bad_indices = rewrite_glb(cube, |root| {
        let index = root["meshes"][0]["primitives"][0]["indices"]
            .as_u64()
            .unwrap() as usize;
        root["accessors"][index]["componentType"] = json!(5126);
        root["accessors"][index]["count"] = json!(18);
    });
    let bad_position = rewrite_glb(cube, |root| root["accessors"][0]["type"] = json!("VEC2"));
    let zero_sparse = rewrite_glb(
        cube,
        |root| root["accessors"][0]["sparse"] = json!({"count":0,"indices":{"bufferView":1,"componentType":5123},"values":{"bufferView":0}}),
    );
    let sparse_range = rewrite_glb(
        cube,
        |root| root["accessors"][0]["sparse"] = json!({"count":24,"indices":{"bufferView":1,"componentType":5123},"values":{"bufferView":0,"byteOffset":500}}),
    );
    for (name, bytes) in [
        ("index type", bad_indices),
        ("position dimensions", bad_position),
        ("sparse count", zero_sparse),
        ("sparse range", sparse_range),
    ] {
        let pending = start(&app, &actor, &bytes).await;
        upload(&pending, &bytes).await;
        let path = format!(
            "/api/v1/lab/asset-uploads/{}/complete",
            pending["upload_id"].as_str().unwrap()
        );
        assert_eq!(
            request(&app, &actor, "POST", &path, Value::Null)
                .await
                .status(),
            StatusCode::UNPROCESSABLE_ENTITY,
            "{name}"
        );
        assert_eq!(
            data(request(&app, &actor, "GET", "/api/v1/lab/assets", Value::Null).await).await["data"],
            json!([])
        );
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn basis_extension_sources_and_mime_must_match_even_with_core_fallbacks(pool: PgPool) {
    let app = application(pool).await;
    let actor = register(&app, "basis-context@example.test").await;
    for source in [999999, 1] {
        let bytes = rewrite_glb(microscope(), |root| {
            root["textures"][0]["extensions"]["KHR_texture_basisu"] = json!({"source":source});
            root["extensionsUsed"] = json!(["KHR_texture_basisu"]);
            root["extensionsRequired"] = json!(["KHR_texture_basisu"]);
            if source == 1 {
                root["images"][1]["mimeType"] = json!("image/ktx2");
            }
        });
        let pending = start(&app, &actor, &bytes).await;
        upload(&pending, &bytes).await;
        let path = format!(
            "/api/v1/lab/asset-uploads/{}/complete",
            pending["upload_id"].as_str().unwrap()
        );
        assert_eq!(
            request(&app, &actor, "POST", &path, Value::Null)
                .await
                .status(),
            StatusCode::UNPROCESSABLE_ENTITY,
            "source {source}"
        );
        assert_eq!(
            data(request(&app, &actor, "GET", "/api/v1/lab/assets", Value::Null).await).await["data"],
            json!([])
        );
    }
    let bytes = rewrite_glb(
        include_bytes!("../../../tests/fixtures/lab/cube-basis.glb"),
        |root| {
            root["textures"][0]["source"] = json!(0);
            root["textures"][0]
                .as_object_mut()
                .unwrap()
                .remove("extensions");
            root["extensionsUsed"] = json!([]);
            root["extensionsRequired"] = json!([]);
        },
    );
    let pending = start(&app, &actor, &bytes).await;
    upload(&pending, &bytes).await;
    let path = format!(
        "/api/v1/lab/asset-uploads/{}/complete",
        pending["upload_id"].as_str().unwrap()
    );
    assert_eq!(
        request(&app, &actor, "POST", &path, Value::Null)
            .await
            .status(),
        StatusCode::UNPROCESSABLE_ENTITY,
        "ordinary KTX2 source"
    );
    assert_eq!(
        data(request(&app, &actor, "GET", "/api/v1/lab/assets", Value::Null).await).await["data"],
        json!([])
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn expanded_resource_limit_rejects_small_encoded_models_and_valid_retry_recovers(
    pool: PgPool,
) {
    let app = application(pool).await;
    let actor = register(&app, "expansion@example.test").await;
    let page = data(request(&app, &actor, "GET", "/api/v1/lab/assets", Value::Null).await).await;
    let limit = page["max_decoded_resource_bytes"].as_u64().unwrap();
    let sparse = rewrite_glb(
        include_bytes!("../../../tests/fixtures/lab/cube.glb"),
        |root| {
            root["accessors"][0]
                .as_object_mut()
                .unwrap()
                .remove("bufferView");
            root["accessors"][0]["count"] = json!(limit / 12 + 1);
            root["accessors"][0]["sparse"] = json!({"count":1,"indices":{"bufferView":1,"componentType":5123},"values":{"bufferView":0}});
        },
    );
    let meshopt = rewrite_glb(
        include_bytes!("../../../tests/fixtures/lab/cube-meshopt.glb"),
        |root| root["buffers"][1]["byteLength"] = json!(limit + 1),
    );
    let mut basis = include_bytes!("../../../tests/fixtures/lab/cube-basis.glb").to_vec();
    let json_length = u32::from_le_bytes(basis[12..16].try_into().unwrap()) as usize;
    let root: Value = serde_json::from_slice(&basis[20..20 + json_length]).unwrap();
    let offset = root["bufferViews"][root["images"][0]["bufferView"].as_u64().unwrap() as usize]["byteOffset"].as_u64().unwrap() as usize;
    let width_offset = 28 + json_length + offset + 20;
    basis[width_offset..width_offset + 4].copy_from_slice(&(limit as u32).to_le_bytes());
    for bytes in [sparse, meshopt, basis] {
        let pending = start(&app, &actor, &bytes).await;
        upload(&pending, &bytes).await;
        let path = format!(
            "/api/v1/lab/asset-uploads/{}/complete",
            pending["upload_id"].as_str().unwrap()
        );
        assert_eq!(
            request(&app, &actor, "POST", &path, Value::Null)
                .await
                .status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
        assert_eq!(
            data(request(&app, &actor, "GET", "/api/v1/lab/assets", Value::Null).await).await["data"],
            json!([])
        );
    }
    let pending = start(&app, &actor, microscope()).await;
    upload(&pending, microscope()).await;
    let path = format!(
        "/api/v1/lab/asset-uploads/{}/complete",
        pending["upload_id"].as_str().unwrap()
    );
    assert_eq!(
        request(&app, &actor, "POST", &path, Value::Null)
            .await
            .status(),
        StatusCode::OK
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn malformed_embedded_payloads_with_matching_hashes_never_publish(pool: PgPool) {
    let app = application(pool).await;
    let actor = register(&app, "payloads@example.test").await;
    let draco = corrupt_payload(
        include_bytes!("../../../tests/fixtures/lab/cube-draco.glb"),
        |root| {
            root["meshes"][0]["primitives"][0]["extensions"]["KHR_draco_mesh_compression"]["bufferView"].as_u64().unwrap() as usize
        },
    );
    let basis = corrupt_payload(
        include_bytes!("../../../tests/fixtures/lab/cube-basis.glb"),
        |root| root["images"][0]["bufferView"].as_u64().unwrap() as usize,
    );
    let png = corrupt_payload(microscope(), |root| {
        root["images"][0]["bufferView"].as_u64().unwrap() as usize
    });
    let mut meshopt = include_bytes!("../../../tests/fixtures/lab/cube-meshopt.glb").to_vec();
    let offset = 28 + u32::from_le_bytes(meshopt[12..16].try_into().unwrap()) as usize;
    meshopt[offset..].fill(0);
    let bad_buffer_uri = rewrite_glb(microscope(), |root| {
        root["buffers"][0]["uri"] = json!("data:application/octet-stream;base64,invalid@@")
    });
    let bad_image_uri = rewrite_glb(microscope(), |root| {
        root["images"][0]
            .as_object_mut()
            .unwrap()
            .remove("bufferView");
        root["images"][0]["uri"] = json!("data:image/png;base64,bm90IGFuIGltYWdl");
    });
    for (name, bytes) in [
        ("Draco", draco),
        ("Basis", basis),
        ("PNG", png),
        ("Meshopt", meshopt),
        ("buffer URI", bad_buffer_uri),
        ("image URI", bad_image_uri),
    ] {
        let pending = start(&app, &actor, &bytes).await;
        upload(&pending, &bytes).await;
        let complete = format!(
            "/api/v1/lab/asset-uploads/{}/complete",
            pending["upload_id"].as_str().unwrap()
        );
        assert_eq!(
            request(&app, &actor, "POST", &complete, Value::Null)
                .await
                .status(),
            StatusCode::UNPROCESSABLE_ENTITY,
            "{name}"
        );
        assert_eq!(
            data(request(&app, &actor, "GET", "/api/v1/lab/assets", Value::Null).await).await["data"],
            json!([])
        );
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn invalid_or_external_models_never_publish_and_valid_retry_survives(pool: PgPool) {
    let app = application(pool).await;
    let actor = register(&app, "models@example.test").await;
    let external = rewrite_glb(microscope(), |document| {
        document["buffers"][0]["uri"] = json!("https://example.test/mesh.bin")
    });
    let broken_accessor = rewrite_glb(microscope(), |document| {
        document["meshes"][0]["primitives"][0]["attributes"]["POSITION"] = json!(123456)
    });
    let empty_geometry = rewrite_glb(microscope(), |document| {
        document["accessors"][0]["count"] = json!(0)
    });
    let cycle = rewrite_glb(microscope(), |document| {
        document["nodes"][0]["children"] = json!([0])
    });
    let no_scene = rewrite_glb(microscope(), |document| document["scenes"] = json!([]));
    for bytes in [
        b"not a GLB".to_vec(),
        external,
        broken_accessor,
        empty_geometry,
        cycle,
        no_scene,
    ] {
        let pending = start(&app, &actor, &bytes).await;
        upload(&pending, &bytes).await;
        let complete = format!(
            "/api/v1/lab/asset-uploads/{}/complete",
            pending["upload_id"].as_str().unwrap()
        );
        assert_eq!(
            request(&app, &actor, "POST", &complete, Value::Null)
                .await
                .status(),
            StatusCode::UNPROCESSABLE_ENTITY
        );
        let list =
            data(request(&app, &actor, "GET", "/api/v1/lab/assets", Value::Null).await).await;
        assert_eq!(list["data"], json!([]));
    }
    let pending = start(&app, &actor, microscope()).await;
    let complete = format!(
        "/api/v1/lab/asset-uploads/{}/complete",
        pending["upload_id"].as_str().unwrap()
    );
    assert_eq!(
        request(&app, &actor, "POST", &complete, Value::Null)
            .await
            .status(),
        StatusCode::CONFLICT
    );
    assert_eq!(
        data(request(&app, &actor, "GET", "/api/v1/lab/assets", Value::Null).await).await["data"],
        json!([])
    );
    upload(&pending, microscope()).await;
    assert_eq!(
        request(&app, &actor, "POST", &complete, Value::Null)
            .await
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        data(request(&app, &actor, "GET", "/api/v1/lab/assets", Value::Null).await).await["data"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}

async fn start(app: &Router, actor: &Browser, bytes: &[u8]) -> Value {
    let response = request(app, actor, "POST", "/api/v1/lab/asset-uploads", json!({
        "name":"Bench microscope", "source":"https://polyhaven.com/a/industrial_microscope", "license":"CC0", "version":"1.0",
        "file":{"file_name":"microscope.glb","content_type":"model/gltf-binary","size":bytes.len(),"sha256":hex::encode(Sha256::digest(bytes))}
    })).await;
    assert_eq!(response.status(), StatusCode::CREATED);
    data(response).await
}

#[sqlx::test(migrations = "../../migrations")]
async fn entity_and_node_references_protect_asset_bytes_and_restore_in_world(pool: PgPool) {
    let app = application(pool).await;
    let actor = register(&app, "asset-references@example.test").await;
    let pending = start(&app, &actor, microscope()).await;
    upload(&pending, microscope()).await;
    let asset = data(
        request(
            &app,
            &actor,
            "POST",
            &format!(
                "/api/v1/lab/asset-uploads/{}/complete",
                pending["upload_id"].as_str().unwrap()
            ),
            Value::Null,
        )
        .await,
    )
    .await;
    let lab = data(
        request(
            &app,
            &actor,
            "POST",
            "/api/v1/lab/labs",
            json!({"name":"Asset references"}),
        )
        .await,
    )
    .await;
    let lab_id = lab["id"].as_str().unwrap();
    let entity=request(&app,&actor,"POST",&format!("/api/v1/lab/labs/{lab_id}/entities"),json!({"name":"Microscope A","definition_id":"model","definition_version":"1.0","reality":"simulated","configuration":{},"representation_id":asset["representation"]["id"]})).await;
    assert_eq!(entity.status(), StatusCode::CREATED);
    let entity = data(entity).await;
    let response = request(
        &app,
        &actor,
        "DELETE",
        &format!("/api/v1/lab/assets/{}", asset["id"].as_str().unwrap()),
        Value::Null,
    )
    .await;
    assert_eq!(response.status(), StatusCode::CONFLICT);
    assert_eq!(data(response).await["error"]["code"], "lab.asset_in_use");
    let world = data(
        request(
            &app,
            &actor,
            "GET",
            &format!("/api/v1/lab/labs/{lab_id}/world"),
            Value::Null,
        )
        .await,
    )
    .await;
    assert_eq!(world["entities"][0]["id"], entity["id"]);
    assert_eq!(
        world["nodes"][0]["representation_id"],
        asset["representation"]["id"]
    );
    assert_eq!(world["assets"][0], asset);
    let subscription = request(
        &app,
        &actor,
        "GET",
        &format!("/api/v1/lab/labs/{lab_id}/world/subscribe"),
        Value::Null,
    )
    .await;
    assert_eq!(subscription.status(), StatusCode::OK);
    let mut stream = subscription.into_body();
    async fn stream_event(stream: &mut Body) -> Value {
        let frame = tokio::time::timeout(Duration::from_secs(5), stream.frame())
            .await
            .unwrap()
            .unwrap()
            .unwrap()
            .into_data()
            .unwrap();
        let text = std::str::from_utf8(&frame).unwrap();
        serde_json::from_str(
            text.lines()
                .find_map(|line| line.strip_prefix("data: "))
                .unwrap(),
        )
        .unwrap()
    }
    assert_eq!(stream_event(&mut stream).await["world"], world);
    assert_eq!(
        request(
            &app,
            &actor,
            "PATCH",
            &format!("/api/v1/lab/assets/{}", asset["id"].as_str().unwrap()),
            json!({"name":"Renamed shared microscope"})
        )
        .await
        .status(),
        StatusCode::OK
    );
    loop {
        let event = stream_event(&mut stream).await;
        if event["type"] != "update" {
            continue;
        }
        assert!(
            event["version"].as_str().unwrap().parse::<u64>().unwrap()
                > world["version"].as_str().unwrap().parse::<u64>().unwrap()
        );
        assert!(
            event["changes"]
                .as_array()
                .unwrap()
                .iter()
                .any(|change| change["collection"] == "assets"
                    && change["id"] == asset["id"]
                    && change["patch"]["name"] == "Renamed shared microscope")
        );
        assert!(
            event["changes"]
                .as_array()
                .unwrap()
                .iter()
                .all(|change| change["collection"] == "assets")
        );
        break;
    }
    drop(stream);
    assert_eq!(
        request(
            &app,
            &actor,
            "GET",
            &format!(
                "/api/v1/lab/assets/{}/download",
                asset["id"].as_str().unwrap()
            ),
            Value::Null
        )
        .await
        .status(),
        StatusCode::OK
    );
    let static_entity=data(request(&app,&actor,"POST",&format!("/api/v1/lab/labs/{lab_id}/entities"),json!({"name":"Static bench","definition_id":"bench","definition_version":"1.0","reality":"simulated","configuration":{},"representation_id":null})).await).await;
    assert_eq!(static_entity["binding"], Value::Null);
    assert_eq!(request(&app,&actor,"POST",&format!("/api/v1/lab/labs/{lab_id}/nodes"),json!({"entity_id":static_entity["id"],"representation_id":asset["representation"]["id"],"placement":{"position":[3,0,0],"rotation":[0,0,0],"scale":[1,1,1]}})).await.status(),StatusCode::CREATED);
}

async fn bearer(app: &Router, secret: &str, method: &str, path: &str, body: Value) -> Response {
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

async fn key(app: &Router, actor: &Browser) -> Value {
    let response = request(
        app,
        actor,
        "POST",
        "/api/v1/api-keys",
        json!({"name":"Lab Agent", "scopes":["lab:full"], "expires_in_days":30}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    data(response).await
}

#[sqlx::test(migrations = "../../migrations")]
async fn agent_has_member_asset_access_and_invalid_credentials_cannot_change_assets(pool: PgPool) {
    let app = application(pool.clone()).await;
    let _owner = register(&app, "owner@example.test").await;
    let member = register(&app, "member@example.test").await;
    let key = key(&app, &member).await;
    let secret = key["secret"].as_str().unwrap();
    let bytes = microscope();
    let input = json!({"name":"Agent microscope", "source":"Poly Haven", "license":"CC0", "version":"1.0",
        "file":{"file_name":"agent.glb","content_type":"model/gltf-binary","size":bytes.len(),"sha256":hex::encode(Sha256::digest(bytes))}});
    let response = bearer(
        &app,
        secret,
        "POST",
        "/api/v1/lab/asset-uploads",
        input.clone(),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    let pending = data(response).await;
    upload(&pending, bytes).await;
    let complete = format!(
        "/api/v1/lab/asset-uploads/{}/complete",
        pending["upload_id"].as_str().unwrap()
    );
    let response = bearer(&app, secret, "POST", &complete, Value::Null).await;
    assert_eq!(response.status(), StatusCode::OK);
    let asset = data(response).await;
    let path = format!("/api/v1/lab/assets/{}", asset["id"].as_str().unwrap());
    assert_eq!(
        data(request(&app, &member, "GET", &path, Value::Null).await).await,
        asset
    );
    assert_eq!(
        data(bearer(&app, secret, "GET", &path, Value::Null).await).await,
        asset
    );
    let no_csrf = app
        .clone()
        .oneshot(
            Request::patch(&path)
                .header("origin", "http://127.0.0.1:5173")
                .header("cookie", &member.cookie)
                .header("content-type", "application/json")
                .body(Body::from(json!({"name":"Forged"}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(no_csrf.status(), StatusCode::FORBIDDEN);
    let invalid_bearer = app
        .clone()
        .oneshot(
            Request::patch(&path)
                .header("cookie", &member.cookie)
                .header("x-csrf-token", &member.csrf)
                .header("authorization", "Bearer invalid")
                .header("content-type", "application/json")
                .body(Body::from(json!({"name":"Forged"}).to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(invalid_bearer.status(), StatusCode::UNAUTHORIZED);
    let renamed = data(
        bearer(
            &app,
            secret,
            "PATCH",
            &path,
            json!({"name":"Agent renamed"}),
        )
        .await,
    )
    .await;
    assert_eq!(renamed["name"], "Agent renamed");
    assert_eq!(renamed["updated_by"], member.id);
    let revoke = format!("/api/v1/api-keys/{}", key["key"]["id"].as_str().unwrap());
    assert_eq!(
        request(&app, &member, "DELETE", &revoke, Value::Null)
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        bearer(&app, secret, "DELETE", &path, Value::Null)
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        bearer(&app, secret, "GET", &path, Value::Null)
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        data(request(&app, &member, "GET", &path, Value::Null).await).await["name"],
        "Agent renamed"
    );
    let fresh = self::key(&app, &member).await;
    let fresh_secret = fresh["secret"].as_str().unwrap();
    sqlx::query("UPDATE labos_threejs_core.api_keys SET expires_at = clock_timestamp() - interval '1 second' WHERE id = $1::uuid")
        .bind(fresh["key"]["id"].as_str().unwrap()).execute(&pool).await.unwrap();
    assert_eq!(
        bearer(&app, fresh_secret, "DELETE", &path, Value::Null)
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let final_key = self::key(&app, &member).await;
    assert_eq!(
        bearer(
            &app,
            final_key["secret"].as_str().unwrap(),
            "DELETE",
            &path,
            Value::Null
        )
        .await
        .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        request(&app, &member, "GET", &path, Value::Null)
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
}

async fn upload(upload: &Value, bytes: &[u8]) {
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
async fn member_publishes_asset_another_browser_reads_bytes_and_member_manages_it(pool: PgPool) {
    let app = application(pool).await;
    let _owner = register(&app, "owner@example.test").await;
    let member = register(&app, "member@example.test").await;
    let other = register(&app, "other@example.test").await;
    let bytes = microscope();
    let pending = start(&app, &member, bytes).await;
    let before = data(request(&app, &other, "GET", "/api/v1/lab/assets", Value::Null).await).await;
    assert_eq!(before["data"], json!([]));
    assert_eq!(before["max_upload_bytes"], 20 * 1024 * 1024);
    upload(&pending, bytes).await;
    let complete = format!(
        "/api/v1/lab/asset-uploads/{}/complete",
        pending["upload_id"].as_str().unwrap()
    );
    let response = request(&app, &member, "POST", &complete, Value::Null).await;
    assert_eq!(response.status(), StatusCode::OK);
    let asset = data(response).await;
    assert_eq!(asset["created_by"], member.id);
    assert_eq!(asset["version"], "1.0");
    assert_eq!(asset["license"], "CC0");
    assert_eq!(asset["representation"]["file_id"], pending["upload_id"]);
    assert_ne!(asset["id"], pending["upload_id"]);
    let path = format!("/api/v1/lab/assets/{}", asset["id"].as_str().unwrap());
    let reopened = data(request(&app, &other, "GET", &path, Value::Null).await).await;
    assert_eq!(reopened, asset);
    let capability = data(
        request(
            &app,
            &other,
            "GET",
            &format!("{path}/download"),
            Value::Null,
        )
        .await,
    )
    .await;
    let response = reqwest::get(capability["url"].as_str().unwrap())
        .await
        .unwrap_or_else(|_| panic!("Signed download transport failed"));
    assert!(response.status().is_success());
    assert_eq!(response.bytes().await.unwrap().as_ref(), bytes);
    let renamed =
        data(request(&app, &member, "PATCH", &path, json!({"name":"North bench"})).await).await;
    assert_eq!(renamed["name"], "North bench");
    assert_eq!(renamed["updated_by"], member.id);
    assert_eq!(
        request(&app, &member, "DELETE", &path, Value::Null)
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        request(&app, &other, "GET", &path, Value::Null)
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    let after = data(request(&app, &other, "GET", "/api/v1/lab/assets", Value::Null).await).await;
    assert_eq!(after["data"], json!([]));
}
