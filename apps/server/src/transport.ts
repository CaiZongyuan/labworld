import type { IncomingMessage } from 'node:http';
import { loopback } from '../../../packages/server/src/lab/motion/fixture.ts';

/** Forwarded headers never turn an ordinary TCP socket into a secure socket. */
export function secureTransport(request: IncomingMessage | undefined) {
  return (
    !!request &&
    'encrypted' in request.socket &&
    request.socket.encrypted === true
  );
}

export function localTransport(request: IncomingMessage | undefined) {
  return (
    !!request &&
    loopback(request.socket.remoteAddress) &&
    !['forwarded', 'x-forwarded-for', 'x-real-ip', 'x-forwarded-proto'].some(
      (name) => request.headers[name] !== undefined,
    )
  );
}

export function motionTransportAllowed(request: IncomingMessage | undefined) {
  return secureTransport(request) || localTransport(request);
}

/** Ordinary transport logs contain categories, not private scope or credentials. */
export function transportLog(entry: Record<string, unknown>) {
  const event = String(entry.event ?? '');
  if (/^(motion\.|sessions\.|recordings?\.)/.test(event))
    return {
      event,
      ...(typeof entry.code === 'string' ? { code: entry.code } : {}),
    };
  if (event === 'http.request' && typeof entry.path === 'string')
    return {
      ...entry,
      path: entry.path.replace(
        /[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}/gi,
        ':id',
      ),
    };
  return entry;
}
