//! Private transport shared by bounded Redis capabilities, never a business command gateway.
use crate::config::ConfigError;
use std::{sync::Arc, time::Duration};
use tokio::{sync::Semaphore, time::Instant};

#[derive(Debug)]
pub(crate) struct Unavailable;
struct Inner {
    client: redis::Client,
    budget: Duration,
    slots: Semaphore,
}
#[derive(Clone)]
pub(crate) struct Endpoint(Arc<Inner>);
impl Endpoint {
    pub(crate) fn new(address: &str, budget: Duration) -> Result<Self, ConfigError> {
        let url = url::Url::parse(address).map_err(|_| ConfigError("REDIS_URL"))?;
        if url.scheme() != "redis" || url.host_str().is_none() || url.fragment().is_some() {
            return Err(ConfigError("REDIS_URL"));
        }
        let client = redis::Client::open(address).map_err(|_| ConfigError("REDIS_URL"))?;
        Ok(Self(Arc::new(Inner {
            client,
            budget,
            slots: Semaphore::new(16),
        })))
    }
    pub(crate) async fn query<T: redis::FromRedisValue>(
        &self,
        command: &redis::Cmd,
        deadline: Instant,
    ) -> Result<T, Unavailable> {
        let _permit = self.0.slots.try_acquire().map_err(|_| Unavailable)?;
        if Instant::now() >= deadline {
            return Err(Unavailable);
        }
        tokio::time::timeout_at(deadline, async {
            let config = redis::AsyncConnectionConfig::new()
                .set_connection_timeout(Some(self.0.budget))
                .set_response_timeout(Some(self.0.budget))
                .set_concurrency_limit(1)
                .set_pipeline_buffer_size(1);
            // This future owns the only connection handle. Cancellation drops its driver too.
            let mut connection = self
                .0
                .client
                .get_multiplexed_async_connection_with_config(&config)
                .await
                .map_err(|_| Unavailable)?;
            command
                .query_async(&mut connection)
                .await
                .map_err(|_| Unavailable)
        })
        .await
        .map_err(|_| Unavailable)?
    }
}
