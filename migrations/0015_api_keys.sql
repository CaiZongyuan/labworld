CREATE TABLE labos_threejs_core.api_keys (
    id uuid PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES labos_threejs_core.users(id),
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 100),
    prefix text NOT NULL,
    secret_hash bytea NOT NULL UNIQUE,
    scopes text[] NOT NULL CHECK (cardinality(scopes) BETWEEN 1 AND 16),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    last_used_at timestamptz
);
CREATE INDEX api_keys_owner_history ON labos_threejs_core.api_keys (user_id, id DESC);
