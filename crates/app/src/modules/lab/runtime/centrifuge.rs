use super::{DeviceRuntime, ObservationReport, ObservationSink, RunSource, lock_entity};
use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sqlx::PgConnection;

fn initial_temperature(source: &RunSource) -> f64 {
    source
        .configuration
        .get("initial_temperature")
        .and_then(Value::as_f64)
        .unwrap_or(22.0)
}
fn within_tolerance(
    speed: f64,
    temperature: f64,
    target_speed: f64,
    target_temperature: f64,
) -> bool {
    (speed - target_speed).abs() <= 50.0 && (temperature - target_temperature).abs() <= 0.5
}

pub(super) async fn execute(
    connection: &mut PgConnection,
    source: &RunSource,
    command: &str,
    capability: &str,
    now: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    let task: Option<String> =
        sqlx::query_scalar("SELECT task_id::text FROM lab.device_commands WHERE id=$1::uuid")
            .bind(command)
            .fetch_one(&mut *connection)
            .await?;
    match capability {
        "centrifuge.start" => {
            let task = task
                .as_ref()
                .ok_or_else(|| sqlx::Error::Protocol("missing reserved task".into()))?;
            sqlx::query("UPDATE lab.device_tasks SET status='preparing',last_tick_at=$2 WHERE id=$1::uuid AND status='pending'").bind(task).bind(now).execute(&mut *connection).await?;
            let previous:Option<Value>=sqlx::query_scalar("SELECT values FROM lab.current_observations WHERE entity_id=$1::uuid AND run_id=$2::uuid").bind(&source.entity).bind(&source.run).fetch_optional(&mut *connection).await?;
            let temperature = previous
                .as_ref()
                .and_then(|values| values.get("temperature"))
                .and_then(Value::as_f64)
                .unwrap_or_else(|| initial_temperature(source));
            if !ObservationSink::apply(connection,source,&ObservationReport{sequence:source.sequence+1,values:json!({"speed":0.0,"temperature":temperature,"phase":"preparing","elapsed_seconds":0.0}),observed_at:Some(now),quality:"good".into()},now).await? {
                return Err(sqlx::Error::Protocol("device report would regress source time".into()));
            }
        }
        "centrifuge.stop" => {
            if let Some(task_id) = &task {
                let elapsed:Option<f64>=sqlx::query_scalar("UPDATE lab.device_tasks SET status='decelerating',pending_outcome=CASE WHEN pending_outcome IN ('failed','unknown') THEN pending_outcome ELSE 'cancelled' END,elapsed_seconds=CASE WHEN status='running' THEN LEAST((parameters->>'duration_seconds')::double precision,elapsed_seconds+GREATEST(0,EXTRACT(EPOCH FROM $2-last_tick_at))) ELSE elapsed_seconds END,last_tick_at=CASE WHEN status='decelerating' THEN last_tick_at ELSE $2 END WHERE id=$1::uuid AND status IN ('pending','preparing','running','decelerating') RETURNING elapsed_seconds").bind(task_id).bind(now).fetch_optional(&mut *connection).await?;
                let Some(elapsed) = elapsed else {
                    return complete_command(connection, command, &task, capability, now).await;
                };
                let applied = ObservationSink::apply(
                    connection,
                    source,
                    &ObservationReport {
                        sequence: source.sequence + 1,
                        values: json!({"phase":"decelerating","elapsed_seconds":elapsed}),
                        observed_at: Some(now),
                        quality: "good".into(),
                    },
                    now,
                )
                .await?;
                if !applied {
                    return Err(sqlx::Error::Protocol(
                        "device report would regress source time".into(),
                    ));
                }
            }
        }
        _ => {
            return Err(sqlx::Error::Protocol(
                "unsupported centrifuge capability".into(),
            ));
        }
    }
    complete_command(connection, command, &task, capability, now).await
}
async fn complete_command(
    connection: &mut PgConnection,
    command: &str,
    task: &Option<String>,
    capability: &str,
    now: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE lab.device_commands SET status='succeeded',result=$2,updated_at=$3 WHERE id=$1::uuid").bind(command).bind(json!({"meaning":if capability=="centrifuge.start" {"task_started"} else {"deceleration_requested"},"task_id":task})).bind(now).execute(connection).await?;
    Ok(())
}
pub(super) async fn execution_uncertain(
    runtime: &DeviceRuntime,
    command: &str,
    entity: &str,
    run: &str,
) -> Result<(), sqlx::Error> {
    let mut tx = runtime.pool.begin().await?;
    lock_entity(&mut tx, entity).await?;
    let Some(source) = RunSource::load(&mut tx, run, runtime.generation).await? else {
        return Ok(());
    };
    if source.program == "centrifuge.v1" {
        let task: Option<String> =
            sqlx::query_scalar("SELECT task_id::text FROM lab.device_commands WHERE id=$1::uuid")
                .bind(command)
                .fetch_one(&mut *tx)
                .await?;
        if let Some(task) = task {
            sqlx::query("UPDATE lab.device_task_results SET reason='execution_uncertain' WHERE task_id=$1::uuid AND status='pending'").bind(&task).execute(&mut *tx).await?;
            sqlx::query("UPDATE lab.device_tasks SET status='decelerating',pending_outcome='unknown',last_tick_at=CASE WHEN status='decelerating' THEN last_tick_at ELSE $2 END WHERE id=$1::uuid AND status IN ('pending','preparing','running','decelerating')").bind(task).bind(runtime.clock.now()).execute(&mut *tx).await?;
        }
    }
    tx.commit().await
}

