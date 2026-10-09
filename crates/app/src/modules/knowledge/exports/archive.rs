use super::{ExportPolicy, Snapshot};
use crate::modules::jobs::JobError;
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom, Write},
    path::PathBuf,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::Instant,
};
use tokio::sync::OwnedSemaphorePermit;

pub(super) struct Artifact {
    pub directory: tempfile::TempDir,
    pub path: PathBuf,
    pub size: i64,
    pub sha256: String,
    pub _permit: OwnedSemaphorePermit,
}

pub(super) fn attachment_path(file: &crate::modules::files::FileSnapshot) -> String {
    let extension = file
        .file_name
        .rsplit_once('.')
        .map(|(_, ext)| ext)
        .filter(|ext| {
            !ext.is_empty() && ext.len() <= 10 && ext.bytes().all(|c| c.is_ascii_alphanumeric())
        })
        .unwrap_or("bin");
    format!("attachments/{}.{}", file.id, extension.to_ascii_lowercase())
}

struct BoundedText(String);
impl std::fmt::Write for BoundedText {
    fn write_str(&mut self, text: &str) -> std::fmt::Result {
        if self.0.len().saturating_add(text.len()) > 2 * 1024 * 1024 {
            return Err(std::fmt::Error);
        }
        self.0.push_str(text);
        Ok(())
    }
}
fn markdown(snapshot: &Snapshot) -> Result<String, JobError> {
    use pulldown_cmark::{Event, LinkType, Options, Parser, Tag};
    let paths = snapshot
        .attachments
        .iter()
        .map(|file| (file.id.clone(), attachment_path(file)))
        .collect::<std::collections::HashMap<_, _>>();
    let mut changed = false;
    let options = Options::ENABLE_TABLES
        | Options::ENABLE_STRIKETHROUGH
        | Options::ENABLE_TASKLISTS
        | Options::ENABLE_FOOTNOTES;
    let events = Parser::new_ext(&snapshot.markdown, options).map(|mut event| {
        if let Event::Start(
            Tag::Link {
                dest_url,
                link_type,
                ..
            }
            | Tag::Image {
                dest_url,
                link_type,
                ..
            },
        ) = &mut event
            && let Some(id) = dest_url
                .strip_prefix("attachment:")
                .and_then(|id| uuid::Uuid::parse_str(id).ok())
            && let Some(path) = paths.get(&id.to_string())
        {
            *dest_url = path.clone().into();
            *link_type = LinkType::Inline;
            changed = true;
        }
        event
    });
    let mut output = BoundedText(String::new());
    // A longer fence prevents embedded runs of backticks from closing code blocks.
    let fence = snapshot
        .markdown
        .split(|c| c != '`')
        .map(str::len)
        .max()
        .unwrap_or(0)
        .saturating_add(1)
        .max(3);
    let options = pulldown_cmark_to_cmark::Options {
        code_block_token_count: fence,
        ..Default::default()
    };
    pulldown_cmark_to_cmark::cmark_with_options(events, &mut output, options)
        .map_err(|_| JobError::Permanent("knowledge.export_markdown_limit"))?;
    Ok(if changed {
        output.0
    } else {
        snapshot.markdown.clone()
    })
}

struct CappedFile {
    file: File,
    limit: u64,
    deadline: Instant,
    cancelled: Arc<AtomicBool>,
}
impl CappedFile {
    fn check(&self) -> std::io::Result<()> {
        if self.cancelled.load(Ordering::Relaxed) || Instant::now() >= self.deadline {
            return Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                "export deadline",
            ));
        }
        Ok(())
    }
}
impl Write for CappedFile {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.check()?;
        let end = self
            .file
            .stream_position()?
            .checked_add(bytes.len() as u64)
            .ok_or_else(|| std::io::Error::other("export size"))?;
        if end > self.limit {
            return Err(std::io::Error::other("export size"));
        }
        self.file.write(bytes)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.check()?;
        self.file.flush()
    }
}
impl Seek for CappedFile {
    fn seek(&mut self, position: SeekFrom) -> std::io::Result<u64> {
        self.check()?;
        let next = match position {
            SeekFrom::Start(value) => i128::from(value),
            SeekFrom::Current(value) => {
                i128::from(self.file.stream_position()?) + i128::from(value)
            }
            SeekFrom::End(value) => i128::from(self.file.metadata()?.len()) + i128::from(value),
        };
        if next < 0 || next > i128::from(self.limit) {
            return Err(std::io::Error::other("export seek limit"));
        }
        self.file.seek(SeekFrom::Start(next as u64))
    }
}

pub(super) fn build(
    snapshot: Snapshot,
    directory: tempfile::TempDir,
    policy: ExportPolicy,
    deadline: Instant,
    cancelled: Arc<AtomicBool>,
    permit: OwnedSemaphorePermit,
) -> Result<Artifact, JobError> {
    let path = directory.path().join("artifact.zip");
    let file = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|_| JobError::Transient("knowledge.export_disk_unavailable"))?;
    let cancellation = cancelled.clone();
    let output = CappedFile {
        file,
        limit: policy.max_output_bytes,
        deadline,
        cancelled,
    };
    let mut zip = zip::ZipWriter::new(output);
    let options =
        zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Stored);
    let write = |_: zip::result::ZipError| JobError::Permanent("knowledge.export_archive_failed");
    zip.start_file("document.md", options).map_err(write)?;
    zip.write_all(markdown(&snapshot)?.as_bytes())
        .map_err(|_| JobError::Permanent("knowledge.export_archive_limit"))?;
    let mut buffer = [0u8; 64 * 1024];
    for file in &snapshot.attachments {
        zip.start_file(attachment_path(file), options)
            .map_err(write)?;
        let mut input = File::open(directory.path().join(&file.id))
            .map_err(|_| JobError::Transient("knowledge.export_disk_unavailable"))?;
        let mut size = 0u64;
        loop {
            if cancellation.load(Ordering::Relaxed) || Instant::now() >= deadline {
                return Err(JobError::Transient("knowledge.export_timeout"));
            }
            let read = input
                .read(&mut buffer)
                .map_err(|_| JobError::Transient("knowledge.export_disk_unavailable"))?;
            if read == 0 {
                break;
            }
            size += read as u64;
            if size > file.size as u64 {
                return Err(JobError::Permanent("knowledge.export_input_changed"));
            }
            zip.write_all(&buffer[..read])
                .map_err(|_| JobError::Permanent("knowledge.export_archive_limit"))?;
        }
        if size != file.size as u64 {
            return Err(JobError::Permanent("knowledge.export_input_changed"));
        }
    }
    let mut output = zip.finish().map_err(write)?;
    output
        .flush()
        .map_err(|_| JobError::Transient("knowledge.export_disk_unavailable"))?;
    let size = output
        .file
        .metadata()
        .map_err(|_| JobError::Transient("knowledge.export_disk_unavailable"))?
        .len();
    output
        .seek(SeekFrom::Start(0))
        .map_err(|_| JobError::Transient("knowledge.export_disk_unavailable"))?;
    let mut hash = Sha256::new();
    loop {
        output
            .check()
            .map_err(|_| JobError::Transient("knowledge.export_timeout"))?;
        let read = output
            .file
            .read(&mut buffer)
            .map_err(|_| JobError::Transient("knowledge.export_disk_unavailable"))?;
        if read == 0 {
            break;
        }
        hash.update(&buffer[..read]);
    }
    drop(output);
    Ok(Artifact {
        directory,
        path,
        size: size as i64,
        sha256: hex::encode(hash.finalize()),
        _permit: permit,
    })
}
