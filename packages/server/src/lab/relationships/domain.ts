export type LayoutRelationship = {
  id: string;
  source_id: string;
  target_id: string;
  kind: 'located_in' | 'contains' | 'simulates';
};
export type EntityRelationship = LayoutRelationship & {
  lab_id: string;
  source: string;
  registered_by: string;
  registered_at: string;
};
export type RelationshipEntity = {
  id: string;
  kind: string;
  reality: string;
  definition_id: string;
};
export function validRelationships(
  entities: RelationshipEntity[],
  relationships: LayoutRelationship[],
) {
  if (relationships.length > 1000) return false;
  const facts = new Set<string>(),
    ids = new Set<string>(),
    map = new Map(entities.map((entity) => [entity.id, entity])),
    parents = new Map<string, string>();
  for (const relationship of relationships) {
    if (
      relationship.source_id === relationship.target_id ||
      ids.has(relationship.id)
    )
      return false;
    ids.add(relationship.id);
    const fact = JSON.stringify([
      relationship.source_id,
      relationship.target_id,
      relationship.kind,
    ]);
    if (facts.has(fact)) return false;
    facts.add(fact);
    const source = map.get(relationship.source_id),
      target = map.get(relationship.target_id);
    if (!source || !target) return false;
    if (relationship.kind === 'simulates') {
      if (
        source.reality !== 'simulated' ||
        target.reality !== 'physical' ||
        source.definition_id !== target.definition_id
      )
        return false;
      continue;
    }
    const child = relationship.kind === 'located_in' ? source : target,
      parent = relationship.kind === 'located_in' ? target : source;
    if (
      !['furniture', 'location', 'labware'].includes(parent.kind) ||
      (parents.has(child.id) && parents.get(child.id) !== parent.id)
    )
      return false;
    parents.set(child.id, parent.id);
  }
  for (const child of parents.keys()) {
    const visited = new Set<string>();
    let current = child;
    while (parents.has(current)) {
      if (visited.has(current)) return false;
      visited.add(current);
      current = parents.get(current)!;
    }
  }
  return true;
}
