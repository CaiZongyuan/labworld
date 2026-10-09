use chrono::{DateTime, Utc};
use labos_threejs_platform::config::{ConfigError, Setting, bounded_u32};
use serde::{Deserialize, Serialize};
use sqlx::{PgConnection, PgPool};
use utoipa::ToSchema;

pub const RETENTION_FIELDS: &[Setting] = &[
    Setting {
        name: "LAB_OBSERVATION_RETENTION_SECS",
        default: Some("86400"),
        secret: false,
        description: "Raw observation retention in seconds (1..31536000). Current properties remain unchanged.",
        description_zh: "原始观测保留秒数（1..31536000）。当前逐属性观测保持不变。",
    },
    Setting {
        name: "LAB_RECORD_RETENTION_SECS",
        default: Some("2592000"),
        secret: false,
        description: "Ended command/task and device event retention in seconds (1..31536000). Active tasks remain.",
        description_zh: "结束命令、任务和设备事件保留秒数（1..31536000）。保留在途任务。",
    },
];
#[derive(Clone, Copy, Serialize, Deserialize, ToSchema)]
pub struct RetentionPolicy {
    pub observation_seconds: u32,
    pub record_seconds: u32,
}
impl Default for RetentionPolicy {
    fn default() -> Self {
        Self {
            observation_seconds: 86400,
            record_seconds: 2592000,
        }
    }
}
impl RetentionPolicy {
    pub fn from_env() -> Result<Self, ConfigError> {
        Self::new(
            bounded_u32(&RETENTION_FIELDS[0], 1, 31536000)?,
            bounded_u32(&RETENTION_FIELDS[1], 1, 31536000)?,
        )
    }
    pub fn new(observation_seconds: u32, record_seconds: u32) -> Result<Self, ConfigError> {
        for (value, setting) in [
            (observation_seconds, &RETENTION_FIELDS[0]),
            (record_seconds, &RETENTION_FIELDS[1]),
        ] {
            if !(1..=31536000).contains(&value) {
                return Err(ConfigError(setting.name));
            }
        }
        Ok(Self {
            observation_seconds,
            record_seconds,
        })
    }
    pub(super) fn cutoff(
        self,
        kind: &super::HistoryRecordType,
        now: DateTime<Utc>,
    ) -> DateTime<Utc> {
        now - chrono::Duration::seconds(i64::from(
            if *kind == super::HistoryRecordType::Observation {
                self.observation_seconds
            } else {
                self.record_seconds
            },
        ))
    }
}
#[derive(Serialize, ToSchema)]
pub struct HistoryCleanup {
    pub observations: u64,
    pub commands: u64,
    pub tasks: u64,
    pub events: u64,
    pub more: bool,
    pub observation_cutoff: DateTime<Utc>,
    pub record_cutoff: DateTime<Utc>,
}
/// Production maintenance entry point. Each call removes at most 10,000 rows per record type.
pub struct HistoryMaintenance {
    pool: PgPool,
    policy: RetentionPolicy,
}
impl HistoryMaintenance {
    pub fn new(pool: PgPool, policy: RetentionPolicy) -> Self {
        Self { pool, policy }
    }
    pub async fn cleanup(
        &self,
        lab: &str,
        now: DateTime<Utc>,
    ) -> Result<HistoryCleanup, sqlx::Error> {
        uuid::Uuid::parse_str(lab)
            .map_err(|_| sqlx::Error::Protocol("invalid Lab identity".into()))?;
        let mut tx = self.pool.begin().await?;
        super::super::sync::lock_world(&mut tx).await?;
        let result = cleanup_in(&mut tx, lab, self.policy, now).await?;
        tx.commit().await?;
        Ok(result)
    }
}
pub(super) async fn cleanup_in(
    connection: &mut PgConnection,
    lab: &str,
    policy: RetentionPolicy,
    now: DateTime<Utc>,
) -> Result<HistoryCleanup, sqlx::Error> {
    sqlx::query("SELECT id FROM lab.labs WHERE id=$1::uuid FOR UPDATE")
        .bind(lab)
        .fetch_one(&mut *connection)
        .await?;
    let observation_cutoff = policy.cutoff(&super::HistoryRecordType::Observation, now);
    let record_cutoff = policy.cutoff(&super::HistoryRecordType::Task, now);
    let observations=delete_batch(connection,"lab.observation_history","SELECT h.id FROM lab.observation_history h JOIN lab.entities e ON e.id=h.entity_id WHERE e.lab_id=$1::uuid AND h.received_at<$2 ORDER BY h.received_at,h.id LIMIT 10000",lab,observation_cutoff).await?;
    let tasks=delete_batch(connection,"lab.device_tasks","SELECT t.id FROM lab.device_tasks t JOIN lab.entities e ON e.id=t.entity_id WHERE e.lab_id=$1::uuid AND t.ended_at<$2 ORDER BY t.ended_at,t.id LIMIT 10000",lab,record_cutoff).await?;
    let commands=delete_batch(connection,"lab.device_commands","SELECT c.id FROM lab.device_commands c JOIN lab.entities e ON e.id=c.entity_id WHERE e.lab_id=$1::uuid AND c.status IN ('succeeded','failed','unknown') AND c.updated_at<$2 AND NOT EXISTS(SELECT 1 FROM lab.device_tasks t WHERE t.command_id=c.id AND t.ended_at IS NULL) ORDER BY c.updated_at,c.id LIMIT 10000",lab,record_cutoff).await?;
    let events=delete_batch(connection,"lab.device_events","SELECT h.id FROM lab.device_events h JOIN lab.entities e ON e.id=h.entity_id WHERE e.lab_id=$1::uuid AND h.received_at<$2 ORDER BY h.received_at,h.id LIMIT 10000",lab,record_cutoff).await?;
    sqlx::query("UPDATE lab.history_bounds h SET cleaned_before=GREATEST(COALESCE(cleaned_before,'-infinity'::timestamptz),CASE WHEN record_type='observation' THEN $2 ELSE $3 END) FROM lab.entities e WHERE e.id=h.entity_id AND e.lab_id=$1::uuid").bind(lab).bind(observation_cutoff).bind(record_cutoff).execute(connection).await?;
    Ok(HistoryCleanup {
        observations,
        commands,
        tasks,
        events,
        more: [observations, commands, tasks, events].contains(&10000),
        observation_cutoff,
        record_cutoff,
    })
}
async fn delete_batch(
    connection: &mut PgConnection,
    table: &str,
    selection: &str,
    lab: &str,
    cutoff: DateTime<Utc>,
) -> Result<u64, sqlx::Error> {
    let ids: Vec<String> =
        sqlx::query_scalar(&format!("SELECT id::text FROM ({selection}) expired"))
            .bind(lab)
            .bind(cutoff)
            .fetch_all(&mut *connection)
            .await?;
    // Avoid statement-level version triggers when there are no expired records.
    if ids.is_empty() {
        return Ok(0);
    }
    if table == "lab.device_commands" {
        super::super::devices::remember_expired_commands(connection, &ids).await?;
    }
    Ok(sqlx::query(&format!(
        "DELETE FROM {table} WHERE id=ANY($1::text[]::uuid[])"
    ))
    .bind(ids)
    .execute(connection)
    .await?
    .rows_affected())
}
pub async fn run_history_maintenance(pool: PgPool, policy: RetentionPolicy) {
    let maintenance = HistoryMaintenance::new(pool.clone(), policy);
    let mut interval = tokio::time::interval(std::time::Duration::from_secs(60));
    loop {
        interval.tick().await;
        let labs: Result<Vec<String>, _> =
            sqlx::query_scalar("SELECT id::text FROM lab.labs ORDER BY id")
                .fetch_all(&pool)
                .await;
        match labs {
            Ok(labs) => {
                for lab in labs {
                    if let Err(error) = maintenance.cleanup(&lab, Utc::now()).await {
                        tracing::warn!(%error,"Lab history cleanup failed");
                    }
                }
            }
            Err(error) => tracing::warn!(%error,"Lab history cleanup unavailable"),
        }
    }
}
