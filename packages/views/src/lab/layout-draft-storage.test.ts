import { expect, test, vi } from 'vitest';
import type { LayoutDraft } from './layout-editor';
import {
  readLayoutDraft,
  writeLayoutDraft,
  type LayoutDraftScope,
} from './layout-draft-storage';

const scope: LayoutDraftScope = {
  apiBase: 'http://api.test',
  userId: 'first-member',
  labId: 'lab-one',
};
const base = {
  id: 'node-one',
  lab_id: 'lab-one',
  entity_id: 'entity-one',
  representation_id: null,
  placement: {
    position: [0, 0, 0] as [number, number, number],
    rotation: [0, 0, 0] as [number, number, number],
    scale: [1, 1, 1] as [number, number, number],
  },
};
const draft: LayoutDraft = {
  version: 3,
  nodes: [{ ...base, placement: { ...base.placement, position: [2, 0, 0] } }],
  baseNodes: [base],
  relationships: [],
  baseRelationships: [],
};

test('returning to one browser draft retains its original baseline and identity scope', () => {
  writeLayoutDraft(scope, draft);
  const restored = readLayoutDraft(scope);
  expect(restored.problem).toBeNull();
  expect(restored.draft?.nodes[0].placement.position).toEqual([2, 0, 0]);
  expect(restored.draft?.baseNodes[0].placement.position).toEqual([0, 0, 0]);
  expect(restored.draft?.version).toBe(3);
  for (const other of [
    { ...scope, apiBase: 'http://another.test' },
    { ...scope, userId: 'second-member' },
    { ...scope, labId: 'lab-two' },
  ])
    expect(readLayoutDraft(other).draft).toBeNull();
  expect(readLayoutDraft(scope).draft?.version).toBe(3);
});

test('invalid stored drafts remain untouched and cannot become an editable layout', () => {
  writeLayoutDraft(scope, draft);
  const key = Object.keys(window.localStorage).find((entry) =>
    entry.startsWith('lab-word.layout-draft.'),
  )!;
  const envelope = { format: 1, scope, draft };
  const invalid = [
    '{unfinished',
    JSON.stringify({ ...envelope, format: 2 }),
    JSON.stringify({
      ...envelope,
      scope: { ...scope, userId: 'other-member' },
    }),
    JSON.stringify({ ...envelope, draft: { ...draft, version: -1 } }),
    JSON.stringify({
      ...envelope,
      draft: { ...draft, baseNodes: null },
    }),
    JSON.stringify({
      ...envelope,
      draft: { ...draft, nodes: [{ ...base, lab_id: 'another-lab' }] },
    }),
    JSON.stringify({
      ...envelope,
      draft: { ...draft, nodes: [base, base] },
    }),
    JSON.stringify({
      ...envelope,
      draft: { ...draft, nodes: [{ ...base, entity_id: 'another-entity' }] },
    }),
    JSON.stringify({
      ...envelope,
      draft: { ...draft, coordinateText: { 'unknown-node-position-X': '-' } },
    }),
    JSON.stringify({
      ...envelope,
      draft: {
        ...draft,
        coordinateText: { 'node-one-position-X': '1'.repeat(65) },
      },
    }),
    JSON.stringify({
      ...envelope,
      draft: {
        ...draft,
        nodes: [
          { ...base, placement: { ...base.placement, scale: [0, 1, 1] } },
        ],
      },
    }),
  ];
  for (const stored of invalid) {
    window.localStorage.setItem(key, stored);
    expect(readLayoutDraft(scope)).toEqual({ draft: null, problem: 'invalid' });
    expect(window.localStorage.getItem(key)).toBe(stored);
  }
});

test('a browser read failure does not erase its existing private draft', () => {
  writeLayoutDraft(scope, draft);
  const unavailable = vi
    .spyOn(Storage.prototype, 'getItem')
    .mockImplementation(() => {
      throw new DOMException('Blocked', 'SecurityError');
    });
  expect(readLayoutDraft(scope)).toEqual({
    draft: null,
    problem: 'unavailable',
  });
  unavailable.mockRestore();
  expect(readLayoutDraft(scope).draft?.nodes[0].placement.position).toEqual([
    2, 0, 0,
  ]);
});
