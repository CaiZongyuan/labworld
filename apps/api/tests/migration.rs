use sqlx::{ConnectOptions, PgPool, migrate::Migrate};
use std::{
    process::Stdio,
    time::{Duration, Instant},
};
use tokio::io::AsyncBufReadExt;

#[sqlx::test(migrations = false)]
async fn a_competing_migration_cannot_hold_the_cli_indefinitely(pool: PgPool) {
    let mut connection = pool.acquire().await.unwrap();
    connection.lock().await.unwrap();
    let result = tokio::time::timeout(
        Duration::from_secs(3),
        tokio::process::Command::new(env!("CARGO_BIN_EXE_migrate"))
            .env(
                "DATABASE_URL",
                pool.connect_options().to_url_lossy().to_string(),
            )
            .env("MIGRATION_TIMEOUT_SECS", "1")
            .kill_on_drop(true)
            .output(),
    )
    .await;
    connection.unlock().await.unwrap();
    let output = result
        .expect("migration must honor its execution deadline")
        .unwrap();
    assert!(!output.status.success());
    let message = String::from_utf8_lossy(&output.stderr);
    assert!(message.contains("timed out"));
    assert!(!message.contains("test-only-password"));
}

/// Spawns a production binary against `database_url` and waits for its health
/// listener; returns the child and the bound port parsed from the listen log.
async fn spawn_against_empty_database(
    binary: &'static str,
    database_url: &str,
    bind: &str,
    ready_message: &str,
) -> (tokio::process::Child, u16) {
    let mut child = tokio::process::Command::new(binary)
        .env("DATABASE_URL", database_url)
        .env("APP_BIND", bind)
        .env("WORKER_BIND", bind)
        .env("RUST_LOG", "info")
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let stdout = child.stdout.take().unwrap();
    let mut lines = tokio::io::BufReader::new(stdout).lines();
    loop {
        let line = tokio::time::timeout(Duration::from_secs(30), lines.next_line())
            .await
            .expect("binary must log while starting")
            .expect("stdout stays open while serving")
            .expect("the listener log appears before stdout closes");
        let Some(position) = line.find(&format!("\"{ready_message}\"")) else {
            continue;
        };
        let address = line[position..]
            .split("\"address\":\"127.0.0.1:")
            .nth(1)
            .expect("the listener log carries the bound address")
            .split('"')
            .next()
            .unwrap()
            .to_owned();
        let port: u16 = address.parse().unwrap();
        return (child, port);
    }
}

async fn table_count(pool: &PgPool) -> i64 {
    sqlx::query_scalar(
        "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'",
    )
    .fetch_one(pool)
    .await
    .unwrap()
}

#[sqlx::test(migrations = false)]
async fn the_api_reports_unavailability_without_migrating_the_empty_database(pool: PgPool) {
    let database_url = pool.connect_options().to_url_lossy().to_string();
    let (mut api, port) = spawn_against_empty_database(
        env!("CARGO_BIN_EXE_labos-threejs-api"),
        &database_url,
        "127.0.0.1:0",
        "API listening",
    )
    .await;
    let base = format!("http://127.0.0.1:{port}");
    // Liveness stays true even though the schema is missing; readiness fails
    // with the public controlled error and never runs migrations itself.
    let live = reqwest::get(format!("{base}/health/live")).await.unwrap();
    assert_eq!(live.status(), 200);
    // Poll past any window in which an implicit startup migration could run.
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let ready = reqwest::get(format!("{base}/health/ready")).await.unwrap();
        assert_eq!(ready.status(), 503);
        let body: serde_json::Value = ready.json().await.unwrap();
        assert_eq!(body["error"]["code"], "database.unavailable");
        if Instant::now() > deadline {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    assert_eq!(table_count(&pool).await, 0, "the api must not migrate");
    assert!(api.try_wait().unwrap().is_none(), "the api stays up");
    api.kill().await.unwrap();
}
