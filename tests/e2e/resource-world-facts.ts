import type { Page } from '@playwright/test';

// DEBUG-geometry379: safe projections of actual world responses, without I/O in assertions.
const responses = new WeakMap<Page, Map<string, object>>();
function signature(value: string) {
  let hash = 2166136261;
  for (const char of value)
    hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(16);
}
export function observeResourceWorld(page: Page) {
  const facts = new Map<string, object>();
  responses.set(page, facts);
  page.on('response', (response) => {
    if (!new URL(response.url()).pathname.endsWith('/world')) return;
    void response
      .json()
      .then((world) => {
        if (!world?.lab?.id || !Array.isArray(world.nodes)) return;
        facts.set(signature(world.lab.id), {
          status: response.status(),
          version: world.version,
          lab: signature(world.lab.id),
          nodeCount: world.nodes.length,
          entityCount: world.entities.length,
          assetCount: world.assets.length,
          nodeSignature: signature(
            world.nodes
              .map((node: { id: string }) => node.id)
              .sort()
              .join(','),
          ),
        });
      })
      .catch(() => {});
  });
}
export function authoritativeWorld(page: Page, lab: string | undefined) {
  return lab ? (responses.get(page)?.get(lab) ?? null) : null;
}
