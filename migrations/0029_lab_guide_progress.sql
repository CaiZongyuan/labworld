CREATE TABLE lab.guide_progress (
    actor_id uuid NOT NULL REFERENCES labos_threejs_core.users(id),
    guide_id text NOT NULL CHECK (length(guide_id) BETWEEN 1 AND 64),
    guide_version text NOT NULL CHECK (length(guide_version) BETWEEN 1 AND 32),
    revision bigint NOT NULL CHECK (revision > 0),
    status text NOT NULL CHECK (status IN ('not_started', 'in_progress', 'paused', 'completed')),
    step text,
    guide_attempt_id uuid,
    context jsonb NOT NULL CHECK (octet_length(context::text) <= 4096),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (actor_id, guide_id, guide_version)
);

CREATE INDEX guide_progress_previous ON lab.guide_progress
    (actor_id, guide_id, updated_at DESC, guide_version DESC);
