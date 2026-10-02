CREATE SCHEMA lab;

CREATE TABLE lab.asset_uploads (
    upload_id uuid PRIMARY KEY REFERENCES labos_threejs_core.files(id),
    asset_id uuid NOT NULL UNIQUE,
    name text NOT NULL,
    source text NOT NULL,
    license text NOT NULL,
    version text NOT NULL,
    created_by uuid NOT NULL REFERENCES labos_threejs_core.users(id)
);

CREATE TABLE lab.assets (
    id uuid PRIMARY KEY,
    name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
    source text NOT NULL,
    license text NOT NULL,
    version text NOT NULL,
    created_by uuid NOT NULL REFERENCES labos_threejs_core.users(id),
    updated_by uuid NOT NULL REFERENCES labos_threejs_core.users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE lab.asset_representations (
    id uuid PRIMARY KEY,
    asset_id uuid NOT NULL UNIQUE REFERENCES lab.assets(id) ON DELETE CASCADE,
    file_id uuid NOT NULL UNIQUE REFERENCES labos_threejs_core.files(id),
    file_name text NOT NULL,
    size bigint NOT NULL,
    sha256 text NOT NULL,
    content_type text NOT NULL
);
