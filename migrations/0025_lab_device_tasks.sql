ALTER TABLE lab.device_commands ADD COLUMN task_id uuid;
CREATE TABLE lab.device_tasks (
    id uuid PRIMARY KEY,
    entity_id uuid NOT NULL REFERENCES lab.entities(id),
    run_id uuid NOT NULL REFERENCES lab.program_runs(id),
    command_id uuid NOT NULL UNIQUE REFERENCES lab.device_commands(id),
    result_id uuid NOT NULL UNIQUE,
    parameters jsonb NOT NULL,
    status text NOT NULL CHECK (status IN ('pending','preparing','running','decelerating','completed','cancelled','failed','unknown','interrupted')),
    elapsed_seconds double precision NOT NULL DEFAULT 0 CHECK (elapsed_seconds >= 0),
    timer_started_at timestamptz,
    last_tick_at timestamptz,
    pending_outcome text CHECK (pending_outcome IN ('completed','cancelled','failed','unknown')),
    created_at timestamptz NOT NULL DEFAULT now(),
    ended_at timestamptz
);
CREATE UNIQUE INDEX one_active_device_task ON lab.device_tasks(entity_id)
    WHERE status IN ('pending','preparing','running','decelerating');
CREATE INDEX device_tasks_entity ON lab.device_tasks(entity_id,created_at DESC,id DESC);
CREATE TABLE lab.device_task_results (
    id uuid PRIMARY KEY,
    task_id uuid NOT NULL UNIQUE REFERENCES lab.device_tasks(id),
    status text NOT NULL CHECK (status IN ('pending','completed','cancelled','failed','unknown','interrupted')),
    reason text,
    ended_at timestamptz
);
ALTER TABLE lab.device_tasks ADD FOREIGN KEY (result_id) REFERENCES lab.device_task_results(id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE lab.device_commands ADD FOREIGN KEY (task_id) REFERENCES lab.device_tasks(id);
CREATE TRIGGER world_version BEFORE INSERT OR UPDATE OR DELETE ON lab.device_tasks
    FOR EACH STATEMENT EXECUTE FUNCTION lab.advance_world_version();
CREATE TRIGGER world_version BEFORE INSERT OR UPDATE OR DELETE ON lab.device_task_results
    FOR EACH STATEMENT EXECUTE FUNCTION lab.advance_world_version();
WITH existing AS (
    SELECT gen_random_uuid() AS binding_id,id AS entity_id FROM lab.entities
    WHERE definition_id='centrifuge' AND definition_version='1.0' AND reality='simulated'
)
INSERT INTO lab.runtime_bindings(id,entity_id,program_id,source)
SELECT binding_id,entity_id,'centrifuge.v1','simulated:centrifuge.v1:'||binding_id::text FROM existing;