#[derive(sqlx::FromRow)]
struct ActiveTask {
    id: String,
    result_id: String,
    parameters: Value,
    status: String,
    elapsed_seconds: f64,
    last_tick_at: Option<DateTime<Utc>>,
    pending_outcome: Option<String>,
}
pub(super) async fn fail(
    connection: &mut PgConnection,
    source: &RunSource,
    outcome: &str,
    now: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    sqlx::query("UPDATE lab.device_task_results SET reason=$2 WHERE task_id IN (SELECT id FROM lab.device_tasks WHERE run_id=$1::uuid AND status IN ('pending','preparing','running','decelerating'))").bind(&source.run).bind(if outcome=="failed" {"device_fault"} else {"observation_uncertain"}).execute(&mut *connection).await?;
    sqlx::query("UPDATE lab.device_tasks SET status='decelerating',pending_outcome=$2,last_tick_at=CASE WHEN status='decelerating' THEN last_tick_at ELSE $3 END WHERE run_id=$1::uuid AND status IN ('pending','preparing','running','decelerating')").bind(&source.run).bind(outcome).bind(now).execute(connection).await?;
    Ok(())
}
fn approach(value: f64, target: f64, step: f64) -> f64 {
    if value < target {
        (value + step).min(target)
    } else {
        (value - step).max(target)
    }
}
pub(super) async fn sample_due(
    runtime: &DeviceRuntime,
    now: DateTime<Utc>,
) -> Result<usize, sqlx::Error> {
    let candidates:Vec<(String,String)>=sqlx::query_as("SELECT r.id::text,r.entity_id::text FROM lab.program_runs r JOIN lab.runtime_bindings b ON b.id=r.binding_id WHERE r.status='running' AND r.generation=$1 AND b.program_id='centrifuge.v1' AND (r.next_sample_at IS NULL OR r.next_sample_at<=$2) ORDER BY r.id").bind(runtime.generation).bind(now).fetch_all(&runtime.pool).await?;
    let mut sampled = 0;
    for (run, entity) in candidates {
        let mut tx = runtime.pool.begin().await?;
        lock_entity(&mut tx, &entity).await?;
        let Some(source) = RunSource::load(&mut tx, &run, runtime.generation)
            .await?
            .filter(|source| source.next_sample_at.is_none_or(|at| at <= now))
        else {
            continue;
        };
        let previous:Option<Value>=sqlx::query_scalar("SELECT values FROM lab.current_observations WHERE entity_id=$1::uuid AND run_id=$2::uuid").bind(&entity).bind(&run).fetch_optional(&mut *tx).await?;
        let mut speed = previous
            .as_ref()
            .and_then(|values| values.get("speed"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let mut temperature = previous
            .as_ref()
            .and_then(|values| values.get("temperature"))
            .and_then(Value::as_f64)
            .unwrap_or_else(|| initial_temperature(&source));
        let task:Option<ActiveTask>=sqlx::query_as("SELECT id::text,result_id::text,parameters,status,elapsed_seconds,last_tick_at,pending_outcome FROM lab.device_tasks WHERE run_id=$1::uuid AND status IN ('preparing','running','decelerating') FOR UPDATE").bind(&run).fetch_optional(&mut *tx).await?;
        let mut phase = "idle".to_owned();
        let mut elapsed = previous
            .as_ref()
            .and_then(|values| values.get("elapsed_seconds"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        if let Some(task) = task {
            let seconds = task
                .last_tick_at
                .map(|at| (now - at).num_milliseconds().max(0) as f64 / 1000.0)
                .unwrap_or(0.0);
            let target_speed = task.parameters["rpm"].as_f64().unwrap();
            let target_temperature = task.parameters["temperature"].as_f64().unwrap();
            let duration = task.parameters["duration_seconds"].as_f64().unwrap();
            elapsed = task.elapsed_seconds;
            phase = task.status.clone();
            let mut outcome = task.pending_outcome;
            temperature = approach(temperature, target_temperature, 2.0 * seconds);
            match task.status.as_str() {
                "preparing" => {
                    speed = approach(speed, target_speed, 3000.0 * seconds);
                    if within_tolerance(speed, temperature, target_speed, target_temperature) {
                        phase = "running".into();
                        sqlx::query(
                            "UPDATE lab.device_tasks SET timer_started_at=$2 WHERE id=$1::uuid",
                        )
                        .bind(&task.id)
                        .bind(now)
                        .execute(&mut *tx)
                        .await?;
                    }
                }
                "running" => {
                    if within_tolerance(speed, temperature, target_speed, target_temperature) {
                        elapsed = (elapsed + seconds).min(duration);
                    }
                    speed = approach(speed, target_speed, 3000.0 * seconds);
                    if elapsed >= duration {
                        phase = "decelerating".into();
                        outcome = Some("completed".into());
                    }
                }
                "decelerating" => {
                    speed = approach(speed, 0.0, 3000.0 * seconds);
                }
                _ => unreachable!(),
            }
            let terminal = phase == "decelerating" && speed == 0.0;
            let status = if terminal {
                outcome.as_deref().unwrap_or("unknown")
            } else {
                phase.as_str()
            };
            sqlx::query("UPDATE lab.device_tasks SET status=$2,elapsed_seconds=$3,last_tick_at=$4,pending_outcome=$5,ended_at=CASE WHEN $6 THEN $4 ELSE ended_at END WHERE id=$1::uuid").bind(&task.id).bind(status).bind(elapsed).bind(now).bind(&outcome).bind(terminal).execute(&mut *tx).await?;
            if terminal {
                sqlx::query("UPDATE lab.device_task_results SET status=$2,reason=COALESCE(reason,$3),ended_at=$4 WHERE id=$1::uuid").bind(&task.result_id).bind(status).bind(if status=="unknown" {Some("execution_uncertain")} else {None}).bind(now).execute(&mut *tx).await?;
                phase = "idle".into();
            }
        }
        if !ObservationSink::apply(&mut tx,&source,&ObservationReport{sequence:source.sequence+1,values:json!({"speed":speed,"temperature":temperature,"phase":phase,"elapsed_seconds":elapsed}),observed_at:Some(now),quality:"good".into()},now).await? {continue;}
        sqlx::query("UPDATE lab.program_runs SET next_sample_at=$2 WHERE id=$1::uuid")
            .bind(&run)
            .bind(now + chrono::Duration::seconds(1))
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        sampled += 1;
    }
    Ok(sampled)
}
