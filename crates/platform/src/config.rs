use crate::object_storage::StorageSettings;
use serde::Serialize;
use sqlx::{ConnectOptions, postgres::PgConnectOptions};
use std::{net::SocketAddr, str::FromStr, time::Duration};
use tracing_subscriber::EnvFilter;

#[derive(Serialize)]
pub struct Setting {
    pub name: &'static str,
    pub default: Option<&'static str>,
    pub secret: bool,
    pub description: &'static str,
    #[serde(rename = "descriptionZh")]
    pub description_zh: &'static str,
}

const DATABASE: Setting = Setting {
    name: "DATABASE_URL",
    default: None,
    secret: true,
    description: "PostgreSQL connection URL. Required; never logged.",
    description_zh: "PostgreSQL 连接 URL。必填；绝不写入日志。",
};
const LISTENER: Setting = Setting {
    name: "APP_BIND",
    default: Some("127.0.0.1:3000"),
    secret: false,
    description: "API listener IP address and port.",
    description_zh: "API 监听 IP 地址和端口。",
};
const LOG_FILTER: Setting = Setting {
    name: "RUST_LOG",
    default: Some("info"),
    secret: false,
    description: "Structured log filter.",
    description_zh: "结构化日志过滤器。",
};
const MIGRATION_TIMEOUT: Setting = Setting {
    name: "MIGRATION_TIMEOUT_SECS",
    default: Some("30"),
    secret: false,
    description: "Migration execution deadline in seconds (1..3600).",
    description_zh: "迁移执行时限，单位秒（1..3600）。",
};
const APP_ORIGIN: Setting = Setting {
    name: "APP_ORIGIN",
    default: Some("http://127.0.0.1:5173"),
    secret: false,
    description: "Trusted browser origin. HTTPS required except loopback development.",
    description_zh: "受信任的浏览器来源。除本机回环开发外必须为 HTTPS。",
};
const SESSION_ABSOLUTE: Setting = Setting {
    name: "SESSION_ABSOLUTE_SECS",
    default: Some("604800"),
    secret: false,
    description: "Absolute session lifetime in seconds (60..2592000).",
    description_zh: "会话绝对有效期，单位秒（60..2592000）。",
};
const SESSION_IDLE: Setting = Setting {
    name: "SESSION_IDLE_SECS",
    default: Some("86400"),
    secret: false,
    description: "Idle session lifetime in seconds (60..absolute lifetime).",
    description_zh: "会话空闲有效期，单位秒（60..绝对有效期）。",
};
const S3_ENDPOINT: Setting = Setting {
    name: "S3_ENDPOINT",
    default: None,
    secret: false,
    description: "Internal S3 endpoint at its root path. Unset disables object storage.",
    description_zh: "内部 S3 端点（根路径）。未设置时禁用对象存储。",
};
const S3_PUBLIC_ENDPOINT: Setting = Setting {
    name: "S3_PUBLIC_ENDPOINT",
    default: None,
    secret: false,
    description: "Browser-accessible S3 origin. Defaults to S3_ENDPOINT; HTTPS except loopback.",
    description_zh: "浏览器可访问的 S3 来源。默认取 S3_ENDPOINT；除本机回环外必须为 HTTPS。",
};
const S3_BUCKET: Setting = Setting {
    name: "S3_BUCKET",
    default: Some("labos-files"),
    secret: false,
    description: "Dedicated private application bucket.",
    description_zh: "应用专用的私有存储桶。",
};
const S3_REGION: Setting = Setting {
    name: "S3_REGION",
    default: Some("us-east-1"),
    secret: false,
    description: "S3 signing region.",
    description_zh: "S3 签名区域。",
};
const S3_ACCESS_KEY: Setting = Setting {
    name: "S3_ACCESS_KEY",
    default: None,
    secret: true,
    description: "Explicit S3 access key; required when S3_ENDPOINT is set.",
    description_zh: "显式 S3 访问密钥；设置 S3_ENDPOINT 时必填。",
};
const S3_SECRET_KEY: Setting = Setting {
    name: "S3_SECRET_KEY",
    default: None,
    secret: true,
    description: "Explicit S3 secret; required when enabled, never logged.",
    description_zh: "显式 S3 私密密钥；启用对象存储时必填，绝不写入日志。",
};
const FILE_MAX_BYTES: Setting = Setting {
    name: "FILE_MAX_BYTES",
    default: Some("20971520"),
    secret: false,
    description: "File byte limit, verified again on the final object (1..104857600).",
    description_zh: "文件字节上限，最终对象会再次校验（1..104857600）。",
};
const UPLOAD_SESSION_SECS: Setting = Setting {
    name: "UPLOAD_SESSION_SECS",
    default: Some("900"),
    secret: false,
    description: "Upload resource/signing lifetime in seconds (1..3600).",
    description_zh: "上传资源/签名有效期，单位秒（1..3600）。",
};
const DOWNLOAD_URL_SECS: Setting = Setting {
    name: "DOWNLOAD_URL_SECS",
    default: Some("60"),
    secret: false,
    description: "Download capability lifetime in seconds (1..300). Revocation blocks new signing.",
    description_zh: "下载能力有效期，单位秒（1..300）。撤销后停止新签名。",
};
pub const FIELDS: &[Setting] = &[
    DATABASE,
    LISTENER,
    LOG_FILTER,
    MIGRATION_TIMEOUT,
    APP_ORIGIN,
    SESSION_ABSOLUTE,
    SESSION_IDLE,
    S3_ENDPOINT,
    S3_PUBLIC_ENDPOINT,
    S3_BUCKET,
    S3_REGION,
    S3_ACCESS_KEY,
    S3_SECRET_KEY,
    FILE_MAX_BYTES,
    UPLOAD_SESSION_SECS,
    DOWNLOAD_URL_SECS,
];

