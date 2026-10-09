CREATE TABLE labos_threejs_core.notifications (
    id uuid PRIMARY KEY,
    recipient_id uuid NOT NULL REFERENCES labos_threejs_core.users(id),
    event_key text NOT NULL,
    outcome text NOT NULL CHECK (outcome IN ('succeeded', 'failed')),
    subject text NOT NULL,
    target jsonb NOT NULL,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    read_at timestamptz,
    UNIQUE (recipient_id, event_key, outcome)
);
CREATE INDEX notifications_inbox ON labos_threejs_core.notifications (recipient_id, created_at DESC, id DESC);
CREATE INDEX notifications_unread ON labos_threejs_core.notifications (recipient_id) WHERE read_at IS NULL;

-- Deliberately independent of the reference resource's lifetime.
CREATE TABLE labos_threejs_core.job_notifications (
    job_id uuid PRIMARY KEY REFERENCES labos_threejs_core.jobs(id),
    recipient_id uuid NOT NULL REFERENCES labos_threejs_core.users(id),
    event_key text NOT NULL CHECK (length(event_key) BETWEEN 1 AND 200),
    subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 200),
    target jsonb NOT NULL CHECK (jsonb_typeof(target) = 'object' AND octet_length(target::text) <= 4096)
);
