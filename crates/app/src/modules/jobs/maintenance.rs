use super::JobError;
use std::{future::Future, sync::Arc, time::Duration};

#[async_trait::async_trait]
pub trait Maintenance: Send + Sync {
    fn name(&self) -> &'static str;
    /// Schedule bounded work in short database transactions; perform storage I/O in Jobs.
    async fn schedule(&self) -> Result<(), JobError>;
}

/// Poll this independently from the Worker so scheduling cannot suspend a live handler.
pub async fn run_maintenance(
    tasks: Vec<Arc<dyn Maintenance>>,
    period: Duration,
    shutdown: impl Future<Output = ()>,
) {
    tokio::pin!(shutdown);
    let mut interval = tokio::time::interval(period);
    interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {_=&mut shutdown=>return,_=interval.tick()=>{}}
        for task in &tasks {
            tokio::select! {
                _=&mut shutdown=>return,
                result=tokio::time::timeout(Duration::from_secs(3),task.schedule())=>{
                    if !matches!(result,Ok(Ok(()))){tracing::warn!(task=task.name(),"maintenance scheduling failed");}
                }
            }
        }
    }
}
