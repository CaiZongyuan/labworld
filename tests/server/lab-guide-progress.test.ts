import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type {
  CreatedApiKey,
  PersistentLab,
  LabEntity,
  LabWorld,
  LabGuideProgressRead as ProgressRead,
} from '../../packages/contracts/src/generated/types.gen.ts';
import { ServerProcess, until } from '../support/server-process.ts';
import { CoreHttp } from '../support/core-http.ts';
import { deviceHttpFixture } from '../support/device-http.ts';

const path = '/api/v1/lab/guides/lab-onboarding/1.0/progress';
type Progress = {
  guide_id: string;
  guide_version: string;
  revision: number;
  status: string;
  step: string | null;
  guide_attempt_id: string | null;
  context: unknown;
  updated_at: string | null;
};
test('initial progress is private to the current user, permits no Lab and is shared with that user Agent', async () => {
  const target = await new ServerProcess().create();
  target.env.APP_ORIGIN = target.url;
  try {
    await target.start();
    await new CoreHttp(target.url).register('owner@example.test');
    const member = new CoreHttp(target.url);
    const other = new CoreHttp(target.url);
    await member.register('progress-member@example.test');
    await other.register('other-member@example.test');
    assert.equal(member.session!.user.role, 'member');
    assert.equal(other.session!.user.role, 'member');
    const missing: ProgressRead = {
      current_guide_version: '1.0',
      compatibility: 'compatible',
      progress: {
        guide_id: 'lab-onboarding',
        guide_version: '1.0',
        revision: 0,
        status: 'not_started',
        step: null,
        guide_attempt_id: null,
        context: null,
        updated_at: null,
      },
      previous_progress: null,
    };
    assert.deepEqual(await member.json<ProgressRead>('GET', path), missing);
    assert.deepEqual(await other.json<ProgressRead>('GET', path), missing);
    const guideAttempt = randomUUID();
    const input = {
      expected_revision: 0,
      status: 'paused',
      step: 'create_lab',
      guide_attempt_id: guideAttempt,
      context: null,
    };
    const saved = await member.json<Progress>('PUT', path, input);
    assert.equal(saved.revision, 1);
    assert.equal(saved.status, 'paused');
    assert.equal(saved.guide_attempt_id, guideAttempt);
    assert.equal(saved.context, null);
    assert.equal(typeof saved.updated_at, 'string');
    assert.deepEqual(
      (await member.json<ProgressRead>('GET', path)).progress,
      saved,
    );
    assert.deepEqual(await other.json<ProgressRead>('GET', path), missing);
    const key = await member.json<CreatedApiKey>(
      'POST',
      '/api/v1/api-keys',
      {
        name: 'Personal progress Agent',
        scopes: ['lab:full'],
        expires_in_days: 1,
      },
      201,
    );
    const agent = new CoreHttp(target.url, {
      authorization: `Bearer ${key.secret}`,
    });
    assert.deepEqual(
      (await agent.json<ProgressRead>('GET', path)).progress,
      saved,
    );
    const resumed = await agent.json<Progress>('PUT', path, {
      ...input,
      expected_revision: 1,
      status: 'in_progress',
    });
    assert.equal(resumed.revision, 2);
    assert.deepEqual(
      (await member.json<ProgressRead>('GET', path)).progress,
      resumed,
    );
    assert.deepEqual(await other.json<ProgressRead>('GET', path), missing);
    assert.deepEqual(
      (await member.json<{ data: unknown[] }>('GET', '/api/v1/lab/labs')).data,
      [],
    );
  } finally {
    console.log(
      JSON.stringify({
        event: 'guide.progress.fixture',
        path: target.evidence + '/owned-resources.json',
      }),
    );
    await target.cleanup();
  }
});

