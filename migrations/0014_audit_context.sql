ALTER TABLE labos_threejs_core.audit_events
    ADD COLUMN actor_type text NOT NULL DEFAULT 'user',
    ADD COLUMN resource_type text,
    ADD COLUMN trace_id text,
    ADD COLUMN correlation_id text,
    ADD COLUMN job_id uuid,
    ADD COLUMN metadata jsonb NOT NULL DEFAULT '{}',
    ALTER COLUMN request_id DROP NOT NULL;

-- Preserve existing facts; do not invent historical Job or trace identities.
UPDATE labos_threejs_core.audit_events SET
    actor_type = CASE WHEN actor_id IS NULL THEN 'system' ELSE 'user' END,
    resource_type = CASE action
        WHEN 'identity.register' THEN 'identity.user'
        WHEN 'jobs.retry' THEN 'jobs.job'
        ELSE regexp_replace(action, '\.[^.]+$', '') END,
    correlation_id = request_id;
ALTER TABLE labos_threejs_core.audit_events
    ALTER COLUMN resource_type SET NOT NULL,
    ALTER COLUMN correlation_id SET NOT NULL,
    ADD CONSTRAINT audit_metadata_object CHECK (jsonb_typeof(metadata) = 'object'),
    ADD CONSTRAINT audit_metadata_allowlist CHECK (metadata - 'subject_user_id' = '{}'::jsonb);
CREATE INDEX audit_resource_history ON labos_threejs_core.audit_events (resource_id, id DESC);
CREATE INDEX audit_action_history ON labos_threejs_core.audit_events (action, id DESC);
CREATE INDEX audit_actor_history ON labos_threejs_core.audit_events (actor_id, id DESC);
CREATE INDEX audit_request_history ON labos_threejs_core.audit_events (request_id, id DESC);
CREATE INDEX audit_correlation_history ON labos_threejs_core.audit_events (correlation_id, id DESC);
CREATE INDEX audit_job_history ON labos_threejs_core.audit_events (job_id, id DESC) WHERE job_id IS NOT NULL;
