// Paste into the Console of the authenticated, same-origin Lab page.
// Call with a Lab UUID whose Session is running or paused. Neither action is accepted.
globalThis.checkSessionRefusals = async function checkSessionRefusals(labId) {
  const read = async () => {
    const response = await fetch(`/api/v1/lab/labs/${labId}/sessions`);
    if (!response.ok)
      throw new Error(`Session list failed: ${response.status}`);
    const page = await response.json();
    return page.data.find((session) => session.id === page.active_session_id);
  };
  const before = await read();
  if (
    !before ||
    !['running', 'paused'].includes(before.status) ||
    before.revision < 1
  )
    throw new Error(
      'Start or Pause a Session, wait for its final state, then retry.',
    );
  const identityResponse = await fetch('/api/v1/auth/session');
  if (!identityResponse.ok) throw new Error('Sign in before this check.');
  const identity = await identityResponse.json();
  const action = before.status === 'paused' ? 'resume' : 'pause';
  const path = `/api/v1/lab/labs/${labId}/sessions/${before.id}/${action}`;
  const conflict = await fetch(path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': identity.csrf_token,
    },
    body: JSON.stringify({ expected_revision: before.revision - 1 }),
  });
  if (conflict.status !== 409)
    throw new Error(`Expected conflict 409, received ${conflict.status}`);
  const denied = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expected_revision: before.revision }),
  });
  if (denied.status !== 403)
    throw new Error(`Expected CSRF refusal 403, received ${denied.status}`);
  const after = await read();
  if (
    after?.id !== before.id ||
    after.revision !== before.revision ||
    after.status !== before.status
  )
    throw new Error(
      'Session changed during the check. Stop other controls and retry.',
    );
  console.log({
    conflict: conflict.status,
    denied: denied.status,
    unchanged: true,
    session_id: after.id,
  });
};
