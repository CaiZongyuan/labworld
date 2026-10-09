# Read real trends in device details

Continue in the same Lab from [Device details](device-details.md). You need a signed-in Member and a running Lab Word Server. Trends read retained property reports.

## Create temperature history

1. Open Lab.
2. Select **Register object**.
3. Select `sensor@1.0` and **Simulated object**.
4. Enter `Trend sensor`, then register it.
5. Select **Start program** in its **Operations** tab.
6. Wait for **Current key observations valid**.

The current temperature comes from World property observations. A trend query does not change this reading. A stopped source keeps its last value, time and source.

## Read a range and its samples

1. Select **Show trends**.
2. Scroll inside the Inspector to the chart.
3. Select **1 hour**, **6 hours** or **24 hours**.
4. Read **Queried through** and **Returned / raw samples**.
5. Point at a sample.
6. Focus the chart with the keyboard, then use the arrow keys.
7. Tap a sample, or read the **Trend readings** table below.

The axis uses actual received times and a UTC scale. Each sample keeps its value, unit, observed time, received time, source, Run, Binding and sequence. Missing source time stays unknown.

The server preserves each bucket’s first, last, minimum and maximum reported samples. **Sampling resolution** gives the effective seconds per segment. Zero means no reduction. Returned samples are neither all raw samples nor averages. The value axis includes the returned spikes.

Different units have separate charts and value axes. The application does not convert units. Hollow points and dashed lines mark uncertain or bad quality, or unknown source time.

## Open the recent minute from space

1. Select this sensor’s scene representation.
2. Select **Recent minute** beside its reading.
3. Read the same Entity’s **Operations** and **1 minute** range.

This entry preserves the camera, Placement and layout draft. It uses the same trend query and ordinary device details.

Centrifuge trends also offer **Temperature trend** and **Speed trend**. Speed comes from reported `speed` values, rather than Task targets. Temperature and RPM are separate queries.

## Identify gaps and recover

1. Select **Stop program**.
2. Select **Refresh trend**.
3. Read the **Source stopped** gap.
4. Start a new program explicitly.
5. Wait for its Run to report, then refresh.

The new Run preserves old reports and their identities. Paths stop between segments. The chart does not fill gaps with zero or extend expired endpoints. Isolated samples remain visible points.

**Querying trend**, **No samples in this range**, **History gaps** and **Trend query failed** are distinct states. Expand **Data coverage** to read collection, retention and availability bounds.

A failed query keeps the loaded chart and table with their original cutoff. A budget error suggests a shorter range. Select that range, then select **Refresh trend**. Empty data does not replace a failure.

Only visible trends respond to World updates, at most once every five seconds. Manual refresh is immediate. Closing trends, changing detail tabs or hiding the browser page stops automatic refresh. Showing them again reads history for the latest World.

An expired identity stops access. Sign in again to query with the new identity’s cache scope. Old responses cannot enter a different Lab, Entity, property or time range.

## Use the same public query

A Member and a valid `lab:full` Agent use the same generated SDK. Keep the credentials and Entity from [Bounded trends](bounded-trends.md), then run its complete example.

```bash
node examples/lab/query-trend.mjs
```

<<< ../../examples/lab/query-trend.mjs

The first release supports up to 24 hours, including `from` and excluding `to`. The ordinary interface requests 600 plot items. See [Bounded trends](bounded-trends.md) for API and retention limits.

Continue with [Backend lights](backend-lights.md). Compare Commands and reported observations as a Member and an Agent.
