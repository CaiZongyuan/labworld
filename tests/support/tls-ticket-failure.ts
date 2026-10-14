import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CoreHttp } from './core-http';

const codes = new Set([
  'lab.session_closed',
  'session_closed',
  'lab.publisher_preparing',
  'publisher_preparing',
  'lab.viewer_capacity',
  'viewer_capacity',
  'lab.ticket_capacity',
  'ticket_capacity',
  'unauthorized',
  'identity.machine_unauthorized',
  'recording_ack_timeout',
  'recorder_capacity',
  'source_disconnected',
  'source_crashed',
  'source_failed',
  'recording_fault',
  'ack_timeout',
  'sync_failed',
  'server_shutdown',
  'server_restarted',
  'stopped',
  'reset',
  'mapping_changed',
  'machine_expired',
]);
const safeCode = (value: unknown) =>
  typeof value === 'string' && codes.has(value) ? value : 'unknown';

async function bounded<T>(read: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      read(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Diagnostic read unavailable')),
          750,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function captureTlsTicketFailure(
  api: CoreHttp,
  path: string,
  response: Response,
) {
  const match =
    /^\/api\/v1\/lab\/labs\/([0-9a-f-]{36})\/sessions\/([0-9a-f-]{36})\/viewer-tickets$/i.exec(
      path,
    );
  if (!match) return;
  const fact: Record<string, unknown> = {
    at: performance.now(),
    nodeEpoch: performance.timeOrigin,
    sessionId: match[2],
    ticketStatus: response.status,
    ticketCode: 'unknown',
    sessionRead: 'unknown',
  };
  try {
    const body = await bounded(() => response.clone().json());
    fact.ticketCode = safeCode(body?.error?.code);
  } catch {
    /* The already returned ticket response may have no readable body. */
  }
  try {
    const current = await bounded(() =>
      api.response('GET', path.slice(0, -'/viewer-tickets'.length)),
    );
    fact.sessionHttpStatus = current.status;
    if (current.status === 200) {
      const session = await bounded(() => current.json());
      fact.sessionRead = 'ack';
      fact.sessionStatus = [
        'preparing',
        'running',
        'paused',
        'stopped',
        'failed',
        'interrupted',
      ].includes(session?.status)
        ? session.status
        : 'unknown';
      fact.sessionReason =
        session?.reason === null ? null : safeCode(session?.reason);
      fact.sessionEnded = typeof session?.ended_at === 'string';
    }
  } catch {
    /* Missing failure-only read is unknown; the original assertion remains. */
  }
  try {
    writeFileSync(
      join(
        process.env.LAB_NODE_EVIDENCE ?? 'test-results',
        'tls-ticket-failure.json',
      ),
      JSON.stringify(fact) + '\n',
      { mode: 0o600 },
    );
  } catch {
    /* Diagnostics must preserve the original 201 failure. */
  }
}
