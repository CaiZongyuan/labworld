# Trace and Retain Operational Facts with Node

Goal: query device history, mixed Lab records and trends, then archive safely. Complete [World synchronization](server-sync.en.md) first. Keep a sensor or centrifuge Entity with recorded activity. Use an active Member or `lab:full` Agent. Run commands from the repository root.

## Query Existing Facts

```bash
export LAB_API_BASE=http://127.0.0.1:3000
export LAB_ID='<lab-uuid>'
export LAB_ENTITY_ID='<sensor-or-centrifuge-uuid>'
read -rs LAB_API_KEY
export LAB_API_KEY
node examples/lab/query-history.mjs
node examples/lab/query-records.mjs
node examples/lab/query-trend.mjs
```

<<< ../../examples/lab/query-history.mjs

History queries observation, command, task or event. It defaults to 20 items and permits 100, 256 KiB and 31 days. Continue with the same Entity, type and range. Invalid queries leave World unchanged. Correct the fields and retry.

Records combine Command, Task, Event and Run. Pages retain their first `query_upper_bound` and order `(recorded_at, record_type, id)`. New records stay outside that window. Program-stop events retain unknown attribution. A Task cannot invent its source after its original Command is removed.

Trend queries temperature or speed with an inclusive from and exclusive to. It allows 24 hours and defaults to 600 plot items, including gaps. The maximum is 1000 items. The database selects true first/last/min/max samples. It does not join lines across source, unit, quality, Run or collection boundaries. Browsers receive bounded results. World, Records and Trend allow ten submitted SQL statements per request, including authentication and transaction controls.

## Clean Ended Records and Keep Last Values

Raw Observations default to 86400 seconds. Ended records default to 2592000 seconds. Runs have no new cleanup policy. Cleanup retains Entity identity, configuration, last properties and unfinished Tasks.

```bash
curl -X POST "http://127.0.0.1:3000/api/v1/lab/labs/$LAB_ID/history/cleanup" \
  -H "Authorization: Bearer $LAB_API_KEY"
```

This command deletes expired persistent records in the Lab. Use disposable directories for short retention tests. Set `LAB_OBSERVATION_RETENTION_SECS` and `LAB_RECORD_RETENTION_SECS`, then restart the Node server. Both settings allow 1–31536000 seconds. available_since and gap identify the retained range.

## Archive and Change Appearance

Wait for the Task to end, then stop the Run and execute:

```bash
node examples/lab/manage-entity.mjs
```

The script changes and archives the selected Entity. Running programs and unfinished Tasks prevent archive and definition changes. Archive keeps identity, references and retained records. Appearance can change during operation. It preserves Binding, Run, Task and Observation. A definition change keeps the old Run's original definition and source. Start a new Run explicitly.

[History and retention](../../packages/server/src/lab/history/use-cases.ts), [mixed records](../../packages/server/src/lab/records/use-cases.ts), [database trends](../../packages/server/src/lab/history/trend.sql), and [lifecycle](../../packages/server/src/lab/world/lifecycle.ts) own these behaviors. `pnpm test:contract:server` runs complete Node contracts in isolated directories with resource ledgers. The official SDK and default application composition switch remains a later migration step.
