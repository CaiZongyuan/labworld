use crate::config::{ConfigError, Setting};
use lettre::{
    AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor,
    message::{Mailbox, SinglePart},
    transport::smtp::authentication::Credentials,
};
use std::{error::Error as _, sync::Arc, time::Duration};
use tokio::{sync::Semaphore, time::Instant};

#[derive(Clone, Copy)]
pub enum TlsMode {
    Local,
    StartTls,
    Wrapper,
}
#[derive(Clone)]
pub struct SmtpSettings {
    pub host: String,
    pub port: u16,
    pub tls: TlsMode,
    pub from: String,
    pub username: Option<String>,
    pub password: Option<String>,
    pub timeout: Duration,
}
pub const FIELDS: &[Setting] = &[
    Setting {
        name: "MAIL_SMTP_HOST",
        default: None,
        secret: false,
        description: "SMTP host. Unset disables password reset delivery; ordinary registration/login remain available.",
        description_zh: "SMTP 主机。未设置时停发密码重置邮件；普通注册/登录不受影响。",
    },
    Setting {
        name: "MAIL_SMTP_PORT",
        default: Some("1025"),
        secret: false,
        description: "SMTP port (1..65535); typically 465 wrapper, 587 STARTTLS, 1025 local capture.",
        description_zh: "SMTP 端口（1..65535）；常见为 465 wrapper、587 STARTTLS、1025 本地捕获。",
    },
    Setting {
        name: "MAIL_SMTP_TLS",
        default: Some("local"),
        secret: false,
        description: "wrapper, starttls, or local (only loopback/localhost/mailpit).",
        description_zh: "wrapper、starttls 或 local（仅限回环/localhost/mailpit）。",
    },
    Setting {
        name: "MAIL_FROM",
        default: Some("noreply@example.test"),
        secret: false,
        description: "Validated sender mailbox.",
        description_zh: "经过校验的发件邮箱。",
    },
    Setting {
        name: "MAIL_SMTP_USERNAME",
        default: None,
        secret: true,
        description: "Optional SMTP username; requires matching password.",
        description_zh: "可选 SMTP 用户名；必须同时提供密码。",
    },
    Setting {
        name: "MAIL_SMTP_PASSWORD",
        default: None,
        secret: true,
        description: "Optional SMTP password; never logged.",
        description_zh: "可选 SMTP 密码；绝不写入日志。",
    },
    Setting {
        name: "MAIL_TIMEOUT_SECS",
        default: Some("30"),
        secret: false,
        description: "Whole SMTP attempt deadline, including TLS/DATA/QUIT (1..300 seconds).",
        description_zh: "SMTP 单次尝试总时限，含 TLS/DATA/QUIT（1..300 秒）。",
    },
];
impl SmtpSettings {
    pub fn from_env() -> Result<Option<Self>, ConfigError> {
        let host = match std::env::var("MAIL_SMTP_HOST") {
            Ok(value) if !value.trim().is_empty() => value,
            Ok(_) | Err(std::env::VarError::NotPresent) => return Ok(None),
            Err(_) => return Err(ConfigError("MAIL_SMTP_HOST")),
        };
        let value = |name: &'static str, default: &str| {
            std::env::var(name).unwrap_or_else(|_| default.into())
        };
        let tls = match value("MAIL_SMTP_TLS", "local").as_str() {
            "local" => TlsMode::Local,
            "starttls" => TlsMode::StartTls,
            "wrapper" => TlsMode::Wrapper,
            _ => return Err(ConfigError("MAIL_SMTP_TLS")),
        };
        let port = value("MAIL_SMTP_PORT", "1025")
            .parse()
            .map_err(|_| ConfigError("MAIL_SMTP_PORT"))?;
        let secs = value("MAIL_TIMEOUT_SECS", "30")
            .parse::<u64>()
            .map_err(|_| ConfigError("MAIL_TIMEOUT_SECS"))?;
        Ok(Some(Self {
            host,
            port,
            tls,
            from: value("MAIL_FROM", "noreply@example.test"),
            username: std::env::var("MAIL_SMTP_USERNAME")
                .ok()
                .filter(|v| !v.is_empty()),
            password: std::env::var("MAIL_SMTP_PASSWORD")
                .ok()
                .filter(|v| !v.is_empty()),
            timeout: Duration::from_secs(secs),
        }))
    }
}
#[derive(Debug)]
pub enum DeliveryFailure {
    Transient(&'static str),
    Permanent(&'static str),
}
#[derive(Clone)]
pub struct SmtpSender {
    transport: Arc<AsyncSmtpTransport<Tokio1Executor>>,
    from: Mailbox,
    timeout: Duration,
    slots: Arc<Semaphore>,
}
impl SmtpSender {
    pub fn new(settings: SmtpSettings) -> Result<Self, ConfigError> {
        if settings.host.is_empty()
            || settings.host.len() > 253
            || settings.host.chars().any(char::is_whitespace)
            || settings.host.contains(['@', '/', '\\'])
        {
            return Err(ConfigError("MAIL_SMTP_HOST"));
        }
        if settings.port == 0 {
            return Err(ConfigError("MAIL_SMTP_PORT"));
        }
        if !(Duration::from_secs(1)..=Duration::from_secs(300)).contains(&settings.timeout) {
            return Err(ConfigError("MAIL_TIMEOUT_SECS"));
        }
        if settings.username.is_some() != settings.password.is_some() {
            return Err(ConfigError("MAIL_SMTP_PASSWORD"));
        }
        let from = settings
            .from
            .parse()
            .map_err(|_| ConfigError("MAIL_FROM"))?;
        let builder = match settings.tls {
            TlsMode::Local => {
                let local = settings.host == "localhost"
                    || settings.host == "mailpit"
                    || settings
                        .host
                        .parse::<std::net::IpAddr>()
                        .is_ok_and(|ip| ip.is_loopback());
                if !local {
                    return Err(ConfigError("MAIL_SMTP_TLS"));
                }
                AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&settings.host)
            }
            TlsMode::StartTls => {
                AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&settings.host)
                    .map_err(|_| ConfigError("MAIL_SMTP_TLS"))?
            }
            TlsMode::Wrapper => AsyncSmtpTransport::<Tokio1Executor>::relay(&settings.host)
                .map_err(|_| ConfigError("MAIL_SMTP_TLS"))?,
        };
        let mut builder = builder
            .port(settings.port)
            .timeout(Some(Duration::from_secs(5).min(settings.timeout)));
        if let (Some(username), Some(password)) = (settings.username, settings.password) {
            builder = builder.credentials(Credentials::new(username, password));
        }
        Ok(Self {
            transport: Arc::new(builder.build()),
            from,
            timeout: settings.timeout,
            slots: Arc::new(Semaphore::new(4)),
        })
    }
    pub async fn send_plain_text(
        &self,
        to: &str,
        subject: &str,
        body: String,
        message_id: &str,
        expires: Instant,
    ) -> Result<(), DeliveryFailure> {
        let _permit = self
            .slots
            .try_acquire()
            .map_err(|_| DeliveryFailure::Transient("mail.busy"))?;
        let to: Mailbox = to
            .parse()
            .map_err(|_| DeliveryFailure::Permanent("mail.invalid_address"))?;
        // Declare the part explicitly: a bare body is delivered without a
        // Content-Type, so non-ASCII text can be misread as us-ascii.
        let message = Message::builder()
            .from(self.from.clone())
            .to(to)
            .subject(subject)
            .message_id(Some(format!("<{message_id}@labos_threejs.invalid>")))
            .singlepart(SinglePart::plain(body))
            .map_err(|_| DeliveryFailure::Permanent("mail.invalid_message"))?;
        match tokio::time::timeout_at(
            expires.min(Instant::now() + self.timeout),
            self.transport.send(message),
        )
        .await
        {
            Ok(Ok(_)) => Ok(()),
            Ok(Err(error)) => Err(classify(error)),
            Err(_) => Err(DeliveryFailure::Transient("mail.smtp_timeout")),
        }
    }
}
fn classify(error: lettre::transport::smtp::Error) -> DeliveryFailure {
    if error.is_transient() {
        return DeliveryFailure::Transient("mail.smtp_transient");
    }
    if error.is_permanent() {
        return DeliveryFailure::Permanent("mail.smtp_rejected");
    }
    if error.is_timeout() {
        return DeliveryFailure::Transient("mail.smtp_timeout");
    }
    let mut source = error.source();
    while let Some(cause) = source {
        if cause.downcast_ref::<std::io::Error>().is_some_and(|io| {
            matches!(
                io.kind(),
                std::io::ErrorKind::ConnectionRefused
                    | std::io::ErrorKind::ConnectionReset
                    | std::io::ErrorKind::ConnectionAborted
                    | std::io::ErrorKind::BrokenPipe
                    | std::io::ErrorKind::NotConnected
                    | std::io::ErrorKind::UnexpectedEof
                    | std::io::ErrorKind::TimedOut
                    | std::io::ErrorKind::Interrupted
            )
        }) {
            return DeliveryFailure::Transient("mail.smtp_unavailable");
        }
        source = cause.source();
    }
    DeliveryFailure::Permanent("mail.smtp_invalid")
}
