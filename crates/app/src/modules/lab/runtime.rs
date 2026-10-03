use chrono::{DateTime, Utc};
use serde_json::{Value, json};
use sqlx::{PgConnection, PgPool};
use std::sync::{
    Arc,
    atomic::{AtomicI64, Ordering},
};
use std::time::Duration;

pub async fn run_device_programs(pool: PgPool, availability: RuntimeAvailability) {
    let mut runtime = None;
    let mut interval = tokio::time::interval(Duration::from_millis(100));
    loop {
        interval.tick().await;
        if runtime.is_none() {
            match DeviceRuntime::initialize_with_availability(pool.clone(), availability.clone())
                .await
            {
                Ok(initialized) => runtime = Some(initialized),
                Err(error) => {
                    tracing::warn!(%error,"device runtime initialization unavailable");
                    tokio::time::sleep(Duration::from_secs(1)).await;
                    continue;
                }
            }
        }
        if let Some(runtime) = &runtime
            && let Err(error) = runtime.process_next().await
        {
            tracing::warn!(%error,"device command execution failed");
        }
    }
}

#[derive(Clone, Default)]
pub struct RuntimeAvailability(Arc<AtomicI64>);
impl RuntimeAvailability {
    pub(super) fn is_ready(&self) -> bool {
        self.0.load(Ordering::Acquire) > 0
    }
}

/// One API process owns a generation. Reinitialization fences the previous process.
pub struct DeviceRuntime {
    pool: PgPool,
    generation: i64,
    availability: RuntimeAvailability,
}
pub struct ObservationReport {
    pub sequence: i64,
    pub values: Value,
    pub observed_at: Option<DateTime<Utc>>,
    pub quality: String,
}
#[derive(Debug, PartialEq, Eq)]
pub enum ObservationAcceptance {
    Applied,
    StaleRun,
    OutOfOrder,
}
impl DeviceRuntime {
    /// Reports are accepted only from an active run in this host generation.
    pub async fn observe(
        &self,
        run: &str,
        report: ObservationReport,
    ) -> Result<ObservationAcceptance, sqlx::Error> {
        let entity: Option<String> =
            sqlx::query_scalar("SELECT entity_id::text FROM lab.program_runs WHERE id=$1::uuid")
                .bind(run)
                .fetch_optional(&self.pool)
                .await?;
        let Some(entity) = entity else {
            return Ok(ObservationAcceptance::StaleRun);
        };
        let mut tx = self.pool.begin().await?;
        lock_entity(&mut tx, &entity).await?;
        let source: Option<(String,i64,Option<DateTime<Utc>>)>=sqlx::query_as("SELECT b.source,r.sequence,r.last_observed_at FROM lab.program_runs r JOIN lab.runtime_bindings b ON b.id=r.binding_id WHERE r.id=$1::uuid AND r.status='running' AND r.generation=$2 FOR UPDATE OF r").bind(run).bind(self.generation).fetch_optional(&mut *tx).await?;
        let Some((source, sequence, previous)) = source else {
            return Ok(ObservationAcceptance::StaleRun);
        };
        if report.sequence <= sequence {
            return Ok(ObservationAcceptance::OutOfOrder);
        };
        if previous
            .zip(report.observed_at)
            .is_some_and(|(previous, current)| current < previous)
        {
            return Ok(ObservationAcceptance::OutOfOrder);
        };
        write_observation(&mut tx, &entity, run, &source, &report).await?;
        tx.commit().await?;
        Ok(ObservationAcceptance::Applied)
    }
    pub async fn initialize(pool: PgPool) -> Result<Self, sqlx::Error> {
        Self::initialize_with_availability(pool, RuntimeAvailability::default()).await
    }
    pub async fn initialize_with_availability(
        pool: PgPool,
        availability: RuntimeAvailability,
    ) -> Result<Self, sqlx::Error> {
        let mut tx = pool.begin().await?;
        let generation: i64 = sqlx::query_scalar("UPDATE lab.runtime_generation SET generation=generation+1 WHERE singleton RETURNING generation").fetch_one(&mut *tx).await?;
        sqlx::query("SELECT id FROM lab.entities WHERE EXISTS(SELECT 1 FROM lab.program_runs r WHERE r.entity_id=entities.id AND r.status='running') ORDER BY id FOR UPDATE").fetch_all(&mut *tx).await?;
        sqlx::query("UPDATE lab.program_runs SET status='interrupted',ended_at=now() WHERE status='running'").execute(&mut *tx).await?;
        sqlx::query("UPDATE lab.device_commands SET status='unknown',result=jsonb_build_object('reason','runtime_interrupted'),updated_at=now() WHERE status IN ('accepted','executing')").execute(&mut *tx).await?;
        tx.commit().await?;
        availability.0.store(generation, Ordering::Release);
        Ok(Self {
            pool,
            generation,
            availability,
        })
    }