test('generated SDK tutorial pauses and recovers private progress; completed position review performs no write', async () => {
  const target = await new ServerProcess().create();
  target.env.APP_ORIGIN = target.url;
  try {
    await target.start();
    const client = new CoreHttp(target.url);
    await client.register('guide-sdk@example.test');
    const key = await client.json<CreatedApiKey>(
      'POST',
      '/api/v1/api-keys',
      { name: 'Guide SDK example', scopes: ['lab:full'], expires_in_days: 1 },
      201,
    );
    async function run() {
      const actor = await new ServerProcess().create();
      actor.entry = 'examples/lab/guide-progress.mjs';
      actor.env = { LAB_API_BASE: target.url, LAB_API_KEY: key.secret };
      try {
        await actor.spawn();
        assert.equal(
          await until(
            async () => actor.child!.exitCode,
            (value) => value !== null,
          ),
          0,
        );
        return JSON.parse(actor.logs.trim());
      } finally {
        console.log(
          JSON.stringify({
            event: 'guide.sdk.fixture',
            path: actor.evidence + '/owned-resources.json',
          }),
        );
        await actor.cleanup();
      }
    }
    const first = await run();
    assert.equal(first.saved.status, 'paused');
    assert.equal(first.saved.step, 'create_lab');
    assert.equal(first.saved.revision, 1);
    assert.equal(first.saved.context, null);
    assert.equal(first.conflict, 'lab.guide_progress_conflict');
    assert.deepEqual(
      (await client.json<ProgressRead>('GET', path)).progress,
      first.saved,
    );
    const completed = await client.json<Progress>('PUT', path, {
      expected_revision: 1,
      status: 'completed',
      step: 'complete',
      guide_attempt_id: first.saved.guide_attempt_id,
      context: null,
    });
    const review = await run();
    assert.equal(review.result, 'completed_position_review');
    assert.equal(review.writePerformed, false);
    assert.deepEqual(
      (await client.json<ProgressRead>('GET', path)).progress,
      completed,
    );
    assert.deepEqual(
      (await client.json<{ data: unknown[] }>('GET', '/api/v1/lab/labs')).data,
      [],
    );
  } finally {
    console.log(
      JSON.stringify({
        event: 'guide.progress.fixture',
        path: target.evidence + '/owned-resources.json',
      }),
    );
    await target.cleanup();
  }
});

test('authentication scope and CSRF refusals preserve private progress and permit recovery after logout and key revocation', async () => {
  const fixture = await deviceHttpFixture();
  const client = fixture.client;
  try {
    const input = {
      expected_revision: 0,
      status: 'paused',
      step: 'create_lab',
      guide_attempt_id: randomUUID(),
      context: null,
    };
    const saved = await client.json<Progress>('PUT', path, input);
    const changed = { ...input, expected_revision: 1, status: 'in_progress' };
    const anonymous = new CoreHttp(client.url);
    await anonymous.error('GET', path, undefined, 401, 'auth.unauthorized');
    await anonymous.error('PUT', path, changed, 401, 'auth.unauthorized');
    await client.error('PUT', path, changed, 403, 'auth.csrf', {
      'x-csrf-token': '',
    });
    await client.error('PUT', path, changed, 403, 'auth.origin', {
      origin: 'https://different.example.test',
    });
    await client.error('GET', path, undefined, 401, 'auth.unauthorized', {
      authorization: 'Bearer invalid-does-not-fall-back-to-cookie',
    });
    const limited = await client.json<CreatedApiKey>(
      'POST',
      '/api/v1/api-keys',
      {
        name: 'Wrong progress scope',
        scopes: ['profile:read'],
        expires_in_days: 1,
      },
      201,
    );
    await new CoreHttp(client.url, {
      authorization: `Bearer ${limited.secret}`,
    }).error('PUT', path, changed, 403, 'api_keys.scope_forbidden');
    const key = await client.json<CreatedApiKey>(
      'POST',
      '/api/v1/api-keys',
      {
        name: 'Progress recovery key',
        scopes: ['lab:full'],
        expires_in_days: 1,
      },
      201,
    );
    const agent = new CoreHttp(client.url, {
      authorization: `Bearer ${key.secret}`,
    });
    await client.json(
      'DELETE',
      `/api/v1/api-keys/${key.key.id}`,
      undefined,
      204,
    );
    await agent.error('GET', path, undefined, 401, 'auth.unauthorized');
    await agent.error('PUT', path, changed, 401, 'auth.unauthorized');
    assert.deepEqual(
      (await client.json<ProgressRead>('GET', path)).progress,
      saved,
    );
    await client.json('POST', '/api/v1/auth/logout', undefined, 204);
    await client.error('GET', path, undefined, 401, 'auth.unauthorized');
    await client.error('PUT', path, changed, 401, 'auth.unauthorized');
    await client.login('member@example.test');
    assert.deepEqual(
      (await client.json<ProgressRead>('GET', path)).progress,
      saved,
    );
    const recovered = await client.json<Progress>('PUT', path, changed);
    assert.equal(recovered.revision, 2);
  } finally {
    console.log(
      JSON.stringify({
        event: 'guide.progress.fixture',
        path: fixture.target.evidence + '/owned-resources.json',
      }),
    );
    await fixture.close();
  }
});

