use std::{
    process::{Command, Stdio},
    time::{Duration, Instant},
};

fn rejects_configuration(database_url: &str, bind: &str, field: &str, overrides: &[(&str, &str)]) {
    let mut child = Command::new(env!("CARGO_BIN_EXE_labos-threejs-api"))
        .env("DATABASE_URL", database_url)
        .env("APP_BIND", bind)
        .envs(overrides.iter().copied())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if child.try_wait().unwrap().is_some() {
            break;
        }
        if Instant::now() >= deadline {
            child.kill().unwrap();
            child.wait().unwrap();
            panic!("invalid {field} did not fail before serving");
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let output = child.wait_with_output().unwrap();
    assert!(!output.status.success());
    let logs = format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(logs.contains(field));
    assert!(!logs.contains("should-never-appear-in-logs"));
}

#[test]
fn invalid_bind_configuration_fails_before_serving_and_redacts_credentials() {
    rejects_configuration(
        "postgres://user:should-never-appear-in-logs@127.0.0.1:9/missing",
        "not-an-address",
        "APP_BIND",
        &[],
    );
}

#[test]
fn a_non_postgres_url_is_rejected_without_logging_its_credentials() {
    rejects_configuration(
        "http://user:should-never-appear-in-logs@127.0.0.1:9/missing",
        "127.0.0.1:0",
        "DATABASE_URL",
        &[],
    );
}

#[test]
fn non_loopback_http_origins_and_invalid_session_lifetimes_fail_before_serving() {
    for (field, value) in [
        ("APP_ORIGIN", "http://public.example.com"),
        ("APP_ORIGIN", "https://example.com/untrusted-path"),
        ("SESSION_ABSOLUTE_SECS", "0"),
        ("SESSION_IDLE_SECS", "9999999"),
    ] {
        rejects_configuration(
            "postgres://user:should-never-appear-in-logs@127.0.0.1:9/missing",
            "127.0.0.1:0",
            field,
            &[(field, value)],
        );
    }
}

#[test]
fn storage_endpoints_and_file_limits_are_validated_without_exposing_credentials() {
    for (field, value) in [
        ("S3_PUBLIC_ENDPOINT", "http://public.example.com"),
        (
            "S3_PUBLIC_ENDPOINT",
            "https://s3.example.com/rewritten-prefix",
        ),
        (
            "S3_ENDPOINT",
            "http://user:should-never-appear-in-logs@localhost:9000",
        ),
        ("S3_BUCKET", "../outside"),
        ("FILE_MAX_BYTES", "-1"),
        ("UPLOAD_SESSION_SECS", "0"),
        ("DOWNLOAD_URL_SECS", "99999"),
    ] {
        rejects_configuration(
            "postgres://user:should-never-appear-in-logs@127.0.0.1:9/missing",
            "127.0.0.1:0",
            field,
            &[
                ("S3_ENDPOINT", "http://127.0.0.1:9000"),
                ("S3_PUBLIC_ENDPOINT", "http://127.0.0.1:9000"),
                ("S3_ACCESS_KEY", "test-access"),
                ("S3_SECRET_KEY", "should-never-appear-in-logs"),
                (field, value),
            ],
        );
    }
}

#[test]
fn invalid_cache_configuration_fails_before_serving_without_exposing_redis_credentials() {
    for (field, value) in [
        (
            "REDIS_URL",
            "http://user:should-never-appear-in-logs@127.0.0.1:9",
        ),
        ("CACHE_TTL_SECS", "0"),
        ("CACHE_BUDGET_MS", "1001"),
        ("CACHE_PREFIX", "bad prefix"),
    ] {
        rejects_configuration(
            "postgres://user:should-never-appear-in-logs@127.0.0.1:9/missing",
            "127.0.0.1:0",
            field,
            &[
                (
                    "REDIS_URL",
                    "redis://user:should-never-appear-in-logs@127.0.0.1:9/",
                ),
                (field, value),
            ],
        );
    }
}

#[test]
fn invalid_rate_limit_policies_fail_before_serving_without_leaking_redis_credentials() {
    for (field, value) in [
        ("RATE_LIMIT_ENABLED", "perhaps"),
        ("RATE_LIMIT_WINDOW_SECS", "0"),
        ("RATE_LIMIT_MAX_LOCAL_ENTRIES", "0"),
        ("RATE_LIMIT_REGISTRATION", "0"),
        ("RATE_LIMIT_AUTHENTICATION_FALLBACK", "61"),
        ("RATE_LIMIT_BUDGET_MS", "1001"),
        ("RATE_LIMIT_PREFIX", "bad prefix"),
    ] {
        rejects_configuration(
            "postgres://user:should-never-appear-in-logs@127.0.0.1:9/missing",
            "127.0.0.1:0",
            field,
            &[
                (
                    "REDIS_URL",
                    "redis://user:should-never-appear-in-logs@127.0.0.1:9/",
                ),
                (field, value),
            ],
        );
    }
}
