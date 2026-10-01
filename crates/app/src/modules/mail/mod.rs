//! Mail capability hides SMTP and short-lived authenticated material; owners define validity.
use chacha20poly1305::{
    XChaCha20Poly1305, XNonce,
    aead::{Aead, KeyInit, Payload},
};
use labos_threejs_platform::{
    config::{ConfigError, Setting},
    mail::{SmtpSender, SmtpSettings},
};
use std::sync::Arc;

pub const FIELDS: &[Setting] = &[
    Setting {
        name: "MAIL_ENCRYPTION_KEY",
        default: None,
        secret: true,
        description: "Independent 32-byte hex key for short-lived mail materials; shared by API/Worker, required with SMTP.",
        description_zh: "用于短期邮件材料的独立 32 字节十六进制密钥；API/Worker 共享，配置 SMTP 时必填。",
    },
    Setting {
        name: "MAIL_ENCRYPTION_KEY_VERSION",
        default: Some("1"),
        secret: false,
        description: "Current positive key version; drain or expire old materials before rotation.",
        description_zh: "当前正整数密钥版本；轮换前需清空或等待旧材料过期。",
    },
];
#[derive(Debug)]
pub enum MaterialError {
    Unavailable,
    Invalid,
    KeyUnavailable,
}
pub struct Binding<'a> {
    pub purpose: &'static str,
    pub resource_id: &'a str,
    pub job_id: &'a str,
    pub user_id: &'a str,
    pub expires_at: i64,
}
impl Binding<'_> {
    fn bytes(&self, version: i32) -> Result<Vec<u8>, MaterialError> {
        serde_json::to_vec(&(
            1,
            self.purpose,
            self.resource_id,
            self.job_id,
            self.user_id,
            version,
            self.expires_at,
        ))
        .map_err(|_| MaterialError::Invalid)
    }
}
pub struct Sealed {
    pub key_version: i32,
    pub nonce: Vec<u8>,
    pub ciphertext: Vec<u8>,
}
struct Inner {
    cipher: XChaCha20Poly1305,
    version: i32,
    sender: SmtpSender,
}
#[derive(Clone)]
pub struct MailService(Arc<Inner>);
impl MailService {
    pub fn from_env() -> Result<Option<Self>, ConfigError> {
        let Some(settings) = SmtpSettings::from_env()? else {
            return Ok(None);
        };
        let value =
            std::env::var("MAIL_ENCRYPTION_KEY").map_err(|_| ConfigError("MAIL_ENCRYPTION_KEY"))?;
        let key = hex::decode(value).map_err(|_| ConfigError("MAIL_ENCRYPTION_KEY"))?;
        let version = std::env::var("MAIL_ENCRYPTION_KEY_VERSION")
            .unwrap_or_else(|_| "1".into())
            .parse()
            .map_err(|_| ConfigError("MAIL_ENCRYPTION_KEY_VERSION"))?;
        Self::new(settings, &key, version).map(Some)
    }
    pub fn new(settings: SmtpSettings, key: &[u8], version: i32) -> Result<Self, ConfigError> {
        if version < 1 {
            return Err(ConfigError("MAIL_ENCRYPTION_KEY_VERSION"));
        }
        let cipher = XChaCha20Poly1305::new_from_slice(key)
            .map_err(|_| ConfigError("MAIL_ENCRYPTION_KEY"))?;
        Ok(Self(Arc::new(Inner {
            cipher,
            version,
            sender: SmtpSender::new(settings)?,
        })))
    }
    pub fn seal(&self, binding: &Binding<'_>, plaintext: &[u8]) -> Result<Sealed, MaterialError> {
        if plaintext.len() > 4096 {
            return Err(MaterialError::Invalid);
        }
        let bytes = crate::secrets::random_bytes::<24>().map_err(|_| MaterialError::Unavailable)?;
        let nonce: XNonce = bytes.into();
        let ciphertext = self
            .0
            .cipher
            .encrypt(
                &nonce,
                Payload {
                    msg: plaintext,
                    aad: &binding.bytes(self.0.version)?,
                },
            )
            .map_err(|_| MaterialError::Unavailable)?;
        Ok(Sealed {
            key_version: self.0.version,
            nonce: bytes.to_vec(),
            ciphertext,
        })
    }
    pub fn open(&self, binding: &Binding<'_>, sealed: &Sealed) -> Result<Vec<u8>, MaterialError> {
        if sealed.key_version != self.0.version {
            return Err(MaterialError::KeyUnavailable);
        }
        let bytes: [u8; 24] = sealed
            .nonce
            .as_slice()
            .try_into()
            .map_err(|_| MaterialError::Invalid)?;
        if sealed.ciphertext.len() > 8192 {
            return Err(MaterialError::Invalid);
        }
        self.0
            .cipher
            .decrypt(
                &bytes.into(),
                Payload {
                    msg: &sealed.ciphertext,
                    aad: &binding.bytes(sealed.key_version)?,
                },
            )
            .map_err(|_| MaterialError::Invalid)
    }
    pub async fn send_plain_text(
        &self,
        to: &str,
        subject: &str,
        body: String,
        message_id: &str,
        expires: tokio::time::Instant,
    ) -> Result<(), labos_threejs_platform::mail::DeliveryFailure> {
        self.0
            .sender
            .send_plain_text(to, subject, body, message_id, expires)
            .await
    }
}
