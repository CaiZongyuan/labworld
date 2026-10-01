import { createClient, createConfig } from './generated/client';

export * from './generated/sdk.gen';
export type { Client as ApiClient } from './generated/client';
export type * from '@labos-threejs/contracts';

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
  return createClient(
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
}
