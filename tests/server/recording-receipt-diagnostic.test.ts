import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RecordingReceiptTrace,
  receiptFacts,
  admissionCode,
  serverPhases,
  writeRecordingReceipt,
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

test('an actual captured 503 Response seals a prerequisite failure without another admission request', async () => {
  const root = await mkdtemp(join(tmpdir(), 'u64-diagnostic-seal-owned-'));
  const originalFetch = globalThis.fetch;
  const nonce = '10000000-0000-0000-0000-000000000001';
  const captured = new Response(
    JSON.stringify({
      error: {
        code: 'lab.recording_prepare_timeout',
        message: 'private-credential',
        details: { mapping: 'private-mapping' },
      },
    }),
    { status: 503 },
  );
  const requests: string[] = [];
  try {
    await writeFile(
      join(root, 'owned-resources.json'),
      JSON.stringify({ runId: nonce }),
    );
    globalThis.fetch = async (input, init) => {
      requests.push(init?.method ?? 'GET');
      return new Response(
        JSON.stringify(
          String(input).endsWith('/session')
            ? {
                status: 'starting',
                epoch: '9007199254740998',
                ticket: 'private-ticket',
              }
            : {
                data: [
                  {
                    session_id: 'current',
                    status: 'incomplete',
                    prefix: { source_packet_sequence: '0' },
                  },
                ],
              },
        ),
      );
    };
    const firstError = new assert.AssertionError({
      actual: 503,
      expected: 201,
      operator: 'strictEqual',
    });
    await writeRecordingReceipt(
      root,
      new RecordingReceiptTrace(),
      firstError,
      { url: 'http://fixture.invalid', cookie: 'private-cookie' } as Parameters<
        typeof writeRecordingReceipt
      >[3],
      '/session',
      '/recordings',
      { phase: 6, nonce, sessionId: 'current', response: captured, logs: '' },
    );
    const text = await readFile(
      join(root, 'recording-u64-diagnostic.json'),
      'utf8',
    );
    const sealed = JSON.parse(text);
    assert.equal(
      sealed.facts.classification,
      'FAILED_PREREQUISITE_OR_UNCLASSIFIED',
    );
    assert.equal(sealed.trace.rows.length, 0);
    assert.equal(sealed.facts.current_nonce, nonce);
    assert.equal(sealed.facts.owner_run_id, nonce);
    assert.deepEqual(sealed.facts.admission, {
      http_status: 503,
      error_code: 3,
    });
    assert.deepEqual(sealed.facts.first_assertion, {
      expected: 201,
      actual: 503,
      strict_equal: true,
    });
    assert(!text.includes('private'));
    assert.deepEqual(requests, ['GET', 'GET']);
    assert.equal(captured.bodyUsed, false);
    assert.equal(firstError.actual, 503);
    assert.equal(
      JSON.parse(
        await readFile(join(root, 'recording-u64-server-phases.json'), 'utf8'),
      ).current_nonce,
      nonce,
    );
  } finally {
    globalThis.fetch = originalFetch;
    await rm(root, { recursive: true, force: true });
  }
});

test('same-response error classification and finite server projection retain no private data', () => {
  assert.equal(
    admissionCode({
      error: {
        code: 'lab.recording_prepare_timeout',
        message: 'secret-ticket',
        request_id: 'secret-id',
      },
    }),
    3,
  );
  assert.equal(admissionCode({ error: { code: 'secret-credential' } }), 0);
  const logs = Array.from({ length: 100 }, () =>
    JSON.stringify({
      event: 'database.operation',
      outcome: 'error',
      statements: 4,
      queueWaitMs: 123,
      durationMs: 456,
      id: 'secret-id',
      commands: ['secret-sql'],
      headers: 'secret-credential',
    }),
  ).join('\n');
  const projected = serverPhases(
    logs +
      '\n' +
      JSON.stringify({
        event: 'http.request',
        status: 503,
        path: 'secret-url/publisher-admissions',
        duration_ms: 700,
      }),
  );
  assert.equal(projected.length, 16);
  assert(!JSON.stringify(projected).includes('secret'));
  assert.deepEqual(projected.at(-1), [2, 503, 0, 700, 0, 0, 1]);
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
  assert(source.includes('observe(response);'));
  assert(source.includes('assert.equal(response.status, 201,'));
});
