import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  assertPressureSealAck,
  publishPressureRequest,
} from '../support/pressure-barrier.ts';

export function pressureWindow(sessionId: string, clientPort: number) {
  const directory = process.env.TLS_PRESSURE_PROBE_DIR;
  if (!directory) return;
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    writeFileSync(
      join(directory, 'window.json'),
      JSON.stringify({
        sessionId,
        clientPort,
        serverPort: Number(new URL(process.env.E2E_API_URL!).port),
        durationMs: 180000,
        testNodeAt: performance.now(),
        testMonoNs: process.hrtime.bigint().toString(),
        wallMs: Date.now(),
        clock: 'test Node performance.now; compare within this process',
      }) + '\n',
      { mode: 0o600 },
    );
  } catch {
    /* Measurement setup must not replace the original predicate. */
  }
}

/** Capture the actual failed predicate and last bounded tuples before cleanup. */
export function pressureFailure(error: unknown = undefined) {
  const directory = process.env.TLS_PRESSURE_PROBE_DIR;
  if (!directory) return;
  try {
    const locations =
      error instanceof Error
        ? [
            ...(error.stack ?? '').matchAll(
              /(lab-secure-motion\.spec\.ts):(\d+):(\d+)/g,
            ),
          ]
            .slice(0, 4)
            .map((match) => ({
              file: match[1],
              line: Number(match[2]),
              column: Number(match[3]),
            }))
        : [];
    const files = readdirSync(directory).filter((name) =>
      /^(peer|source)-[0-9a-f-]{36}\.json$/.test(name),
    );
    const tuples = [
      'window.json',
      'server.json',
      'ss-owner.json',
      ...files.slice(0, 5),
    ].map((name) => {
      try {
        const bytes = readFileSync(join(directory, name));
        if (bytes.length > 16384)
          return { name, available: false, reason: 'tuple exceeds bound' };
        return {
          name,
          available: true,
          value: JSON.parse(bytes.toString('utf8')),
        };
      } catch {
        return { name, available: false, reason: 'unavailable tuple' };
      }
    });
    writeFileSync(
      join(
        directory,
        error === undefined
          ? 'pressure-boundary.json'
          : 'before-cleanup-failure.json',
      ),
      JSON.stringify({
        testNodeAt: performance.now(),
        testMonoNs: process.hrtime.bigint().toString(),
        wallMs: Date.now(),
        errorClass:
          error instanceof Error &&
          ['Error', 'AssertionError', 'TimeoutError'].includes(error.name)
            ? error.name
            : 'unavailable',
        locations,
        rawMessageRetained: false,
        tuples,
      }) + '\n',
      { mode: 0o600 },
    );
  } catch {
    // Diagnostic evidence must not replace the original failed assertion.
  }
}

/** Private owner ACKs outside the original 180s predicate, before any teardown. */
export async function sealPressureWindow(sessionId: string) {
  const probe = process.env.TLS_PRESSURE_PROBE_DIR;
  const witnesses = process.env.SECURE_MOTION_SOURCE_WITNESS;
  if (!probe || !witnesses) return;
  const result: Record<string, unknown> = { valid: false };
  try {
    const request_id = randomUUID(),
      requestedAt = Date.now();
    const serverPid = Number(
      readFileSync(process.env.E2E_API_PID_FILE!, 'utf8'),
    );
    const service = JSON.parse(
      readFileSync(
        join(process.env.LAB_NODE_EVIDENCE!, 'owned-resources.json'),
        'utf8',
      ),
    );
    const source = JSON.parse(
      readFileSync(
        join(
          service.directory,
          'runtime/synthetic-sources',
          sessionId + '.json',
        ),
        'utf8',
      ),
    );
    const peer = readdirSync(process.env.LAB_NODE_EVIDENCE!)
      .filter((name) => name.startsWith('secure-slow-reader-'))
      .map((name) =>
        JSON.parse(
          readFileSync(join(process.env.LAB_NODE_EVIDENCE!, name), 'utf8'),
        ),
      )
      .find((row) => row.state === 'owned');
    const roles = [
      { role: 'source', pid: source.process.pid },
      { role: 'peer', pid: peer.process.pid },
    ];
    const baselineGenerations: Record<string, number> = {};
    for (const role of ['server', 'source', 'peer']) {
      try {
        const previous = JSON.parse(
          readFileSync(
            role === 'server'
              ? join(probe, 'server.json')
              : join(
                  witnesses,
                  role + '-' + sessionId + '.pressure-health.json',
                ),
            'utf8',
          ),
        );
        baselineGenerations[role] =
          role === 'server'
            ? previous.diagnosticHealth.published
            : previous.published;
      } catch {
        baselineGenerations[role] = 0;
      }
    }
    if (
      !publishPressureRequest(process.env.E2E_OBSERVER_CONTROL!, {
        action: 'observer-health-barrier',
        request_id,
        expected_owner_pid: serverPid,
      })
    )
      throw new Error('Diagnostic publication unavailable');
    for (const owner of roles)
      if (
        !publishPressureRequest(
          join(witnesses, owner.role + '-seal-request.json'),
          {
            request_id,
            expected_owner_pid: owner.pid,
            sessionId,
          },
        )
      )
        throw new Error('Diagnostic publication unavailable');
    const deadline = performance.now() + 2500;
    let replies: Record<string, unknown> | undefined;
    let invalidCurrentAck = false;
    function checkCurrentAck(
      value: unknown,
      expected: Parameters<typeof assertPressureSealAck>[1],
    ) {
      if ((value as { request_id?: string })?.request_id !== request_id)
        throw new Error('Await current ACK');
      try {
        return assertPressureSealAck(value, expected);
      } catch {
        invalidCurrentAck = true;
        throw new Error('Current ACK invalid');
      }
    }
    while (performance.now() < deadline) {
      try {
        const envelope = JSON.parse(
          readFileSync(process.env.E2E_OBSERVER_REPLY!, 'utf8'),
        );
        if (
          envelope.request_id !== request_id ||
          envelope.served_pid !== serverPid ||
          envelope.run_id !== process.env.CONTRACT_RUN_ID
        )
          throw new Error('No current owner reply');
        const server = checkCurrentAck(envelope.ack, {
          request_id,
          pid: serverPid,
          afterGeneration: baselineGenerations.server,
          requestedAt,
        });
        const acknowledgments = roles.map((owner) =>
          checkCurrentAck(
            JSON.parse(
              readFileSync(
                join(witnesses, owner.role + '-seal-ack.json'),
                'utf8',
              ),
            ),
            {
              request_id,
              pid: owner.pid,
              afterGeneration: baselineGenerations[owner.role],
              requestedAt,
            },
          ),
        );
        replies = {
          server,
          source: acknowledgments[0],
          peer: acknowledgments[1],
        };
        break;
      } catch {
        if (invalidCurrentAck) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    Object.assign(result, {
      request_id,
      requestedAt,
      expectedOwners: {
        server: serverPid,
        source: roles[0].pid,
        peer: roles[1].pid,
      },
      baselineGenerations,
      invalidCurrentAck,
      valid: !!replies,
      replies: replies ?? null,
    });
  } catch {
    result.category = 'pressure_barrier_unavailable';
  }
  try {
    writeFileSync(
      join(probe, 'seal-barrier.json'),
      JSON.stringify(result) + '\n',
      { mode: 0o600 },
    );
  } catch {
    /* No ACK proof. */
  }
}