test('audit storage rejection rolls progress revision back and healthy retry leaves World Run Command and Task unchanged', async () => {
  const fixture = await deviceHttpFixture();
  try {
    const entity = await fixture.register('light');
    await fixture.start(entity.id);
    const worldPath = `/api/v1/lab/labs/${fixture.lab.id}/world`;
    const input = {
      expected_revision: 0,
      status: 'in_progress',
      step: 'start_program',
      guide_attempt_id: randomUUID(),
      context: {
        lab_id: fixture.lab.id,
        entity_id: entity.id,
        node_id: null,
        business_attempt: null,
      },
    };
    const saved = await fixture.client.json<Progress>('PUT', path, input);
    const before = await fixture.client.json<LabWorld>('GET', worldPath);
    await fixture.db.script(
      { id: 'guide-owned-audit-fault', kind: 'startup' },
      `create function labos_threejs_core.reject_guide_audit() returns trigger language plpgsql as $$ begin if NEW.action='lab.guide_progress.save' then raise exception 'controlled guide audit failure'; end if; return NEW; end $$; create trigger reject_guide_audit before insert on labos_threejs_core.audit_events for each row execute function labos_threejs_core.reject_guide_audit();`,
    );
    const changed = {
      ...input,
      expected_revision: 1,
      status: 'completed',
      step: 'complete',
    };
    await fixture.client.error('PUT', path, changed, 503, 'lab.unavailable');
    assert.deepEqual(
      (await fixture.client.json<ProgressRead>('GET', path)).progress,
      saved,
    );
    assert.deepEqual(
      await fixture.client.json<LabWorld>('GET', worldPath),
      before,
    );
    await fixture.db.script(
      { id: 'guide-owned-audit-recovery', kind: 'startup' },
      'drop trigger reject_guide_audit on labos_threejs_core.audit_events; drop function labos_threejs_core.reject_guide_audit();',
    );
    const completed = await fixture.client.json<Progress>('PUT', path, changed);
    assert.equal(completed.revision, 2);
    assert.equal(completed.status, 'completed');
    assert.deepEqual(
      (await fixture.client.json<ProgressRead>('GET', path)).progress,
      completed,
    );
    assert.deepEqual(
      await fixture.client.json<LabWorld>('GET', worldPath),
      before,
    );
  } finally {
    console.log(
      JSON.stringify({
        event: 'guide.progress.fixture',
        path: fixture.target.evidence + '/owned-resources.json',
      }),
    );
    await fixture.close();
  }
});

