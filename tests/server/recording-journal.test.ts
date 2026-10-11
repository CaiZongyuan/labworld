import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  RecordingJournal,
  decodeJournalBytes,
  journalDigest,
} from '../../packages/server/src/lab/recordings/journal.ts';
import { ServerProcess } from '../support/server-process.ts';

test('a failed journal sync keeps the confirmed prefix and the next seal has no duplicate ordinal', async () => {
  const target = await new ServerProcess().create();
  let failSync = false;
  const adopted: Uint8Array[] = [];
  const journal = new RecordingJournal(
    target.directory,
    randomUUID(),
    randomUUID(),
    async (_part, bytes) => {
      adopted.push(bytes);
    },
    {
      beforeSync: async () => {
        if (failSync) {
          failSync = false;
          throw new Error('owned_sync_failure');
        }
      },
    },
  );
  try {
    await target.startInProcess(
      'owned-recording-journal',
      () => journal.initialize(),
      () => journal.close(),
    );
    await journal.append(
      'source.packet',
      { sample: 'confirmed' },
      '2026-10-11T00:00:00.123456Z',
    );
    failSync = true;
    await assert.rejects(
      journal.append(
        'source.packet',
        { sample: 'unconfirmed' },
        '2026-10-11T00:00:01.123456Z',
      ),
      /owned_sync_failure/,
    );
    await journal.append(
      'seal',
      { integrity: 'incomplete' },
      '2026-10-11T00:00:02.123456Z',
    );
    await journal.sealAll();
    const records = adopted.flatMap(decodeJournalBytes);
    assert.deepEqual(
      records.map((r) => r.ordinal),
      ['1', '2'],
    );
    assert.deepEqual(
      records.map((r) => r.data),
      [{ sample: 'confirmed' }, { integrity: 'incomplete' }],
    );
  } finally {
    await target.cleanup();
  }
});

test('a failed managed publication retains the exact synced candidate for retry and reopen', async () => {
  const target = await new ServerProcess().create(),
    id = randomUUID(),
    session = randomUUID();
  let failPublish = true;
  const adopted = new Map<string, Uint8Array>();
  const journal = new RecordingJournal(
    target.directory,
    id,
    session,
    async (part, bytes) => {
      if (failPublish) {
        failPublish = false;
        throw new Error('owned_publication_failure');
      }
      adopted.set(part.id, bytes);
    },
  );
  let reopened: RecordingJournal | undefined;
  try {
    await target.startInProcess(
      'owned-recording-journal',
      () => journal.initialize(),
      async () => {
        await reopened?.close();
        await journal.close();
      },
    );
    await journal.append(
      'source.packet',
      { sample: 'externally-confirmed-A' },
      '2026-10-11T00:00:00.123456Z',
    );
    await journal.append(
      'source.packet',
      { sample: 'externally-confirmed-B' },
      '2026-10-11T00:00:01.123456Z',
    );
    await assert.rejects(journal.sealAll(), /owned_publication_failure/);
    const before = await journal.inventory();
    assert.equal(before.length, 1);
    assert.equal(before[0].index, 0);
    await journal.sealAll();
    const after = await journal.inventory();
    assert.deepEqual(after, before);
    assert.equal(journalDigest(adopted.get(before[0].id)!), before[0].sha256);
    assert.deepEqual(
      decodeJournalBytes(adopted.get(before[0].id)!).map((r) => r.data.sample),
      ['externally-confirmed-A', 'externally-confirmed-B'],
    );
    await journal.close();
    reopened = new RecordingJournal(
      target.directory,
      id,
      session,
      async () => {},
    );
    await reopened.initialize();
    const actual = [];
    for await (const record of reopened.records())
      actual.push(record.data.sample);
    assert.deepEqual(actual, [
      'externally-confirmed-A',
      'externally-confirmed-B',
    ]);
  } finally {
    await target.cleanup();
  }
});

