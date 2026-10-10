# Read the overview and filter devices

Goal: scan devices, Tasks, key observations, and attention facts in one Lab. Then open the original device. These views share the World subscription and Entity detail.

## Starting state

Complete [device operations](device-details.md), [device trends](device-trends.md), or [Lab records](lab-records.md). Register at least one light and one temperature sensor. Use a valid Member session. An Agent needs a valid `lab:full` API key. The server uses Node 24. Linux and Windows do not need Docker.

From the repository root, run `pnpm install --frozen-lockfile`, then `pnpm dev`. Viewing does not change devices, layouts, or registered locations. Device operations still write persistent records.

Source: [workbench](../../packages/views/src/lab/workbench-context.tsx), [operations view](../../packages/views/src/lab/operations-view.tsx), [summaries and regions](../../packages/views/src/lab/operations-state.ts), and [property validity](../../packages/views/src/lab/observation-state.ts). Lab owns these business rules. Platform Core owns identity and sessions.

## Open the original device

1. Open `http://127.0.0.1:5173/lab` and sign in. Without a `view` parameter, Lab first opens “3D space”.
2. Select “Overview”. Read Registered devices, Active Tasks, Current valid observations, and Devices needing attention.
3. Select “Registered devices”. The directory includes active instrument, iot, sensor, and robot Entities. Unplaced devices count. Multiple Scene Nodes count once per Entity.
4. Select a device name. The shared “Object information” shows the same Entity's values, source, Run, Task, and result. Closing detail returns focus to its entry.
5. Return to “Overview”. Select an “Environment sensor” registered in this Lab. Choose 1, 6, or 24 hours. Read real samples and gaps.
6. In “Recent activity”, select “Open original Entity”. Detail shows the result stored in that record. A new Task or Run cannot replace it.
7. Select “View all Lab records”. Continue with device, category, and time filters.

Recent activity reads at most five records from the first page. It excludes raw Observations and does not represent complete history. Environment trends reuse [device trend](device-trends.md) queries, sampling, and source descriptions. Without a registered sensor, the view shows an empty state.

## Interpret the summaries

Active Task stages are pending, preparing, running, and decelerating. A running program Run does not prove an active Task exists.

All required key properties must match the fixed definition, current Binding, and running Run. Their source times must be known. Quality must be good and freshness current. Only then does the device count as having current valid observations. `0` and `false` are valid. Unknown values stay unknown. A heartbeat or another property's update cannot refresh an old property.

“Needs attention” merges retained interruption, failure, uncertain result, expiration, quality, and unknown source time facts for each device. Uncertain results and interruptions come first. Within a priority, the earliest relevant fact comes first. Normal stops, programs not started, and absent Bindings remain separate. A live connection does not prove device health. This page has no alert acknowledgment, notification, or work order process.

## Filter regions and retain space access

1. Open “Devices”. In “Search name or identity”, enter a name, identity fragment, or existing label.
2. Select “Runtime status”. Summary buttons also open their matching set.
3. Select “Registered region” or “No registered region”. Manual `located_in` and `contains` relationships identify the nearest Location. Placement cannot establish a region.
4. Select “Unplaced objects only”. A device without Scene Nodes remains accessible.
5. Select “Full object directory”. The space directory still provides furniture, labware, locations, and models.
6. Select “Archived objects”. Archived identities and retained records remain accessible.

View changes preserve valid filters, the selected Entity, and unsaved layout drafts. Open `/lab?lab=<lab-uuid>&view=devices&entity=<entity-uuid>`, then refresh. The same device opens. Replace the Entity with a missing identity. The view shows “Entity not found”. Select “Clear Entity link” to continue in the current view. A missing Lab cannot silently select another Lab.

## Recover after disconnecting

1. Keep the page open. Disconnect the network with browser developer tools.
2. Read “Last synchronized snapshot · Read only” and its time. Loaded content and inputs remain. New writes are disabled. Last reported values do not prove current measurements.
3. Restore the network or select “Reconnect”. The workbench refreshes World, visible environment trends, and recent activity. Valid filters and layout drafts remain.
4. If the session expires or is revoked, sign in again. The new identity cannot use old subscriptions or operation attempts.

Failed trend or activity queries retain previously loaded content and show the failure. Use the reader's refresh or retry button. Old curves, accepted Commands, and snapshots cannot prove a device action completed.

## Verify

Run from the repository root:

```bash
pnpm exec vitest run apps/web/src/lab-operations.test.tsx
pnpm test:e2e tests/e2e/lab-operations.spec.ts
```

Views checks use MSW only for HTTP. Browser checks use an isolated Node service and temporary persistent directory. They preserve existing development data. They check a Member, second browser, and Agent against the same World, at desktop and existing agreed narrow viewports. CI retains World, realtime, and bundle budgets.
