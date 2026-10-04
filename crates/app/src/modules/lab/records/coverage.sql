WITH entities AS (
    SELECT e.id,e.created_at FROM lab.entities e
    WHERE e.lab_id=$1::uuid AND ($4::uuid IS NULL OR e.id=$4::uuid)
), retained AS (
    SELECT 'command'::text AS record_type,c.created_at AS recorded_at
    FROM lab.device_commands c JOIN entities e ON e.id=c.entity_id
    LEFT JOIN lab.history_bounds hb ON hb.entity_id=c.entity_id AND hb.record_type='command'
    WHERE c.created_at >= $2 AND c.created_at < $3
        AND (c.status IN ('accepted','executing') OR c.updated_at >= GREATEST($6,hb.cleaned_before)
            OR EXISTS(SELECT 1 FROM lab.device_tasks t WHERE t.command_id=c.id AND t.ended_at IS NULL))
    UNION ALL
    SELECT 'task',t.created_at FROM lab.device_tasks t JOIN entities e ON e.id=t.entity_id
    LEFT JOIN lab.history_bounds hb ON hb.entity_id=t.entity_id AND hb.record_type='task'
    WHERE t.created_at >= $2 AND t.created_at < $3
        AND (t.ended_at IS NULL OR t.ended_at >= GREATEST($6,hb.cleaned_before))
    UNION ALL
    SELECT 'event',ev.received_at FROM lab.device_events ev JOIN entities e ON e.id=ev.entity_id
    LEFT JOIN lab.history_bounds hb ON hb.entity_id=ev.entity_id AND hb.record_type='event'
    WHERE ev.received_at >= $2 AND ev.received_at < $3 AND ev.received_at >= GREATEST($6,hb.cleaned_before)
    UNION ALL
    SELECT 'run',r.started_at FROM lab.program_runs r JOIN entities e ON e.id=r.entity_id
    WHERE r.started_at >= $2 AND r.started_at < $3
), bounds AS (
    SELECT h.record_type,MIN(h.captured_since) AS captured_since,
        MAX(h.captured_since) AS fully_captured_since,MAX(h.cleaned_before) AS cleaned_before
    FROM lab.history_bounds h JOIN entities e ON e.id=h.entity_id
    WHERE h.record_type IN ('command','task','event') GROUP BY h.record_type
    UNION ALL
    SELECT 'run',MIN(e.created_at),MAX(e.created_at),NULL::timestamptz FROM entities e
), available AS (
    SELECT record_type,MIN(recorded_at) AS oldest_record_at,MAX(recorded_at) AS newest_record_at
    FROM retained GROUP BY record_type
)
SELECT k.record_type,b.captured_since,b.fully_captured_since,b.cleaned_before,
    a.oldest_record_at,a.newest_record_at
FROM (VALUES ('command'),('task'),('event'),('run')) k(record_type)
LEFT JOIN bounds b ON b.record_type=k.record_type
LEFT JOIN available a ON a.record_type=k.record_type
WHERE $5::text IS NULL OR k.record_type=$5
ORDER BY k.record_type
