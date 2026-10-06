import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  mkdir,
  writeFile,
  appendFile,
  readdir,
  stat,
  copyFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ServerProcess } from '../tests/support/server-process.ts';
const duration = process.argv.includes('--duration-seconds')
  ? Number(process.argv[process.argv.indexOf('--duration-seconds') + 1])
  : 1800;
if (!Number.isInteger(duration) || duration < 1)
  throw new Error('Duration must be a positive integer');
const output = resolve(
  process.argv.includes('--output')
    ? process.argv[process.argv.indexOf('--output') + 1]
    : `.scratch/vnext-m1/spike-${Date.now()}`,
);
await mkdir(output, { recursive: true });
const target = await new ServerProcess().create();
target.entry = 'tests/support/spike-process.ts';
const streams: Array<{
  controller: AbortController;
  updates: number;
  samples: number;
  snapshots: number;
  maximumBytes: number;
  active: boolean;
  task: Promise<void>;
}> = [];
const injectFinalFailure = process.argv.includes('--inject-final-read-failure');
let running = true;
let background: Promise<void> | undefined;
let failure: unknown;
let started: number;
const ticks: Array<{
  tick: number;
  scheduled_ms: number;
  started_ms: number;
  committed_ms: number;
  drift_ms: number;
}> = [];
const metadata: Array<unknown> = [];
let concurrentReads = 0;
let concurrentWrites = 0;
async function bytes(directory: string): Promise<number> {
  let size = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const p = join(directory, entry.name);
    size += entry.isDirectory() ? await bytes(p) : (await stat(p)).size;
  }
  return size;
}
async function subscribe() {
  const controller = new AbortController();
  const response = await fetch(`${target.url}/proof/events`, {
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  let resolveReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve;
  });
  const observed = {
    controller,
    updates: 0,
    samples: 0,
    snapshots: 0,
    maximumBytes: 0,
    active: true,
    task: Promise.resolve(),
  };
  observed.task = (async () => {
    const reader = response.body!.getReader();
    let buffer = '';
    const decoder = new TextDecoder();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decoder.decode(chunk.value, { stream: true });
        let boundary: number;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const event = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const name = event.match(/^event: ?(.+)$/m)?.[1];
          const data = event.match(/^data: ?(.+)$/m)?.[1];
          if (!data) continue;
          const count = Buffer.byteLength(data);
          observed.maximumBytes = Math.max(observed.maximumBytes, count);
          assert.ok(count <= 1024 * 1024);
          if (name === 'snapshot') {
            observed.snapshots++;
            resolveReady();
          } else if (name === 'update') {
            observed.updates++;
            observed.samples += (
              JSON.parse(data) as { samples: unknown[] }
            ).samples.length;
          }
        }
      }
      if (!controller.signal.aborted)
        throw new Error('SSE subscriber ended unexpectedly');
    } catch (error) {
      if (!controller.signal.aborted) {
        failure = error;
        throw error;
      }
    } finally {
      observed.active = false;
    }
  })();
  observed.task.catch(() => {});
  streams.push(observed);
  await ready;
}
try {
  const cold = performance.now();
  await target.start();
  const coldStartMs = performance.now() - cold;
  await copyFile(
    join(target.evidence, 'owned-resources.json'),
    join(output, 'owned-resources-at-start.json'),
  );
  const initial = (await (
    await fetch(`${target.url}/proof/devices`)
  ).json()) as { devices: Array<{ entity_id: string }> };
  const devices = initial.devices.slice(0, 20);
  await Promise.all([subscribe(), subscribe()]);
  metadata.push(await (await fetch(`${target.url}/proof/metadata`)).json());
  started = performance.now();
  const wallStart = Date.now();
  background = (async () => {
    let sequence = 1;
    while (running) {
      assert.equal(streams.filter((s) => s.active).length, 2);
      const read = Promise.all([
        fetch(`${target.url}/proof/world`),
        fetch(
          `${target.url}/proof/history?entity_id=${devices[0].entity_id}&limit=100`,
        ),
      ]).then(async (responses) => {
        for (const response of responses) {
          assert.equal(response.status, 200);
          assert.ok(Buffer.byteLength(await response.text()) <= 256 * 1024);
          concurrentReads++;
        }
      });
      const write = fetch(`${target.url}/proof/samples`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([
          {
            id: randomUUID(),
            entity_id: initial.devices[20].entity_id,
            received_at: new Date().toISOString(),
            value: sequence,
            sequence: sequence++,
          },
        ]),
      }).then(async (response) => {
        assert.equal(response.status, 201);
        await response.text();
        concurrentWrites++;
      });
      await Promise.all([read, write]);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  })().catch((error) => {
    failure = error;
  });
  for (let tick = 1; tick <= duration; tick++) {
    const scheduled = tick * 1000;
    const wait = started + scheduled - performance.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    if (failure) throw failure;
    assert.equal(streams.filter((s) => s.active).length, 2);
    const begin = performance.now() - started;
    const samples = devices.map((device, index) => ({
      id: randomUUID(),
      entity_id: device.entity_id,
      received_at: new Date().toISOString(),
      value: 20 + index + tick / 1000,
      sequence: tick,
    }));
    const response = await fetch(`${target.url}/proof/samples`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(samples),
    });
    assert.equal(response.status, 201);
    const acknowledged = await response.json();
    const commit = performance.now() - started;
    const drift = commit - scheduled;
    assert.ok(
      drift <= 1000,
      `Tick${tick}: commit drift ${drift}ms exceeds one 1Hz cycle`,
    );
    ticks.push({
      tick,
      scheduled_ms: scheduled,
      started_ms: begin,
      committed_ms: commit,
      drift_ms: drift,
    });
    await appendFile(
      join(output, 'samples.jsonl'),
      JSON.stringify({
        tick,
        scheduled_at: new Date(wallStart + scheduled).toISOString(),
        committed_ms: commit,
        acknowledged,
      }) + '\n',
    );
    if (tick % 60 === 0) {
      metadata.push(await (await fetch(`${target.url}/proof/metadata`)).json());
      console.log(
        JSON.stringify({
          event: 'spike.progress',
          tick,
          duration,
          maxDriftMs: Math.max(...ticks.map((t) => t.drift_ms)),
          concurrentReads,
          concurrentWrites,
        }),
      );
    }
  }
  running = false;
  await background;
  if (injectFinalFailure) {
    try {
      assert.equal((await fetch(`${target.url}/not-a-route`)).status, 200);
    } catch (error) {
      failure = error;
    }
  }
  if (failure) throw failure;
  assert.equal(concurrentReads, concurrentWrites * 2);
  const elapsedMs = performance.now() - started;
  assert.ok(elapsedMs >= duration * 1000);
  const counts = (await (
    await fetch(`${target.url}/proof/stats`)
  ).json()) as Array<{
    samples: number;
    sequences: number;
    first_sequence: number;
    last_sequence: number;
  }>;
  assert.equal(counts.length, 20);
  for (const row of counts) {
    assert.equal(row.samples, duration);
    assert.equal(row.sequences, duration);
    assert.equal(row.first_sequence, 1);
    assert.equal(row.last_sequence, duration);
  }
  // Give both readers a bounded chance to observe the final already committed update.
  const observationDeadline = Date.now() + 3000;
  while (
    streams.some((s) => s.samples < duration * 20 + concurrentWrites) &&
    Date.now() < observationDeadline
  )
    await new Promise((resolve) => setTimeout(resolve, 20));
  for (const observed of streams) {
    assert.equal(observed.snapshots, 1);
    assert.equal(observed.samples, duration * 20 + concurrentWrites);
    observed.controller.abort();
  }
  await Promise.all(streams.map((s) => s.task));
  if (failure) throw failure;
  const directoryBytes = await bytes(target.directory);
  await target.stop();
  const measurements = target.logs.split('\n').flatMap((line) => {
    try {
      const entry = JSON.parse(line) as {
        event: string;
        kind: string;
        statements: number;
        outcome: string;
      };
      return entry.event === 'database.operation' && entry.kind === 'request'
        ? [entry]
        : [];
    } catch {
      return [];
    }
  });
  assert.ok(measurements.length > 0);
  assert.ok(
    measurements.every((m) => m.outcome === 'ok' && m.statements <= 10),
  );
  await writeFile(
    join(output, 'database-measurements.json'),
    JSON.stringify(measurements, null, 2),
  );
  await writeFile(
    join(output, 'timeseries.json'),
    JSON.stringify(ticks, null, 2),
  );
  await writeFile(
    join(output, 'report.json'),
    JSON.stringify(
      {
        status: 'passed',
        representation:
          'M1 synthetic device-shaped persistence; business Device/SSE/history contracts remain pending M3',
        platform: process.platform,
        node: process.version,
        engine: '@electric-sql/pglite@0.5.8',
        durationSeconds: duration,
        elapsedMs,
        devices: 20,
        frequencyHz: 1,
        deviceSamples: duration * 20,
        concurrentReads,
        concurrentWrites,
        subscribers: streams.map(
          ({ updates, samples, snapshots, maximumBytes }) => ({
            updates,
            samples,
            snapshots,
            maximumBytes,
          }),
        ),
        maxDriftMs: Math.max(...ticks.map((t) => t.drift_ms)),
        maxStatements: Math.max(...measurements.map((m) => m.statements)),
        coldStartMs,
        directoryBytes,
        metadata,
      },
      null,
      2,
    ),
  );
} catch (error) {
  await writeFile(
    join(output, 'failure.json'),
    JSON.stringify(
      {
        message: error instanceof Error ? error.message : String(error),
        ticks: ticks.length,
      },
      null,
      2,
    ),
  );
  throw error;
} finally {
  running = false;
  for (const observed of streams) observed.controller.abort();
  await background;
  await Promise.allSettled(streams.map((s) => s.task));
  await target.cleanup();
  await copyFile(
    join(target.evidence, 'owned-resources.json'),
    join(output, 'owned-resources.json'),
  );
}
console.log(JSON.stringify({ output, status: 'passed', duration }));
