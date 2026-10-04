SELECT EXISTS(
    SELECT 1 FROM lab.device_commands c JOIN lab.entities e ON e.id=c.entity_id
    WHERE e.lab_id=$1::uuid AND ($2::uuid IS NULL OR e.id=$2::uuid)
        AND $3='command' AND c.id=$4::uuid AND c.created_at=$5
    UNION ALL
    SELECT 1 FROM lab.device_tasks t JOIN lab.entities e ON e.id=t.entity_id
    WHERE e.lab_id=$1::uuid AND ($2::uuid IS NULL OR e.id=$2::uuid)
        AND $3='task' AND t.id=$4::uuid AND t.created_at=$5
    UNION ALL
    SELECT 1 FROM lab.device_events ev JOIN lab.entities e ON e.id=ev.entity_id
    WHERE e.lab_id=$1::uuid AND ($2::uuid IS NULL OR e.id=$2::uuid)
        AND $3='event' AND ev.id=$4::uuid AND ev.received_at=$5
    UNION ALL
    SELECT 1 FROM lab.program_runs r JOIN lab.entities e ON e.id=r.entity_id
    WHERE e.lab_id=$1::uuid AND ($2::uuid IS NULL OR e.id=$2::uuid)
        AND $3='run' AND r.id=$4::uuid AND r.started_at=$5
)
