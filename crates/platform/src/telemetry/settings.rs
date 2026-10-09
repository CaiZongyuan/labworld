use crate::config::{ConfigError, Setting, bounded_u32};
use std::{path::PathBuf, time::Duration};

pub const FIELDS: &[Setting] = &[
    Setting {
        name: "TELEMETRY_ENDPOINT",
        default: None,
        secret: false,
        description: "Optional local OTLP/HTTP base URL (loopback or collector); empty disables export.",
        description_zh: "可选的本地 OTLP/HTTP 基础 URL（回环或 collector）；留空禁用导出。",
    },
    Setting {
        name: "TELEMETRY_LOG_DIRECTORY",
        default: None,
        secret: false,
        description: "Optional private JSON log directory; hourly rotation with at most 24 files per service. Empty uses stdout.",
        description_zh: "可选的私有 JSON 日志目录；按小时轮转，每个服务最多保留 24 个文件。留空输出到 stdout。",
    },
    Setting {
        name: "TELEMETRY_QUEUE_SIZE",
        default: Some("512"),
        secret: false,
        description: "Bounded span queue (64..4096); overflow drops telemetry, never blocks requests.",
        description_zh: "有界 span 队列（64..4096）；溢出时丢弃遥测，绝不阻塞请求。",
    },
    Setting {
        name: "TELEMETRY_TIMEOUT_MS",
        default: Some("1000"),
        secret: false,
        description: "Whole OTLP request timeout, one attempt (50..2000 ms).",
        description_zh: "OTLP 请求整体超时，单次尝试（50..2000 毫秒）。",
    },
    Setting {
        name: "TELEMETRY_METRICS_INTERVAL_MS",
        default: Some("5000"),
        secret: false,
        description: "Metrics export interval (1000..60000 ms).",
        description_zh: "指标导出间隔（1000..60000 毫秒）。",
    },
];
#[derive(Clone)]
pub struct TelemetrySettings {
    pub endpoint: Option<String>,
    pub log_directory: Option<PathBuf>,
    pub queue_size: usize,
    pub timeout: Duration,
    pub metrics_interval: Duration,
}
impl Default for TelemetrySettings {
    fn default() -> Self {
        Self {
            endpoint: None,
            log_directory: None,
            queue_size: 512,
            timeout: Duration::from_secs(1),
            metrics_interval: Duration::from_secs(5),
        }
    }
}
impl TelemetrySettings {
    pub fn from_env() -> Result<Self, ConfigError> {
        let optional = |name| std::env::var(name).ok().filter(|v| !v.is_empty());
        let value = Self {
            endpoint: optional("TELEMETRY_ENDPOINT"),
            log_directory: optional("TELEMETRY_LOG_DIRECTORY").map(Into::into),
            queue_size: bounded_u32(&FIELDS[2], 64, 4096)? as usize,
            timeout: Duration::from_millis(u64::from(bounded_u32(&FIELDS[3], 50, 2000)?)),
            metrics_interval: Duration::from_millis(u64::from(bounded_u32(
                &FIELDS[4], 1000, 60000,
            )?)),
        };
        value.validate()?;
        Ok(value)
    }
    pub(super) fn validate(&self) -> Result<(), ConfigError> {
        if !(64..=4096).contains(&self.queue_size) {
            return Err(ConfigError("TELEMETRY_QUEUE_SIZE"));
        }
        if !(Duration::from_millis(50)..=Duration::from_secs(2)).contains(&self.timeout) {
            return Err(ConfigError("TELEMETRY_TIMEOUT_MS"));
        }
        if !(Duration::from_secs(1)..=Duration::from_secs(60)).contains(&self.metrics_interval) {
            return Err(ConfigError("TELEMETRY_METRICS_INTERVAL_MS"));
        }
        if let Some(endpoint) = &self.endpoint {
            let url = url::Url::parse(endpoint).map_err(|_| ConfigError("TELEMETRY_ENDPOINT"))?;
            let local = match url.host() {
                Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
                Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
                Some(url::Host::Domain(name)) => matches!(name, "localhost" | "collector"),
                _ => false,
            };
            if !local
                || url.scheme() != "http"
                || !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
                || url.path() != "/"
            {
                return Err(ConfigError("TELEMETRY_ENDPOINT"));
            }
        }
        Ok(())
    }
}
