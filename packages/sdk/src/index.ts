import { createClient, createConfig } from './generated/client';

export * from './generated/sdk.gen';
export type { Client as ApiClient } from './generated/client';
export type * from '@labos-threejs/contracts';
export type * from '@labos-threejs/contracts/motion';
export * from './motion';
export * from './simulation-session';
export { MotionBuffer, type MotionSample } from './motion-buffer';
export {
  subscribeLabWorld,
  applyLabWorldEvent,
  WorldSyncError,
} from './lab-world';

export function createApiClient(
  baseUrl: string,
  options: { timeoutMs?: number } = {},
) {
  const timeoutMs = options.timeoutMs ?? 5_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
    throw new Error(
      'API request timeout must be between 1 and 60000 milliseconds',
    );
  }
  const client = createClient(
    createConfig({
      baseUrl,
      credentials: 'include',
      fetch: (input, init) => {
        const signals = [AbortSignal.timeout(timeoutMs)];
        if (input instanceof Request) signals.push(input.signal);
        if (init?.signal) signals.push(init.signal);
        return fetch(input, { ...init, signal: AbortSignal.any(signals) });
      },
    }),
  );
  // SSE is caller-controlled; the short request deadline applies only to ordinary HTTP.
  for (const method of Object.keys(client.sse) as Array<
    keyof typeof client.sse
  >) {
    const request = client.sse[method];
    client.sse[method] = ((options: Parameters<typeof request>[0]) =>
      request({
        ...options,
        fetch: options.fetch ?? globalThis.fetch,
      })) as typeof request;
  }
  return client;
}
