ALTER TABLE labos_threejs_core.jobs ADD COLUMN batch integer NOT NULL DEFAULT 1 CHECK (batch > 0);
CREATE TABLE labos_threejs_core.job_batches (
    job_id uuid NOT NULL REFERENCES labos_threejs_core.jobs(id) ON DELETE CASCADE,
    number integer NOT NULL CHECK (number > 0),
    max_attempts integer NOT NULL CHECK (max_attempts BETWEEN 1 AND 20),
    attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    legacy_attempts integer NOT NULL DEFAULT 0 CHECK (legacy_attempts >= 0),
    status text NOT NULL CHECK (status IN ('queued', 'running', 'retry_wait', 'succeeded', 'failed')),
    requested_by uuid REFERENCES labos_threejs_core.users(id),
    last_error text,
    created_at timestamptz NOT NULL DEFAULT now(),
    ended_at timestamptz,
    PRIMARY KEY (job_id, number)
);
CREATE TABLE labos_threejs_core.job_attempts (
    job_id uuid NOT NULL,
    batch integer NOT NULL,
    number integer NOT NULL CHECK (number > 0),
    lease_token uuid NOT NULL UNIQUE,
    worker_id text NOT NULL,
    status text NOT NULL CHECK (status IN ('running', 'retry_wait', 'succeeded', 'failed', 'lease_expired')),
    last_error text,
    started_at timestamptz NOT NULL DEFAULT now(),
    lease_expires_at timestamptz NOT NULL,
    ended_at timestamptz,
    PRIMARY KEY (job_id, batch, number),
    FOREIGN KEY (job_id, batch) REFERENCES labos_threejs_core.job_batches(job_id, number) ON DELETE CASCADE
);
-- Preserve available pre-history summaries; do not invent missing attempt details.
INSERT INTO labos_threejs_core.job_batches (job_id, number, max_attempts, attempts, legacy_attempts, status, last_error, created_at, ended_at)
SELECT id, 1, max_attempts, attempts, CASE WHEN status = 'running' THEN GREATEST(attempts - 1, 0) ELSE attempts END, status, last_error, created_at, CASE WHEN status IN ('succeeded', 'failed') THEN updated_at END FROM labos_threejs_core.jobs;
INSERT INTO labos_threejs_core.job_attempts (job_id, batch, number, lease_token, worker_id, status, started_at, lease_expires_at)
SELECT id, 1, attempts, lease_token, locked_by, 'running', updated_at, lease_expires_at FROM labos_threejs_core.jobs WHERE status = 'running' AND attempts > 0;
CREATE INDEX jobs_administration ON labos_threejs_core.jobs(status, id DESC);
ALTER TABLE labos_threejs_core.jobs ADD CONSTRAINT jobs_current_batch FOREIGN KEY (id, batch) REFERENCES labos_threejs_core.job_batches(job_id, number) DEFERRABLE INITIALLY DEFERRED;
