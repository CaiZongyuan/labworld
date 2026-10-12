import assert from 'node:assert/strict';
import type { Session } from '../../packages/server/src/lab/sessions/dto.ts';

type SessionEvent = { type: 'session'; session: Session };

/** Independent public SSE framing; each HTTP reader retains its own leftovers. */
export class SessionEventReader {
  private text = '';
  private decoder = new TextDecoder('utf-8', { fatal: true });
  private reader: ReadableStreamDefaultReader<Uint8Array>;
  constructor(reader: ReadableStreamDefaultReader<Uint8Array>) {
    this.reader = reader;
  }

  async next(): Promise<SessionEvent | undefined> {
    while (true) {
      const end = this.text.indexOf('\n\n');
      if (end !== -1) {
        const block = this.text.slice(0, end);
        this.text = this.text.slice(end + 2);
        const data = block
          .split('\n')
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).replace(/^ /, ''))
          .join('\n');
        if (!data) continue;
        const event = JSON.parse(data) as SessionEvent;
        assert.equal(event.type, 'session');
        return event;
      }
      const chunk = await this.reader.read();
      if (chunk.done) {
        this.text += this.decoder.decode();
        assert.equal(this.text.trim(), '', 'Torn lifecycle SSE block');
        return undefined;
      }
      this.text += this.decoder.decode(chunk.value, { stream: true });
    }
  }

  async receive(expected: Pick<Session, 'id' | 'revision' | 'status'>) {
    while (true) {
      const event = await this.next();
      assert(event, 'Lifecycle stream closed before requested revision');
      assert.equal(event.session.id, expected.id);
      if (event.session.revision < expected.revision) continue;
      assert.equal(
        event.session.revision,
        expected.revision,
        'Requested Session revision skipped',
      );
      assert.equal(
        event.session.status,
        expected.status,
        'Requested Session status changed',
      );
      return event;
    }
  }
}
