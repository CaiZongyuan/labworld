import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  RecordingEventCursors,
  recordingEventCursorKey,
} from '../../packages/server/src/lab/recordings/event-cursor.ts';
import { eventPosition } from '../../packages/server/src/lab/recordings/event-page.ts';
const id = '10000000-0000-0000-0000-000000000001';
const old = (value: object) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');

test('only authenticated scope/floor/scan/lookup/legacy states may bypass prefix reconstruction', () => {
  const codec = new RecordingEventCursors(Buffer.alloc(32, 1));
  const p = eventPosition(
    {
      recording_id: id,
      ordinal: '4',
      index: 0,
      scan: '3',
      legacy: { commit: '4', prepare: '1' },
    },
    id,
  );
  const signed = codec.encode(p);
  assert(signed.length <= 2048);
  assert.deepEqual(codec.decode(signed, id), p);
  const attack = [
    {
      recording_id: id,
      ordinal: '0',
      index: -1,
      scan: '3',
      legacy: { commit: '4', prepare: '1' },
    },
    {
      recording_id: id,
      ordinal: '0',
      index: -1,
      scan: '3',
      lookup: { commit: '4', batch: 'B', scan: '3', prepare: '1' },
    },
    p,
  ];
  for (const value of attack)
    assert.throws(
      () => codec.decode(old(value), id),
      /recording_invalid_cursor/,
    );
  const envelope = JSON.parse(Buffer.from(signed, 'base64url').toString());
  const body = JSON.parse(Buffer.from(envelope.p, 'base64url').toString());
  body.legacy.prepare = '2';
  envelope.p = old(body);
  assert.throws(
    () => codec.decode(old(envelope), id),
    /recording_invalid_cursor/,
  );
  assert.throws(() =>
    codec.decode(signed, '10000000-0000-0000-0000-000000000002'),
  );
  assert.deepEqual(
    codec.decode(old({ recording_id: id, ordinal: '4', index: 0 }), id),
    { recording_id: id, ordinal: '4', index: 0, scan: '0' },
  );
});

test('Lab cursor key publication is complete/stable across concurrent initialization and restart; bad keys fail', async () => {
  const root = await mkdtemp(join(tmpdir(), 'recording-cursor-owned-'));
  try {
    const keys = await Promise.all([
      recordingEventCursorKey(root),
      recordingEventCursorKey(root),
      recordingEventCursorKey(root),
    ]);
    assert(keys.every((key) => key.length === 32 && key.equals(keys[0])));
    const cursor = new RecordingEventCursors(keys[0]).encode(
      eventPosition(
        { recording_id: id, ordinal: '1', index: 0, scan: '1' },
        id,
      ),
    );
    assert.equal(
      new RecordingEventCursors(await recordingEventCursorKey(root)).decode(
        cursor,
        id,
      ).scan,
      '1',
    );
    assert.deepEqual((await readdir(join(root, 'secrets'))).sort(), [
      'recording-events-cursor-key',
    ]);
    const restoredRoot = await mkdtemp(
      join(tmpdir(), 'recording-cursor-restored-owned-'),
    );
    try {
      const restoredCodec = new RecordingEventCursors(
        await recordingEventCursorKey(restoredRoot),
      );
      assert.throws(
        () => restoredCodec.decode(cursor, id),
        /recording_invalid_cursor/,
      );
    } finally {
      await rm(restoredRoot, { recursive: true, force: true });
    }
    assert.equal(
      (await readFile(join(root, 'secrets/recording-events-cursor-key')))
        .length,
      32,
    );
    await writeFile(
      join(root, 'secrets/recording-events-cursor-key'),
      Buffer.alloc(31),
    );
    await assert.rejects(
      recordingEventCursorKey(root),
      /recording_cursor_key_invalid/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
