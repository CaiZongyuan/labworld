use labos_threejs_platform::config::{ConfigError, Setting, bounded_u32};

pub const FIELDS: &[Setting] = &[
    Setting {
        name: "EXPORT_JOB_MAX_ATTEMPTS",
        default: Some("5"),
        secret: false,
        description: "Finite attempt budget per export execution batch (1..20).",
        description_zh: "每个导出执行批次的有限尝试预算（1..20）。",
    },
    Setting {
        name: "EXPORT_MAX_ATTACHMENTS",
        default: Some("100"),
        secret: false,
        description: "Maximum attachments in one document export (0..1000).",
        description_zh: "单次文档导出的附件数量上限（0..1000）。",
    },
    Setting {
        name: "EXPORT_MAX_INPUT_BYTES",
        default: Some("268435456"),
        secret: false,
        description: "Maximum snapshot Markdown and attachment bytes (1..1073741824).",
        description_zh: "快照 Markdown 与附件的总字节上限（1..1073741824）。",
    },
    Setting {
        name: "EXPORT_MAX_OUTPUT_BYTES",
        default: Some("285212672"),
        secret: false,
        description: "Maximum ZIP extent, including headers and central directory (1024..1107296256).",
        description_zh: "ZIP 总大小上限，含文件头与中央目录（1024..1107296256）。",
    },
    Setting {
        name: "EXPORT_RETENTION_SECS",
        default: Some("86400"),
        secret: false,
        description: "Export and snapshot lifetime (60..604800 seconds).",
        description_zh: "导出结果与快照的保存期（60..604800 秒）。",
    },
    Setting {
        name: "EXPORT_TIMEOUT_SECS",
        default: Some("120"),
        secret: false,
        description: "Entire export execution budget (1..600 seconds), with cooperative blocking cancellation.",
        description_zh: "导出执行的整体预算（1..600 秒），支持协作式阻塞取消。",
    },
];
#[derive(Clone)]
pub struct ExportPolicy {
    pub max_attempts: i32,
    pub max_attachments: u32,
    pub max_input_bytes: i64,
    pub max_output_bytes: u64,
    pub retention_secs: u32,
    pub timeout_secs: u32,
}
impl Default for ExportPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 5,
            max_attachments: 100,
            max_input_bytes: 256 * 1024 * 1024,
            max_output_bytes: 272 * 1024 * 1024,
            retention_secs: 86400,
            timeout_secs: 120,
        }
    }
}
impl ExportPolicy {
    pub fn from_env() -> Result<Self, ConfigError> {
        Ok(Self {
            max_attempts: bounded_u32(&FIELDS[0], 1, 20)? as i32,
            max_attachments: bounded_u32(&FIELDS[1], 0, 1000)?,
            max_input_bytes: i64::from(bounded_u32(&FIELDS[2], 1, 1073741824)?),
            max_output_bytes: u64::from(bounded_u32(&FIELDS[3], 1024, 1107296256)?),
            retention_secs: bounded_u32(&FIELDS[4], 60, 604800)?,
            timeout_secs: bounded_u32(&FIELDS[5], 1, 600)?,
        })
    }
}
