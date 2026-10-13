const base = process.env.LAB_API_BASE ?? 'http://127.0.0.1:3000';
const credential = process.env.LAB_API_KEY;
async function request(path, method = 'GET', body) {
  const response = await fetch(new URL(path, base), {
    method,
    headers: {
      authorization: `Bearer ${credential}`,
      'content-type': 'application/json',
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const result = await response.json();
  if (!response.ok)
    throw new Error(
      `HTTP ${response.status}: ${result.error?.code ?? 'request_failed'}`,
    );
  return result;
}
try {
  if (!credential) throw new Error('Set LAB_API_KEY');
  const lab = await request('/api/v1/lab/labs', 'POST', {
    name: 'Complete asset tutorial',
  });
  const instances = [];
  for (const [name, initial_temperature] of [
    ['Centrifuge A', 4],
    ['Centrifuge B', 20],
  ])
    instances.push(
      await request(`/api/v1/lab/labs/${lab.id}/entities`, 'POST', {
        name,
        definition_id: 'tutorial/centrifuge-c',
        definition_version: '1.0.0',
        reality: 'simulated',
        configuration: { initial_temperature },
      }),
    );
  const world = await request(`/api/v1/lab/labs/${lab.id}/world`);
  const saved = instances.map((instance) =>
    world.entities.find((entity) => entity.id === instance.id),
  );
  if (
    saved[0].id === saved[1].id ||
    saved[0].configuration.initial_temperature !== 4 ||
    saved[1].configuration.initial_temperature !== 20 ||
    saved.some(
      (entity) =>
        entity.binding !== null ||
        entity.observation !== null ||
        entity.capabilities.some((capability) => capability.executable),
    )
  )
    throw new Error('Instance verification failed');
  console.log(
    JSON.stringify(
      {
        lab_id: lab.id,
        instances: saved.map((entity) => ({
          id: entity.id,
          name: entity.name,
          asset_version_id: entity.definition.asset_version.id,
          configuration: entity.configuration,
          binding: entity.binding,
          observation: entity.observation,
        })),
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    error instanceof Error && /^(Set |HTTP |Instance )/.test(error.message)
      ? error.message
      : 'Instance registration did not finish; check the asset version and connection',
  );
  process.exitCode = 1;
}
