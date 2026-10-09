CREATE TABLE knowledge.exports (
    id uuid PRIMARY KEY,
    document_id uuid NOT NULL REFERENCES knowledge.documents(id) ON DELETE CASCADE,
    requested_by uuid NOT NULL REFERENCES labos_threejs_core.users(id),
    credential jsonb NOT NULL,
    job_id uuid NOT NULL UNIQUE REFERENCES labos_threejs_core.jobs(id),
    document_version bigint NOT NULL CHECK (document_version > 0),
    snapshot jsonb,
    file_id uuid REFERENCES labos_threejs_core.files(id),
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX exports_document_requester ON knowledge.exports(document_id, requested_by, id);
CREATE INDEX exports_expiry ON knowledge.exports(expires_at, id);
