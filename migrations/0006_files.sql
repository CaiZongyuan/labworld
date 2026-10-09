CREATE TABLE labos_threejs_core.files (
    id uuid PRIMARY KEY,
    created_by uuid NOT NULL REFERENCES labos_threejs_core.users(id),
    file_name text NOT NULL,
    content_type text NOT NULL,
    declared_size bigint NOT NULL CHECK (declared_size >= 0),
    sha256 bytea NOT NULL CHECK (octet_length(sha256) = 32),
    state text NOT NULL DEFAULT 'pending_upload' CHECK (state IN ('pending_upload', 'ready', 'rejected', 'expired', 'deleting', 'deleted')),
    bucket text NOT NULL,
    staging_key text NOT NULL UNIQUE,
    ready_key text UNIQUE,
    ready_candidate_id uuid UNIQUE,
    actual_size bigint,
    expires_at timestamptz NOT NULL,
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (state <> 'ready' OR (ready_key IS NOT NULL AND ready_candidate_id IS NOT NULL AND actual_size IS NOT NULL))
);
CREATE INDEX files_cleanup ON labos_threejs_core.files(state, expires_at, id);

CREATE TABLE labos_threejs_core.file_candidates (
    id uuid PRIMARY KEY,
    file_id uuid NOT NULL REFERENCES labos_threejs_core.files(id),
    bucket text NOT NULL,
    object_key text NOT NULL UNIQUE,
    state text NOT NULL DEFAULT 'copying' CHECK (state IN ('copying', 'adopted', 'abandoned', 'deleted')),
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX file_candidates_file ON labos_threejs_core.file_candidates(file_id, id);
ALTER TABLE labos_threejs_core.files ADD FOREIGN KEY (ready_candidate_id) REFERENCES labos_threejs_core.file_candidates(id);
