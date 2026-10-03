CREATE TABLE lab.observation_history (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id uuid NOT NULL REFERENCES lab.entities(id),
    run_id uuid NOT NULL REFERENCES lab.program_runs(id),
    observed_at timestamptz,
    received_at timestamptz NOT NULL,
    data jsonb NOT NULL
);
CREATE INDEX observation_history_range ON lab.observation_history(entity_id,received_at DESC,id DESC);

CREATE TABLE lab.device_events (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    entity_id uuid NOT NULL REFERENCES lab.entities(id),
    run_id uuid NOT NULL REFERENCES lab.program_runs(id),
    occurred_at timestamptz NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now(),
    data jsonb NOT NULL
);
CREATE INDEX device_events_range ON lab.device_events(entity_id,received_at DESC,id DESC);
CREATE INDEX device_commands_range ON lab.device_commands(entity_id,created_at DESC,id DESC);

CREATE TABLE lab.history_bounds (
    entity_id uuid NOT NULL REFERENCES lab.entities(id),
    record_type text NOT NULL CHECK (record_type IN ('observation','command','task','event')),
    captured_since timestamptz NOT NULL,
    cleaned_before timestamptz,
    PRIMARY KEY(entity_id,record_type)
);
INSERT INTO lab.history_bounds(entity_id,record_type,captured_since)
SELECT e.id,k.kind,CASE WHEN k.kind IN ('command','task') THEN e.created_at ELSE now() END
FROM lab.entities e CROSS JOIN (VALUES ('observation'),('command'),('task'),('event')) k(kind);

CREATE FUNCTION lab.initialize_history_bounds() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO lab.history_bounds(entity_id,record_type,captured_since)
    SELECT NEW.id,kind,NEW.created_at FROM (VALUES ('observation'),('command'),('task'),('event')) k(kind);
    RETURN NEW;
END $$;
CREATE TRIGGER initialize_history_bounds AFTER INSERT ON lab.entities
    FOR EACH ROW EXECUTE FUNCTION lab.initialize_history_bounds();

CREATE FUNCTION lab.append_device_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    kind text;
    at timestamptz;
    actor uuid;
    actor_source text;
    run uuid;
BEGIN
    IF TG_OP='UPDATE' AND OLD.status=NEW.status THEN RETURN NEW; END IF;
    IF TG_TABLE_NAME='program_runs' THEN
        kind:='program'; run:=NEW.id; actor:=NEW.started_by;
        at:=COALESCE(NEW.ended_at,NEW.started_at);
    ELSIF TG_TABLE_NAME='device_commands' THEN
        kind:='command'; run:=NEW.run_id; actor:=NEW.actor_id; actor_source:=NEW.actor_source;
        at:=NEW.updated_at;
    ELSE
        kind:='task'; run:=NEW.run_id;
        SELECT c.actor_id,c.actor_source INTO actor,actor_source FROM lab.device_commands c WHERE c.id=NEW.command_id;
        at:=COALESCE(NEW.ended_at,now());
    END IF;
    INSERT INTO lab.device_events(entity_id,run_id,occurred_at,data)
    VALUES(NEW.entity_id,run,at,jsonb_build_object('record_type',kind,'record_id',NEW.id,
        'status',NEW.status,'actor_id',actor,'actor_source',actor_source));
    RETURN NEW;
END $$;
CREATE TRIGGER append_device_event AFTER INSERT OR UPDATE ON lab.program_runs
    FOR EACH ROW EXECUTE FUNCTION lab.append_device_event();
CREATE TRIGGER append_device_event AFTER INSERT OR UPDATE ON lab.device_commands
    FOR EACH ROW EXECUTE FUNCTION lab.append_device_event();
CREATE TRIGGER append_device_event AFTER INSERT OR UPDATE ON lab.device_tasks
    FOR EACH ROW EXECUTE FUNCTION lab.append_device_event();

ALTER TABLE lab.device_commands DROP CONSTRAINT device_commands_task_id_fkey;
ALTER TABLE lab.device_commands ADD FOREIGN KEY(task_id) REFERENCES lab.device_tasks(id) ON DELETE SET NULL;
-- A retained Task keeps its Command identity after the independently expired Command is removed.
ALTER TABLE lab.device_tasks DROP CONSTRAINT device_tasks_command_id_fkey;
ALTER TABLE lab.device_task_results DROP CONSTRAINT device_task_results_task_id_fkey;
ALTER TABLE lab.device_task_results ADD FOREIGN KEY(task_id) REFERENCES lab.device_tasks(id) ON DELETE CASCADE;
