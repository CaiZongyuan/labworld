const base = process.env.LAB_API_BASE ?? 'http://127.0.0.1:3000';
const secret = process.env.LAB_API_KEY;
const lab = process.env.LAB_ID;
if (!secret || !lab) throw new Error('Set LAB_API_KEY and LAB_ID');
const lifetime = new AbortController();
process.once('SIGINT', () => lifetime.abort());
process.once('SIGTERM', () => lifetime.abort());
let reconnect = process.argv.includes('--reconnect');

async function observe() {
  const connection = new AbortController();
  const response = await fetch(
    `${base}/api/v1/lab/labs/${encodeURIComponent(lab)}/world/subscribe`,
    {
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.any([lifetime.signal, connection.signal]),
    },
  );
  if (!response.ok)
    throw new Error(`Subscription rejected: HTTP ${response.status}`);
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = '';
  try {
    while (!lifetime.signal.aborted) {
      const { value, done } = await reader.read();
      if (done) return false;
      pending += value;
      if (new TextEncoder().encode(pending).length > 1024 * 1024 + 64)
        throw new Error('Subscription frame exceeded its limit');
      let boundary;
      while ((boundary = pending.indexOf('\n\n')) >= 0) {
        const frame = pending.slice(0, boundary);
        pending = pending.slice(boundary + 2);
        const data = frame
          .split('\n')
          .find((line) => line.startsWith('data: '));
        if (!data) continue;
        const event = JSON.parse(data.slice(6));
        if (event.type === 'snapshot') {
          console.log(
            JSON.stringify({
              type: 'snapshot',
              version: event.world.version,
              lab: event.world.lab.id,
              entities: event.world.entities.map((entity) => ({
                id: entity.id,
                name: entity.name,
                run: entity.program_run?.id,
                values: entity.observation?.values,
              })),
            }),
          );
          if (process.argv.includes('--once')) return false;
        } else if (event.type === 'update') {
          console.log(JSON.stringify(event));
          if (reconnect) {
            reconnect = false;
            console.log('Reopening subscription for the latest snapshot');
            return true;
          }
        } else if (event.type !== 'heartbeat')
          console.log(JSON.stringify(event));
        if (event.type === 'access_ended') return false;
        if (event.type === 'resync') return true;
      }
    }
    return false;
  } finally {
    connection.abort();
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
try {
  while (!lifetime.signal.aborted) {
    if (!(await observe())) break;
  }
} catch (error) {
  if (!lifetime.signal.aborted) throw error;
}
