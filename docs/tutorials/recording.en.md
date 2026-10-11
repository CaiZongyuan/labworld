# Capture And Inspect A Lab Recording

Goal: run a Simulation Session, read its starting conditions, reliable motion segments and events, then check integrity and delete it independently.

Complete [fixed scenes and Simulation Sessions](simulation-session.en.md) first. Keep that chapter's `Shared Session` Lab, Installation, GLB asset and development data directory. Use the repository's Node and pnpm versions, plus Python with the pinned `websockets` dependency. Run the Bash commands from the repository root. This chapter uses the Synthetic development source. It requires no Newton, GPU or Docker.

## Capture One Run

If you stopped the previous chapter's server, restart it with the same directory:

```bash
LAB_WORD_SYNTHETIC_SESSION=true LAB_WORD_SYNTHETIC_PYTHON="$PWD/.scratch/session-python/bin/python" LAB_WORD_DATA_DIR=.scratch/session-tutorial-data pnpm dev
```

1. Open <http://127.0.0.1:5173/lab> and sign in as a Member.
2. Open the `Shared Session` Lab and **Simulation Session**.
3. Select the original Installation, then select **Start**.
4. Wait for **Running** and **Motion connected**.
5. Select **Pause** and wait for the paused state.
6. Wait several seconds, then select **Resume**.
7. Let it run for several seconds. Select **Stop** and wait for the stopped state.

Start automatically creates one Recording. The server saves and syncs starting conditions before accepting the reliable source header and first frame. Running means initial reliable capture and live motion both passed admission. It does not prove a robot task succeeded.

The source retains each complete selected motion frame before offering it to the live sender. Live delivery can replace an older pending frame. Recording keeps every selected sample with no Viewer, a disconnected Viewer or a slow Viewer. Selected samples do not represent every physics solver step.

## Read The Recording And Actual Segments

Run this in the Console of the authenticated Lab page:

```js
(await (await fetch('/api/v1/lab/labs')).json()).data.map(({ id, name }) => ({
  id,
  name,
}));
```

Replace the Lab UUID below with the `Shared Session` identity. This bounded first-page query does not change the Lab:

```js
(
  await (await fetch('/api/v1/lab/labs/<lab-uuid>/recordings?limit=5')).json()
).data.map(({ id, session_id, status, integrity, reason }) => ({
  id,
  session_id,
  status,
  integrity,
  reason,
}));
```

Find the Recording UUID associated with the Session you just stopped. Paste this complete example into the Console:

<<< ../examples/recording-inspection.js

Run `await inspectRecording('<lab-uuid>', '<recording-uuid>')`.

The result includes Recording and Session identities, status, integrity, reason, reliable prefix, versions, and first pages of segments and events. After normal Stop completes, `status` and `integrity` are `complete`, and `prefix.source_ended` is `true`. Read again if the final segment is still being completed. Do not interpret temporary `open` status as complete.

The example reads at most five segments and five events, then downloads one sealed segment. It verifies segment size and SHA-256. It also checks up to the first 16 LWF records. `first_record` is usually the startup header. `source_header` shows an accepted source version header among those records. If it is null, inspect later records before interpreting dependency versions. When `verified_segment_id` is null, that page has no sealed segment yet. Read again after Stop.

A segment contains original facts. Each LWF record contains a little-endian u32 JSON length, a 32-byte SHA-256 and UTF-8 JSON. The `packet_base64` field in `source.packet` preserves original LWR1 bytes. Motion batches preserve original LWM1 frames. These bytes support independent checks without inferring Recording content from the Gateway's latest frame.

## Understand Time And Integrity

| Field                              | Meaning                                                                                                                                                    |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `snapshot_hash`, `manifest_sha256` | Identities of the fixed snapshot and manifest. Current layout or asset updates do not rewrite them.                                                        |
| `capture_baseline`                 | Ordinary device state, active Commands and times when capture starts. Reset keeps the original physics snapshot and saves a new baseline.                  |
| `versions`, `source.header`        | Server versions and source-reported code, Python and dependency versions. Unknown values stay null. Source reports are not independent installation proof. |
| `recorded_at`                      | Real time when the server records a fact. Ordinary device time continues during physics Pause.                                                             |
| `sim_time_ns`                      | Source simulation time as a decimal string. Ordinary Device Program events use null.                                                                       |
| `prefix`                           | The contiguous synced source prefix. Motion sequence, source event sequence and global record ordinal have separate meanings.                              |
| `incomplete`, `reason`             | Only preserved valid facts are assured. An unconfirmed tail can remain unknown; it does not prove there was no activity.                                   |

Pause and Resume each save a new boundary frame and a `lifecycle.applied` event. Their simulation times can match, while sequences increase. Stop also saves the final source frontier and source-end fact. Complete status additionally requires saved server events and final segments.

