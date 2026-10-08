import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const base = process.env.LAB_API_BASE ?? 'http://127.0.0.1:3000';
const key = process.env.LAB_API_KEY;
if (!key) throw new Error('Set LAB_API_KEY to an active lab:full credential');
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
    headers: { authorization: `Bearer ${key}` },
  };
  const read = await getLabGuideProgress(options);
  assert.equal(read.response.status, 200);
  if (
    read.data.compatibility !== 'compatible' &&
    process.env.LAB_GUIDE_START_CURRENT !== 'true'
  ) {
    console.log(
      JSON.stringify({
        current: read.data,
        result: 'explicit_current_version_choice_required',
      }),
    );
  } else if (read.data.progress.status === 'completed') {
    console.log(
      JSON.stringify({
        current: read.data,
        result: 'completed_position_review',
        writePerformed: false,
      }),
    );
  } else {
    const current = read.data.progress;
    const body = {
      expected_revision: current.revision,
      status: 'paused',
      step: current.step ?? 'create_lab',
      guide_attempt_id: current.guide_attempt_id ?? randomUUID(),
      context: current.context,
    };
    const saved = await saveLabGuideProgress({ ...options, body });
    assert.equal(saved.response.status, 200);
    assert.equal(saved.data.revision, current.revision + 1);
    const stale = await saveLabGuideProgress({ ...options, body });
    assert.equal(stale.response.status, 409);
    assert.equal(stale.error.error.code, 'lab.guide_progress_conflict');
    const recovered = await getLabGuideProgress(options);
    assert.equal(recovered.response.status, 200);
    assert.deepEqual(recovered.data.progress, saved.data);
    console.log(
      JSON.stringify({
        before: read.data,
        saved: saved.data,
        conflict: stale.error.error.code,
        recovered: recovered.data,
      }),
    );
  }
} finally {
  await loader.close();
}