test('older progress stays readable and requires explicit current-version start without changing its stored milestone', async () => {
  const fixture = await deviceHttpFixture();
  try {
    const attempt = randomUUID();
    await fixture.db.script(
      { id: 'owned-historical-guide-record', kind: 'startup' },
      `insert into lab.guide_progress(actor_id,guide_id,guide_version,revision,status,step,guide_attempt_id,context,updated_at) values('${fixture.client.session!.user.id}'::uuid,'lab-onboarding','0.9',4,'completed','old_layout_hint','${attempt}'::uuid,null,'2026-09-01T12:00:00.123456Z'::timestamptz)`,
    );
    const oldPath = '/api/v1/lab/guides/lab-onboarding/0.9/progress';
    const original = await fixture.client.json<ProgressRead>('GET', oldPath);
    assert.equal(original.compatibility, 'unsupported');
    assert.equal(original.progress.step, 'old_layout_hint');
    assert.equal(original.progress.updated_at, '2026-09-01T12:00:00.123456Z');
    const current = await fixture.client.json<ProgressRead>('GET', path);
    assert.equal(current.compatibility, 'restart_required');
    assert.equal(current.progress.revision, 0);
    const previous: ProgressRead['previous_progress'] = original.progress;
    assert.deepEqual(current.previous_progress, previous);
    const input = {
      expected_revision: 0,
      status: 'paused',
      step: 'create_lab',
      guide_attempt_id: randomUUID(),
      context: null,
    };
    await fixture.client.error(
      'PUT',
      oldPath,
      { ...input, expected_revision: 4 },
      400,
      'lab.guide_version_unsupported',
    );
    assert.deepEqual(
      await fixture.client.json<ProgressRead>('GET', oldPath),
      original,
    );
    const saved = await fixture.client.json<Progress>('PUT', path, input);
    assert.equal(saved.revision, 1);
    const started = await fixture.client.json<ProgressRead>('GET', path);
    assert.equal(started.compatibility, 'compatible');
    assert.equal(started.previous_progress, null);
    assert.deepEqual(
      await fixture.client.json<ProgressRead>('GET', oldPath),
      original,
    );
    await fixture.client.error(
      'GET',
      '/api/v1/lab/guides/not-a-guide/1.0/progress',
      undefined,
      404,
      'lab.guide_not_found',
    );
  } finally {
    console.log(
      JSON.stringify({
        event: 'guide.progress.fixture',
        path: fixture.target.evidence + '/owned-resources.json',
      }),
    );
    await fixture.close();
  }
});

test('expired credentials and inactive membership refuse progress without deleting the private record', async () => {
  const fixture = await deviceHttpFixture();
  try {
    const owner = new CoreHttp(fixture.client.url);
    await owner.login('owner@example.test');
    const input = {
      expected_revision: 0,
      status: 'paused',
      step: 'create_lab',
      guide_attempt_id: randomUUID(),
      context: null,
    };
    const saved = await fixture.client.json<Progress>('PUT', path, input);
    const key = await fixture.client.json<CreatedApiKey>(
      'POST',
      '/api/v1/api-keys',
      {
        name: 'Expires before progress access',
        scopes: ['lab:full'],
        expires_in_days: 1,
      },
      201,
    );
    const agent = new CoreHttp(fixture.client.url, {
      authorization: `Bearer ${key.secret}`,
    });
    fixture.setTime('2026-10-12T12:00:00.000Z');
    await agent.error('GET', path, undefined, 401, 'auth.unauthorized');
    await agent.error(
      'PUT',
      path,
      { ...input, expected_revision: 1 },
      401,
      'auth.unauthorized',
    );
    await fixture.db.script(
      { id: 'owned-progress-session-expiry', kind: 'startup' },
      `update labos_threejs_core.sessions set expires_at=now()-interval '1 second' where user_id='${fixture.client.session!.user.id}'::uuid`,
    );
    await fixture.client.error(
      'GET',
      path,
      undefined,
      401,
      'auth.unauthorized',
    );
    await fixture.client.login('member@example.test');
    assert.deepEqual(
      (await fixture.client.json<ProgressRead>('GET', path)).progress,
      saved,
    );
    await owner.login('owner@example.test');
    const members = await owner.json<{
      data: { user_id: string; role: string; version: number }[];
    }>('GET', '/api/v1/organization/members');
    const current = members.data.find(
      (value) => value.user_id === fixture.client.session!.user.id,
    )!;
    await owner.json('PUT', `/api/v1/organization/members/${current.user_id}`, {
      role: current.role,
      active: false,
      version: current.version,
    });
    await fixture.client.error(
      'GET',
      path,
      undefined,
      401,
      'auth.unauthorized',
    );
    await fixture.client.error(
      'PUT',
      path,
      { ...input, expected_revision: 1 },
      401,
      'auth.unauthorized',
    );
    const changed = (
      await owner.json<typeof members>('GET', '/api/v1/organization/members')
    ).data.find((value) => value.user_id === current.user_id)!;
    await owner.json('PUT', `/api/v1/organization/members/${current.user_id}`, {
      role: current.role,
      active: true,
      version: changed.version,
    });
    await fixture.client.login('member@example.test');
    assert.deepEqual(
      (await fixture.client.json<ProgressRead>('GET', path)).progress,
      saved,
    );
  } finally {
    console.log(
      JSON.stringify({
        event: 'guide.progress.fixture',
        path: fixture.target.evidence + '/owned-resources.json',
      }),
    );
    await fixture.close();
  }
});

