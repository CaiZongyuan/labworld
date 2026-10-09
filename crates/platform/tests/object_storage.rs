use base64::{Engine, engine::general_purpose::STANDARD};
use labos_threejs_platform::object_storage::{
    ObjectLocation, ObjectStorage, S3ObjectStorage, StorageError, StorageSettings, UploadHeaders,
};
use sha2::{Digest, Sha256};
use std::time::{Duration, SystemTime};

async fn send(request: reqwest::RequestBuilder) -> reqwest::Response {
    request
        .send()
        .await
        .unwrap_or_else(|_| panic!("Signed request transport failed"))
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn concurrent_bucket_bootstrap_is_ready_for_every_caller() {
    let mut tasks = tokio::task::JoinSet::new();
    for _ in 0..9 {
        tasks.spawn(async {
            let settings = StorageSettings {
                endpoint: std::env::var("S3_ENDPOINT").unwrap(),
                public_endpoint: std::env::var("S3_PUBLIC_ENDPOINT").unwrap(),
                region: "us-east-1".into(),
                bucket: format!("bootstrap-{}", uuid::Uuid::now_v7()),
                access_key: std::env::var("S3_ACCESS_KEY").unwrap(),
                secret_key: std::env::var("S3_SECRET_KEY").unwrap(),
            };
            S3ObjectStorage::new(&settings)
                .bootstrap(&settings.bucket, "http://127.0.0.1:5173")
                .await
        });
    }
    let mut failed = 0;
    while let Some(result) = tasks.join_next().await {
        if result.unwrap().is_err() {
            failed += 1;
        }
    }
    assert_eq!(
        failed, 0,
        "every independently created bucket must be ready"
    );
}

#[tokio::test]
async fn presigned_upload_is_copied_without_overwriting_an_existing_final_object() {
    let settings = StorageSettings {
        endpoint: std::env::var("S3_ENDPOINT").expect("use scripts/test-storage.mjs"),
        public_endpoint: std::env::var("S3_PUBLIC_ENDPOINT").unwrap(),
        region: "us-east-1".into(),
        bucket: format!("adapter-{}", uuid::Uuid::now_v7()),
        access_key: std::env::var("S3_ACCESS_KEY").unwrap(),
        secret_key: std::env::var("S3_SECRET_KEY").unwrap(),
    };
    let storage = S3ObjectStorage::new(&settings);
    storage
        .bootstrap(&settings.bucket, "http://127.0.0.1:5173")
        .await
        .unwrap();
    let source = ObjectLocation {
        bucket: settings.bucket.clone(),
        key: "uploads/test/staging".into(),
    };
    let target = ObjectLocation {
        bucket: settings.bucket,
        key: "objects/test/final".into(),
    };
    let contents = b"the original complete object";
    let deadline = SystemTime::now() + Duration::from_secs(60);
    let upload_headers = UploadHeaders {
        content_type: "text/plain".into(),
        upload_id: "test-upload".into(),
        checksum_sha256: STANDARD.encode(Sha256::digest(contents)),
    };
    let signed = storage
        .presign_upload(&source, &upload_headers, deadline)
        .await
        .unwrap();
    assert!(signed.expires_at <= deadline);
    assert!(matches!(
        storage
            .presign_upload(&source, &upload_headers, SystemTime::UNIX_EPOCH)
            .await,
        Err(StorageError::Expired)
    ));
    let url = reqwest::Url::parse(&signed.url).unwrap();
    let query: std::collections::HashMap<_, _> = url.query_pairs().collect();
    let started =
        chrono::NaiveDateTime::parse_from_str(query.get("X-Amz-Date").unwrap(), "%Y%m%dT%H%M%SZ")
            .unwrap()
            .and_utc()
            .timestamp();
    let lifetime: u64 = query.get("X-Amz-Expires").unwrap().parse().unwrap();
    assert_eq!(
        SystemTime::UNIX_EPOCH + Duration::from_secs(started as u64 + lifetime),
        signed.expires_at
    );
    let signed_headers: Vec<_> = query
        .get("X-Amz-SignedHeaders")
        .unwrap()
        .split(';')
        .collect();
    for name in [
        "content-type",
        "content-encoding",
        "x-amz-meta-upload-id",
        "x-amz-checksum-sha256",
    ] {
        assert!(signed_headers.contains(&name));
    }
    assert!(!signed.headers.contains_key("content-length"));
    let client = reqwest::Client::new();
    let mut request = client.put(&signed.url).body(contents.to_vec());
    for (name, value) in &signed.headers {
        request = request.header(name, value);
    }
    assert!(send(request).await.status().is_success());
    for attack in ["wrong-body", "changed-checksum", "missing-checksum"] {
        let mut request = client.put(&signed.url).body(b"unexpected content".to_vec());
        for (name, value) in &signed.headers {
            if name == "x-amz-checksum-sha256" && attack == "missing-checksum" {
                continue;
            }
            let value = if name == "x-amz-checksum-sha256" && attack == "changed-checksum" {
                STANDARD.encode(Sha256::digest(b"unexpected content"))
            } else {
                value.clone()
            };
            request = request.header(name, value);
        }
        assert!(
            !send(request).await.status().is_success(),
            "invalid upload must fail: {attack}"
        );
        assert_eq!(storage.read(&source, 1024).await.unwrap(), contents);
    }
    let metadata = storage.head(&source).await.unwrap();
    assert_eq!(metadata.size, contents.len() as u64);
    storage
        .copy_if_absent(&source, &metadata.etag, &target)
        .await
        .unwrap();
    assert_eq!(storage.read(&target, 1024).await.unwrap(), contents);
    let replacement = b"a different staging object";
    let replay = storage
        .presign_upload(
            &source,
            &UploadHeaders {
                content_type: "text/plain".into(),
                upload_id: "test-upload".into(),
                checksum_sha256: STANDARD.encode(Sha256::digest(replacement)),
            },
            SystemTime::now() + Duration::from_secs(60),
        )
        .await
        .unwrap();
    let mut request = client.put(&replay.url).body(replacement.to_vec());
    for (name, value) in &replay.headers {
        request = request.header(name, value);
    }
    assert!(send(request).await.status().is_success());
    let changed = storage.head(&source).await.unwrap();
    assert!(matches!(
        storage
            .copy_if_absent(&source, &changed.etag, &target)
            .await,
        Err(StorageError::PreconditionFailed)
    ));
    assert_eq!(storage.read(&target, 1024).await.unwrap(), contents);
    let another = ObjectLocation {
        bucket: target.bucket.clone(),
        key: "objects/test/another".into(),
    };
    assert!(matches!(
        storage
            .copy_if_absent(&source, &metadata.etag, &another)
            .await,
        Err(StorageError::PreconditionFailed)
    ));
    assert!(matches!(
        storage.head(&another).await,
        Err(StorageError::NotFound)
    ));
}

#[tokio::test]
async fn generated_files_stream_without_overwriting_an_existing_candidate() {
    let settings = StorageSettings {
        endpoint: std::env::var("S3_ENDPOINT").expect("use scripts/test-storage.mjs"),
        public_endpoint: std::env::var("S3_PUBLIC_ENDPOINT").unwrap(),
        region: "us-east-1".into(),
        bucket: format!("stream-{}", uuid::Uuid::now_v7()),
        access_key: std::env::var("S3_ACCESS_KEY").unwrap(),
        secret_key: std::env::var("S3_SECRET_KEY").unwrap(),
    };
    let storage = S3ObjectStorage::new(&settings);
    storage
        .bootstrap(&settings.bucket, "http://127.0.0.1:5173")
        .await
        .unwrap();
    let directory = tempfile::tempdir().unwrap();
    let source = directory.path().join("source");
    let copied = directory.path().join("copied");
    let bytes: Vec<u8> = (0..200_000).map(|i| (i % 251) as u8).collect();
    std::fs::write(&source, &bytes).unwrap();
    let location = ObjectLocation {
        bucket: settings.bucket,
        key: "objects/generated/candidate".into(),
    };
    let mut headers = UploadHeaders {
        content_type: "application/octet-stream".into(),
        upload_id: "server-generated".into(),
        checksum_sha256: STANDARD.encode(Sha256::digest(&bytes)),
    };
    storage
        .put_file_if_absent(&location, &source, &headers)
        .await
        .unwrap();
    let digest = storage
        .download_to(&location, &copied, bytes.len() as u64)
        .await
        .unwrap();
    assert_eq!(digest.size, 200_000);
    assert_eq!(digest.sha256, hex::encode(Sha256::digest(&bytes)));
    assert_eq!(std::fs::read(&copied).unwrap(), bytes);
    std::fs::write(&source, b"replacement").unwrap();
    headers.checksum_sha256 = STANDARD.encode(Sha256::digest(b"replacement"));
    assert!(matches!(
        storage
            .put_file_if_absent(&location, &source, &headers)
            .await,
        Err(StorageError::PreconditionFailed)
    ));
    assert!(matches!(
        storage.download_to(&location, &copied, 199_999).await,
        Err(StorageError::TooLarge)
    ));
    storage
        .download_to(&location, &copied, 200_000)
        .await
        .unwrap();
    assert_eq!(std::fs::read(&copied).unwrap(), bytes);
}
