ALTER TABLE lab.program_runs ADD COLUMN last_observed_at timestamptz;

UPDATE lab.program_runs r
SET last_observed_at=o.observed_at
FROM lab.current_observations o
WHERE o.run_id=r.id AND o.observed_at IS NOT NULL;
