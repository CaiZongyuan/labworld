CREATE TABLE lab.world_clock (
    singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
    version bigint NOT NULL DEFAULT 0 CHECK (version >= 0)
);
INSERT INTO lab.world_clock DEFAULT VALUES;

-- The transactional clock serializes writers, so visible versions follow commit order.
CREATE FUNCTION lab.advance_world_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    UPDATE lab.world_clock SET version = version + 1 WHERE singleton;
    RETURN NULL;
END;
$$;

CREATE TRIGGER world_version BEFORE INSERT OR UPDATE OR DELETE ON lab.labs
    FOR EACH STATEMENT EXECUTE FUNCTION lab.advance_world_version();
CREATE TRIGGER world_version BEFORE INSERT OR UPDATE OR DELETE ON lab.entities
    FOR EACH STATEMENT EXECUTE FUNCTION lab.advance_world_version();
CREATE TRIGGER world_version BEFORE INSERT OR UPDATE OR DELETE ON lab.scene_nodes
    FOR EACH STATEMENT EXECUTE FUNCTION lab.advance_world_version();
CREATE TRIGGER world_version BEFORE INSERT OR UPDATE OR DELETE ON lab.entity_relationships
    FOR EACH STATEMENT EXECUTE FUNCTION lab.advance_world_version();
CREATE TRIGGER world_version BEFORE INSERT OR UPDATE OR DELETE ON lab.runtime_bindings
    FOR EACH STATEMENT EXECUTE FUNCTION lab.advance_world_version();
CREATE TRIGGER world_version BEFORE INSERT OR UPDATE OR DELETE ON lab.program_runs
    FOR EACH STATEMENT EXECUTE FUNCTION lab.advance_world_version();
CREATE TRIGGER world_version BEFORE INSERT OR UPDATE OR DELETE ON lab.current_observations
    FOR EACH STATEMENT EXECUTE FUNCTION lab.advance_world_version();
CREATE TRIGGER world_version BEFORE INSERT OR UPDATE OR DELETE ON lab.assets
    FOR EACH STATEMENT EXECUTE FUNCTION lab.advance_world_version();
CREATE TRIGGER world_version BEFORE INSERT OR UPDATE OR DELETE ON lab.asset_representations
    FOR EACH STATEMENT EXECUTE FUNCTION lab.advance_world_version();
