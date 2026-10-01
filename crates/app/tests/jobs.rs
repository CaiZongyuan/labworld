use labos_threejs_app::modules::jobs::{self, Handler, JobError, Lease, NewJob, Worker, WorkerPolicy};
use sqlx::PgPool;
use std::{sync::Arc, time::Duration};
use tokio::sync::Notify;

struct Publishing {
    pool: PgPool,
    entered: Arc<Notify>,
    release: Arc<Notify>,
}
#[async_trait::async_trait]
impl Handler for Publishing {
    fn kind(&self) -> &'static str {
        "test.publish"
    }
    async fn run(&self, lease: &Lease) -> Result<(), JobError> {
        let mut tx = self.pool.begin().await?;
        lease.lock_current(&mut tx).await?;
        self.entered.notify_one();
        self.release.notified().await;
        lease.succeed(&mut tx).await?;
        tx.commit().await?;
        Ok(())
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn a_heartbeat_waiting_on_publication_does_not_suspend_the_publisher(pool: PgPool) {
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let mut tx = pool.begin().await.unwrap();
    let id = jobs::enqueue(
        &mut tx,
        NewJob {
            kind: "test.publish",
            schema_version: 1,
            max_attempts: 5,
            payload: serde_json::json!({}),
            correlation_id: "heartbeat-publication",
        },
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let worker = Worker::new(
        pool.clone(),
        vec![Arc::new(Publishing {
            pool: pool.clone(),
            entered: entered.clone(),
            release: release.clone(),
        })],
        WorkerPolicy {
            heartbeat_secs: 1,
            ..Default::default()
        },
    );
    let mut task = tokio::spawn(async move { worker.run_once().await });
    entered.notified().await;
    // Observe the real database lock wait instead of guessing when the heartbeat starts.
    tokio::time::timeout(Duration::from_secs(5),async {
        loop {
            let blocked: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE 'UPDATE labos_threejs_core.jobs SET lease_expires_at%')").fetch_one(&pool).await.unwrap();
            if blocked {break;}
            tokio::task::yield_now().await;
        }
    }).await.expect("heartbeat reached the publication lock");
    release.notify_one();
    let finished = tokio::time::timeout(Duration::from_secs(2), &mut task).await;
    if finished.is_err() {
        task.abort();
        let _ = task.await;
    }
    assert!(
        finished.is_ok(),
        "the handler must keep progressing while renewal waits"
    );
    let mut connection = pool.acquire().await.unwrap();
    let status = jobs::statuses(&mut connection, &[id]).await.unwrap();
    assert_eq!(status[0].status, "succeeded");
}

#[sqlx::test(migrations = "../../migrations")]
async fn renewal_timeout_cancels_the_publisher_before_recording_failure(pool: PgPool) {
    let entered = Arc::new(Notify::new());
    let mut tx = pool.begin().await.unwrap();
    let id = jobs::enqueue(
        &mut tx,
        NewJob {
            kind: "test.publish",
            schema_version: 1,
            max_attempts: 5,
            payload: serde_json::json!({}),
            correlation_id: "renewal-timeout",
        },
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let worker = Worker::new(
        pool.clone(),
        vec![Arc::new(Publishing {
            pool: pool.clone(),
            entered: entered.clone(),
            release: Arc::new(Notify::new()),
        })],
        WorkerPolicy {
            heartbeat_secs: 1,
            ..Default::default()
        },
    );
    let mut task = tokio::spawn(async move { worker.run_once().await });
    entered.notified().await;
    // The publisher deliberately keeps the lease row locked beyond the renewal deadline.
    let finished = tokio::time::timeout(Duration::from_secs(5), &mut task).await;
    if finished.is_err() {
        task.abort();
        let _ = task.await;
    }
    assert!(
        finished.is_ok(),
        "failure recording must not wait on the cancelled handler"
    );
    let mut connection = pool.acquire().await.unwrap();
    let status = jobs::statuses(&mut connection, &[id]).await.unwrap();
    assert_eq!(status[0].status, "retry_wait");
    assert_eq!(
        status[0].last_error.as_deref(),
        Some("jobs.heartbeat_timeout")
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn crashed_claims_consume_the_budget_and_stale_workers_cannot_change_the_result(
    pool: PgPool,
) {
    let mut tx = pool.begin().await.unwrap();
    let id = jobs::enqueue(
        &mut tx,
        NewJob {
            kind: "test.crash",
            schema_version: 1,
            max_attempts: 2,
            payload: serde_json::json!({"resource_id":"stable"}),
            correlation_id: "crash-budget",
        },
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let first = jobs::claim(&pool, &["test.crash"], "worker-one", 60)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(first.attempt, 1);
    // Advance the persisted lease clock without sleeping or modifying business results.
    sqlx::query("UPDATE labos_threejs_core.jobs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1::uuid").bind(&id).execute(&pool).await.unwrap();
    let second = jobs::claim(&pool, &["test.crash"], "worker-two", 60)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(second.id, first.id);
    assert_eq!(second.payload, first.payload);
    assert_eq!(second.attempt, 2);
    assert_ne!(second.lease_token, first.lease_token);
    assert!(matches!(
        first.heartbeat(&pool, 60).await,
        Err(JobError::LostLease)
    ));
    let mut tx = pool.begin().await.unwrap();
    assert!(matches!(
        first.succeed(&mut tx).await,
        Err(JobError::LostLease)
    ));
    tx.rollback().await.unwrap();
    first
        .fail(&pool, &JobError::Permanent("test.old_result"))
        .await
        .unwrap();
    let mut connection = pool.acquire().await.unwrap();
    assert_eq!(
        jobs::statuses(&mut connection, std::slice::from_ref(&id))
            .await
            .unwrap()[0]
            .status,
        "running"
    );
    drop(connection);
    sqlx::query("UPDATE labos_threejs_core.jobs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1::uuid").bind(&id).execute(&pool).await.unwrap();
    assert!(
        jobs::claim(&pool, &["test.crash"], "worker-three", 60)
            .await
            .unwrap()
            .is_none()
    );
    let mut connection = pool.acquire().await.unwrap();
    let status = jobs::statuses(&mut connection, &[id]).await.unwrap();
    assert_eq!(status[0].status, "failed");
    assert_eq!(
        status[0].last_error.as_deref(),
        Some("jobs.attempts_exhausted")
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn transient_retries_wait_until_scheduled_and_keep_the_same_business_payload(pool: PgPool) {
    let mut tx = pool.begin().await.unwrap();
    let id = jobs::enqueue(
        &mut tx,
        NewJob {
            kind: "test.transient",
            schema_version: 1,
            max_attempts: 3,
            payload: serde_json::json!({"resource_id":"same-resource"}),
            correlation_id: "retry-wait",
        },
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let first = jobs::claim(&pool, &["test.transient"], "worker-one", 60)
        .await
        .unwrap()
        .unwrap();
    first
        .fail(&pool, &JobError::Transient("test.provider_unavailable"))
        .await
        .unwrap();
    let mut connection = pool.acquire().await.unwrap();
    assert_eq!(
        jobs::statuses(&mut connection, std::slice::from_ref(&id))
            .await
            .unwrap()[0]
            .status,
        "retry_wait"
    );
    drop(connection);
    sqlx::query("UPDATE labos_threejs_core.jobs SET scheduled_at = clock_timestamp() + interval '1 hour' WHERE id = $1::uuid").bind(&id).execute(&pool).await.unwrap();
    assert!(
        jobs::claim(&pool, &["test.transient"], "worker-two", 60)
            .await
            .unwrap()
            .is_none()
    );
    sqlx::query("UPDATE labos_threejs_core.jobs SET scheduled_at = clock_timestamp() - interval '1 second' WHERE id = $1::uuid").bind(&id).execute(&pool).await.unwrap();
    let second = jobs::claim(&pool, &["test.transient"], "worker-two", 60)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(second.id, first.id);
    assert_eq!(second.payload, first.payload);
    assert_eq!(second.attempt, 2);
    let mut tx = pool.begin().await.unwrap();
    second.succeed(&mut tx).await.unwrap();
    tx.commit().await.unwrap();
    assert!(
        jobs::claim(&pool, &["test.transient"], "worker-three", 60)
            .await
            .unwrap()
            .is_none()
    );
}

struct DelayedFirst {
    pool: PgPool,
    first_entered: Arc<Notify>,
    release_first: Arc<Notify>,
    published: Arc<std::sync::Mutex<Vec<i32>>>,
}
#[async_trait::async_trait]
impl Handler for DelayedFirst {
    fn kind(&self) -> &'static str {
        "test.late"
    }
    async fn run(&self, lease: &Lease) -> Result<(), JobError> {
        if lease.attempt == 1 {
            self.first_entered.notify_one();
            self.release_first.notified().await;
        }
        let mut tx = self.pool.begin().await?;
        lease.lock_current(&mut tx).await?;
        lease.succeed(&mut tx).await?;
        tx.commit().await?;
        self.published.lock().unwrap().push(lease.attempt);
        Ok(())
    }
}
#[sqlx::test(migrations = "../../migrations")]
async fn two_workers_recover_a_lease_without_publishing_the_late_first_result(pool: PgPool) {
    let mut tx = pool.begin().await.unwrap();
    let id = jobs::enqueue(
        &mut tx,
        NewJob {
            kind: "test.late",
            schema_version: 1,
            max_attempts: 5,
            payload: serde_json::json!({}),
            correlation_id: "late-result",
        },
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let published = Arc::new(std::sync::Mutex::new(Vec::new()));
    let handler = Arc::new(DelayedFirst {
        pool: pool.clone(),
        first_entered: entered.clone(),
        release_first: release.clone(),
        published: published.clone(),
    });
    let first = Worker::new(pool.clone(), vec![handler.clone()], Default::default());
    let second = Worker::new(pool.clone(), vec![handler], Default::default());
    let first_task = tokio::spawn(async move { first.run_once().await });
    entered.notified().await;
    sqlx::query("UPDATE labos_threejs_core.jobs SET lease_expires_at = clock_timestamp() - interval '1 second' WHERE id = $1::uuid").bind(&id).execute(&pool).await.unwrap();
    assert!(second.run_once().await.unwrap());
    release.notify_one();
    assert!(first_task.await.unwrap().unwrap());
    assert_eq!(*published.lock().unwrap(), vec![2]);
    let mut connection = pool.acquire().await.unwrap();
    assert_eq!(
        jobs::statuses(&mut connection, &[id]).await.unwrap()[0].status,
        "succeeded"
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn shutdown_cancels_after_a_bounded_drain_without_releasing_a_live_lease(pool: PgPool) {
    let mut tx = pool.begin().await.unwrap();
    let id = jobs::enqueue(
        &mut tx,
        NewJob {
            kind: "test.publish",
            schema_version: 1,
            max_attempts: 5,
            payload: serde_json::json!({}),
            correlation_id: "shutdown",
        },
    )
    .await
    .unwrap();
    tx.commit().await.unwrap();
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let worker = Arc::new(Worker::new(
        pool.clone(),
        vec![Arc::new(Publishing {
            pool: pool.clone(),
            entered: entered.clone(),
            release,
        })],
        WorkerPolicy {
            shutdown_secs: 1,
            ..Default::default()
        },
    ));
    let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();
    let running = worker.clone();
    let task = tokio::spawn(async move {
        running
            .run_until(async {
                let _ = stop_rx.await;
            })
            .await
    });
    entered.notified().await;
    stop_tx.send(()).unwrap();
    tokio::time::timeout(Duration::from_secs(3), task)
        .await
        .unwrap()
        .unwrap();
    assert!(!worker.is_running());
    assert!(
        jobs::claim(&pool, &["test.publish"], "replacement", 60)
            .await
            .unwrap()
            .is_none()
    );
    let mut connection = pool.acquire().await.unwrap();
    assert_eq!(
        jobs::statuses(&mut connection, &[id]).await.unwrap()[0].status,
        "running"
    );
}