    /// Process at most one command. Used by the host loop independently of HTTP clients.
    pub async fn process_next(&self) -> Result<bool, sqlx::Error> {
        let candidate: Option<(String,String,String)> = sqlx::query_as("SELECT c.id::text,c.entity_id::text,c.run_id::text FROM lab.device_commands c JOIN lab.program_runs r ON r.id=c.run_id WHERE c.status='accepted' AND r.status='running' AND r.generation=$1 ORDER BY c.created_at,c.id LIMIT 1").bind(self.generation).fetch_optional(&self.pool).await?;
        let Some((command, entity, run)) = candidate else {
            return Ok(false);
        };
        let mut tx = self.pool.begin().await?;
        lock_entity(&mut tx, &entity).await?;
        let claimed = sqlx::query("UPDATE lab.device_commands SET status='executing',updated_at=now() WHERE id=$1::uuid AND status='accepted' AND EXISTS(SELECT 1 FROM lab.program_runs r WHERE r.id=$2::uuid AND r.status='running' AND r.generation=$3)").bind(&command).bind(&run).bind(self.generation).execute(&mut *tx).await?.rows_affected()==1;
        tx.commit().await?;
        if !claimed {
            return Ok(false);
        };
        // An execution is never reclaimed: failure after this point has an uncertain result.
        let result = self.execute(&command, &entity, &run).await;
        if result.is_err() {
            let _=sqlx::query("UPDATE lab.device_commands SET status='unknown',result=jsonb_build_object('reason','execution_uncertain'),updated_at=now() WHERE id=$1::uuid AND status='executing'").bind(&command).execute(&self.pool).await;
        }
        result.map(|()| true)
    }
    async fn execute(&self, command: &str, entity: &str, run: &str) -> Result<(), sqlx::Error> {
        let mut tx = self.pool.begin().await?;
        lock_entity(&mut tx, entity).await?;
        let info: Option<(Value,String,i64)> = sqlx::query_as("SELECT configuration,b.source,r.sequence FROM lab.program_runs r JOIN lab.runtime_bindings b ON b.id=r.binding_id WHERE r.id=$1::uuid AND r.status='running' AND r.generation=$2 FOR UPDATE OF r").bind(run).bind(self.generation).fetch_optional(&mut *tx).await?;
        let Some((configuration, source, sequence)) = info else {
            return Ok(());
        };
        let action: Option<(String,Value)>=sqlx::query_as("SELECT capability,parameters FROM lab.device_commands WHERE id=$1::uuid AND status='executing' FOR UPDATE").bind(command).fetch_optional(&mut *tx).await?;
        let Some((capability, parameters)) = action else {
            return Ok(());
        };
        let previous: Option<Value> = sqlx::query_scalar(
            "SELECT values FROM lab.current_observations WHERE entity_id=$1::uuid AND run_id=$2::uuid",
        )
        .bind(entity)
        .bind(run)
        .fetch_optional(&mut *tx)
        .await?;
        let mut values=previous.unwrap_or_else(|| json!({"on":configuration.get("on").cloned().unwrap_or(json!(false)),"brightness":configuration.get("brightness").cloned().unwrap_or(json!(100))}));
        match capability.as_str() {
            "light.set_power" => values["on"] = parameters["on"].clone(),
            "light.set_brightness" => values["brightness"] = parameters["brightness"].clone(),
            _ => {
                return Err(sqlx::Error::Protocol(
                    "unsupported device capability".into(),
                ));
            }
        }
        write_observation(
            &mut tx,
            entity,
            run,
            &source,
            &ObservationReport {
                sequence: sequence + 1,
                values: values.clone(),
                observed_at: Some(Utc::now()),
                quality: "good".into(),
            },
        )
        .await?;
        sqlx::query("UPDATE lab.device_commands SET status='succeeded',result=$2,updated_at=now() WHERE id=$1::uuid")
            .bind(command).bind(json!({"meaning":"applied_by_device_program","observation_sequence":sequence+1,"values":values})).execute(&mut *tx).await?;
        tx.commit().await
    }
}
impl Drop for DeviceRuntime {
    fn drop(&mut self) {
        let _ = self.availability.0.compare_exchange(
            self.generation,
            0,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
    }
}
async fn write_observation(
    connection: &mut PgConnection,
    entity: &str,
    run: &str,
    source: &str,
    report: &ObservationReport,
) -> Result<(), sqlx::Error> {
    if report.sequence < 1
        || !matches!(report.quality.as_str(), "good" | "uncertain" | "bad")
        || !report.values.as_object().is_some_and(|values| {
            values.len() == 2
                && values.get("on").is_some_and(Value::is_boolean)
                && values
                    .get("brightness")
                    .and_then(Value::as_f64)
                    .is_some_and(|value| (0.0..=100.0).contains(&value))
        })
    {
        return Err(sqlx::Error::Protocol("invalid light observation".into()));
    }
    sqlx::query("UPDATE lab.program_runs SET sequence=$2,last_observed_at=COALESCE($3,last_observed_at) WHERE id=$1::uuid")
        .bind(run)
        .bind(report.sequence)
        .bind(report.observed_at)
        .execute(&mut *connection)
        .await?;
    sqlx::query("INSERT INTO lab.current_observations(entity_id,run_id,sequence,source,values,observed_at,quality) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7) ON CONFLICT(entity_id) DO UPDATE SET run_id=excluded.run_id,sequence=excluded.sequence,source=excluded.source,values=excluded.values,observed_at=excluded.observed_at,received_at=now(),updated_at=now(),quality=excluded.quality")
        .bind(entity).bind(run).bind(report.sequence).bind(source).bind(&report.values).bind(report.observed_at).bind(&report.quality).execute(connection).await?;
    Ok(())
}
async fn lock_entity(connection: &mut PgConnection, entity: &str) -> Result<(), sqlx::Error> {
    sqlx::query("SELECT id FROM lab.entities WHERE id=$1::uuid FOR UPDATE")
        .bind(entity)
        .fetch_one(connection)
        .await?;
    Ok(())
}
