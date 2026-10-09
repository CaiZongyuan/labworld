WITH bounds AS (
    SELECT (b->'from'->>'seconds')::numeric+(b->'from'->>'nanos')::numeric/1000000000 AS from_time,
      (b->'to'->>'seconds')::numeric+(b->'to'->>'nanos')::numeric/1000000000 AS to_time,
      (b->'retained'->>'seconds')::numeric+(b->'retained'->>'nanos')::numeric/1000000000 AS retained_time,
      (b->'captured'->>'seconds')::numeric+(b->'captured'->>'nanos')::numeric/1000000000 AS captured_time,
      b->'from'->'value' AS from_value,b->'to'->'value' AS to_value
    FROM (SELECT $8::jsonb AS b) input
), reports AS (
    SELECT h.id,h.data->'properties'->$2 AS p,r.ended_at,r.started_at,r.status AS run_status,
      CASE WHEN b.program_id IN ('sensor.v1','centrifuge.v1') THEN 1.0 END AS report_interval_seconds
    FROM lab.observation_history h
    JOIN lab.program_runs r ON r.id=h.run_id JOIN lab.runtime_bindings b ON b.id=r.binding_id
    WHERE h.entity_id=$1::uuid AND h.received_at>=GREATEST($3,$6)-interval '1 microsecond'
      AND h.received_at<$4::timestamptz+interval '1 microsecond'
      AND h.data->'values' ? $2 AND h.data->'properties' ? $2
), precise AS (
    -- Parse whole seconds first so PostgreSQL's fractional tie rounding cannot alter the original fraction.
    SELECT reports.*,
      EXTRACT(epoch FROM REGEXP_REPLACE(p->>'received_at','\.[0-9]+','')::timestamptz)+rx_fraction AS received_time,
      EXTRACT(epoch FROM REGEXP_REPLACE(p->>'expires_at','\.[0-9]+','')::timestamptz)+expiry_fraction AS expiry_time,
      EXTRACT(epoch FROM ended_at) AS ended_time
    FROM reports CROSS JOIN LATERAL (
      SELECT ('0.'||COALESCE(SUBSTRING(p->>'received_at' FROM '\.([0-9]+)'),'0'))::numeric AS rx_fraction,
        ('0.'||COALESCE(SUBSTRING(p->>'expires_at' FROM '\.([0-9]+)'),'0'))::numeric AS expiry_fraction
    ) fractions
), raw AS MATERIALIZED (
    SELECT DISTINCT ON (p->>'binding_id',p->>'run_id',p->>'sequence') id,p,received_time,started_at,
      GREATEST(received_time,LEAST(expiry_time,ended_time)) AS valid_until,
      CASE WHEN ended_time<=expiry_time THEN
        CASE run_status WHEN 'stopped' THEN 'run_stopped' WHEN 'interrupted' THEN 'run_interrupted' ELSE 'run_ended' END
        ELSE 'expired' END AS end_reason,report_interval_seconds
    FROM precise CROSS JOIN bounds
    WHERE jsonb_typeof(p->'value')='number' AND received_time>=GREATEST(from_time,retained_time) AND received_time<to_time
    ORDER BY p->>'binding_id',p->>'run_id',p->>'sequence',received_time,id
), previous AS (
    SELECT *,LAG(p) OVER timeline AS prev,LAG(received_time) OVER timeline AS prev_time,
      LAG(valid_until) OVER timeline AS prev_until,LAG(end_reason) OVER timeline AS prev_end_reason,
      LAG(report_interval_seconds) OVER timeline AS prev_interval
    FROM raw WINDOW timeline AS (ORDER BY received_time,started_at,(p->>'sequence')::bigint,id)
), boundaries AS (
    SELECT *,ARRAY_REMOVE(ARRAY[
      CASE WHEN p->'binding_id' IS DISTINCT FROM prev->'binding_id' THEN 'binding_changed' END,
      CASE WHEN p->'run_id' IS DISTINCT FROM prev->'run_id' THEN 'run_changed' END,
      CASE WHEN p->'source' IS DISTINCT FROM prev->'source' THEN 'source_changed' END,
      CASE WHEN p->'unit' IS DISTINCT FROM prev->'unit' THEN 'unit_changed' END,
      CASE WHEN p->'quality' IS DISTINCT FROM prev->'quality' THEN 'quality_changed' END,
      CASE WHEN (p->'observed_at'='null'::jsonb) IS DISTINCT FROM (prev->'observed_at'='null'::jsonb)
        THEN CASE WHEN p->'observed_at'='null'::jsonb THEN 'source_time_unknown' ELSE 'source_time_restored' END END,
      CASE WHEN received_time>=prev_until THEN prev_end_reason END,
      CASE WHEN received_time-prev_time>2*prev_interval THEN 'collection_gap' END
    ],NULL) AS reasons FROM previous
), segmented AS MATERIALIZED (
    SELECT *,SUM(CASE WHEN prev IS NULL OR CARDINALITY(reasons)>0 THEN 1 ELSE 0 END)
      OVER (ORDER BY received_time,started_at,(p->>'sequence')::bigint,id) AS segment FROM boundaries
), gaps AS MATERIALIZED (
    SELECT GREATEST(b.from_time,LEAST(received_time,prev_until,
      CASE WHEN 'collection_gap'=ANY(reasons) THEN prev_time+prev_interval ELSE received_time END)) AS from_time,
      received_time AS to_time,reasons FROM segmented CROSS JOIN bounds b
    WHERE prev IS NOT NULL AND CARDINALITY(reasons)>0
    UNION ALL SELECT from_time,LEAST(to_time,retained_time),ARRAY['retention']::text[] FROM bounds WHERE from_time<retained_time
    UNION ALL SELECT GREATEST(from_time,retained_time),LEAST(to_time,captured_time,COALESCE((SELECT MIN(received_time) FROM raw),to_time)),ARRAY['collection_not_started']::text[]
    FROM bounds WHERE LEAST(to_time,captured_time,COALESCE((SELECT MIN(received_time) FROM raw),to_time))>GREATEST(from_time,retained_time)
    UNION ALL SELECT GREATEST(from_time,retained_time,LEAST(captured_time,first_time)),first_time,ARRAY['no_sample']::text[]
    FROM bounds CROSS JOIN (SELECT MIN(received_time) AS first_time FROM raw) first_sample
    WHERE first_time>GREATEST(from_time,retained_time,LEAST(captured_time,first_time))
    UNION ALL SELECT GREATEST(from_time,valid_until),to_time,ARRAY[end_reason]::text[]
    FROM bounds CROSS JOIN (SELECT * FROM raw ORDER BY received_time DESC,started_at DESC,(p->>'sequence')::bigint DESC,id DESC LIMIT 1) last_sample WHERE valid_until<to_time
    UNION ALL SELECT GREATEST(from_time,retained_time,captured_time),to_time,ARRAY['no_sample']::text[]
    FROM bounds WHERE NOT EXISTS(SELECT 1 FROM raw) AND GREATEST(from_time,retained_time,captured_time)<to_time
), segment_stats AS (
    SELECT segment,COUNT(*) AS count,MIN(received_time) AS first_time,MAX(received_time) AS last_time FROM segmented GROUP BY segment
), population AS (
    SELECT (SELECT COUNT(*) FROM raw) AS raw_count,(SELECT COUNT(*) FROM gaps) AS gap_count
), allocation AS (
    SELECT GREATEST(1,FLOOR(($5::bigint-(SELECT gap_count FROM population)-COALESCE(SUM(count) FILTER(WHERE count<=4),0))
      /GREATEST(1,4*COUNT(*) FILTER(WHERE count>4)))) AS buckets FROM segment_stats
), bucketed AS (
    SELECT s.*,stats.count,
      GREATEST(0.000000001,(stats.last_time-stats.first_time)
        /CASE WHEN stats.count<=4 THEN 1 ELSE a.buckets END)::double precision AS seconds,
      CASE WHEN stats.count<=4 THEN 0 ELSE LEAST(a.buckets-1,FLOOR((s.received_time-stats.first_time)/GREATEST(0.000000001,(stats.last_time-stats.first_time)/a.buckets))) END AS bucket
    FROM segmented s JOIN segment_stats stats USING(segment) CROSS JOIN allocation a
), endpoints AS (
    SELECT *,ROW_NUMBER() OVER(PARTITION BY segment,bucket ORDER BY received_time,(p->>'sequence')::bigint,id) AS first_rank,
      ROW_NUMBER() OVER(PARTITION BY segment,bucket ORDER BY received_time DESC,(p->>'sequence')::bigint DESC,id DESC) AS last_rank FROM bucketed
), ranked AS (
    SELECT *,ROW_NUMBER() OVER(PARTITION BY segment,bucket ORDER BY (p->>'value')::numeric,(first_rank=1 OR last_rank=1) DESC,received_time,(p->>'sequence')::bigint,id) AS min_rank,
      ROW_NUMBER() OVER(PARTITION BY segment,bucket ORDER BY (p->>'value')::numeric DESC,(first_rank=1 OR last_rank=1) DESC,received_time,(p->>'sequence')::bigint,id) AS max_rank FROM endpoints
), selected AS MATERIALIZED (
    SELECT * FROM ranked WHERE (SELECT raw_count+gap_count FROM population)<=$5 OR first_rank=1 OR last_rank=1 OR min_rank=1 OR max_rank=1
), totals AS (
    SELECT raw_count,(SELECT COUNT(*) FROM selected) AS returned_count,
      (SELECT COUNT(*) FROM selected)+gap_count AS plot_count FROM population
), samples AS (
    SELECT segment,CASE WHEN COUNT(*)=MAX(count) THEN 0.0 ELSE MAX(seconds) END AS seconds,
      (jsonb_agg(p ORDER BY received_time,(p->>'sequence')::bigint,id)->0) AS p,
      jsonb_agg(jsonb_build_object('id',id,'value',p->'value','sequence',p->'sequence','observed_at',p->'observed_at',
        'received_at',p->'received_at','expires_at',p->'expires_at') ORDER BY received_time,(p->>'sequence')::bigint,id) AS items
    FROM selected WHERE (SELECT plot_count FROM totals)<=$5 GROUP BY segment
), gap_values AS (
    SELECT g.*,
      CASE WHEN g.from_time=b.from_time THEN b.from_value WHEN g.from_time=b.to_time THEN b.to_value ELSE
        to_jsonb(TO_CHAR(TO_TIMESTAMP(FLOOR(g.from_time)::double precision) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'.'||LPAD(TRUNC((g.from_time-FLOOR(g.from_time))*1000000000)::bigint::text,9,'0')||'Z') END AS from_value,
      CASE WHEN g.to_time=b.to_time THEN b.to_value WHEN g.to_time=b.from_time THEN b.from_value ELSE
        to_jsonb(TO_CHAR(TO_TIMESTAMP(FLOOR(g.to_time)::double precision) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS')||'.'||LPAD(TRUNC((g.to_time-FLOOR(g.to_time))*1000000000)::bigint::text,9,'0')||'Z') END AS to_value
    FROM gaps g CROSS JOIN bounds b WHERE (SELECT plot_count FROM totals)<=$5
)
SELECT jsonb_build_object('raw_sample_count',raw_count,'returned_sample_count',returned_count,'plot_item_count',plot_count,'budget_exceeded',plot_count>$5,
  'first_report_at',(SELECT p->'received_at' FROM raw ORDER BY received_time,started_at,(p->>'sequence')::bigint,id LIMIT 1),
  'last_report_at',(SELECT p->'received_at' FROM raw ORDER BY received_time DESC,started_at DESC,(p->>'sequence')::bigint DESC,id DESC LIMIT 1),
  'segments',COALESCE((SELECT jsonb_agg(jsonb_build_object('binding_id',p->'binding_id','run_id',p->'run_id','source',p->'source','quality',p->'quality','unit',p->'unit',
    'source_time_known',p->'observed_at'<>'null'::jsonb,'resolution_seconds',seconds,'samples',items) ORDER BY segment) FROM samples),'[]'::jsonb),
  'gaps',COALESCE((SELECT jsonb_agg(jsonb_build_object('from',from_value,'to',to_value,'reasons',reasons) ORDER BY from_time,to_time) FROM gap_values),'[]'::jsonb)
) FROM totals