test('named progress request reply and whole-operation SQL budgets retain records after invalid input', async () => {
  const target = await new ServerProcess().create();
  target.env.APP_ORIGIN = target.url;
  try {
    await target.start();
    const client = new CoreHttp(target.url);
    await client.register('guide-budget@example.test');
    const body = {
      expected_revision: 0,
      status: 'paused',
      step: 'create_lab',
      guide_attempt_id: randomUUID(),
      context: null,
    };
    const measured: {
      method: string;
      statements: number;
      bytes: number;
      budget: number;
    }[] = [];
    for (const method of ['GET', 'PUT']) {
      const response = await client.response(
        method,
        path,
        method === 'PUT' ? body : undefined,
      );
      assert.equal(response.status, 200);
      const bytes = (await response.arrayBuffer()).byteLength;
      const requestId = response.headers.get('x-request-id');
      const rows = target.logs.split('\n').flatMap((line) => {
        try {
          return [JSON.parse(line)];
        } catch {
          return [];
        }
      });
      const receipt = rows.find(
        (row) => row.event === 'database.operation' && row.id === requestId,
      )!;
      assert.ok(receipt);
      const budget = method === 'GET' ? 6 : 8;
      assert.equal(receipt.budget, budget);
      assert.ok(receipt.statements <= budget);
      assert.ok(bytes <= (method === 'GET' ? 12288 : 6144));
      measured.push({ method, statements: receipt.statements, bytes, budget });
    }
    const saved = (await client.json<ProgressRead>('GET', path)).progress;
    for (const invalid of [
      { ...body, expected_revision: Number.MAX_SAFE_INTEGER },
      { ...body, expected_revision: 1.5 },
      { ...body, expected_revision: 1, step: 'driver_step_4' },
      { ...body, expected_revision: 1, status: 'not_started' },
    ]) {
      const response = await client.response('PUT', path, invalid);
      assert.equal(response.status, 400);
      await response.arrayBuffer();
    }
    const oversized = await fetch(client.url + path, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        origin: client.url,
        cookie: client.cookie!,
        'x-csrf-token': client.csrf!,
      },
      body: ' '.repeat(8192) + JSON.stringify(body),
    });
    assert.equal(oversized.status, 413);
    assert.equal((await oversized.json()).error.code, 'http.payload_too_large');
    assert.deepEqual(
      (await client.json<ProgressRead>('GET', path)).progress,
      saved,
    );
    console.log(JSON.stringify({ event: 'guide.progress.budgets', measured }));
  } finally {
    console.log(
      JSON.stringify({
        event: 'guide.progress.fixture',
        path: target.evidence + '/owned-resources.json',
      }),
    );
    await target.cleanup();
  }
});

