import { useState } from 'react';
import type {
  LabWorld,
  LayoutRelationship,
  Placement,
  SceneNode,
} from '@labos-threejs/sdk';
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@labos-threejs/ui/components/field';
import { Input } from '@labos-threejs/ui/components/input';
import { useAppMessage } from '../shell/messages';

export type LayoutDraft = {
  version: number;
  nodes: SceneNode[];
  relationships: LayoutRelationship[];
  baseNodes: SceneNode[];
  baseRelationships: LayoutRelationship[];
};
export function layoutDraft(world: LabWorld): LayoutDraft {
  const relationships = (world.relationships ?? []).map(
    ({ id, source_id, target_id, kind }) => ({
      id,
      source_id,
      target_id,
      kind: kind as LayoutRelationship['kind'],
    }),
  );
  return {
    version: world.lab.layout_version,
    nodes: world.nodes,
    relationships,
    baseNodes: world.nodes,
    baseRelationships: relationships,
  };
}
function mergeChanges<T extends { id: string }>(
  base: T[],
  draft: T[],
  latest: T[],
): T[] {
  const original = new Map(base.map((item) => [item.id, item]));
  const local = new Map(draft.map((item) => [item.id, item]));
  const merged = new Map(latest.map((item) => [item.id, item]));
  for (const id of original.keys()) if (!local.has(id)) merged.delete(id);
  for (const [id, item] of local)
    if (JSON.stringify(item) !== JSON.stringify(original.get(id)))
      merged.set(id, item);
  return [...merged.values()];
}
export function rebaseLayout(
  draft: LayoutDraft,
  latest: LabWorld,
): LayoutDraft {
  const fresh = layoutDraft(latest);
  return {
    ...fresh,
    nodes: mergeChanges(draft.baseNodes, draft.nodes, fresh.nodes),
    relationships: mergeChanges(
      draft.baseRelationships,
      draft.relationships,
      fresh.relationships,
    ),
  };
}

function Coordinate({
  id,
  label,
  value,
  min,
  max,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  disabled: boolean;
}) {
  const [text, setText] = useState<string | null>(null);
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type="number"
        step="0.01"
        min={min}
        max={max}
        disabled={disabled}
        value={text ?? Number(value.toFixed(4))}
        onChange={(event) => {
          setText(event.target.value);
          const next = event.target.valueAsNumber;
          if (Number.isFinite(next)) onChange(next);
        }}
        onBlur={() => setText(null)}
      />
    </Field>
  );
}
export function PlacementEditor({
  node,
  onChange,
  disabled,
}: {
  node: SceneNode;
  onChange: (placement: Placement) => void;
  disabled: boolean;
}) {
  const message = useAppMessage('lab');
  return (
    <FieldGroup className="world-placement">
      {(['position', 'rotation', 'scale'] as const).map((property) => (
        <FieldSet key={property}>
          <FieldLegend>{message(`layout.${property}`)}</FieldLegend>
          <FieldGroup className="world-coordinate-row">
            {['X', 'Y', 'Z'].map((axis, index) => (
              <Coordinate
                key={`${node.id}-${property}-${axis}`}
                id={`${node.id}-${property}-${axis}`}
                label={
                  property === 'position'
                    ? `${axis} (m)`
                    : property === 'rotation'
                      ? `R${axis.toLowerCase()} (rad)`
                      : `S${axis.toLowerCase()}`
                }
                value={node.placement[property][index]}
                min={property === 'scale' ? 0.001 : -10000}
                max={property === 'scale' ? 1000 : 10000}
                disabled={disabled}
                onChange={(value) =>
                  onChange({
                    ...node.placement,
                    [property]: node.placement[property].map((current, i) =>
                      i === index ? value : current,
                    ),
                  })
                }
              />
            ))}
          </FieldGroup>
        </FieldSet>
      ))}
    </FieldGroup>
  );
}
