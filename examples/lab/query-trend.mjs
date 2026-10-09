import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const base = process.env.LAB_API_BASE ?? 'http://127.0.0.1:3000';
const lab = process.env.LAB_ID;
const entity = process.env.LAB_ENTITY_ID;
const key = process.env.LAB_API_KEY;
const cookie = process.env.LAB_SESSION_COOKIE;
if (!lab || !entity || (!key && !cookie))
  throw new Error(
    'Set LAB_ID, LAB_ENTITY_ID and LAB_API_KEY or LAB_SESSION_COOKIE',
  );
const property = process.env.LAB_TREND_PROPERTY ?? 'temperature';
const to = process.env.LAB_TREND_TO ?? new Date().toISOString();
const from =
  process.env.LAB_TREND_FROM ??
  new Date(new Date(to).getTime() - 3600000).toISOString();
const maxPoints = Number(process.env.LAB_TREND_POINTS ?? 600);

function epochNanoseconds(timestamp) {
  const fraction =
    timestamp.match(/\.([0-9]+)(?:Z|[+-][0-9]{2}:[0-9]{2})$/)?.[1] ?? '';
  // Date parses the calendar and offset; retain the original sub-millisecond fraction.
  return (
    BigInt(Date.parse(timestamp)) * 1000000n +
    BigInt(fraction.padEnd(9, '0').slice(3, 9))
  );
}

// The workspace SDK is TypeScript source; Vite loads the same generated client used by the app.
const loader = await createServer({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  configFile: false,
  server: { middlewareMode: true, watch: null, hmr: false },
  appType: 'custom',
});
try {
  const { createApiClient, getLabEntityTrend } = await loader.ssrLoadModule(
    '/packages/sdk/src/index.ts',
  );
  const options = {
    client: createApiClient(base, { timeoutMs: 10000 }),
    path: { lab_id: lab, entity_id: entity },
    query: { property, from, to, max_points: maxPoints },
    headers: key ? { authorization: `Bearer ${key}` } : { cookie },
  };
  const result = await getLabEntityTrend(options);
  assert.equal(result.response.status, 200, 'Trend query failed');
  const trend = result.data;
  const samples = trend.segments.flatMap((segment) => segment.samples);
  assert.equal(trend.returned_sample_count, samples.length);
  assert.equal(trend.plot_item_count, samples.length + trend.gaps.length);
  assert(trend.plot_item_count <= maxPoints);
  assert(Buffer.byteLength(JSON.stringify(trend)) <= 256 * 1024);
  const fromInstant = epochNanoseconds(trend.from);
  const toInstant = epochNanoseconds(trend.to);
  for (const segment of trend.segments)
    for (const sample of segment.samples) {
      const received = epochNanoseconds(sample.received_at);
      assert(received >= fromInstant);
      assert(received < toInstant);
    }
  const invalid = await getLabEntityTrend({
    ...options,
    query: { ...options.query, max_points: 1001 },
  });
  assert.equal(invalid.response.status, 400);
  const recovered = await getLabEntityTrend(options);
  assert.equal(recovered.response.status, 200);
  console.log(JSON.stringify(trend, null, 2));
} finally {
  await loader.close();
}
