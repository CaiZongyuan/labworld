WITH records AS (
    SELECT c.id, 'command'::text AS record_type, c.entity_id, c.run_id,
        c.id AS command_id, c.task_id, NULL::uuid AS result_id,
        c.created_at AS recorded_at, NULL::timestamptz AS ended_at,
        c.status AS state, c.capability AS summary,
        c.actor_id::text AS actor_id, c.actor_source,
        'initiator'::text AS actor_role, to_jsonb(c) AS data
    FROM lab.device_commands c
    JOIN lab.entities e ON e.id=c.entity_id
    LEFT JOIN lab.history_bounds hb ON hb.entity_id=c.entity_id AND hb.record_type='command'
    WHERE e.lab_id=$1::uuid AND c.created_at >= $2 AND c.created_at < $3
        AND (c.status IN ('accepted','executing') OR c.updated_at >= GREATEST($10,hb.cleaned_before)
            OR EXISTS(SELECT 1 FROM lab.device_tasks t WHERE t.command_id=c.id AND t.ended_at IS NULL))
    UNION ALL
    SELECT t.id, 'task', t.entity_id, t.run_id, t.command_id, t.id, t.result_id,
        t.created_at, t.ended_at, t.status, 'device_task',
        c.actor_id::text, COALESCE(c.actor_source, 'unknown'),
        CASE WHEN c.actor_id IS NULL THEN 'unknown' ELSE 'initiator' END,
        (to_jsonb(t)-'last_tick_at'-'pending_outcome') || jsonb_build_object('result', to_jsonb(result))
    FROM lab.device_tasks t
    JOIN lab.entities e ON e.id=t.entity_id
    LEFT JOIN lab.device_commands c ON c.id=t.command_id
    LEFT JOIN lab.device_task_results result ON result.id=t.result_id
    LEFT JOIN lab.history_bounds hb ON hb.entity_id=t.entity_id AND hb.record_type='task'
    WHERE e.lab_id=$1::uuid AND t.created_at >= $2 AND t.created_at < $3
        AND (t.ended_at IS NULL OR t.ended_at >= GREATEST($10,hb.cleaned_before))
    UNION ALL
    SELECT ev.id, 'event', ev.entity_id, ev.run_id,
        CASE WHEN ev.data->>'record_type'='command' THEN (ev.data->>'record_id')::uuid END,
        CASE WHEN ev.data->>'record_type'='task' THEN (ev.data->>'record_id')::uuid END,
        NULL::uuid, ev.received_at, NULL::timestamptz,
        COALESCE(ev.data->>'status', 'unknown'),
        COALESCE(ev.data->>'record_type', 'event') || '_' || COALESCE(ev.data->>'status', 'unknown'),
        CASE WHEN ev.data->>'record_type'='program' AND ev.data->>'status' IS DISTINCT FROM 'running'
            THEN NULL ELSE ev.data->>'actor_id' END,
        CASE WHEN ev.data->>'record_type'='program' THEN 'unknown'
            WHEN ev.data->>'actor_source' IN ('member','agent') THEN ev.data->>'actor_source'
            ELSE 'unknown' END,
        CASE WHEN ev.data->>'actor_id' IS NULL OR
            (ev.data->>'record_type'='program' AND ev.data->>'status' IS DISTINCT FROM 'running')
            THEN 'unknown' ELSE 'initiator' END,
        (ev.data-'actor_id'-'actor_source') ||
            jsonb_build_object('occurred_at',ev.occurred_at,'received_at',ev.received_at)
    FROM lab.device_events ev
    JOIN lab.entities e ON e.id=ev.entity_id
    LEFT JOIN lab.history_bounds hb ON hb.entity_id=ev.entity_id AND hb.record_type='event'
    WHERE e.lab_id=$1::uuid AND ev.received_at >= $2 AND ev.received_at < $3
        AND ev.received_at >= GREATEST($10,hb.cleaned_before)
    UNION ALL
    SELECT r.id, 'run', r.entity_id, r.id, NULL::uuid, NULL::uuid, NULL::uuid,
        r.started_at, r.ended_at, r.status, 'device_program_run',
        r.started_by::text, 'unknown', 'initiator',
        to_jsonb(r)-'next_sample_at'-'last_observed_at'-'sequence'-'generation'
    FROM lab.program_runs r
    JOIN lab.entities e ON e.id=r.entity_id
    WHERE e.lab_id=$1::uuid AND r.started_at >= $2 AND r.started_at < $3
)
SELECT h.id::text, h.record_type, h.entity_id::text, e.name AS entity_name,
    e.reality, e.archived_at, h.run_id::text, r.binding_id::text,
    h.command_id::text, h.task_id::text, h.result_id::text, h.recorded_at,
    h.ended_at, h.state, h.summary, b.source, h.actor_id, h.actor_source,
    h.actor_role, h.data
FROM records h
JOIN lab.entities e ON e.id=h.entity_id
JOIN lab.program_runs r ON r.id=h.run_id
JOIN lab.runtime_bindings b ON b.id=r.binding_id
WHERE ($5::uuid IS NULL OR h.entity_id=$5::uuid)
    AND ($6::text IS NULL OR h.record_type=$6)
    AND ($7::timestamptz IS NULL OR
        (h.recorded_at,h.record_type,h.id)<($7,$8::text,$9::uuid))
ORDER BY h.recorded_at DESC, h.record_type DESC, h.id DESC
LIMIT $4
