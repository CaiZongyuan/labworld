import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import type {
  CurrentSession,
  CreatedApiKey,
} from '../../packages/contracts/src/generated/types.gen';

export const base = process.env.CONTRACT_URL;
if (!base)
  throw new Error(
    'Run pnpm test:contract through the isolated target supervisor',
  );
export const origin = process.env.CONTRACT_ORIGIN!;
export const password = 'contract-isolated-password';
export type ErrorEnvelope = {
  error: { code: string; message: string; request_id: string };
};
export class HttpClient {
  cookie?: string;
  csrf?: string;
  secret?: string;
  session?: CurrentSession;
  constructor(secret?: string) {
    this.secret = secret;
  }
  headers(extra: Record<string, string> = {}) {
    return {
      'content-type': 'application/json',
      origin,
      ...(this.cookie ? { cookie: this.cookie } : {}),
      ...(this.csrf ? { 'x-csrf-token': this.csrf } : {}),
      ...(this.secret ? { authorization: `Bearer ${this.secret}` } : {}),
      ...extra,
    };
  }
  async response(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    return fetch(`${base}${path}`, {
      method,
      headers: this.headers(headers),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
  }
  async json<T>(
    method: string,
    path: string,
    body?: unknown,
    status = 200,
    headers: Record<string, string> = {},
  ): Promise<T> {
    const response = await this.response(method, path, body, headers);
    expect(response.status, `${method} ${path.split('?')[0]}`).toBe(status);
    if (status === 204) return undefined as T;
    const text = await response.text();
    return JSON.parse(text) as T;
  }
  async error(
    method: string,
    path: string,
    body: unknown,
    status: number,
    code?: string,
    headers: Record<string, string> = {},
  ) {
    const value = await this.json<ErrorEnvelope>(
      method,
      path,
      body,
      status,
      headers,
    );
    expect(value.error.request_id).toEqual(expect.any(String));
    expect(value.error.message).toEqual(expect.any(String));
    if (code) expect(value.error.code).toBe(code);
    return value;
  }
  async register(email = `contract-${randomUUID()}@example.test`) {
    const response = await this.response('POST', '/api/v1/auth/register', {
      email,
      password,
    });
    expect(response.status).toBe(201);
    const cookie = response.headers.get('set-cookie')!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    this.cookie = cookie.split(';')[0];
    this.session = (await response.json()) as CurrentSession;
    this.csrf = this.session.csrf_token;
    return this.session;
  }
  async agent(scopes = ['lab:full']) {
    const credential = await this.json<CreatedApiKey>(
      'POST',
      '/api/v1/api-keys',
      { name: 'Contract Agent', scopes, expires_in_days: 1 },
      201,
    );
    return { client: new HttpClient(credential.secret), credential };
  }
}
export async function member() {
  const client = new HttpClient();
  await client.register();
  return client;
}
export async function until<T>(
  read: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeout = 15_000,
): Promise<T> {
  const deadline = Date.now() + timeout;
  do {
    const value = await read();
    if (predicate(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error(
    'Public observable condition did not become true before the deadline',
  );
}
