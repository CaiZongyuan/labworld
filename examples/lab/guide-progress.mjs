import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const base = process.env.LAB_API_BASE ?? 'http://127.0.0.1:3000';
const key = process.env.LAB_API_KEY;
const cookie = process.env.LAB_SESSION_COOKIE;
const csrf = process.env.LAB_SESSION_CSRF;
const write = process.env.LAB_GUIDE_WRITE === '1';
if (!key && !cookie) throw new Error('Set LAB_API_KEY or LAB_SESSION_COOKIE');
if (write && !key && !csrf)
  throw new Error('Session writes require LAB_SESSION_CSRF');

const loader = await createServer({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  configFile: false,
  server: { middlewareMode: true, watch: null, hmr: false },
  appType: 'custom',
});
try {
  const { createApiClient, getLabGuideProgress, saveLabGuideProgress } =
    await loader.ssrLoadModule('/packages/sdk/src/index.ts');
  const options = {
    client: createApiClient(base, { timeoutMs: 10000 }),
    path: { guide_id: 'lab-onboarding', guide_version: '1.0' },
    headers: key
      ? { authorization: `Bearer ${key}` }
      : {
          cookie,
          origin: process.env.LAB_WEB_ORIGIN ?? 'http://127.0.0.1:5173',
          ...(csrf ? { 'x-csrf-token': csrf } : {}),
        },
  };
  const read = await getLabGuideProgress(options);
  assert.equal(read.response.status, 200);
  const result = { read: read.data };
  if (write) {
    assert.notEqual(read.data.compatibility, 'unsupported');
    const before = read.data.progress;
    const attempt = before.guide_attempt_id ?? randomUUID();
    const body = {
      expected_revision: before.revision,
      status: before.status === 'completed' ? 'completed' : 'paused',
      step: before.step ?? 'create_lab',
      guide_attempt_id: attempt,
      context:
        before.revision > 0
          ? before.context
          : {
              lab_id: null,
              entity_id: null,
              node_id: null,
              business_attempt: {
                operation: 'create_lab',
                target_lab_id: null,
                request_key: `progress-tutorial-${attempt}`,
              },
            },
    };
    const saved = await saveLabGuideProgress({ ...options, body });
    assert.equal(saved.response.status, 200);
    assert.equal(saved.data.revision, before.revision + 1);
    const forged = await saveLabGuideProgress({
      ...options,
      body: {
        ...body,
        expected_revision: saved.data.revision,
        committed_context: body.context,
      },
    });
    assert.equal(forged.response.status, 400);
    const stale = await saveLabGuideProgress({ ...options, body });
    assert.equal(stale.response.status, 409);
    const recovered = await getLabGuideProgress(options);
    assert.equal(recovered.response.status, 200);
    assert.deepEqual(recovered.data.progress, saved.data);
    result.saved = saved.data;
    result.recovered = recovered.data;
  }
  console.log(JSON.stringify(result, null, 2));
} finally {
  await loader.close();
}
