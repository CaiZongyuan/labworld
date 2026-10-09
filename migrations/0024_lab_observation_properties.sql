ALTER TABLE lab.program_runs ADD COLUMN next_sample_at timestamptz;
ALTER TABLE lab.current_observations
    ADD COLUMN properties jsonb NOT NULL DEFAULT '{}',
    ADD COLUMN observed_times jsonb NOT NULL DEFAULT '{}',
    ADD COLUMN freshness text NOT NULL DEFAULT 'current';

-- Preserve the last lighting reports when upgrading an existing deployment.
UPDATE lab.current_observations o SET
    properties = (SELECT jsonb_object_agg(p.key,jsonb_build_object(
        'value',p.value,'unit',CASE WHEN p.key='brightness' THEN '%' ELSE NULL END,
        'binding_id',r.binding_id,'run_id',o.run_id,'sequence',o.sequence,'source',o.source,
        'observed_at',o.observed_at,'received_at',o.received_at,'updated_at',o.updated_at,
        'expires_at',o.received_at+interval '5 seconds','quality',o.quality,
        'freshness',CASE WHEN o.observed_at IS NULL THEN 'source_time_unknown' ELSE 'current' END
    )) FROM jsonb_each(o.values) p),
    observed_times = CASE WHEN COALESCE(o.observed_at,r.last_observed_at) IS NULL THEN '{}'::jsonb ELSE
        (SELECT jsonb_object_agg(p.key,to_jsonb(COALESCE(o.observed_at,r.last_observed_at))) FROM jsonb_each(o.values) p) END,
    freshness = CASE WHEN o.observed_at IS NULL THEN 'source_time_unknown' ELSE 'current' END
FROM lab.program_runs r WHERE r.id=o.run_id;

WITH existing AS (
    SELECT gen_random_uuid() AS binding_id,id AS entity_id FROM lab.entities
    WHERE definition_id='sensor' AND definition_version='1.0' AND reality='simulated'
)
INSERT INTO lab.runtime_bindings(id,entity_id,program_id,source)
SELECT binding_id,entity_id,'sensor.v1','simulated:sensor.v1:'||binding_id::text FROM existing;
