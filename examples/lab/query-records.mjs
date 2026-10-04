import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const base = process.env.LAB_API_BASE ?? 'http://127.0.0.1:3000';
const lab = process.env.LAB_ID;
const key = process.env.LAB_API_KEY;
const cookie = process.env.LAB_SESSION_COOKIE;
if (!lab || (!key && !cookie))
  throw new Error('Set LAB_ID and LAB_API_KEY or LAB_SESSION_COOKIE');
const to = process.env.LAB_RECORDS_TO ?? new Date().toISOString();
const from =
  process.env.LAB_RECORDS_FROM ?? new Date(Date.now() - 86400000).toISOString();
const limit = Number(process.env.LAB_RECORDS_LIMIT ?? 20);
const entity = process.env.LAB_ENTITY_ID;
const kind = process.env.LAB_RECORD_TYPE;

function epochNanoseconds(timestamp) {
  const fraction =
    timestamp.match(/\.([0-9]+)(?:Z|[+-][0-9]{2}:[0-9]{2})$/)?.[1] ?? '';
  // Date handles the calendar and offset; preserve the remaining fractional digits.
  return (
    BigInt(Date.parse(timestamp)) * 1000000n +
    BigInt(fraction.padEnd(9, '0').slice(3, 9))
  );
}

const loader = await createServer({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  configFile: false,
  server: { middlewareMode: true, watch: null, hmr: false },
  appType: 'custom',
});
try {
  const { createApiClient, listLabRecords } = await loader.ssrLoadModule(
    '/packages/sdk/src/index.ts',
  );
  const options = {
    client: createApiClient(base, { timeoutMs: 10000 }),
    path: { lab_id: lab },
    query: {
      from,
      to,
      limit,
      ...(entity ? { entity_id: entity } : {}),
      ...(kind ? { record_type: kind } : {}),
    },
    headers: key ? { authorization: `Bearer ${key}` } : { cookie },
  };
  const pages = [];
  const identities = new Set();
  let cursor;
  let previous;
  for (let pageIndex = 0; pageIndex < 2; pageIndex++) {
    const result = await listLabRecords({
      ...options,
      query: { ...options.query, ...(cursor ? { cursor } : {}) },
    });
    assert.equal(result.response.status, 200, 'Lab records query failed');
    const page = result.data;
    assert(page.items.length <= limit && page.items.length <= 100);
    assert(Buffer.byteLength(JSON.stringify(page)) <= 256 * 1024);
    if (pages.length)
      assert.equal(page.query_upper_bound, pages[0].query_upper_bound);
    for (const item of page.items) {
      const time = epochNanoseconds(item.recorded_at);
      assert(time >= epochNanoseconds(page.from));
      assert(time < epochNanoseconds(page.query_upper_bound));
      const identity = `${item.record_type}:${item.id}`;
      assert(!identities.has(identity), 'A record appeared on two pages');
      identities.add(identity);
      if (previous)
        assert(
          time < previous.time ||
            (time === previous.time &&
              (item.record_type < previous.kind ||
                (item.record_type === previous.kind && item.id < previous.id))),
          'Records must keep their descending total order',
        );
      previous = { time, kind: item.record_type, id: item.id };
    }
    pages.push(page);
    cursor = page.next_cursor;
    if (!cursor) break;
  }
  const invalid = await listLabRecords({
    ...options,
    query: { ...options.query, limit: 101 },
  });
  assert.equal(invalid.response.status, 400);
  const recovered = await listLabRecords(options);
  assert.equal(recovered.response.status, 200);
  console.log(JSON.stringify({ pages }, null, 2));
} finally {
  await loader.close();
}
