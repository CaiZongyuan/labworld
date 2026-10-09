CREATE TABLE knowledge.attachment_uploads (
    upload_id uuid PRIMARY KEY REFERENCES labos_threejs_core.files(id),
    document_id uuid NOT NULL REFERENCES knowledge.documents(id) ON DELETE CASCADE
);
CREATE INDEX attachment_uploads_document ON knowledge.attachment_uploads(document_id, upload_id);

CREATE TABLE knowledge.attachments (
    file_id uuid PRIMARY KEY REFERENCES labos_threejs_core.files(id),
    document_id uuid NOT NULL REFERENCES knowledge.documents(id) ON DELETE CASCADE
);
CREATE INDEX attachments_document ON knowledge.attachments(document_id, file_id);