#[derive(Clone)]
pub struct AuthSettings {
    pub origin: String,
    pub secure_cookie: bool,
    pub absolute_secs: u32,
    pub idle_secs: u32,
}

impl Default for AuthSettings {
    fn default() -> Self {
        Self {
            origin: "http://127.0.0.1:5173".into(),
            secure_cookie: false,
            absolute_secs: 604800,
            idle_secs: 86400,
        }
    }
}

pub struct Settings {
    pub bind: SocketAddr,
    pub database: PgConnectOptions,
    pub log_filter: EnvFilter,
    pub migration_timeout: Duration,
    pub auth: AuthSettings,
    pub storage: Option<StorageSettings>,
    pub file_limits: FileLimits,
}

pub struct FileLimits {
    pub max_bytes: i64,
    pub upload_secs: u32,
    pub download_secs: u32,
}

#[derive(Debug, thiserror::Error)]
#[error("Invalid or missing {0}; check the configuration reference")]
pub struct ConfigError(pub &'static str);

impl Settings {
    pub fn from_env() -> Result<Self, ConfigError> {
        let value = |setting: &Setting| {
            std::env::var(setting.name)
                .ok()
                .or_else(|| setting.default.map(str::to_owned))
                .filter(|value| !value.trim().is_empty())
                .ok_or(ConfigError(setting.name))
        };
        let database_url = value(&DATABASE)?;
        let scheme = database_url.split_once("://").map(|(scheme, _)| scheme);
        if !scheme.is_some_and(|scheme| {
            scheme.eq_ignore_ascii_case("postgres") || scheme.eq_ignore_ascii_case("postgresql")
        }) {
            return Err(ConfigError(DATABASE.name));
        }
        let database = PgConnectOptions::from_str(&database_url)
            .map_err(|_| ConfigError(DATABASE.name))?
            .disable_statement_logging();
        let bind = value(&LISTENER)?
            .parse()
            .map_err(|_| ConfigError(LISTENER.name))?;
        let log_filter =
            EnvFilter::try_new(value(&LOG_FILTER)?).map_err(|_| ConfigError(LOG_FILTER.name))?;
        let seconds = value(&MIGRATION_TIMEOUT)?
            .parse::<u64>()
            .map_err(|_| ConfigError(MIGRATION_TIMEOUT.name))?;
        if !(1..=3600).contains(&seconds) {
            return Err(ConfigError(MIGRATION_TIMEOUT.name));
        }
        let origin =
            url::Url::parse(&value(&APP_ORIGIN)?).map_err(|_| ConfigError(APP_ORIGIN.name))?;
        let local = matches!(origin.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
        if !(origin.scheme() == "https" || origin.scheme() == "http" && local)
            || origin.path() != "/"
            || origin.query().is_some()
            || origin.fragment().is_some()
            || !origin.username().is_empty()
            || origin.password().is_some()
            || origin.host_str().is_none()
        {
            return Err(ConfigError(APP_ORIGIN.name));
        }
        let absolute_secs = value(&SESSION_ABSOLUTE)?
            .parse::<u32>()
            .map_err(|_| ConfigError(SESSION_ABSOLUTE.name))?;
        let idle_secs = value(&SESSION_IDLE)?
            .parse::<u32>()
            .map_err(|_| ConfigError(SESSION_IDLE.name))?;
        if !(60..=2592000).contains(&absolute_secs) {
            return Err(ConfigError(SESSION_ABSOLUTE.name));
        }
        if !(60..=absolute_secs).contains(&idle_secs) {
            return Err(ConfigError(SESSION_IDLE.name));
        }
        let max_bytes = value(&FILE_MAX_BYTES)?
            .parse::<i64>()
            .map_err(|_| ConfigError(FILE_MAX_BYTES.name))?;
        let upload_secs = value(&UPLOAD_SESSION_SECS)?
            .parse::<u32>()
            .map_err(|_| ConfigError(UPLOAD_SESSION_SECS.name))?;
        let download_secs = value(&DOWNLOAD_URL_SECS)?
            .parse::<u32>()
            .map_err(|_| ConfigError(DOWNLOAD_URL_SECS.name))?;
        if !(1..=104857600).contains(&max_bytes) {
            return Err(ConfigError(FILE_MAX_BYTES.name));
        }
        if !(1..=3600).contains(&upload_secs) {
            return Err(ConfigError(UPLOAD_SESSION_SECS.name));
        }
        if !(1..=300).contains(&download_secs) {
            return Err(ConfigError(DOWNLOAD_URL_SECS.name));
        }
        let storage = if std::env::var_os(S3_ENDPOINT.name).is_some() {
            let endpoint = storage_endpoint(&value(&S3_ENDPOINT)?, false, S3_ENDPOINT.name)?;
            let public =
                std::env::var(S3_PUBLIC_ENDPOINT.name).unwrap_or_else(|_| endpoint.clone());
            let public_endpoint = storage_endpoint(&public, true, S3_PUBLIC_ENDPOINT.name)?;
            let bucket = value(&S3_BUCKET)?;
            if !(3..=63).contains(&bucket.len())
                || !bucket
                    .bytes()
                    .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b".-".contains(&b))
                || !bucket.starts_with(|c: char| c.is_ascii_alphanumeric())
                || !bucket.ends_with(|c: char| c.is_ascii_alphanumeric())
                || bucket.contains("..")
                || bucket.parse::<std::net::Ipv4Addr>().is_ok()
            {
                return Err(ConfigError(S3_BUCKET.name));
            }
            Some(StorageSettings {
                endpoint,
                public_endpoint,
                bucket,
                region: value(&S3_REGION)?,
                access_key: value(&S3_ACCESS_KEY)?,
                secret_key: value(&S3_SECRET_KEY)?,
            })
        } else {
            None
        };
        Ok(Self {
            bind,
            database,
            log_filter,
            migration_timeout: Duration::from_secs(seconds),
            storage,
            file_limits: FileLimits {
                max_bytes,
                upload_secs,
                download_secs,
            },
            auth: AuthSettings {
                origin: origin.origin().ascii_serialization(),
                secure_cookie: origin.scheme() == "https",
                absolute_secs,
                idle_secs,
            },
        })
    }
}

fn storage_endpoint(value: &str, public: bool, name: &'static str) -> Result<String, ConfigError> {
    let endpoint = url::Url::parse(value).map_err(|_| ConfigError(name))?;
    let local = matches!(
        endpoint.host_str(),
        Some("localhost" | "127.0.0.1" | "[::1]")
    );
    if !matches!(endpoint.scheme(), "http" | "https")
        || (public && endpoint.scheme() == "http" && !local)
        || endpoint.host_str().is_none()
        || endpoint.path() != "/"
        || endpoint.query().is_some()
        || endpoint.fragment().is_some()
        || !endpoint.username().is_empty()
        || endpoint.password().is_some()
        || endpoint.port() == Some(0)
    {
        return Err(ConfigError(name));
    }
    Ok(endpoint.origin().ascii_serialization())
}

pub fn bounded_u32(setting: &Setting, min: u32, max: u32) -> Result<u32, ConfigError> {
    let value = std::env::var(setting.name)
        .ok()
        .or_else(|| setting.default.map(str::to_owned))
        .ok_or(ConfigError(setting.name))?;
    let value = value
        .parse::<u32>()
        .map_err(|_| ConfigError(setting.name))?;
    if !(min..=max).contains(&value) {
        return Err(ConfigError(setting.name));
    }
    Ok(value)
}
