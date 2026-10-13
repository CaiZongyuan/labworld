type Resource = { file_id: string; sha256: string; size: number };
/** Frozen versions carry the exact resource closure alongside legacy visual projections. */
export function recordingResources(world: {
  assets: { representation: Resource }[];
  entities: { definition: { asset_version?: { resources: Resource[] } } }[];
}): Resource[] {
  const resources = new Map<string, Resource>();
  for (const asset of world.assets)
    resources.set(asset.representation.file_id, asset.representation);
  for (const entity of world.entities)
    for (const resource of entity.definition.asset_version?.resources ?? [])
      resources.set(resource.file_id, resource);
  return [...resources.values()];
}
