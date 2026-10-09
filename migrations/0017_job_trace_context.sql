-- Trace metadata is independent of the versioned business payload. Historical
-- jobs keep NULL context rather than inventing an originating authenticated actor.
ALTER TABLE labos_threejs_core.jobs
    ADD COLUMN request_id text CHECK (octet_length(request_id) <= 128),
    ADD COLUMN actor_id uuid,
    ADD COLUMN traceparent text CHECK (traceparent ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$');
