import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../../packages/server/src/platform/db/index.ts';
import { configuration } from '../../apps/server/src/config.ts';
import {
  register,
  login,
} from '../../packages/server/src/core/identity/use-cases.ts';
import { PublicFailure } from '../../packages/server/src/platform/http/failure.ts';

const policy = configuration().auth;
const input = {
  email: 'recovery@example.test',
  password: 'a-long-test-password',
};
const failure = (code: string) => (error: unknown) =>
  error instanceof PublicFailure && error.code === code;
test('audit failure rolls back account and first Owner; real use-case retry recovers', async () => {
  const db = new Database();
  const context = { db, clock: { now: () => new Date().toISOString() } };
  try {
    await db.initialize();
    await db.script(
      { id: 'install-audit-fault', kind: 'startup' },
      `create function labos_threejs_core.reject_audit() returns trigger language plpgsql as $$ begin raise exception 'controlled audit failure'; end $$; create trigger reject_audit before insert on labos_threejs_core.audit_events for each row execute function labos_threejs_core.reject_audit();`,
    );
    await assert.rejects(
      register(context, policy, input, 'register-failed'),
      failure('auth.unavailable'),
    );
    await assert.rejects(
      login(context, policy, input, 'login-missing'),
      failure('auth.invalid_credentials'),
    );
    await db.script(
      { id: 'remove-audit-fault', kind: 'startup' },
      'drop trigger reject_audit on labos_threejs_core.audit_events',
    );
    const recovered = await register(
      context,
      policy,
      input,
      'register-recovered',
    );
    assert.equal(recovered.session.user.role, 'owner');
    const signedIn = await login(context, policy, input, 'login-recovered');
    assert.equal(signedIn.session.user.id, recovered.session.user.id);
  } finally {
    await db.close();
  }
});
test('session insert failure preserves the committed Owner account and later login recovers', async () => {
  const db = new Database();
  const context = { db, clock: { now: () => new Date().toISOString() } };
  try {
    await db.initialize();
    await db.script(
      { id: 'install-session-fault', kind: 'startup' },
      `create function labos_threejs_core.reject_session() returns trigger language plpgsql as $$ begin raise exception 'controlled session failure'; end $$; create trigger reject_session before insert on labos_threejs_core.sessions for each row execute function labos_threejs_core.reject_session();`,
    );
    await assert.rejects(
      register(context, policy, input, 'register-session-failed'),
      failure('auth.session_unavailable'),
    );
    await assert.rejects(
      register(context, policy, input, 'register-duplicate'),
      failure('auth.email_exists'),
    );
    await db.script(
      { id: 'remove-session-fault', kind: 'startup' },
      'drop trigger reject_session on labos_threejs_core.sessions',
    );
    const recovered = await login(context, policy, input, 'login-recovered');
    assert.equal(recovered.session.user.role, 'owner');
    const later = await register(
      context,
      policy,
      { ...input, email: 'member@example.test' },
      'later-register',
    );
    assert.equal(later.session.user.role, 'member');
  } finally {
    await db.close();
  }
});
