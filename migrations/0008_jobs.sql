CREATE TABLE labos_threejs_core.jobs (
    id uuid PRIMARY KEY,
    kind text NOT NULL,
    schema_version integer NOT NULL CHECK (schema_version > 0),
    payload jsonb NOT NULL CHECK (octet_length(payload::text) <= 16384),
    status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'retry_wait', 'succeeded', 'failed')),
    scheduled_at timestamptz NOT NULL DEFAULT now(),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    max_attempts integer NOT NULL DEFAULT 5 CHECK (max_attempts BETWEEN 1 AND 20),
    lease_token uuid,
    locked_by text,
    lease_expires_at timestamptz,
    last_error text,
    correlation_id text NOT NULL,
    causation_id text,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CHECK (status <> 'running' OR (lease_token IS NOT NULL AND locked_by IS NOT NULL AND lease_expires_at IS NOT NULL))
);
CREATE INDEX jobs_runnable ON labos_threejs_core.jobs(scheduled_at, id) WHERE status IN ('queued', 'retry_wait');
CREATE INDEX jobs_leases ON labos_threejs_core.jobs(lease_expires_at, id) WHERE status = 'running';