test('shared Lab references are valid private learning context without changing the World', async () => {
  const target = await new ServerProcess().create();
  target.env.APP_ORIGIN = target.url;
  try {
    await target.start();
    await new CoreHttp(target.url).register('owner@example.test');
    const member = new CoreHttp(target.url);
    const other = new CoreHttp(target.url);
    await member.register('context-member@example.test');
    await other.register('context-other@example.test');
    const lab = await member.json<PersistentLab>(
      'POST',
      '/api/v1/lab/labs',
      { name: 'Shared learning Lab' },
      201,
    );
    const entity = await member.json<LabEntity>(
      'POST',
      `/api/v1/lab/labs/${lab.id}/entities`,
      {
        name: 'Existing shared light',
        definition_id: 'light',
        definition_version: '1.0',
        reality: 'simulated',
        configuration: {},
        representation_id: null,
      },
      201,
    );
    const worldPath = `/api/v1/lab/labs/${lab.id}/world`;
    const before = await member.json<LabWorld>('GET', worldPath);
    const nodes = before.nodes.filter((node) => node.entity_id === entity.id);
    assert.equal(nodes.length, 1);
    const context = {
      lab_id: lab.id,
      entity_id: entity.id,
      node_id: nodes[0].id,
      business_attempt: {
        operation: 'register_entity',
        target_lab_id: lab.id,
        request_key: 'never-submitted-context-intent',
      },
    };
    const input = {
      expected_revision: 0,
      status: 'paused',
      step: 'edit_placement',
      guide_attempt_id: randomUUID(),
      context,
    };
    const saved = await member.json<Progress>('PUT', path, input);
    assert.deepEqual(saved.context, context);
    const independent = await other.json<ProgressRead>('GET', path);
    assert.equal(independent.progress.status, 'not_started');
    const otherSaved = await other.json<Progress>('PUT', path, {
      ...input,
      guide_attempt_id: randomUUID(),
    });
    assert.equal(otherSaved.revision, 1);
    assert.notEqual(otherSaved.guide_attempt_id, saved.guide_attempt_id);
    assert.deepEqual(
      (await member.json<ProgressRead>('GET', path)).progress,
      saved,
    );
    assert.deepEqual(await member.json<LabWorld>('GET', worldPath), before);
  } finally {
    console.log(
      JSON.stringify({
        event: 'guide.progress.fixture',
        path: target.evidence + '/owned-resources.json',
      }),
    );
    await target.cleanup();
  }
});

test('progress CAS rejects a stale concurrent write and recovers through an explicit fresh revision', async () => {
  const target = await new ServerProcess().create();
  target.env.APP_ORIGIN = target.url;
  try {
    await target.start();
    const client = new CoreHttp(target.url);
    await client.register('progress-cas@example.test');
    const attempts = [randomUUID(), randomUUID()];
    const writes = attempts.map((guide_attempt_id) => ({
      expected_revision: 0,
      status: 'paused',
      step: 'create_lab',
      guide_attempt_id,
      context: null,
    }));
    const responses = await Promise.all(
      writes.map((input) => client.response('PUT', path, input)),
    );
    assert.deepEqual(
      responses.map((response) => response.status).sort(),
      [200, 409],
    );
    const winner = (await responses
      .find((response) => response.status === 200)!
      .json()) as Progress;
    const rejected = await responses
      .find((response) => response.status === 409)!
      .json();
    assert.equal(rejected.error.code, 'lab.guide_progress_conflict');
    assert.equal(typeof rejected.error.request_id, 'string');
    assert.equal(winner.revision, 1);
    assert.deepEqual(
      (await client.json<ProgressRead>('GET', path)).progress,
      winner,
    );
    const stale = writes.find(
      (input) => input.guide_attempt_id !== winner.guide_attempt_id,
    )!;
    await client.error('PUT', path, stale, 409, 'lab.guide_progress_conflict');
    assert.deepEqual(
      (await client.json<ProgressRead>('GET', path)).progress,
      winner,
    );
    const recovered = await client.json<Progress>('PUT', path, {
      ...stale,
      expected_revision: winner.revision,
      status: 'in_progress',
    });
    assert.equal(recovered.revision, 2);
    assert.equal(recovered.guide_attempt_id, stale.guide_attempt_id);
    assert.deepEqual(
      (await client.json<ProgressRead>('GET', path)).progress,
      recovered,
    );
  } finally {
    console.log(
      JSON.stringify({
        event: 'guide.progress.fixture',
        path: target.evidence + '/owned-resources.json',
      }),
    );
    await target.cleanup();
  }
});

