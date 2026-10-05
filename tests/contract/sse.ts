import { expect } from 'vitest';
import type { WorldEvent } from '../../packages/contracts/src/generated/types.gen';
import { base, HttpClient } from './http';

export class WorldStream {
  private abort = new AbortController();
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private buffer = '';
  private decoder = new TextDecoder();
  static async open(client: HttpClient, lab: string) {
    const stream = new WorldStream();
    const response = await fetch(
      `${base}/api/v1/lab/labs/${lab}/world/subscribe`,
      { headers: client.headers(), signal: stream.abort.signal },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');
    stream.reader = response.body!.getReader();
    return stream;
  }
  async next(timeout = 10_000): Promise<WorldEvent | undefined> {
    const deadline = setTimeout(() => this.abort.abort(), timeout);
    try {
      while (true) {
        const boundary = this.buffer.indexOf('\n\n');
        if (boundary !== -1) {
          const frame = this.buffer.slice(0, boundary);
          this.buffer = this.buffer.slice(boundary + 2);
          const data = frame
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (!data) continue;
          expect(Buffer.byteLength(data)).toBeLessThanOrEqual(1024 * 1024);
          return JSON.parse(data) as WorldEvent;
        }
        const chunk = await this.reader!.read();
        if (chunk.done) return undefined;
        this.buffer += this.decoder
          .decode(chunk.value, { stream: true })
          .replace(/\r\n/g, '\n');
      }
    } finally {
      clearTimeout(deadline);
    }
  }
  async event(type: WorldEvent['type'], timeout = 15_000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const event = await this.next(Math.min(10_000, deadline - Date.now()));
      if (!event) throw new Error(`Stream ended before ${type}`);
      if (event.type === type) return event;
    }
    throw new Error(`Stream produced no ${type} before the deadline`);
  }
  close() {
    this.abort.abort();
  }
}
