import type { LayoutDraft } from './layout-editor';

export type LayoutDraftScope = {
  apiBase: string;
  userId: string;
  labId: string;
};

export type StoredLayoutDraft = {
  draft: LayoutDraft | null;
  problem: 'unavailable' | 'invalid' | null;
};

function storageKey(scope: LayoutDraftScope) {
  return `lab-word.layout-draft.v1:${JSON.stringify([
    scope.apiBase,
    scope.userId,
    scope.labId,
  ])}`;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function identity(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function axis(value: unknown, min: number, max: number) {
  return (
    Array.isArray(value) &&
    value.length === 3 &&
    value.every(
      (number) =>
        typeof number === 'number' &&
        Number.isFinite(number) &&
        number >= min &&
        number <= max,
    )
  );
}

function nodes(value: unknown, labId: string) {
  if (!Array.isArray(value) || value.length > 1000) return false;
  const ids = new Set<string>();
  return value.every((node: unknown) => {
    if (
      !record(node) ||
      !identity(node.id) ||
      ids.has(node.id) ||
      !identity(node.entity_id) ||
      node.lab_id !== labId ||
      !(node.representation_id === null || identity(node.representation_id)) ||
      !record(node.placement) ||
      !axis(node.placement.position, -10000, 10000) ||
      !axis(node.placement.rotation, -10000, 10000) ||
      !axis(node.placement.scale, 0.001, 1000)
    )
      return false;
    ids.add(node.id);
    return true;
  });
}

function relationships(value: unknown) {
  if (!Array.isArray(value) || value.length > 1000) return false;
  const ids = new Set<string>();
  return value.every((relationship: unknown) => {
    if (
      !record(relationship) ||
      !identity(relationship.id) ||
      ids.has(relationship.id) ||
      !identity(relationship.source_id) ||
      !identity(relationship.target_id) ||
      !['located_in', 'contains', 'simulates'].includes(
        String(relationship.kind),
      )
    )
      return false;
    ids.add(relationship.id);
    return true;
  });
}

function validDraft(value: unknown, labId: string): value is LayoutDraft {
  const valid =
    record(value) &&
    Number.isSafeInteger(value.version) &&
    Number(value.version) >= 0 &&
    nodes(value.nodes, labId) &&
    nodes(value.baseNodes, labId) &&
    relationships(value.relationships) &&
    relationships(value.baseRelationships);
  if (!valid || !record(value)) return false;
  const baseline = new Map(
    (value.baseNodes as LayoutDraft['baseNodes']).map((node) => [
      node.id,
      node.entity_id,
    ]),
  );
  if (
    (value.nodes as LayoutDraft['nodes']).some(
      (node) =>
        baseline.has(node.id) && baseline.get(node.id) !== node.entity_id,
    )
  )
    return false;
  if (value.coordinateText === undefined) return true;
  if (!record(value.coordinateText)) return false;
  const keys = new Set(
    [
      ...(value.nodes as LayoutDraft['nodes']),
      ...(value.baseNodes as LayoutDraft['baseNodes']),
    ].flatMap((node) =>
      ['position', 'rotation', 'scale'].flatMap((property) =>
        ['X', 'Y', 'Z'].map((axis) => `${node.id}-${property}-${axis}`),
      ),
    ),
  );
  return Object.entries(value.coordinateText).every(
    ([key, text]) =>
      keys.has(key) && typeof text === 'string' && text.length <= 64,
  );
}

export function readLayoutDraft(scope: LayoutDraftScope): StoredLayoutDraft {
  let stored: string | null;
  try {
    stored = window.localStorage.getItem(storageKey(scope));
  } catch {
    return { draft: null, problem: 'unavailable' };
  }
  if (!stored) return { draft: null, problem: null };
  try {
    const envelope: unknown = JSON.parse(stored);
    if (
      record(envelope) &&
      envelope.format === 1 &&
      record(envelope.scope) &&
      envelope.scope.apiBase === scope.apiBase &&
      envelope.scope.userId === scope.userId &&
      envelope.scope.labId === scope.labId &&
      validDraft(envelope.draft, scope.labId)
    )
      return { draft: envelope.draft, problem: null };
  } catch {
    // Keep the stored bytes; an invalid draft never replaces the World.
  }
  return { draft: null, problem: 'invalid' };
}

export function writeLayoutDraft(
  scope: LayoutDraftScope,
  draft: LayoutDraft,
): boolean {
  try {
    window.localStorage.setItem(
      storageKey(scope),
      JSON.stringify({ format: 1, scope, draft }),
    );
    return true;
  } catch {
    return false;
  }
}

export function removeLayoutDraft(scope: LayoutDraftScope): boolean {
  try {
    window.localStorage.removeItem(storageKey(scope));
    return true;
  } catch {
    return false;
  }
}
