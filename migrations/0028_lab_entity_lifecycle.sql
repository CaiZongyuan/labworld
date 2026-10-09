ALTER TABLE lab.entities ADD COLUMN archived_at timestamptz;

-- Retired Bindings remain the immutable definition and program source for their Runs.
ALTER TABLE lab.runtime_bindings
    DROP CONSTRAINT runtime_bindings_entity_id_key,
    ADD COLUMN current boolean NOT NULL DEFAULT true,
    ADD COLUMN definition_id text,
    ADD COLUMN definition_version text,
    ADD COLUMN definition jsonb;
UPDATE lab.runtime_bindings b SET definition_id=e.definition_id,
    definition_version=e.definition_version,definition=e.definition
    FROM lab.entities e WHERE e.id=b.entity_id;
ALTER TABLE lab.runtime_bindings
    ALTER COLUMN definition_id SET NOT NULL,
    ALTER COLUMN definition_version SET NOT NULL,
    ALTER COLUMN definition SET NOT NULL;
CREATE UNIQUE INDEX one_current_binding ON lab.runtime_bindings(entity_id) WHERE current;
