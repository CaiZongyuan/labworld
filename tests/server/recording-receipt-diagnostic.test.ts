import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  RecordingReceiptTrace,
  receiptFacts,
} from '../support/recording-receipt-diagnostic.ts';

test('passive ring stays finite and controls/public facts redact arbitrary content', () => {
  const trace = new RecordingReceiptTrace();
  for (let i = 0; i < 40; i++) trace.mark(10, i);
  trace.response(
    JSON.stringify({
      type: 'secret-ticket',
      code: 'secret-credential',
      mapping: ['secret-mapping'],
    }),
  );
  trace.expectedPrefix = 'secret-prefix';
  const value = {
    ...trace.snapshot(),
    facts: receiptFacts(
      {
        status: 'open',
        epoch: '9007199254740998',
        ticket: 'secret-ticket',
        mapping: ['secret-mapping'],
        prefix: {
          source_packet_sequence: '1',
          source_prefix_sha256: 'secret-prefix',
        },
      },
      true,
    ),
  };
  assert.equal(trace.snapshot().rows.length, 16);
  assert(!JSON.stringify(value).includes('secret'));
  assert.equal(
    receiptFacts({ status: 'running', epoch: '9007199254740998' }, false).epoch,
    '9007199254740998',
  );
});

test('critical trace methods perform no await, timer, IO or payload mutation', async () => {
  const helper = await readFile(
    new URL('../support/recording-receipt-diagnostic.ts', import.meta.url),
    'utf8',
  );
  const critical = helper.slice(
    helper.indexOf('export class'),
    helper.indexOf('const decimal'),
  );
  assert(!/\bawait\b|setTimeout|setInterval|writeFile|fetch\(/.test(critical));
  const source = await readFile(
    new URL('./session-authority.test.ts', import.meta.url),
    'utf8',
  );
  assert(source.includes('this.recording!.send(data);'));
  assert(source.includes("new Error('Recording receipt deadline exceeded')"));
  assert(source.includes('{ timeout: 60000 }'));
  assert(source.includes('throw error;'));
});
