pub const MAX_TITLE_CHARS: usize = 200;
pub const MAX_MARKDOWN_BYTES: usize = 1024 * 1024;

pub struct Content {
    pub title: String,
    pub markdown: String,
}

pub enum ContentError {
    InvalidTitle,
    TooLarge,
    InvalidText,
}

impl Content {
    pub fn new(title: String, markdown: String) -> Result<Self, ContentError> {
        let title = title.trim().to_owned();
        if title.is_empty() || title.chars().count() > MAX_TITLE_CHARS {
            return Err(ContentError::InvalidTitle);
        }
        if markdown.len() > MAX_MARKDOWN_BYTES {
            return Err(ContentError::TooLarge);
        }
        if title.contains('\0') || markdown.contains('\0') {
            return Err(ContentError::InvalidText);
        }
        Ok(Self { title, markdown })
    }
}
