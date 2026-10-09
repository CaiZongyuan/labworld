use crate::{config::ConfigError, redis_transport::Endpoint};
use std::time::Duration;
use tokio::time::Instant;

#[derive(Clone)]
pub struct CounterSettings {
    pub url: String,
    pub prefix: String,
    pub budget: Duration,
}
impl Default for CounterSettings {
    fn default() -> Self {
        Self {
            url: "redis://127.0.0.1:6379/".into(),
            prefix: "labos_threejs".into(),
            budget: Duration::from_millis(50),
        }
    }
}
#[derive(Debug)]
pub struct CounterUnavailable;
#[derive(Clone)]
pub struct WindowCounter {
    endpoint: Endpoint,
    prefix: String,
    budget: Duration,
}
const CONSUME: &str = r#"
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if not current or current < 0 or current % 1 ~= 0 then return redis.error_reply('invalid counter') end
if current >= tonumber(ARGV[1]) then return 0 end
redis.call('SET', KEYS[1], current + 1, 'PX', ARGV[2])
return 1
"#;
impl WindowCounter {
    pub fn new(settings: CounterSettings) -> Result<Self, ConfigError> {
        if settings.prefix.is_empty()
            || settings.prefix.len() > 100
            || !settings
                .prefix
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || b":-_".contains(&c))
        {
            return Err(ConfigError("RATE_LIMIT_PREFIX"));
        }
        if settings.budget < Duration::from_millis(1) || settings.budget > Duration::from_secs(1) {
            return Err(ConfigError("RATE_LIMIT_BUDGET_MS"));
        }
        Ok(Self {
            endpoint: Endpoint::new(&settings.url, settings.budget)?,
            prefix: settings.prefix,
            budget: settings.budget,
        })
    }
    /// One atomic window operation, one bounded transport attempt, no implicit retry.
    pub async fn allow(
        &self,
        policy: &str,
        client: &[u8; 32],
        window: u64,
        remaining_ms: u64,
        limit: u32,
    ) -> Result<bool, CounterUnavailable> {
        let key = format!(
            "{}:rate:{policy}:{window}:{}",
            self.prefix,
            hex::encode(client)
        );
        let result: i64 = self
            .endpoint
            .query(
                redis::cmd("EVAL")
                    .arg(CONSUME)
                    .arg(1)
                    .arg(key)
                    .arg(limit)
                    .arg(remaining_ms.max(1)),
                Instant::now() + self.budget,
            )
            .await
            .map_err(|_| CounterUnavailable)?;
        Ok(result == 1)
    }
}
