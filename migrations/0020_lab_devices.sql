CREATE TABLE lab.runtime_generation (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    generation bigint NOT NULL DEFAULT 0
);
INSERT INTO lab.runtime_generation DEFAULT VALUES;

CREATE TABLE lab.runtime_bindings (
    id uuid PRIMARY KEY,
    entity_id uuid NOT NULL UNIQUE REFERENCES lab.entities(id),
    program_id text NOT NULL,
    source text NOT NULL UNIQUE
);
WITH existing AS (
    SELECT gen_random_uuid() AS binding_id, id AS entity_id
    FROM lab.entities WHERE definition_id='light' AND definition_version='1.0' AND reality='simulated'
)
INSERT INTO lab.runtime_bindings(id,entity_id,program_id,source)
SELECT binding_id,entity_id,'light.v1','simulated:light.v1:'||binding_id::text FROM existing;
CREATE TABLE lab.program_runs (
    id uuid PRIMARY KEY,
    entity_id uuid NOT NULL REFERENCES lab.entities(id),
    binding_id uuid NOT NULL REFERENCES lab.runtime_bindings(id),
    generation bigint NOT NULL,
    configuration jsonb NOT NULL,
    status text NOT NULL CHECK (status IN ('running', 'stopped', 'interrupted')),
    started_by uuid NOT NULL REFERENCES labos_threejs_core.users(id),
    started_at timestamptz NOT NULL DEFAULT now(),
    ended_at timestamptz,
    sequence bigint NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX one_running_program ON lab.program_runs(entity_id) WHERE status='running';
CREATE INDEX program_runs_entity ON lab.program_runs(entity_id, started_at DESC, id DESC);

CREATE TABLE lab.device_commands (
    id uuid PRIMARY KEY,
    entity_id uuid NOT NULL REFERENCES lab.entities(id),
    run_id uuid NOT NULL REFERENCES lab.program_runs(id),
    actor_id uuid NOT NULL REFERENCES labos_threejs_core.users(id),
    actor_source text NOT NULL CHECK (actor_source IN ('member', 'agent')),
    request_key text NOT NULL,
    capability text NOT NULL,
    parameters jsonb NOT NULL,
    status text NOT NULL CHECK (status IN ('accepted', 'executing', 'succeeded', 'failed', 'unknown')),
    result jsonb,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (actor_id, entity_id, request_key)
);
CREATE INDEX pending_device_commands ON lab.device_commands(created_at, id) WHERE status='accepted';

CREATE TABLE lab.current_observations (
    entity_id uuid PRIMARY KEY REFERENCES lab.entities(id),
    run_id uuid NOT NULL REFERENCES lab.program_runs(id),
    sequence bigint NOT NULL,
    source text NOT NULL,
    values jsonb NOT NULL,
    observed_at timestamptz,
    received_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    quality text NOT NULL
);
