use super::devices::ObservationProperty;
use chrono::{DateTime, Utc};
use serde_json::{Map, Value, json};
use sqlx::{PgConnection, PgPool};
use std::collections::BTreeMap;
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
        if let Some(runtime) = &runtime
            && let Err(error) = runtime.sample_due().await
        {
            tracing::warn!(%error,"device sampling failed");
        }
        if let Some(runtime) = &runtime
            && let Err(error) = runtime.expire_due().await
        {
            tracing::warn!(%error,"observation expiry failed");
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
    clock: Arc<dyn ObservationClock>,
}
/// Source timestamps and host reception time have independent meanings.
pub trait ObservationClock: Send + Sync {
    fn now(&self) -> DateTime<Utc>;
}
struct SystemClock;
impl ObservationClock for SystemClock {
    fn now(&self) -> DateTime<Utc> {
        Utc::now()
    }
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
#[derive(sqlx::FromRow)]
struct RunSource {
    entity: String,
    run: String,
    binding: String,
    source: String,
    program: String,
    sequence: i64,
    configuration: Value,
    next_sample_at: Option<DateTime<Utc>>,
}
impl RunSource {
    async fn load(
        connection: &mut PgConnection,
        run: &str,
        generation: i64,
    ) -> Result<Option<Self>, sqlx::Error> {
        sqlx::query_as("SELECT r.entity_id::text AS entity,r.id::text AS run,b.id::text AS binding,b.source,b.program_id AS program,r.sequence,r.configuration,r.next_sample_at FROM lab.program_runs r JOIN lab.runtime_bindings b ON b.id=r.binding_id AND b.entity_id=r.entity_id WHERE r.id=$1::uuid AND r.status='running' AND r.generation=$2 FOR UPDATE OF r").bind(run).bind(generation).fetch_optional(connection).await
    }
}
#[derive(Default, sqlx::FromRow)]
struct PropertyState {
    #[sqlx(json)]
    values: Map<String, Value>,
    #[sqlx(json)]
    properties: BTreeMap<String, ObservationProperty>,
    #[sqlx(json)]
    observed_times: BTreeMap<String, DateTime<Utc>>,
}
/// Trusted device-program ingress; it is deliberately absent from Member/Agent HTTP routes.
pub struct ObservationSink<'runtime> {
    runtime: &'runtime DeviceRuntime,
}
impl ObservationSink<'_> {
    /// Reports must name the current Binding and active Run in this host generation.
    pub async fn report(
        &self,
        binding: &str,
        run: &str,
        report: ObservationReport,
    ) -> Result<ObservationAcceptance, sqlx::Error> {
        let entity: Option<String> =
            sqlx::query_scalar("SELECT entity_id::text FROM lab.program_runs WHERE id=$1::uuid")
                .bind(run)
                .fetch_optional(&self.runtime.pool)
                .await?;
        let Some(entity) = entity else {
            return Ok(ObservationAcceptance::StaleRun);
        };
        let mut tx = self.runtime.pool.begin().await?;
        lock_entity(&mut tx, &entity).await?;
        let source = RunSource::load(&mut tx, run, self.runtime.generation)
            .await?
            .filter(|source| source.binding == binding);
        let Some(source) = source else {
            return Ok(ObservationAcceptance::StaleRun);
        };
        if report.sequence <= source.sequence {
            return Ok(ObservationAcceptance::OutOfOrder);
        };
        if !Self::apply(&mut tx, &source, &report, self.runtime.clock.now()).await? {
            return Ok(ObservationAcceptance::OutOfOrder);
        };
        tx.commit().await?;
        Ok(ObservationAcceptance::Applied)
    }
}
impl DeviceRuntime {
    pub fn observation_sink(&self) -> ObservationSink<'_> {
        ObservationSink { runtime: self }
    }
    /// Compatibility ingress for an internally owned Run; explicit sources use ObservationSink.
    pub async fn observe(
        &self,
        run: &str,
        report: ObservationReport,
    ) -> Result<ObservationAcceptance, sqlx::Error> {
        let binding: Option<String> =
            sqlx::query_scalar("SELECT binding_id::text FROM lab.program_runs WHERE id=$1::uuid")
                .bind(run)
                .fetch_optional(&self.pool)
                .await?;
        match binding {
            Some(binding) => self.observation_sink().report(&binding, run, report).await,
            None => Ok(ObservationAcceptance::StaleRun),
        }
    }
    pub async fn initialize(pool: PgPool) -> Result<Self, sqlx::Error> {
        Self::initialize_with_availability(pool, RuntimeAvailability::default()).await
    }
    pub async fn initialize_with_availability(
        pool: PgPool,
        availability: RuntimeAvailability,
    ) -> Result<Self, sqlx::Error> {
        Self::initialize_with_options(pool, availability, Arc::new(SystemClock)).await
    }
    pub async fn initialize_with_clock(
        pool: PgPool,
        clock: Arc<dyn ObservationClock>,
    ) -> Result<Self, sqlx::Error> {
        Self::initialize_with_options(pool, RuntimeAvailability::default(), clock).await
    }
    async fn initialize_with_options(
        pool: PgPool,
        availability: RuntimeAvailability,
        clock: Arc<dyn ObservationClock>,
    ) -> Result<Self, sqlx::Error> {
        let mut tx = pool.begin().await?;
        super::sync::lock_world(&mut tx).await?;
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
            clock,
        })
    }

    /// Sample each due backend sensor once; missed intervals are not replayed.
    pub async fn sample_due(&self) -> Result<usize, sqlx::Error> {
        let now = self.clock.now();
        let candidates: Vec<(String,String)>=sqlx::query_as("SELECT r.id::text,r.entity_id::text FROM lab.program_runs r JOIN lab.runtime_bindings b ON b.id=r.binding_id WHERE r.status='running' AND r.generation=$1 AND b.program_id='sensor.v1' AND (r.next_sample_at IS NULL OR r.next_sample_at<=$2) ORDER BY r.id").bind(self.generation).bind(now).fetch_all(&self.pool).await?;
        let mut sampled = 0;
        for (run, entity) in candidates {
            let mut tx = self.pool.begin().await?;
            lock_entity(&mut tx, &entity).await?;
            let source = RunSource::load(&mut tx, &run, self.generation)
                .await?
                .filter(|source| {
                    source.program == "sensor.v1"
                        && source.next_sample_at.is_none_or(|time| time <= now)
                });
            let Some(source) = source else { continue };
            let baseline = source
                .configuration
                .get("baseline_temperature")
                .and_then(Value::as_f64)
                .unwrap_or(22.0);
            let temperature = (baseline + ((source.sequence + 1) as f64 * 0.2).sin() * 0.5) * 10.0;
            let applied = ObservationSink::apply(
                &mut tx,
                &source,
                &ObservationReport {
                    sequence: source.sequence + 1,
                    values: json!({"temperature":temperature.round()/10.0}),
                    observed_at: Some(now),
                    quality: "good".into(),
                },
                now,
            )
            .await?;
            if !applied {
                continue;
            }
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

    /// Persist each expired property once, so versioned snapshots never derive facts from wall time.
    pub async fn expire_due(&self) -> Result<usize, sqlx::Error> {
        let now = self.clock.now();
        let candidates: Vec<String>=sqlx::query_scalar("SELECT entity_id::text FROM lab.current_observations o WHERE EXISTS(SELECT 1 FROM jsonb_each(o.properties) p WHERE p.value->>'freshness'<>'stale' AND (p.value->>'expires_at')::timestamptz<=$1) ORDER BY entity_id").bind(now).fetch_all(&self.pool).await?;
        let mut expired = 0;
        for entity in candidates {
            let mut tx = self.pool.begin().await?;
            lock_entity(&mut tx, &entity).await?;
            let generation: i64 =
                sqlx::query_scalar("SELECT generation FROM lab.runtime_generation WHERE singleton")
                    .fetch_one(&mut *tx)
                    .await?;
            if generation != self.generation {
                continue;
            }
            let mut properties: sqlx::types::Json<BTreeMap<String, ObservationProperty>> =
                sqlx::query_scalar(
                    "SELECT properties FROM lab.current_observations WHERE entity_id=$1::uuid",
                )
                .bind(&entity)
                .fetch_one(&mut *tx)
                .await?;
            let mut changed = false;
            for property in properties.values_mut() {
                if property.freshness != "stale" && property.expires_at <= now {
                    property.freshness = "stale".into();
                    changed = true;
                }
            }
            if !changed {
                continue;
            }
            sqlx::query("UPDATE lab.current_observations SET properties=$2,freshness='stale' WHERE entity_id=$1::uuid").bind(&entity).bind(properties).execute(&mut *tx).await?;
            tx.commit().await?;
            expired += 1;
        }
        Ok(expired)
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
        let source = RunSource::load(&mut tx, run, self.generation).await?;
        let Some(source) = source else {
            return Ok(());
        };
        let configuration = &source.configuration;
        let sequence = source.sequence;
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
        let now = self.clock.now();
        let applied = ObservationSink::apply(
            &mut tx,
            &source,
            &ObservationReport {
                sequence: sequence + 1,
                values: values.clone(),
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
impl ObservationSink<'_> {
    async fn apply(
        connection: &mut PgConnection,
        source: &RunSource,
        report: &ObservationReport,
        now: DateTime<Utc>,
    ) -> Result<bool, sqlx::Error> {
        if report.sequence < 1
            || !matches!(report.quality.as_str(), "good" | "uncertain" | "bad")
            || !report.values.as_object().is_some_and(|values| {
                values.iter().all(
                    |(name, value)| match (source.program.as_str(), name.as_str()) {
                        ("sensor.v1", "temperature") => value.as_f64().is_some(),
                        ("light.v1", "on") => value.is_boolean(),
                        ("light.v1", "brightness") => value
                            .as_f64()
                            .is_some_and(|value| (0.0..=100.0).contains(&value)),
                        _ => false,
                    },
                )
            })
        {
            return Err(sqlx::Error::Protocol("invalid device observation".into()));
        }
        if report.values.as_object().unwrap().is_empty() {
            sqlx::query("UPDATE lab.program_runs SET sequence=$2 WHERE id=$1::uuid")
                .bind(&source.run)
                .bind(report.sequence)
                .execute(connection)
                .await?;
            return Ok(true);
        }
        let mut state=sqlx::query_as::<_,PropertyState>("SELECT values,properties,observed_times FROM lab.current_observations WHERE entity_id=$1::uuid").bind(&source.entity).fetch_optional(&mut *connection).await?.unwrap_or_default();
        for name in report.values.as_object().unwrap().keys() {
            if state
                .properties
                .get(name)
                .is_some_and(|property| property.run_id == source.run)
                && state
                    .observed_times
                    .get(name)
                    .zip(report.observed_at)
                    .is_some_and(|(previous, current)| current < *previous)
            {
                return Ok(false);
            }
        }
        sqlx::query("UPDATE lab.program_runs SET sequence=$2 WHERE id=$1::uuid")
            .bind(&source.run)
            .bind(report.sequence)
            .execute(&mut *connection)
            .await?;
        let property_freshness = if report.observed_at.is_some() {
            "current"
        } else {
            "source_time_unknown"
        };
        for (name, value) in report.values.as_object().unwrap() {
            if state
                .properties
                .get(name)
                .is_none_or(|property| property.run_id != source.run)
            {
                state.observed_times.remove(name);
            }
            if let Some(time) = report.observed_at {
                state.observed_times.insert(name.clone(), time);
            }
            state.values.insert(name.clone(), value.clone());
            state.properties.insert(
                name.clone(),
                ObservationProperty {
                    value: value.clone(),
                    unit: match name.as_str() {
                        "temperature" => Some("degC".into()),
                        "brightness" => Some("%".into()),
                        _ => None,
                    },
                    binding_id: source.binding.clone(),
                    run_id: source.run.clone(),
                    source: source.source.clone(),
                    sequence: report.sequence,
                    observed_at: report.observed_at,
                    received_at: now,
                    updated_at: now,
                    expires_at: now + chrono::Duration::seconds(5),
                    quality: report.quality.clone(),
                    freshness: property_freshness.into(),
                },
            );
        }
        let freshness = if state
            .properties
            .values()
            .any(|property| property.freshness == "stale")
        {
            "stale"
        } else if state
            .properties
            .values()
            .any(|property| property.freshness == "source_time_unknown")
        {
            "source_time_unknown"
        } else {
            "current"
        };
        sqlx::query("INSERT INTO lab.current_observations(entity_id,run_id,sequence,source,values,observed_at,quality,received_at,updated_at,properties,observed_times,freshness) VALUES($1::uuid,$2::uuid,$3,$4,$5,$6,$7,$8,$8,$9,$10,$11) ON CONFLICT(entity_id) DO UPDATE SET run_id=excluded.run_id,sequence=excluded.sequence,source=excluded.source,values=excluded.values,observed_at=excluded.observed_at,received_at=excluded.received_at,updated_at=excluded.updated_at,quality=excluded.quality,properties=excluded.properties,observed_times=excluded.observed_times,freshness=excluded.freshness")
        .bind(&source.entity).bind(&source.run).bind(report.sequence).bind(&source.source).bind(json!(state.values)).bind(report.observed_at).bind(&report.quality).bind(now).bind(json!(state.properties)).bind(json!(state.observed_times)).bind(freshness).execute(connection).await?;
        Ok(true)
    }
}
async fn lock_entity(connection: &mut PgConnection, entity: &str) -> Result<(), sqlx::Error> {
    super::sync::lock_world(connection).await?;
    sqlx::query("SELECT id FROM lab.entities WHERE id=$1::uuid FOR UPDATE")
        .bind(entity)
        .fetch_one(connection)
        .await?;
    Ok(())
}
