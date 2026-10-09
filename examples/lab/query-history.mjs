import assert from 'node:assert/strict';

const base = process.env.LAB_API_BASE ?? 'http://127.0.0.1:3000';
const key = process.env.LAB_API_KEY;
const lab = process.env.LAB_ID;
const entity = process.env.LAB_ENTITY_ID;
if (!key || !lab || !entity)
  throw new Error('Set LAB_API_KEY, LAB_ID and LAB_ENTITY_ID');
const from =
  process.env.LAB_HISTORY_FROM ?? new Date(Date.now() - 86400000).toISOString();
const to =
  process.env.LAB_HISTORY_TO ?? new Date(Date.now() + 60000).toISOString();
async function request(method, path) {
  const response = await fetch(`${base}/api/v1/lab${path}`, {
    method,
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200, `${method} ${path}: unexpected status`);
  return response.json();
}
const path = `/labs/${lab}/entities/${entity}`;
const policy = await request('GET', `/labs/${lab}/history/retention`);
const records = {};
for (const kind of ['task', 'observation', 'command', 'event']) {
  let cursor;
  const items = [];
  let gap = false;
  let availableSince;
  do {
    const query = new URLSearchParams({
      record_type: kind,
      from,
      to,
      limit: '20',
      ...(cursor ? { cursor } : {}),
    });
    const page = await request('GET', `${path}/history?${query}`);
    assert(page.items.length <= 20);
    items.push(...page.items);
    gap ||= page.gap;
    availableSince = page.available_since;
    cursor = page.next_cursor;
  } while (cursor);
  records[kind] = { items, gap, available_since: availableSince };
}
const current = await request('GET', path);
if (process.argv.includes('--cleanup')) {
  let cleaned;
  do {
    cleaned = await request('POST', `/labs/${lab}/history/cleanup`);
  } while (cleaned.more);
  const retained = await request('GET', path);
  assert.equal(retained.id, current.id);
  assert.deepEqual(retained.configuration, current.configuration);
  // A live source can advance while cleanup runs. The API never rewrites its timestamps.
  if (current.task?.ended_at === null)
    assert.equal(retained.task?.id, current.task.id);
  console.log(
    JSON.stringify(
      { policy, cleanup: cleaned, current: retained, history: records },
      null,
      2,
    ),
  );
} else
  console.log(JSON.stringify({ policy, current, history: records }, null, 2));
