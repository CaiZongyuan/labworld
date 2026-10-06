import assert from 'node:assert/strict';
import type { CurrentSession } from '../../packages/contracts/src/generated/types.gen.ts';
export class CoreHttp {
  cookie?: string;
  csrf?: string;
  session?: CurrentSession;
  url: string;
  constructor(url: string) {
    this.url = url;
  }
  response(
    method: string,
    path: string,
    body?: unknown,
    extra: Record<string, string> = {},
  ) {
    return fetch(this.url + path, {
      method,
      headers: {
        'content-type': 'application/json',
        origin: this.url,
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(this.csrf ? { 'x-csrf-token': this.csrf } : {}),
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
  }
  async json<T>(
    method: string,
    path: string,
    body?: unknown,
    status = 200,
    extra: Record<string, string> = {},
  ): Promise<T> {
    const response = await this.response(method, path, body, extra);
    assert.equal(response.status, status, `${method} ${path.split('?')[0]}`);
    return status === 204 ? (undefined as T) : ((await response.json()) as T);
  }
  async error(
    method: string,
    path: string,
    body: unknown,
    status: number,
    code: string,
    extra: Record<string, string> = {},
  ) {
    const result = await this.json<{
      error: { code: string; request_id: string };
    }>(method, path, body, status, extra);
    assert.equal(result.error.code, code);
    assert.equal(typeof result.error.request_id, 'string');
  }
  async register(email: string, password = 'contract-isolated-password') {
    const response = await this.response('POST', '/api/v1/auth/register', {
      email,
      password,
    });
    assert.equal(response.status, 201);
    this.cookie = response.headers.get('set-cookie')!.split(';')[0];
    this.session = (await response.json()) as CurrentSession;
    this.csrf = this.session.csrf_token;
    return this.session;
  }
  async login(email: string, password = 'contract-isolated-password') {
    const response = await this.response('POST', '/api/v1/auth/login', {
      email,
      password,
    });
    assert.equal(response.status, 200);
    this.cookie = response.headers.get('set-cookie')!.split(';')[0];
    this.session = (await response.json()) as CurrentSession;
    this.csrf = this.session.csrf_token;
    return this.session;
  }
}
