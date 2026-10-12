// Run in the Console of the authenticated same-origin Lab page.
// Keep the returned machine credential private; it is never a WebSocket URL.
const secureMotionId = (value) => {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value))
    throw new Error('Use an existing Lab or Installation UUID.');
  return value;
};
globalThis.startExternalSynthetic = async function startExternalSynthetic(
  labId,
  installationId,
) {
  secureMotionId(labId);
  secureMotionId(installationId);
  const auth = await (await fetch('/api/v1/auth/session')).json();
  async function post(path, body) {
    const response = await fetch(path, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'content-type': 'application/json',
        'x-csrf-token': auth.csrf_token,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`Request failed: ${response.status}`);
    return response.json();
  }
  const machine = await post('/api/v1/machines', {
    name: 'External Synthetic Publisher',
  });
  const session = await post(`/api/v1/lab/labs/${labId}/sessions`, {
    installation_id: installationId,
    machine_id: machine.machine.id,
  });
  return { machine, session };
};