test('invalid or forged context preserves progress; original identities survive rename, archive and Node removal', async () => {
  const target = await new ServerProcess().create();
  target.env.APP_ORIGIN = target.url;
  try {
    await target.start();
    const client = new CoreHttp(target.url);
    await client.register('progress-context-lifecycle@example.test');
    const lab = await client.json<PersistentLab>(
      'POST',
      '/api/v1/lab/labs',
      { name: 'Original progress Lab' },
      201,
    );
    const second = await client.json<PersistentLab>(
      'POST',
      '/api/v1/lab/labs',
      { name: 'Different Lab' },
      201,
    );
    const entity = await client.json<LabEntity>(
      'POST',
      `/api/v1/lab/labs/${lab.id}/entities`,
      {
        name: 'Original light',
        definition_id: 'light',
        definition_version: '1.0',
        reality: 'simulated',
        configuration: {},
        representation_id: null,
      },
      201,
    );
    const worldPath = `/api/v1/lab/labs/${lab.id}/world`;
    const before = await client.json<LabWorld>('GET', worldPath);
    const node = before.nodes.find((value) => value.entity_id === entity.id)!;
    const context = {
      lab_id: lab.id,
      entity_id: entity.id,
      node_id: node.id,
      business_attempt: null,
    };
    const input = {
      expected_revision: 0,
      status: 'in_progress',
      step: 'select_entity',
      guide_attempt_id: randomUUID(),
      context,
    };
    const saved = await client.json<Progress>('PUT', path, input);
    for (const forged of [
      { ...input, expected_revision: 1, actor_id: randomUUID() },
      {
        ...input,
        expected_revision: 1,
        context: { ...context, committed_entity_id: entity.id },
      },
      {
        ...input,
        expected_revision: 1,
        context: {
          ...context,
          business_attempt: {
            operation: 'register_entity',
            target_lab_id: lab.id,
            request_key: 'client-only',
            receipt: entity.id,
          },
        },
      },
    ])
      await client.error('PUT', path, forged, 400, 'http.invalid_json');
    for (const invalid of [
      { ...context, lab_id: second.id },
      { ...context, lab_id: null },
      { ...context, node_id: randomUUID() },
      {
        ...context,
        business_attempt: {
          operation: 'register_entity',
          target_lab_id: second.id,
          request_key: 'wrong-Lab',
        },
      },
      {
        ...context,
        business_attempt: {
          operation: 'create_lab',
          target_lab_id: lab.id,
          request_key: 'not-a-receipt',
        },
      },
    ])
      await client.error(
        'PUT',
        path,
        { ...input, expected_revision: 1, context: invalid },
        400,
        'lab.invalid_reference',
      );
    assert.deepEqual(
      (await client.json<ProgressRead>('GET', path)).progress,
      saved,
    );
    assert.deepEqual(await client.json<LabWorld>('GET', worldPath), before);
    await client.json(
      'PATCH',
      `/api/v1/lab/labs/${lab.id}/entities/${entity.id}`,
      { name: 'Renamed light', configuration: {} },
    );
    const archived = await client.json<LabEntity>(
      'POST',
      `/api/v1/lab/labs/${lab.id}/entities/${entity.id}/archive`,
    );
    assert.ok(archived.archived_at);
    const archivedWorld = await client.json<LabWorld>('GET', worldPath);
    await client.json('PUT', `/api/v1/lab/labs/${lab.id}/layout`, {
      expected_version: archivedWorld.lab.layout_version,
      nodes: archivedWorld.nodes
        .filter((value) => value.id !== node.id)
        .map(({ id, entity_id, representation_id, placement }) => ({
          id,
          entity_id,
          representation_id,
          placement,
        })),
    });
    const removedWorld = await client.json<LabWorld>('GET', worldPath);
    assert.equal(
      removedWorld.nodes.some((value) => value.id === node.id),
      false,
    );
    assert.deepEqual(
      (await client.json<ProgressRead>('GET', path)).progress.context,
      context,
    );
    const paused = await client.json<Progress>('PUT', path, {
      ...input,
      expected_revision: 1,
      status: 'paused',
      context: {
        ...context,
        lab_id: lab.id.toUpperCase(),
        entity_id: entity.id.toUpperCase(),
        node_id: node.id.toUpperCase(),
      },
    });
    assert.deepEqual(paused.context, context);
    assert.equal(paused.revision, 2);
    assert.deepEqual(
      await client.json<LabWorld>('GET', worldPath),
      removedWorld,
    );
  } finally {
    console.log(
      JSON.stringify({
        event: 'guide.progress.fixture',
        path: target.evidence + '/owned-resources.json',
      }),
    );
    await target.cleanup();
  }
});
