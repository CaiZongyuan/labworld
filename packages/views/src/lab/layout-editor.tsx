import { useState } from 'react';
import type {
  LabWorld,
  LayoutRelationship,
  Placement,
  SceneNode,
} from '@labos-threejs/sdk';
import {
  Field,
  FieldDescription,
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
  coordinateText?: Record<string, string>;
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
    coordinateText: draft.coordinateText,
    nodes: mergeChanges(draft.baseNodes, draft.nodes, fresh.nodes),
    relationships: mergeChanges(
      draft.baseRelationships,
      draft.relationships,
      fresh.relationships,
    ),
  };
}

function coordinateNumber(text: string, min: number, max: number) {
  if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return null;
  const next = Number(text);
  return Number.isFinite(next) && next >= min && next <= max ? next : null;
}

export function hasInvalidCoordinateText(draft: LayoutDraft) {
  const texts = Object.entries(draft.coordinateText ?? {});
  if (!texts.length) return false;
  const nodes = new Set(draft.nodes.map((node) => node.id));
  return texts.some(([id, text]) => {
    const coordinate = /^(.+)-(position|rotation|scale)-[XYZ]$/.exec(id);
    if (!coordinate || !nodes.has(coordinate[1])) return false;
    const scale = coordinate[2] === 'scale';
    return (
      coordinateNumber(text, scale ? 0.001 : -10000, scale ? 1000 : 10000) ===
      null
    );
  });
}

export function withPlacement(
  draft: LayoutDraft,
  nodeId: string,
  placement: Placement,
  preserveText = false,
): LayoutDraft {
  const previous = draft.nodes.find((node) => node.id === nodeId);
  const coordinateText = { ...draft.coordinateText };
  if (previous && !preserveText)
    for (const property of ['position', 'rotation', 'scale'] as const)
      for (const [index, axis] of ['X', 'Y', 'Z'].entries())
        if (previous.placement[property][index] !== placement[property][index])
          delete coordinateText[`${nodeId}-${property}-${axis}`];
  return {
    ...draft,
    nodes: draft.nodes.map((node) =>
      node.id === nodeId ? { ...node, placement } : node,
    ),
    coordinateText,
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
  text: restoredText,
  onTextChange,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
  disabled: boolean;
  text?: string;
  onTextChange?: (id: string, text: string | null) => void;
}) {
  const [localText, setLocalText] = useState<string | null>(null);
  const text = onTextChange ? restoredText : localText;
  const invalid =
    text !== null &&
    text !== undefined &&
    coordinateNumber(text, min, max) === null;
  return (
    <Field data-invalid={invalid || undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input
        id={id}
        type="text"
        inputMode="decimal"
        min={min}
        max={max}
        maxLength={64}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? `${id}-range` : undefined}
        disabled={disabled}
        value={text ?? Number(value.toFixed(4))}
        onChange={(event) => {
          if (onTextChange) onTextChange(id, event.target.value);
          else setLocalText(event.target.value);
          const next = coordinateNumber(event.target.value, min, max);
          if (next !== null) onChange(next);
        }}
      />
      {invalid ? (
        <FieldDescription id={`${id}-range`}>
          {min} ≤ {label} ≤ {max}
        </FieldDescription>
      ) : null}
    </Field>
  );
}
export function PlacementEditor({
  node,
  onChange,
  disabled,
  coordinateText,
  onTextChange,
}: {
  node: SceneNode;
  onChange: (placement: Placement) => void;
  disabled: boolean;
  coordinateText?: Record<string, string>;
  onTextChange?: (id: string, text: string | null) => void;
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
                text={coordinateText?.[`${node.id}-${property}-${axis}`]}
                onTextChange={onTextChange}
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