test('restored Core segments seed the first local ordinal on the next reopen', async () => {
  const target = await new ServerProcess().create(),
    id = randomUUID(),
    session = randomUUID(),
    published = [{ index: 7, last_ordinal: '58' }];
  let journal = new RecordingJournal(
    target.directory,
    id,
    session,
    async () => {},
  );
  try {
    await target.startInProcess(
      'owned-recording-journal',
      () => journal.initialize(published),
      () => journal.close(),
    );
    await journal.append(
      'business.commit',
      { fact: 'restored-A' },
      '2026-10-11T00:00:00Z',
    );
    await journal.append(
      'business.commit',
      { fact: 'restored-B' },
      '2026-10-11T00:00:01Z',
    );
    await journal.sealAll();
    await journal.close();
    published.push({ index: 8, last_ordinal: '60' });
    journal = new RecordingJournal(
      target.directory,
      id,
      session,
      async () => {},
    );
    await journal.initialize(published);
    assert.equal(journal.corruptReason, undefined);
    await journal.append(
      'business.commit',
      { fact: 'next-restart-C' },
      '2026-10-11T00:00:02Z',
    );
    const records = [];
    for await (const record of journal.records()) records.push(record);
    assert.deepEqual(
      records.map((r) => r.ordinal),
      ['59', '60', '61'],
    );
    assert.deepEqual(
      records.map((r) => r.data.fact),
      ['restored-A', 'restored-B', 'next-restart-C'],
    );
    assert.deepEqual(
      (await journal.inventory()).map((p) => p.index),
      [8, 9],
    );
  } finally {
    await target.cleanup();
  }
});

test('a torn candidate with no confirmed record has one owned quarantine and no competing segment index', async () => {
  const target = await new ServerProcess().create(),
    id = randomUUID(),
    session = randomUUID(),
    published = [{ index: 2, last_ordinal: '10' }];
  let journal = new RecordingJournal(
    target.directory,
    id,
    session,
    async () => {},
  );
  try {
    await target.startInProcess(
      'owned-recording-journal',
      () => journal.initialize(published),
      () => journal.close(),
    );
    await journal.close();
    await writeFile(
      join(journal.directory, `000003-${randomUUID()}.lwf`),
      Buffer.from([2, 0]),
    );
    journal = new RecordingJournal(
      target.directory,
      id,
      session,
      async () => {},
    );
    await journal.initialize(published);
    assert.equal(journal.corruptReason, 'recording_torn_tail');
    await journal.append(
      'seal',
      { integrity: 'incomplete' },
      '2026-10-11T00:00:00Z',
    );
    const parts = await journal.inventory();
    assert.equal(parts.length, 1);
    assert.equal(parts[0].index, 3);
    assert.equal(parts[0].first_ordinal, '11');
    const names = await readdir(journal.directory);
    assert.equal(names.filter((name) => name.endsWith('.lwf')).length, 1);
    assert.equal(
      names.filter((name) => name.startsWith('quarantine-')).length,
      1,
    );
  } finally {
    await target.cleanup();
  }
});

test('a stalled sync hook fails within its deadline and cannot append after it is released', async () => {
  const target = await new ServerProcess().create();
  let release!: () => void,
    stall = true;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const journal = new RecordingJournal(
    target.directory,
    randomUUID(),
    randomUUID(),
    async () => {},
    {
      beforeSync: async () => {
        if (stall) await held;
      },
    },
    async () => {},
    25,
  );
  try {
    await target.startInProcess(
      'owned-recording-journal',
      () => journal.initialize(),
      () => journal.close(),
    );
    await assert.rejects(
      journal.append(
        'business.prepare',
        { fact: 'uncommitted' },
        '2026-10-11T00:00:00Z',
      ),
      /recording_hook_timeout/,
    );
    release();
    stall = false;
    await journal.append(
      'seal',
      { integrity: 'incomplete' },
      '2026-10-11T00:00:01Z',
    );
    const records = [];
    for await (const record of journal.records()) records.push(record);
    assert.deepEqual(
      records.map((r) => [r.ordinal, r.kind]),
      [['1', 'seal']],
    );
  } finally {
    release();
    await target.cleanup();
  }
});
