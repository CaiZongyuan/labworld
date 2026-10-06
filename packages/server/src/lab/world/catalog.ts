import definitions from './catalog.json' with { type: 'json' };
import type { AssetDefinition } from './domain.ts';
export const catalog: AssetDefinition[] = definitions.map((definition) => ({
  ...definition,
  capabilities: definition.capabilities.map((capability) => ({
    version: '1.0',
    result: null,
    ...capability,
  })),
}));
