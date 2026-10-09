use sqlx::{ConnectOptions, PgPool};
use std::{
    process::Stdio,
    time::{Duration, Instant},
};
use tokio::io::AsyncBufReadExt;

#[sqlx::test(migrations = false)]
async fn the_worker_stays_up_without_migrating_the_empty_database(pool: PgPool) {
    let database_url = pool.connect_options().to_url_lossy().to_string();
    let mut child = tokio::process::Command::new(env!("CARGO_BIN_EXE_labos-threejs-worker"))
        .env("DATABASE_URL", database_url)
        .env("WORKER_BIND", "127.0.0.1:0")
        .env("RUST_LOG", "info")
        .stdout(Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let stdout = child.stdout.take().unwrap();
    let mut lines = tokio::io::BufReader::new(stdout).lines();
    let port = loop {
        let line = tokio::time::timeout(Duration::from_secs(30), lines.next_line())
            .await
            .expect("worker must log while starting")
            .expect("stdout stays open while serving")
            .expect("the listener log appears before stdout closes");
        let Some(position) = line.find("\"Worker health listener ready\"") else {
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
        break address.parse::<u16>().unwrap();
    };
    // Liveness stays true while readiness fails; claim errors against the
    // missing schema must never turn into a startup migration.
    let live = reqwest::get(format!("http://127.0.0.1:{port}/health/live"))
        .await
        .unwrap();
    assert_eq!(live.status(), 200);
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let ready = reqwest::get(format!("http://127.0.0.1:{port}/health/ready"))
            .await
            .unwrap();
        assert_eq!(ready.status(), 503);
        let body: serde_json::Value = ready.json().await.unwrap();
        assert_eq!(body["error"]["code"], "worker.unavailable");
        if Instant::now() > deadline {
            break;
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
    let tables: i64 = sqlx::query_scalar(
        "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'",
    )
    .fetch_one(&pool)
    .await
    .unwrap();
    assert_eq!(tables, 0, "the worker must not migrate");
    assert!(child.try_wait().unwrap().is_none(), "the worker stays up");
    child.kill().await.unwrap();
}