Reset ends the old Session and Recording, then creates new identities for both. The new source starts at simulation time zero. The old Recording's time never moves backward. Ordinary Device Program Runs keep their own real-time behavior. Physics Pause, Reset and Stop do not stop their tasks.

`capture_entity_ids` fixes the World membership at capture. `physics_entity_ids` includes only the Installation's physics-bound objects. Entities created later do not join this old Recording. Missing prior property values remain unknown.

A reliable ACK confirms only contiguous source facts whose file sync completed. Network send completion, live frame receipt and applied actions are separate confirmations. Capacity exhaustion, write failure, confirmation timeout or source failure stops or interrupts the Session and preserves explicit incomplete status. Actions do not replay automatically.

## Pagination And SDK

These reads require an active Member identity for the Lab, or an Agent key with `lab:full`:

| Method and path suffix                                 | Result                                                                    |
| ------------------------------------------------------ | ------------------------------------------------------------------------- |
| `GET /recordings`                                      | Recording metadata page.                                                  |
| `GET /recordings/{recording_id}`                       | One Recording's metadata and integrity.                                   |
| `GET /recordings/{recording_id}/manifest`              | Fixed snapshot, current capture baseline, object membership and versions. |
| `GET /recordings/{recording_id}/segments`              | Segment metadata page.                                                    |
| `GET /recordings/{recording_id}/segments/{segment_id}` | One segment's actual bytes.                                               |
| `GET /recordings/{recording_id}/events`                | Confirmed event page.                                                     |

All suffixes follow `/api/v1/lab/labs/{lab_id}`. List `limit` defaults to 20 and accepts 1 to 100. Event pages also have a 256 KiB budget. Keep `next_cursor` and send it as `cursor` to the same list. Segment and event cursors bind the current Recording. Start at the first page when changing Labs, Recordings or filters.

The generated SDK provides the same list and read methods. [readRecordingSegment](../../packages/sdk/src/recording.ts) verifies one sealed segment, with a 1 MiB limit. The caller owns the AbortSignal and decides when to replace the current page. Do not combine an entire Recording's segments in memory.

## Delete Independently

1. Start the same Installation again, run it for several seconds, then Stop to create Recording B.
2. Read A and B. Their Recording and Session identities differ, while they reference the same fixed GLB version.
3. Save one sealed segment identity and SHA-256 from B.
4. Explicitly run `await deleteRecording('<lab-uuid>', '<recording-a-uuid>')`.
5. Query the Recording list again. A is removed.
6. Run `inspectRecording` for B. Its original segment and SHA-256 remain readable.

Deletion changes persistent data. The function uses the current Member's CSRF token. An active Recording returns 409. Stop it before explicitly deleting it. Invalid identities return 401. Missing permissions or CSRF return 403. Cross-Lab or absent identities return 404. Obtain valid access, then repeat your explicit request.

Recording owns exact resource references. Deleting A releases only A's references. Files remain when B, a current asset or another consumer still uses them. Ordinary device history cleanup does not delete Recording facts.

## Cause An Isolated Write Failure

Run this real process contract case from the repository root:

```bash
node --test --test-concurrency=1 --experimental-strip-types --test-name-pattern='recording write failure' tests/e2e/recording-reliability.test.ts
```

First run `pnpm install --frozen-lockfile` and use the repository's Node version. This case requires no Python, GPU or running tutorial server. It creates its own temporary data directory, loopback server and authenticated Machine source.

The case sends and retains externally confirmed t0 bytes. Test-process IPC then injects one failure before the next `source.packet` file write. The case sends another selected motion frame and reads the result through the official API.

Expect a passing Node test and a nonsecret `recording-write-failure` receipt. The next frame receives no durable ACK. The Session becomes interrupted. Recording becomes incomplete, with a write-failure reason. Its complete acknowledged t0 bytes remain readable through the segment API. The case cleans its processes, sockets and temporary data directory, then reconciles the ownership ledger.

The IPC fault applies only to this isolated test process. Tutorial data remains unchanged.

After a source crash or server process force-kill, reopening the same data directory preserves verifiable valid segments and interrupts the old Session. Unconfirmed tail facts can remain unknown. Durability evidence covers actual source/server process termination, sync and reopen checks. It does not cover operating-system crashes or power loss. Start a new Session explicitly.

## Finish

Stop the active Session, close the Viewer, then stop development with Ctrl+C. The supervisor releases its Python source, both sockets and timers. Keep `.scratch/session-tutorial-data` and the Python environment, or remove them independently after confirming all consumers stopped.

Read [Lab records](lab-records.en.md) for ordinary history queries and retention. Recording queries describe saved facts from that experiment. Replay, external rendering, remote Newton and physics tasks remain future work.
