use axum::{
    Router,
    body::Body,
    http::{Request, StatusCode},
    response::Response,
};
use chrono::{DateTime, Utc};
use http_body_util::BodyExt;
use labos_threejs_app::modules::lab::{
    DeviceRuntime, HistoryMaintenance, ObservationClock, ObservationReport, RetentionPolicy,
};
use serde_json::{Value, json};
use sqlx::PgPool;
use std::collections::BTreeMap;
use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};
use tower::ServiceExt;

#[derive(Clone)]
struct SqlStatementObserver {
    pool: PgPool,
    database_id: i64,
}
struct SqlStatementSnapshot {
    calls: BTreeMap<String, i64>,
    deallocations: i64,
    reset_at: DateTime<Utc>,
}
impl SqlStatementObserver {
    async fn new(target: &PgPool) -> Self {
        let pool = sqlx::postgres::PgPoolOptions::new()
            .max_connections(1)
            .connect(&std::env::var("DATABASE_URL").unwrap())
            .await
            .unwrap();
        let database_id = sqlx::query_scalar(
            "SELECT oid::bigint FROM pg_database WHERE datname=current_database()",
        )
        .fetch_one(target)
        .await
        .unwrap();
        let observer_database_id: i64 = sqlx::query_scalar(
            "SELECT oid::bigint FROM pg_database WHERE datname=current_database()",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_ne!(
            database_id, observer_database_id,
            "observer must use another database"
        );
        Self { pool, database_id }
    }

    async fn snapshot(&self) -> SqlStatementSnapshot {
        // The observer uses another database so it cannot count its own queries.
        let (deallocations, reset_at, calls): (i64, DateTime<Utc>, Value) = sqlx::query_as(
            "SELECT i.dealloc,i.stats_reset,COALESCE((SELECT jsonb_object_agg(query,calls) FROM (SELECT query,SUM(calls)::bigint AS calls FROM pg_stat_statements WHERE dbid=$1::oid AND toplevel GROUP BY query) s),'{}'::jsonb) FROM pg_stat_statements_info i",
        )
        .bind(self.database_id)
        .fetch_one(&self.pool)
        .await
        .unwrap();
        SqlStatementSnapshot {
            calls: serde_json::from_value(calls).unwrap(),
            deallocations,
            reset_at,
        }
    }
}
impl SqlStatementSnapshot {
    fn delta(&self, before: &Self) -> BTreeMap<String, i64> {
        assert_eq!(self.reset_at, before.reset_at, "SQL statistics were reset");
        assert_eq!(
            self.deallocations, before.deallocations,
            "SQL statistics were evicted during measurement"
        );
        for (query, calls) in &before.calls {
            assert!(
                self.calls.get(query).is_some_and(|next| next >= calls),
                "SQL statistics disappeared or moved backwards"
            );
        }
        self.calls
            .iter()
            .filter_map(|(query, calls)| {
                let delta = calls - before.calls.get(query).copied().unwrap_or(0);
                assert!(delta >= 0, "SQL call counts moved backwards");
                (delta > 0).then(|| (query.clone(), delta))
            })
            .collect()
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn a_full_day_with_spikes_duplicates_and_collection_gap_is_bounded_at_one_and_one_hundred_entities(
    pool: PgPool,
) {
    let (clock, runtime, app, member, path) = setup(pool.clone(), "sensor").await;
    let lab = path.split('/').nth(5).unwrap();
    let entity_id = path.split('/').nth(7).unwrap();
    let run = data(
        request(
            &app,
            &member,
            "POST",
            &format!("{path}/program/start"),
            json!({}),
        )
        .await,
    )
    .await;
    clock
        .0
        .store(Utc::now().timestamp() - 86370, Ordering::SeqCst);
    let from = clock.now();
    let to = from + chrono::Duration::hours(24);
    runtime
        .observe(
            run["id"].as_str().unwrap(),
            ObservationReport {
                sequence: 1,
                values: json!({"temperature":20}),
                observed_at: Some(from - chrono::Duration::seconds(2)),
                quality: "good".into(),
            },
        )
        .await
        .unwrap();
    // A restored historical collection uses the same persisted property shape as the real seed report.
    sqlx::query("WITH seed AS (SELECT * FROM lab.observation_history WHERE entity_id=$1::uuid LIMIT 1), reports AS (SELECT seed.*,n,$2::timestamptz+n*interval '1 second' AS at,CASE n WHEN 12345 THEN 500 WHEN 45678 THEN -100 ELSE 20 END AS value FROM seed CROSS JOIN generate_series(1,86399) n WHERE n NOT BETWEEN 50000 AND 50019) INSERT INTO lab.observation_history(entity_id,run_id,observed_at,received_at,data) SELECT entity_id,run_id,at-interval '2 seconds',at,data||jsonb_build_object('sequence',n+1,'values',jsonb_build_object('temperature',value),'properties',jsonb_build_object('temperature',(data->'properties'->'temperature')||jsonb_build_object('sequence',n+1,'value',value,'observed_at',at-interval '2 seconds','received_at',at,'expires_at',at+interval '5 seconds'))) FROM reports").bind(entity_id).bind(from).execute(&pool).await.unwrap();
    sqlx::query("INSERT INTO lab.observation_history(entity_id,run_id,observed_at,received_at,data) SELECT entity_id,run_id,observed_at,received_at,data FROM lab.observation_history WHERE entity_id=$1::uuid AND data->>'sequence'='100' LIMIT 1").bind(entity_id).execute(&pool).await.unwrap();
    sqlx::query("UPDATE lab.history_bounds SET captured_since=$2 WHERE entity_id=$1::uuid AND record_type='observation'").bind(entity_id).bind(from).execute(&pool).await.unwrap();
    let budgets: Value =
        serde_json::from_str(include_str!("../../../scripts/perf/baselines.json")).unwrap();
    let budgets = &budgets["budgets"]["lab"];
    let observer = SqlStatementObserver::new(&pool).await;
    let noise_name = format!("trend_sql_noise_{}", uuid::Uuid::now_v7().simple());
    let mut noise_url = reqwest::Url::parse(&std::env::var("DATABASE_URL").unwrap()).unwrap();
    noise_url.set_path(&format!("/{noise_name}"));
    <sqlx::Postgres as sqlx::migrate::MigrateDatabase>::create_database(noise_url.as_str())
        .await
        .unwrap();
    let noise_pool = sqlx::postgres::PgPoolOptions::new()
        .max_connections(4)
        .connect(noise_url.as_str())
        .await
        .unwrap();
    sqlx::migrate!("../../migrations")
        .run(&noise_pool)
        .await
        .unwrap();
    let noise_database_id =
        sqlx::query_scalar("SELECT oid::bigint FROM pg_database WHERE datname=current_database()")
            .fetch_one(&noise_pool)
            .await
            .unwrap();
    assert_ne!(noise_database_id, observer.database_id);
    let noise_observer = SqlStatementObserver {
        pool: observer.pool.clone(),
        database_id: noise_database_id,
    };
    let noise_app = labos_threejs_api::router(noise_pool.clone(), Default::default());
    let noise_member = Arc::new(self::member(&noise_app).await);
    let ready = Arc::new(tokio::sync::Barrier::new(9));
    let (stop, stopped) = tokio::sync::watch::channel(false);
    let mut workers = Vec::new();
    for _ in 0..8 {
        let app = noise_app.clone();
        let member = noise_member.clone();
        let ready = ready.clone();
        let mut stopped = stopped.clone();
        workers.push(tokio::spawn(async move {
            let (mut accepted, mut rejected) = (0, 0);
            ready.wait().await;
            loop {
                let response = tokio::select! {
                    _ = stopped.changed() => break,
                    response = request(&app, &member, "GET", "/api/v1/lab/labs", Value::Null) => response,
                };
                if response.status() == StatusCode::OK {
                    accepted += 1;
                } else {
                    rejected += 1;
                }
            }
            (accepted, rejected)
        }));
    }
    ready.wait().await;

    let measured_path = path.clone();
    let measured_lab = lab.to_owned();
    let measured_budgets: Value = budgets.clone();
    let measured_observer = observer.clone();
    // Join before cleanup so an assertion panic cannot leave the noise running.
    let outcome = tokio::spawn(async move {
        let path = measured_path;
        let lab = measured_lab;
        let budgets = measured_budgets;
        let mut measurements = Vec::new();
        for scale in [1, 100] {
            if scale == 100 {
                for n in 1..100 {
                    assert_eq!(request(&app,&member,"POST",&format!("/api/v1/lab/labs/{lab}/entities"),json!({"name":format!("Context {n}"),"definition_id":"labware","definition_version":"1.0","reality":"simulated","configuration":{},"representation_id":null})).await.status(),StatusCode::CREATED);
                }
            }
            let before = measured_observer.snapshot().await;
            let noise_before = noise_observer.snapshot().await;
            let response = request(
                &app,
                &member,
                "GET",
                &query(&path, "temperature", from, to, ""),
                Value::Null,
            )
            .await;
            assert_eq!(response.status(), StatusCode::OK);
            let calls = measured_observer.snapshot().await.delta(&before);
            let statements: i64 = calls.values().sum();
            assert!(
                statements > 0
                    && statements <= budgets["trendSqlStatements"].as_i64().unwrap(),
                "measured SQL: {statements}"
            );
            let mut authentication_statements = 0;
            for table in ["labos_threejs_core.sessions", "labos_threejs_core.memberships"] {
                let calls: i64 = calls.iter().filter(|(query, _)| query.contains(table)).map(|(_, calls)| calls).sum();
                assert_eq!(calls, 1, "real Member authentication SQL missing: {table}");
                authentication_statements += calls;
            }
            let noise_statements: i64 = noise_observer.snapshot().await.delta(&noise_before).values().sum();
            assert!(noise_statements > 0, "no overlapping Member requests were measured");
            let bytes = response.into_body().collect().await.unwrap().to_bytes();
            assert!(bytes.len() <= budgets["trendBytes"].as_u64().unwrap() as usize);
            let trend: Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(trend["max_points"], 600);
            assert_eq!(trend["raw_sample_count"], 86380);
            assert!(trend["plot_item_count"].as_u64().unwrap() <= 600);
            assert_eq!(trend["segments"].as_array().unwrap().len(), 2);
            assert!(trend["gaps"].as_array().unwrap().iter().any(|gap| {
                gap["reasons"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|reason| reason == "collection_gap")
            }));
            let samples = trend["segments"]
                .as_array()
                .unwrap()
                .iter()
                .flat_map(|segment| segment["samples"].as_array().unwrap())
                .collect::<Vec<_>>();
            for (sequence, value) in [(1, 20), (12346, 500), (45679, -100), (86400, 20)] {
                assert!(
                    samples
                        .iter()
                        .any(|sample| sample["sequence"] == sequence && sample["value"] == value),
                    "true representative missing: {sequence}"
                );
            }
            measurements.push(json!({"entities":scale,"statements":statements,"authentication_statements":authentication_statements,"overlapping_statements":noise_statements,"bytes":bytes.len(),"plot_items":trend["plot_item_count"]}));
        }
        measurements
    }).await;
    let _ = stop.send(true);
    let mut noise_outcomes = Vec::new();
    for worker in workers {
        noise_outcomes.push(worker.await);
    }
    noise_pool.close().await;
    <sqlx::Postgres as sqlx::migrate::MigrateDatabase>::force_drop_database(noise_url.as_str())
        .await
        .unwrap();
    observer.pool.close().await;
    let measurements = outcome.unwrap();
    for worker in noise_outcomes {
        let (accepted, rejected) = worker.unwrap();
        assert!(accepted > 0);
        assert_eq!(rejected, 0, "overlapping Member requests failed");
    }
    assert_eq!(measurements[0]["statements"], measurements[1]["statements"]);
    println!("trend_budget_measurements={measurements:?}");
    if let Ok(directory) = std::env::var("LAB_TREND_EVIDENCE_DIR") {
        let plan: Value = sqlx::query_scalar(&format!(
            "EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) {}",
            include_str!("../../../crates/app/src/modules/lab/trend.sql")
        ))
        .bind(entity_id)
        .bind("temperature")
        .bind(from)
        .bind(to)
        .bind(600_i64)
        .bind(from)
        .bind(from)
        .bind({let clock=|at:DateTime<Utc>|json!({"seconds":at.timestamp(),"nanos":at.timestamp_subsec_nanos(),"value":at});json!({"from":clock(from),"to":clock(to),"retained":clock(from),"captured":clock(from)})})
        .fetch_one(&pool)
        .await
        .unwrap();
        std::fs::write(
            format!("{directory}/query-plan.json"),
            serde_json::to_vec_pretty(&plan).unwrap(),
        )
        .unwrap();
        std::fs::write(
            format!("{directory}/budget-measurements.json"),
            serde_json::to_vec_pretty(&measurements).unwrap(),
        )
        .unwrap();
    }
}

struct Clock(AtomicI64);

struct PreciseClock(DateTime<Utc>);
impl ObservationClock for PreciseClock {
    fn now(&self) -> DateTime<Utc> {
        self.0
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn non_microsecond_half_open_bounds_include_and_exclude_the_true_stored_sample(pool: PgPool) {
    let app = labos_threejs_api::router(pool.clone(), Default::default());
    let member = member(&app).await;
    for nanos in [123456000, 123456500, 123456789, 999999500, 999999999] {
        let at = DateTime::from_timestamp(Utc::now().timestamp() + 10, nanos).unwrap();
        let runtime =
            DeviceRuntime::initialize_with_clock(pool.clone(), Arc::new(PreciseClock(at)))
                .await
                .unwrap();
        let path = entity(&app, &member, "sensor").await;
        let run = data(
            request(
                &app,
                &member,
                "POST",
                &format!("{path}/program/start"),
                json!({}),
            )
            .await,
        )
        .await;
        runtime
            .observe(
                run["id"].as_str().unwrap(),
                ObservationReport {
                    sequence: 1,
                    values: json!({"temperature":21}),
                    observed_at: Some(at),
                    quality: "good".into(),
                },
            )
            .await
            .unwrap();
        for (from, to, count) in [
            (at, at + chrono::Duration::nanoseconds(1), 1),
            (
                at + chrono::Duration::nanoseconds(1),
                at + chrono::Duration::seconds(1),
                0,
            ),
            (at - chrono::Duration::nanoseconds(1), at, 0),
        ] {
            let response = request(
                &app,
                &member,
                "GET",
                &query(&path, "temperature", from, to, "max_points=1"),
                Value::Null,
            )
            .await;
            assert_eq!(response.status(), StatusCode::OK);
            let trend = data(response).await;
            assert_eq!(trend["raw_sample_count"], count, "from={from} to={to}");
            assert_eq!(trend["from"], json!(from));
            assert_eq!(trend["to"], json!(to));
            if count == 1 {
                assert_eq!(trend["segments"][0]["samples"][0]["received_at"], json!(at));
            }
        }
        let current = data(request(&app, &member, "GET", &path, Value::Null).await).await;
        let expiry: DateTime<Utc> = serde_json::from_value(
            current["observation"]["properties"]["temperature"]["expires_at"].clone(),
        )
        .unwrap();
        let response = request(
            &app,
            &member,
            "GET",
            &query(
                &path,
                "temperature",
                at,
                expiry + chrono::Duration::nanoseconds(1),
                "max_points=2",
            ),
            Value::Null,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let trend = data(response).await;
        assert_eq!(
            trend["segments"][0]["samples"][0]["expires_at"],
            json!(expiry)
        );
        assert_eq!(trend["gaps"][0]["from"], json!(expiry));
        assert_eq!(trend["gaps"][0]["reasons"], json!(["expired"]));
    }
}

async fn setup(
    pool: PgPool,
    definition: &str,
) -> (Arc<Clock>, DeviceRuntime, Router, Member, String) {
    let clock = Clock::new();
    let runtime = DeviceRuntime::initialize_with_clock(pool.clone(), clock.clone())
        .await
        .unwrap();
    let app = labos_threejs_api::router(pool, Default::default());
    let member = member(&app).await;
    let path = entity(&app, &member, definition).await;
    (clock, runtime, app, member, path)
}

#[sqlx::test(migrations = "../../migrations")]
async fn ending_a_run_before_property_expiry_reports_run_end_instead_of_false_expiry(pool: PgPool) {
    let runtime = DeviceRuntime::initialize(pool.clone()).await.unwrap();
    let app = labos_threejs_api::router(pool, Default::default());
    let member = member(&app).await;
    let path = entity(&app, &member, "sensor").await;
    let run = data(
        request(
            &app,
            &member,
            "POST",
            &format!("{path}/program/start"),
            json!({}),
        )
        .await,
    )
    .await;
    runtime
        .observe(
            run["id"].as_str().unwrap(),
            ObservationReport {
                sequence: 1,
                values: json!({"temperature":21}),
                observed_at: Some(Utc::now()),
                quality: "good".into(),
            },
        )
        .await
        .unwrap();
    let current = data(request(&app, &member, "GET", &path, Value::Null).await).await;
    let property = &current["observation"]["properties"]["temperature"];
    let received: DateTime<Utc> = serde_json::from_value(property["received_at"].clone()).unwrap();
    let expires: DateTime<Utc> = serde_json::from_value(property["expires_at"].clone()).unwrap();
    let stopped = data(
        request(
            &app,
            &member,
            "POST",
            &format!("{path}/program/stop"),
            json!({}),
        )
        .await,
    )
    .await;
    assert_eq!(stopped["status"], "stopped");
    let ended: DateTime<Utc> = serde_json::from_value(stopped["ended_at"].clone()).unwrap();
    assert!(
        ended < expires,
        "fixture stops a real source before its property expires"
    );
    let response = request(
        &app,
        &member,
        "GET",
        &query(
            &path,
            "temperature",
            received,
            ended + chrono::Duration::seconds(1),
            "",
        ),
        Value::Null,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let trend = data(response).await;
    let gap = trend["gaps"]
        .as_array()
        .unwrap()
        .iter()
        .find(|gap| gap["from"] == json!(ended))
        .expect("Run end is the real gap boundary");
    assert_eq!(gap["reasons"], json!(["run_stopped"]));
    assert_eq!(
        trend["segments"][0]["samples"][0]["expires_at"],
        json!(expires)
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn historical_numeric_property_survives_definition_replacement_and_archiving(pool: PgPool) {
    let (clock, runtime, app, member, path) = setup(pool.clone(), "sensor").await;
    let run = data(
        request(
            &app,
            &member,
            "POST",
            &format!("{path}/program/start"),
            json!({}),
        )
        .await,
    )
    .await;
    clock.0.store(Utc::now().timestamp() + 1, Ordering::SeqCst);
    let from = clock.now();
    runtime
        .observe(
            run["id"].as_str().unwrap(),
            ObservationReport {
                sequence: 1,
                values: json!({"temperature":21}),
                observed_at: Some(from),
                quality: "good".into(),
            },
        )
        .await
        .unwrap();
    clock.advance(1);
    assert_eq!(
        request(
            &app,
            &member,
            "POST",
            &format!("{path}/program/stop"),
            json!({})
        )
        .await
        .status(),
        StatusCode::OK
    );
    assert_eq!(
        request(
            &app,
            &member,
            "PUT",
            &format!("{path}/definition"),
            json!({"definition_id":"labware","definition_version":"1.0","configuration":{}})
        )
        .await
        .status(),
        StatusCode::OK
    );
    assert_eq!(
        request(&app, &member, "POST", &format!("{path}/archive"), json!({}))
            .await
            .status(),
        StatusCode::OK
    );
    let response = request(
        &app,
        &member,
        "GET",
        &query(&path, "temperature", from, clock.now(), ""),
        Value::Null,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let trend = data(response).await;
    assert_eq!(trend["segments"][0]["run_id"], run["id"]);
    assert_eq!(trend["segments"][0]["binding_id"], run["binding_id"]);
    assert_eq!(trend["segments"][0]["samples"][0]["value"], 21);
}

#[sqlx::test(migrations = "../../migrations")]
async fn generated_sdk_example_reads_member_and_agent_facts_over_real_http_and_recovers(
    pool: PgPool,
) {
    use std::future::IntoFuture;
    let app = labos_threejs_api::router(pool.clone(), Default::default());
    let member = member(&app).await;
    for nanos in [123456789, 999999999] {
        let from = DateTime::from_timestamp(Utc::now().timestamp() + 10, nanos).unwrap();
        let to = from + chrono::Duration::nanoseconds(1);
        let runtime =
            DeviceRuntime::initialize_with_clock(pool.clone(), Arc::new(PreciseClock(from)))
                .await
                .unwrap();
        let path = entity(&app, &member, "sensor").await;
        let run = data(
            request(
                &app,
                &member,
                "POST",
                &format!("{path}/program/start"),
                json!({}),
            )
            .await,
        )
        .await;
        runtime
            .observe(
                run["id"].as_str().unwrap(),
                ObservationReport {
                    sequence: 1,
                    values: json!({"temperature":23}),
                    observed_at: Some(from - chrono::Duration::seconds(2)),
                    quality: "good".into(),
                },
            )
            .await
            .unwrap();
        let credential = key(&app, &member, "lab:full").await;
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (shutdown, stopped) = tokio::sync::oneshot::channel();
        let server = tokio::spawn(
            axum::serve(listener, app.clone())
                .with_graceful_shutdown(async move {
                    let _ = stopped.await;
                })
                .into_future(),
        );
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        let mut results = Vec::new();
        for (kind, environment, value) in [
            ("member", "LAB_SESSION_COOKIE", member.cookie.as_str()),
            (
                "agent",
                "LAB_API_KEY",
                credential["secret"].as_str().unwrap(),
            ),
        ] {
            let offset =
                chrono::FixedOffset::east_opt(if kind == "agent" { 8 * 3600 } else { 0 }).unwrap();
            let mut command = tokio::process::Command::new("node");
            command
                .current_dir(&root)
                .arg("examples/lab/query-trend.mjs")
                .env_remove("LAB_API_KEY")
                .env_remove("LAB_SESSION_COOKIE")
                .env(environment, value)
                .env("LAB_API_BASE", format!("http://{address}"))
                .env("LAB_ID", path.split('/').nth(5).unwrap())
                .env("LAB_ENTITY_ID", path.split('/').nth(7).unwrap())
                .env("LAB_TREND_FROM", from.with_timezone(&offset).to_rfc3339())
                .env("LAB_TREND_TO", to.with_timezone(&offset).to_rfc3339())
                .env("LAB_TREND_POINTS", "600")
                .env("LAB_TREND_PROPERTY", "temperature")
                .kill_on_drop(true);
            let output = tokio::time::timeout(std::time::Duration::from_secs(30), command.output())
                .await
                .unwrap()
                .unwrap();
            assert!(
                output.status.success(),
                "{kind} SDK example failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            let trend: Value =
                serde_json::from_slice(&output.stdout).expect("example returns real SDK JSON");
            assert_eq!(trend["raw_sample_count"], 1);
            assert_eq!(trend["segments"][0]["samples"][0]["value"], 23);
            assert_eq!(
                trend["segments"][0]["samples"][0]["received_at"],
                json!(from)
            );
            assert_eq!(
                trend["segments"][0]["samples"][0]["observed_at"],
                json!(from - chrono::Duration::seconds(2))
            );
            results.push(trend);
        }
        let _ = shutdown.send(());
        let _ = server.await;
        assert_eq!(results[0]["segments"], results[1]["segments"]);
        assert_eq!(results[0]["gaps"], results[1]["gaps"]);
        println!("real SDK example passed for Member and Agent; listener={address} stopped");
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn two_point_budget_preserves_monotonic_small_segment_endpoints(pool: PgPool) {
    let (clock, runtime, app, member, path) = setup(pool.clone(), "sensor").await;
    let run = data(
        request(
            &app,
            &member,
            "POST",
            &format!("{path}/program/start"),
            json!({}),
        )
        .await,
    )
    .await;
    clock.0.store(Utc::now().timestamp() + 1, Ordering::SeqCst);
    let from = clock.now();
    for sequence in 1..=3 {
        runtime
            .observe(
                run["id"].as_str().unwrap(),
                ObservationReport {
                    sequence,
                    values: json!({"temperature":sequence}),
                    observed_at: Some(clock.now()),
                    quality: "good".into(),
                },
            )
            .await
            .unwrap();
        clock.advance(1);
    }
    let response = request(
        &app,
        &member,
        "GET",
        &query(&path, "temperature", from, clock.now(), "max_points=2"),
        Value::Null,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let trend = data(response).await;
    assert_eq!(trend["raw_sample_count"], 3);
    assert_eq!(trend["plot_item_count"], 2);
    assert_eq!(trend["segments"][0]["samples"][0]["sequence"], 1);
    assert_eq!(trend["segments"][0]["samples"][1]["sequence"], 3);
}

#[sqlx::test(migrations = "../../migrations")]
async fn units_sources_and_binding_replacement_stay_separate_and_large_metadata_is_rejected(
    pool: PgPool,
) {
    let (clock, runtime, app, member, path) = setup(pool.clone(), "sensor").await;
    let first = data(
        request(
            &app,
            &member,
            "POST",
            &format!("{path}/program/start"),
            json!({}),
        )
        .await,
    )
    .await;
    clock.0.store(Utc::now().timestamp() + 1, Ordering::SeqCst);
    let from = clock.now();
    for sequence in 1..=4 {
        runtime
            .observe(
                first["id"].as_str().unwrap(),
                ObservationReport {
                    sequence,
                    values: json!({"temperature":sequence}),
                    observed_at: Some(clock.now()),
                    quality: "good".into(),
                },
            )
            .await
            .unwrap();
        clock.advance(1);
    }
    // Imported historical property metadata can carry units and source names beyond today's built-in adapter.
    sqlx::query("UPDATE lab.observation_history SET data=jsonb_set(data,'{properties,temperature,unit}','\"K\"'::jsonb) WHERE run_id=$1::uuid AND data->>'sequence'='2'").bind(first["id"].as_str().unwrap()).execute(&pool).await.unwrap();
    sqlx::query("UPDATE lab.observation_history SET data=jsonb_set(data,'{properties,temperature,source}','\"physical:archive:42\"'::jsonb) WHERE run_id=$1::uuid AND data->>'sequence'='3'").bind(first["id"].as_str().unwrap()).execute(&pool).await.unwrap();
    assert_eq!(
        request(
            &app,
            &member,
            "POST",
            &format!("{path}/program/stop"),
            json!({})
        )
        .await
        .status(),
        StatusCode::OK
    );
    assert_eq!(
        request(
            &app,
            &member,
            "PUT",
            &format!("{path}/definition"),
            json!({"definition_id":"centrifuge","definition_version":"1.0","configuration":{}})
        )
        .await
        .status(),
        StatusCode::OK
    );
    let second = data(
        request(
            &app,
            &member,
            "POST",
            &format!("{path}/program/start"),
            json!({}),
        )
        .await,
    )
    .await;
    runtime
        .observe(
            second["id"].as_str().unwrap(),
            ObservationReport {
                sequence: 1,
                values: json!({"temperature":5}),
                observed_at: Some(clock.now()),
                quality: "good".into(),
            },
        )
        .await
        .unwrap();
    clock.advance(1);
    let url = query(&path, "temperature", from, clock.now(), "max_points=1000");
    let response = request(&app, &member, "GET", &url, Value::Null).await;
    assert_eq!(response.status(), StatusCode::OK);
    let trend = data(response).await;
    assert_eq!(trend["segments"].as_array().unwrap().len(), 5);
    assert_eq!(trend["segments"][1]["unit"], "K");
    assert_eq!(trend["segments"][1]["samples"][0]["value"], 2);
    assert_eq!(trend["segments"][2]["source"], "physical:archive:42");
    assert_eq!(trend["segments"][3]["source"], first["source"]);
    assert_eq!(trend["segments"][4]["binding_id"], second["binding_id"]);
    for reason in ["unit_changed", "source_changed", "binding_changed"] {
        assert!(trend["gaps"].as_array().unwrap().iter().any(|gap| {
            gap["reasons"]
                .as_array()
                .unwrap()
                .iter()
                .any(|r| r == reason)
        }));
    }
    let before = data(request(&app, &member, "GET", &path, Value::Null).await).await;
    sqlx::query("UPDATE lab.observation_history SET data=jsonb_set(data,'{properties,temperature,source}',to_jsonb(repeat('a',300000))) WHERE run_id=$1::uuid").bind(second["id"].as_str().unwrap()).execute(&pool).await.unwrap();
    let response = request(&app, &member, "GET", &url, Value::Null).await;
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(
        data(response).await["error"]["code"],
        "lab.trend_budget_exceeded"
    );
    assert_eq!(
        data(request(&app, &member, "GET", &path, Value::Null).await).await,
        before
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn no_observations_remain_empty_with_capture_boundary_and_one_isolated_real_sample_stays_visible(
    pool: PgPool,
) {
    let (clock, runtime, app, member, path) = setup(pool.clone(), "sensor").await;
    let empty = data(
        request(
            &app,
            &member,
            "GET",
            &query(
                &path,
                "temperature",
                clock.now() - chrono::Duration::hours(1),
                Utc::now() + chrono::Duration::seconds(1),
                "",
            ),
            Value::Null,
        )
        .await,
    )
    .await;
    assert_eq!(empty["raw_sample_count"], 0);
    assert_eq!(empty["returned_sample_count"], 0);
    assert_eq!(empty["segments"], json!([]));
    assert_eq!(empty["last_report_at"], Value::Null);
    assert!(empty["gaps"].as_array().unwrap().iter().any(|gap| {
        gap["reasons"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r == "collection_not_started")
    }));
    let run = data(
        request(
            &app,
            &member,
            "POST",
            &format!("{path}/program/start"),
            json!({}),
        )
        .await,
    )
    .await;
    clock.0.store(Utc::now().timestamp() + 1, Ordering::SeqCst);
    let from = clock.now();
    runtime
        .observe(
            run["id"].as_str().unwrap(),
            ObservationReport {
                sequence: 1,
                values: json!({"temperature":0}),
                observed_at: None,
                quality: "bad".into(),
            },
        )
        .await
        .unwrap();
    runtime
        .observe(
            run["id"].as_str().unwrap(),
            ObservationReport {
                sequence: 1,
                values: json!({"temperature":100}),
                observed_at: Some(from),
                quality: "good".into(),
            },
        )
        .await
        .unwrap();
    clock.advance(1);
    let response = request(
        &app,
        &member,
        "GET",
        &query(&path, "temperature", from, clock.now(), "max_points=1"),
        Value::Null,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let trend = data(response).await;
    assert_eq!(trend["plot_item_count"], 1);
    assert_eq!(trend["raw_sample_count"], 1);
    assert_eq!(trend["segments"][0]["samples"][0]["value"], 0);
    assert_eq!(trend["segments"][0]["source_time_known"], false);
    assert_eq!(trend["segments"][0]["quality"], "bad");
}

async fn agent(app: &Router, secret: &str, path: &str) -> Response {
    app.clone()
        .oneshot(
            Request::get(path)
                .header("authorization", format!("Bearer {secret}"))
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap()
}
async fn key(app: &Router, member: &Member, scope: &str) -> Value {
    let response = request(
        app,
        member,
        "POST",
        "/api/v1/api-keys",
        json!({"name":"Trend reader","scopes":[scope],"expires_in_days":1}),
    )
    .await;
    assert_eq!(response.status(), StatusCode::CREATED);
    data(response).await
}

#[sqlx::test(migrations = "../../migrations")]
async fn member_and_scoped_agent_read_same_facts_and_invalid_or_revoked_access_is_rejected(
    pool: PgPool,
) {
    let (clock, runtime, app, member, path) = setup(pool.clone(), "centrifuge").await;
    let run = data(
        request(
            &app,
            &member,
            "POST",
            &format!("{path}/program/start"),
            json!({}),
        )
        .await,
    )
    .await;
    let from = clock.now();
    runtime
        .observe(
            run["id"].as_str().unwrap(),
            ObservationReport {
                sequence: 1,
                values: json!({"speed":0}),
                observed_at: None,
                quality: "uncertain".into(),
            },
        )
        .await
        .unwrap();
    clock.advance(1);
    let url = query(&path, "speed", from, clock.now(), "");
    let full = key(&app, &member, "lab:full").await;
    let secret = full["secret"].as_str().unwrap();
    let normal = data(request(&app, &member, "GET", &url, Value::Null).await).await;
    let response = agent(&app, secret, &url).await;
    assert_eq!(response.status(), StatusCode::OK);
    let automatic = data(response).await;
    for field in [
        "segments",
        "gaps",
        "raw_sample_count",
        "returned_sample_count",
        "plot_item_count",
        "first_report_at",
        "last_report_at",
    ] {
        assert_eq!(automatic[field], normal[field]);
    }
    assert_eq!(automatic["segments"][0]["samples"][0]["value"], 0);
    assert_eq!(automatic["segments"][0]["unit"], "rpm");
    let before = data(request(&app, &member, "GET", &path, Value::Null).await).await;
    for (property, start, end, extra) in [
        ("phase", from, clock.now(), ""),
        ("unknown", from, clock.now(), ""),
        ("speed", from, from, ""),
        ("speed", from, from + chrono::Duration::hours(25), ""),
        ("speed", from, clock.now(), "max_points=0"),
        ("speed", from, clock.now(), "max_points=1001"),
        ("speed", from, clock.now(), "unknown=1"),
    ] {
        assert_eq!(
            request(
                &app,
                &member,
                "GET",
                &query(&path, property, start, end, extra),
                Value::Null
            )
            .await
            .status(),
            StatusCode::BAD_REQUEST
        );
    }
    let other = entity(&app, &member, "sensor").await;
    let other_lab = other.split('/').nth(5).unwrap();
    let own_lab = path.split('/').nth(5).unwrap();
    assert_eq!(
        agent(&app, secret, &url.replace(own_lab, other_lab))
            .await
            .status(),
        StatusCode::NOT_FOUND
    );
    assert_eq!(
        agent(
            &app,
            secret,
            &url.replace(
                path.split('/').nth(7).unwrap(),
                &uuid::Uuid::now_v7().to_string()
            )
        )
        .await
        .status(),
        StatusCode::NOT_FOUND
    );
    let limited = key(&app, &member, "profile:read").await;
    assert_eq!(
        agent(&app, limited["secret"].as_str().unwrap(), &url)
            .await
            .status(),
        StatusCode::FORBIDDEN
    );
    let expired = key(&app, &member, "lab:full").await;
    sqlx::query("UPDATE labos_threejs_core.api_keys SET expires_at=now()-interval '1 second' WHERE id=$1::uuid").bind(expired["key"]["id"].as_str().unwrap()).execute(&pool).await.unwrap();
    assert_eq!(
        agent(&app, expired["secret"].as_str().unwrap(), &url)
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        request(
            &app,
            &member,
            "DELETE",
            &format!("/api/v1/api-keys/{}", full["key"]["id"].as_str().unwrap()),
            Value::Null
        )
        .await
        .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        agent(&app, secret, &url).await.status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        data(request(&app, &member, "GET", &path, Value::Null).await).await,
        before
    );
    assert_eq!(
        request(&app, &member, "POST", "/api/v1/auth/logout", json!({}))
            .await
            .status(),
        StatusCode::NO_CONTENT
    );
    assert_eq!(
        request(&app, &member, "GET", &url, Value::Null)
            .await
            .status(),
        StatusCode::UNAUTHORIZED
    );
}

#[sqlx::test(migrations = "../../migrations")]
async fn cleanup_boundary_is_an_explicit_retention_gap_and_never_recreates_samples(pool: PgPool) {
    let (clock, runtime, app, member, path) = setup(pool.clone(), "sensor").await;
    let run = data(
        request(
            &app,
            &member,
            "POST",
            &format!("{path}/program/start"),
            json!({}),
        )
        .await,
    )
    .await;
    clock.0.store(Utc::now().timestamp() + 1, Ordering::SeqCst);
    let from = clock.now();
    for sequence in 1..=2 {
        runtime
            .observe(
                run["id"].as_str().unwrap(),
                ObservationReport {
                    sequence,
                    values: json!({"temperature":20+sequence}),
                    observed_at: Some(clock.now()),
                    quality: "good".into(),
                },
            )
            .await
            .unwrap();
        clock.advance(1);
    }
    let to = clock.now();
    let lab = path.split('/').nth(5).unwrap();
    HistoryMaintenance::new(pool, RetentionPolicy::new(5, 30).unwrap())
        .cleanup(lab, from + chrono::Duration::seconds(6))
        .await
        .unwrap();
    let response = request(
        &app,
        &member,
        "GET",
        &query(&path, "temperature", from, to, ""),
        Value::Null,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let trend = data(response).await;
    assert_eq!(trend["raw_sample_count"], 1);
    assert_eq!(
        trend["retained_since"],
        json!(from + chrono::Duration::seconds(1))
    );
    assert_eq!(trend["segments"][0]["samples"][0]["sequence"], 2);
    assert!(trend["gaps"].as_array().unwrap().iter().any(|gap| {
        gap["reasons"]
            .as_array()
            .unwrap()
            .iter()
            .any(|reason| reason == "retention")
    }));
    assert_eq!(trend["observation_retention_seconds"], 86400);
}
impl Clock {
    fn new() -> Arc<Self> {
        Arc::new(Self(AtomicI64::new(Utc::now().timestamp() - 10)))
    }
    fn advance(&self, seconds: i64) {
        self.0.fetch_add(seconds, Ordering::SeqCst);
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn resolution_is_zero_for_every_segment_whose_original_samples_are_all_retained(
    pool: PgPool,
) {
    let (clock, runtime, app, member, path) = setup(pool.clone(), "sensor").await;
    let run = data(
        request(
            &app,
            &member,
            "POST",
            &format!("{path}/program/start"),
            json!({}),
        )
        .await,
    )
    .await;
    clock.0.store(Utc::now().timestamp() + 10, Ordering::SeqCst);
    let from = clock.now();
    for sequence in 1..=5 {
        runtime
            .observe(
                run["id"].as_str().unwrap(),
                ObservationReport {
                    sequence,
                    values: json!({"temperature":sequence}),
                    observed_at: Some(clock.now()),
                    quality: "good".into(),
                },
            )
            .await
            .unwrap();
        clock.advance(1);
    }
    let response = request(
        &app,
        &member,
        "GET",
        &query(&path, "temperature", from, clock.now(), ""),
        Value::Null,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let trend = data(response).await;
    assert_eq!(trend["raw_sample_count"], 5);
    assert_eq!(trend["returned_sample_count"], 5);
    assert_eq!(trend["segments"][0]["resolution_seconds"], 0.0);

    for sequence in 6..=205 {
        runtime
            .observe(
                run["id"].as_str().unwrap(),
                ObservationReport {
                    sequence,
                    values: json!({"temperature":sequence}),
                    observed_at: Some(clock.now()),
                    quality: "uncertain".into(),
                },
            )
            .await
            .unwrap();
        clock.advance(1);
    }
    let response = request(
        &app,
        &member,
        "GET",
        &query(&path, "temperature", from, clock.now(), "max_points=28"),
        Value::Null,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let trend = data(response).await;
    assert_eq!(trend["raw_sample_count"], 205);
    assert!(trend["returned_sample_count"].as_u64().unwrap() < 205);
    assert!(trend["plot_item_count"].as_u64().unwrap() <= 28);
    assert_eq!(trend["gaps"][0]["reasons"], json!(["quality_changed"]));
    let segments = trend["segments"].as_array().unwrap();
    assert_eq!(segments.len(), 2);
    assert_eq!(segments[0]["quality"], "good");
    assert_eq!(segments[0]["resolution_seconds"], 0.0);
    let samples = segments[0]["samples"].as_array().unwrap();
    assert_eq!(samples.len(), 5);
    for (sample, sequence) in samples.iter().zip(1..=5) {
        assert_eq!(sample["sequence"], sequence);
        assert_eq!(sample["value"], sequence);
        assert_eq!(
            sample["received_at"],
            json!(from + chrono::Duration::seconds(sequence - 1))
        );
    }
    assert_eq!(segments[1]["quality"], "uncertain");
    assert!(segments[1]["samples"].as_array().unwrap().len() < 200);
    assert!(segments[1]["resolution_seconds"].as_f64().unwrap() > 0.0);

    let at = clock.now();
    for (sequence, value) in [(206, 1), (207, 2), (208, 3)] {
        runtime
            .observe(
                run["id"].as_str().unwrap(),
                ObservationReport {
                    sequence,
                    values: json!({"temperature":value}),
                    observed_at: Some(at),
                    quality: "uncertain".into(),
                },
            )
            .await
            .unwrap();
    }
    for (max_points, expected_sequences, resolution) in [
        ("", vec![206, 207, 208], 0.0),
        ("max_points=2", vec![206, 208], 0.000000001),
    ] {
        let response = request(
            &app,
            &member,
            "GET",
            &query(
                &path,
                "temperature",
                at,
                at + chrono::Duration::seconds(1),
                max_points,
            ),
            Value::Null,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let trend = data(response).await;
        assert_eq!(trend["raw_sample_count"], 3);
        assert_eq!(trend["returned_sample_count"], expected_sequences.len());
        assert_eq!(trend["plot_item_count"], expected_sequences.len());
        assert_eq!(trend["gaps"], json!([]));
        assert_eq!(trend["segments"].as_array().unwrap().len(), 1);
        let segment = &trend["segments"][0];
        assert_eq!(segment["resolution_seconds"], resolution);
        let samples = segment["samples"].as_array().unwrap();
        assert_eq!(samples.len(), expected_sequences.len());
        for (sample, sequence) in samples.iter().zip(expected_sequences) {
            assert_eq!(sample["sequence"], sequence);
            assert_eq!(sample["value"], sequence - 205);
            assert_eq!(sample["received_at"], json!(at));
            assert_eq!(sample["observed_at"], json!(at));
        }
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn tied_extremes_reuse_real_bucket_endpoints_to_fit_the_budget(pool: PgPool) {
    let (clock, runtime, app, member, path) = setup(pool.clone(), "sensor").await;
    let run = data(
        request(
            &app,
            &member,
            "POST",
            &format!("{path}/program/start"),
            json!({}),
        )
        .await,
    )
    .await;
    clock.0.store(Utc::now().timestamp() + 10, Ordering::SeqCst);
    let from = clock.now();
    for (sequence, value) in [(1, 2), (2, 1), (3, 1)] {
        runtime
            .observe(
                run["id"].as_str().unwrap(),
                ObservationReport {
                    sequence,
                    values: json!({"temperature":value}),
                    observed_at: Some(clock.now()),
                    quality: "good".into(),
                },
            )
            .await
            .unwrap();
        clock.advance(1);
    }
    let original = data(
        request(
            &app,
            &member,
            "GET",
            &query(&path, "temperature", from, clock.now(), ""),
            Value::Null,
        )
        .await,
    )
    .await;
    assert_eq!(original["raw_sample_count"], 3);
    assert_eq!(original["returned_sample_count"], 3);
    assert_eq!(original["gaps"], json!([]));
    assert_eq!(original["segments"][0]["samples"][1]["sequence"], 2);
    assert_eq!(original["segments"][0]["resolution_seconds"], 0.0);
    let target = query(&path, "temperature", from, clock.now(), "max_points=2");
    let response = request(&app, &member, "GET", &target, Value::Null).await;
    assert_eq!(response.status(), StatusCode::OK);
    let trend = data(response).await;
    assert_eq!(trend["raw_sample_count"], 3);
    assert_eq!(trend["returned_sample_count"], 2);
    assert_eq!(trend["plot_item_count"], 2);
    assert_eq!(trend["gaps"], json!([]));
    assert_eq!(trend["segments"].as_array().unwrap().len(), 1);
    let segment = &trend["segments"][0];
    assert_eq!(segment["run_id"], run["id"]);
    assert_eq!(segment["quality"], "good");
    assert!(segment["resolution_seconds"].as_f64().unwrap() > 0.0);
    let samples = segment["samples"].as_array().unwrap();
    assert_eq!(samples.len(), 2);
    for (sample, (sequence, value)) in samples.iter().zip([(1, 2), (3, 1)]) {
        assert_eq!(sample["sequence"], sequence);
        assert_eq!(sample["value"], value);
        assert_eq!(
            sample["received_at"],
            json!(from + chrono::Duration::seconds(sequence - 1))
        );
        assert_eq!(sample["observed_at"], sample["received_at"]);
    }
    assert_eq!(
        request(
            &app,
            &member,
            "GET",
            &query(&path, "temperature", from, clock.now(), "max_points=1"),
            Value::Null,
        )
        .await
        .status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
    let recovered = data(request(&app, &member, "GET", &target, Value::Null).await).await;
    assert_eq!(recovered["segments"], trend["segments"]);
}

#[sqlx::test(migrations = "../../migrations")]
async fn non_multiple_point_budgets_fit_real_extremes_after_reserving_small_segments_and_gaps(
    pool: PgPool,
) {
    let (clock, runtime, app, member, path) = setup(pool.clone(), "sensor").await;
    let run = data(
        request(
            &app,
            &member,
            "POST",
            &format!("{path}/program/start"),
            json!({}),
        )
        .await,
    )
    .await;
    clock.0.store(Utc::now().timestamp() + 10, Ordering::SeqCst);
    let from = clock.now();
    for sequence in 1..=100 {
        let value = match sequence % 4 {
            1 => 2,
            2 => -10,
            3 => 10,
            _ => 0,
        };
        runtime
            .observe(
                run["id"].as_str().unwrap(),
                ObservationReport {
                    sequence,
                    values: json!({"temperature":value}),
                    observed_at: Some(clock.now()),
                    quality: "good".into(),
                },
            )
            .await
            .unwrap();
        clock.advance(1);
    }
    let current = data(request(&app, &member, "GET", &path, Value::Null).await).await;
    let original = &current["observation"]["properties"]["temperature"];
    let assert_original_long_segment = |segment: &Value| {
        for field in ["binding_id", "run_id", "source", "unit", "quality"] {
            assert_eq!(segment[field], original[field]);
        }
        assert!(segment["resolution_seconds"].as_f64().unwrap() > 0.0);
        let samples = segment["samples"].as_array().unwrap();
        assert_eq!(samples.first().unwrap()["sequence"], 1);
        assert_eq!(samples.last().unwrap()["sequence"], 100);
        assert!(samples.iter().any(|sample| sample["value"] == -10));
        assert!(samples.iter().any(|sample| sample["value"] == 10));
        for sample in samples {
            let sequence = sample["sequence"].as_i64().unwrap();
            let value = match sequence % 4 {
                1 => 2,
                2 => -10,
                3 => 10,
                _ => 0,
            };
            assert_eq!(sample["value"], value);
            assert_eq!(
                sample["received_at"],
                json!(from + chrono::Duration::seconds(sequence - 1))
            );
            assert_eq!(sample["observed_at"], sample["received_at"]);
        }
        samples.len()
    };
    for max_points in [5, 6, 7] {
        let response = request(
            &app,
            &member,
            "GET",
            &query(
                &path,
                "temperature",
                from,
                clock.now(),
                &format!("max_points={max_points}"),
            ),
            Value::Null,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let trend = data(response).await;
        assert_eq!(trend["raw_sample_count"], 100);
        assert_eq!(trend["gaps"], json!([]));
        assert_eq!(trend["segments"].as_array().unwrap().len(), 1);
        let segment = &trend["segments"][0];
        let returned = assert_original_long_segment(segment);
        assert_eq!(trend["returned_sample_count"], returned);
        assert_eq!(trend["plot_item_count"], returned);
        assert!(returned <= max_points);
        println!(
            "non_multiple_budget={}",
            json!({"budget":max_points,"plot_items":trend["plot_item_count"],"resolution_seconds":segment["resolution_seconds"]})
        );
    }
    for (sequence, value) in [(101, 30), (102, -20), (103, 40)] {
        runtime
            .observe(
                run["id"].as_str().unwrap(),
                ObservationReport {
                    sequence,
                    values: json!({"temperature":value}),
                    observed_at: Some(clock.now()),
                    quality: "uncertain".into(),
                },
            )
            .await
            .unwrap();
        clock.advance(1);
    }
    assert_eq!(
        request(
            &app,
            &member,
            "GET",
            &query(&path, "temperature", from, clock.now(), "max_points=7"),
            Value::Null,
        )
        .await
        .status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
    for max_points in [9, 11] {
        let response = request(
            &app,
            &member,
            "GET",
            &query(
                &path,
                "temperature",
                from,
                clock.now(),
                &format!("max_points={max_points}"),
            ),
            Value::Null,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let trend = data(response).await;
        assert_eq!(trend["raw_sample_count"], 103);
        assert_eq!(trend["gaps"].as_array().unwrap().len(), 1);
        assert_eq!(trend["gaps"][0]["reasons"], json!(["quality_changed"]));
        let segments = trend["segments"].as_array().unwrap();
        assert_eq!(segments.len(), 2);
        let returned = assert_original_long_segment(&segments[0]);
        assert_eq!(trend["returned_sample_count"], returned + 3);
        assert_eq!(trend["plot_item_count"], returned + 4);
        assert!(returned + 4 <= max_points);
        for field in ["binding_id", "run_id", "source", "unit"] {
            assert_eq!(segments[1][field], original[field]);
        }
        assert_eq!(segments[1]["resolution_seconds"], 0.0);
        assert_eq!(segments[1]["quality"], "uncertain");
        let samples = segments[1]["samples"].as_array().unwrap();
        assert_eq!(samples.len(), 3);
        for (sample, (sequence, value)) in samples.iter().zip([(101, 30), (102, -20), (103, 40)]) {
            assert_eq!(sample["sequence"], sequence);
            assert_eq!(sample["value"], value);
            assert_eq!(
                sample["received_at"],
                json!(from + chrono::Duration::seconds(sequence - 1))
            );
        }
        println!(
            "non_multiple_budget_with_gap={}",
            json!({"budget":max_points,"plot_items":trend["plot_item_count"],"resolution_seconds":segments[0]["resolution_seconds"]})
        );
    }
}

#[sqlx::test(migrations = "../../migrations")]
async fn bounded_compression_keeps_true_first_last_min_max_and_reports_counts(pool: PgPool) {
    let (clock, runtime, app, member, path) = setup(pool.clone(), "sensor").await;
    let run = data(
        request(
            &app,
            &member,
            "POST",
            &format!("{path}/program/start"),
            json!({}),
        )
        .await,
    )
    .await;
    let from = clock.now();
    for sequence in 1..=200 {
        let value = match sequence {
            50 => 500,
            122 => -100,
            _ => 20,
        };
        runtime
            .observe(
                run["id"].as_str().unwrap(),
                ObservationReport {
                    sequence,
                    values: json!({"temperature":value}),
                    observed_at: Some(clock.now()),
                    quality: "good".into(),
                },
            )
            .await
            .unwrap();
        clock.advance(1);
    }
    let response = request(
        &app,
        &member,
        "GET",
        &query(&path, "temperature", from, clock.now(), "max_points=20"),
        Value::Null,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    assert!(bytes.len() <= 256 * 1024);
    let trend: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(trend["raw_sample_count"], 200);
    assert!(trend["plot_item_count"].as_u64().unwrap() <= 20);
    assert_eq!(trend["segments"].as_array().unwrap().len(), 1);
    let samples = trend["segments"][0]["samples"].as_array().unwrap();
    assert_eq!(samples.first().unwrap()["sequence"], 1);
    assert_eq!(samples.last().unwrap()["sequence"], 200);
    for (sequence, value) in [(50, 500), (122, -100)] {
        let sample = samples
            .iter()
            .find(|sample| sample["sequence"] == sequence)
            .expect("true extreme sample retained");
        assert_eq!(sample["value"], value);
        assert_eq!(
            sample["received_at"],
            json!(from + chrono::Duration::seconds(sequence - 1))
        );
    }
    assert_eq!(trend["sampling_strategy"], "first_last_min_max");
    assert!(trend["segments"][0]["resolution_seconds"].as_f64().unwrap() > 1.0);
}
impl ObservationClock for Clock {
    fn now(&self) -> DateTime<Utc> {
        DateTime::from_timestamp(self.0.load(Ordering::SeqCst), 0).unwrap()
    }
}
struct Member {
    cookie: String,
    csrf: String,
}

#[sqlx::test(migrations = "../../migrations")]
async fn explicit_quality_expiry_and_run_boundaries_count_against_budget_without_writes(
    pool: PgPool,
) {
    let (clock, runtime, app, member, path) = setup(pool.clone(), "sensor").await;
    let first = data(
        request(
            &app,
            &member,
            "POST",
            &format!("{path}/program/start"),
            json!({}),
        )
        .await,
    )
    .await;
    let from = clock.now();
    for (sequence, quality, known) in [
        (1, "good", true),
        (2, "bad", true),
        (3, "uncertain", false),
        (4, "good", true),
    ] {
        runtime
            .observe(
                first["id"].as_str().unwrap(),
                ObservationReport {
                    sequence,
                    values: json!({"temperature":sequence}),
                    observed_at: known.then(|| clock.now()),
                    quality: quality.into(),
                },
            )
            .await
            .unwrap();
        clock.advance(1);
    }
    clock.advance(7);
    runtime
        .observe(
            first["id"].as_str().unwrap(),
            ObservationReport {
                sequence: 5,
                values: json!({"temperature":5}),
                observed_at: Some(clock.now()),
                quality: "good".into(),
            },
        )
        .await
        .unwrap();
    clock.advance(1);
    assert_eq!(
        request(
            &app,
            &member,
            "POST",
            &format!("{path}/program/stop"),
            json!({})
        )
        .await
        .status(),
        StatusCode::OK
    );
    let second = data(
        request(
            &app,
            &member,
            "POST",
            &format!("{path}/program/start"),
            json!({}),
        )
        .await,
    )
    .await;
    runtime
        .observe(
            second["id"].as_str().unwrap(),
            ObservationReport {
                sequence: 1,
                values: json!({"temperature":6}),
                observed_at: Some(clock.now()),
                quality: "good".into(),
            },
        )
        .await
        .unwrap();
    clock.advance(10);
    let before = data(request(&app, &member, "GET", &path, Value::Null).await).await;
    let response = request(
        &app,
        &member,
        "GET",
        &query(&path, "temperature", from, clock.now(), ""),
        Value::Null,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let trend = data(response).await;
    assert_eq!(trend["segments"].as_array().unwrap().len(), 6);
    assert_eq!(trend["segments"][1]["quality"], "bad");
    assert_eq!(trend["segments"][2]["source_time_known"], false);
    assert_eq!(trend["segments"][5]["run_id"], second["id"]);
    let gaps = trend["gaps"].as_array().unwrap();
    for reason in [
        "quality_changed",
        "source_time_unknown",
        "expired",
        "run_changed",
    ] {
        assert!(
            gaps.iter().any(|gap| gap["reasons"]
                .as_array()
                .unwrap()
                .iter()
                .any(|r| r == reason)),
            "missing reason {reason}: {trend}"
        );
    }
    assert_eq!(
        trend["plot_item_count"].as_u64().unwrap(),
        6 + gaps.len() as u64
    );
    let response = request(
        &app,
        &member,
        "GET",
        &query(&path, "temperature", from, clock.now(), "max_points=1"),
        Value::Null,
    )
    .await;
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(
        data(response).await["error"]["code"],
        "lab.trend_budget_exceeded"
    );
    assert_eq!(
        data(request(&app, &member, "GET", &path, Value::Null).await).await,
        before
    );
}
async fn data(response: Response) -> Value {
    serde_json::from_slice(&response.into_body().collect().await.unwrap().to_bytes()).unwrap()
}
async fn request(app: &Router, member: &Member, method: &str, path: &str, body: Value) -> Response {
    app.clone()
        .oneshot(
            Request::builder()
                .method(method)
                .uri(path)
                .header("origin", "http://127.0.0.1:5173")
                .header("content-type", "application/json")
                .header("cookie", &member.cookie)
                .header("x-csrf-token", &member.csrf)
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap()
}
async fn member(app: &Router) -> Member {
    let owner = app
        .clone()
        .oneshot(
            Request::post("/api/v1/auth/register")
                .header("origin", "http://127.0.0.1:5173")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"email":"trend-owner@example.test","password":"a-long-test-password"})
                        .to_string(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(owner.status(), StatusCode::CREATED);
    let response = app
        .clone()
        .oneshot(
            Request::post("/api/v1/auth/register")
                .header("origin", "http://127.0.0.1:5173")
                .header("content-type", "application/json")
                .body(Body::from(
                    json!({"email":"trends@example.test","password":"a-long-test-password"})
                        .to_string(),
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
    let session = data(response).await;
    assert_eq!(session["user"]["role"], "member");
    Member {
        cookie,
        csrf: session["csrf_token"].as_str().unwrap().into(),
    }
}
async fn entity(app: &Router, member: &Member, definition: &str) -> String {
    let lab = data(
        request(
            app,
            member,
            "POST",
            "/api/v1/lab/labs",
            json!({"name":"Trend lab"}),
        )
        .await,
    )
    .await;
    let lab = lab["id"].as_str().unwrap();
    let entity = data(request(app, member, "POST", &format!("/api/v1/lab/labs/{lab}/entities"), json!({"name":"Trend device","definition_id":definition,"definition_version":"1.0","reality":"simulated","configuration":{},"representation_id":null})).await).await;
    format!(
        "/api/v1/lab/labs/{lab}/entities/{}",
        entity["id"].as_str().unwrap()
    )
}
fn query(
    path: &str,
    property: &str,
    from: DateTime<Utc>,
    to: DateTime<Utc>,
    extra: &str,
) -> String {
    format!(
        "{path}/trend?property={property}&from={}&to={}&{extra}",
        from.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true),
        to.to_rfc3339_opts(chrono::SecondsFormat::Nanos, true)
    )
}

#[sqlx::test(migrations = "../../migrations")]
async fn member_gets_only_reported_property_samples_in_half_open_receive_time_order(pool: PgPool) {
    let (clock, runtime, app, member, path) = setup(pool.clone(), "centrifuge").await;
    let run = data(
        request(
            &app,
            &member,
            "POST",
            &format!("{path}/program/start"),
            json!({}),
        )
        .await,
    )
    .await;
    let from = clock.now();
    for (sequence, values) in [
        (1, json!({"temperature":0})),
        (2, json!({"speed":1234})),
        (3, json!({})),
        (4, json!({"temperature":22})),
    ] {
        runtime
            .observe(
                run["id"].as_str().unwrap(),
                ObservationReport {
                    sequence,
                    values,
                    observed_at: Some(clock.now() - chrono::Duration::seconds(2)),
                    quality: "good".into(),
                },
            )
            .await
            .unwrap();
        clock.advance(1);
    }
    let response = request(
        &app,
        &member,
        "GET",
        &query(
            &path,
            "temperature",
            from,
            clock.now() - chrono::Duration::seconds(1),
            "",
        ),
        Value::Null,
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let trend = data(response).await;
    assert_eq!(trend["raw_sample_count"], 1);
    assert_eq!(trend["returned_sample_count"], 1);
    let sample = &trend["segments"][0]["samples"][0];
    assert_eq!(sample["value"], 0);
    assert_eq!(sample["sequence"], 1);
    assert_eq!(sample["received_at"], json!(from));
    assert_eq!(
        sample["observed_at"],
        json!(from - chrono::Duration::seconds(2))
    );
    assert_eq!(trend["segments"][0]["run_id"], run["id"]);
    assert_eq!(trend["segments"][0]["binding_id"], run["binding_id"]);
    assert_eq!(trend["segments"][0]["source"], run["source"]);
    assert_eq!(trend["segments"][0]["quality"], "good");
    assert_eq!(trend["segments"][0]["unit"], "degC");
}
