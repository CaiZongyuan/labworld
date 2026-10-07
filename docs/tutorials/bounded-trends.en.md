# Query Bounded Trends With Preserved Sources

The current server uses Node 24 and TypeScript. Desktop web is the default scope. Run commands from the repository root on Linux or Windows without Docker. See [Node devices](../guides/server-devices.en.md), [synchronization](../guides/server-sync.en.md), and [operational records](../guides/server-traceability.en.md).

Goal: query one Entity's temperature or actual speed with the generated SDK. Identify real samples, sampling resolution, and history gaps.

## Starting State

Complete [continuous temperature](continuous-temperature.md) or [centrifuge tasks](centrifuge-tasks.md). Use a source revision containing this chapter's [trend route](../../packages/server/src/lab/history/trend.ts). Start the API and device programs. Queries do not require an open browser.

Run commands from the repository root. A Member needs an active session. An Agent needs an active `lab:full` key. These queries and failure checks do not create objects, start programs, or change retention.

Sources: [database trend model](../../packages/server/src/lab/history/trend.sql), [public HTTP checks](../../tests/server/lab-trend-supplement.test.ts), and [generated SDK](../../packages/sdk/src/generated/sdk.gen.ts). Use [run history](run-history.md) to read raw observations.

## Get A First Result

1. Select a sensor or centrifuge that has reported temperature in Lab.
2. Get its Lab and Entity UUIDs from the Inspector.
3. Create a `lab:full` API key in settings.
4. Set the API address and both identities. Replace the placeholders.

   ```bash
   export LAB_API_BASE=http://127.0.0.1:3000
   export LAB_ID='<lab-uuid>'
   export LAB_ENTITY_ID='<entity-uuid>'
   ```

5. Read the key and export the variable.

   ```bash
   read -rs LAB_API_KEY
   export LAB_API_KEY
   ```

6. Run the complete example.

   ```bash
   node examples/lab/query-trend.mjs
   ```

   The example calls generated `getLabEntityTrend` for the last hour of temperature. It checks size and item limits, rejects an invalid budget, then repeats the valid query.

Complete source:

<<< ../../examples/lab/query-trend.mjs

The workspace SDK contains TypeScript source. The example loads that SDK with existing Vite tooling. It does not start a Web server. Application code can import `createApiClient` and `getLabEntityTrend` from `@labos-threejs/sdk`.

A Member calls the same method with an active `cookie` header. For this Node example, use `LAB_SESSION_COOKIE` instead of `LAB_API_KEY`. Keep credentials out of source files and logs.

## Change The Range

1. Set the property to query a centrifuge's actual speed.

   ```bash
   export LAB_TREND_PROPERTY=speed
   ```

2. Set a UTC half-open range. Replace these timestamps with your device's actual report times.

   ```bash
   export LAB_TREND_FROM=2026-10-04T08:00:00Z
   export LAB_TREND_TO=2026-10-04T09:00:00Z
   export LAB_TREND_POINTS=600
   ```

3. Run the example again.

`GET /api/v1/lab/labs/{lab_id}/entities/{entity_id}/trend` requires `property`, `from`, and `to`. The first supported properties are `temperature` and `speed`. The current Entity or a persisted Binding must define that property as a numeric state. Archiving or replacing the definition with a static one preserves old reports. Their original Binding and Run remain queryable within retention.

| Field Or Limit                                        | Meaning                                                                                                              |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `from`, `to`                                          | RFC 3339 timestamps. Includes `from`, excludes `to`. The range must be positive and at most 24 hours.                |
| `max_points`                                          | Defaults to 600. Accepts 1 through 1000. Every sample and every gap count as one item.                               |
| Complete response                                     | At most 256 KiB and 10 SQL statements, including ordinary Member authentication.                                     |
| `raw_sample_count`                                    | Unique retained property samples in the range. Duplicates, empty reports, and other properties do not increase it.   |
| `returned_sample_count`, `plot_item_count`            | Returned real samples; then samples plus gaps.                                                                       |
| `sampling_strategy`, `resolution_seconds`             | Database buckets keep first/last/min/max within each segment. Zero resolution means that segment was not simplified. |
| `segments`                                            | Original Binding, Run, source, unit, quality, and whether source time is known.                                      |
| `samples`                                             | Original value, sequence, identity, `observed_at`, `received_at`, and `expires_at`, ordered by receive time.         |
| `gaps`                                                | Time ranges and reasons. Source, Run, Binding, unit, or quality changes can have zero-duration boundaries.           |
| `captured_since`, `retained_since`, `available_since` | Capture start, actual retention boundary, and the later boundary. Cleanup is irreversible.                           |
| `first_report_at`, `last_report_at`                   | First and last real property reports in this range. Null when none exist.                                            |

View different units separately. Do not convert them automatically. Do not connect segments, fill zeros, interpolate, or carry values forward. Do not extend an expired tail to the present. Unknown source time remains null. Display bad or uncertain quality and unknown source time separately from valid observations. Keep isolated real samples visible as points.

Built-in continuous sources report each second. When adjacent reports of this property exceed two reporting periods, the query marks `collection_gap`. Property expiry or source termination also breaks continuity. The response uses deployment retention settings. Missing samples and failed requests are different results.

When a Run stops before property expiry, the gap reports `run_stopped`. An interrupted persisted Run reports `run_interrupted`. These reasons use the real Run state. The sample's original `expires_at` remains unchanged.

Queries preserve the original property receive-time precision. Half-open comparisons use complete timestamps, including bounds between microseconds. Second rollover does not create samples or change original times. PostgreSQL row time selects indexed candidates. Final filtering and sampling remain inside the database.

## Check Failure And Recover

The example's `max_points=1001` request returns 400. Its next valid request can still read data. Unknown or nonnumeric properties, invalid ranges, and invalid identity formats also return 400. Unknown or cross-Lab Entities return 404.

Expired or revoked credentials return 401. A key without `lab:full` returns 403. Query again with active credentials. An error response does not establish that a device has no observations.

If real segments and gaps cannot fit the item or byte budget, the API returns 413 and `lab.trend_budget_exceeded`. Shorten the range and retry. The API does not silently truncate the range. Empty `segments` only describes this query's available property samples. Read its gaps and availability boundaries too.

Continue with [Entity lifecycle](entity-lifecycle.md) while preserving the same Entity and history. Chart consumers use this generated contract. This chapter delivers the public query.
