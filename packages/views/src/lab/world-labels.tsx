import { useMemo, useRef, useState, type RefObject } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Html } from '@react-three/drei';
import { Group, Vector3 } from 'three';
import type { LabWorld, SceneNode } from '@labos-threejs/sdk';
import { Button } from '@labos-threejs/ui/components/button';
import { Crosshair } from 'lucide-react';
import { useAppMessage } from '../shell/messages';
import { readEntityObservations } from './observation-state';
import { observationValue } from './observation-reading';

type Rect = { x: number; y: number; width: number; height: number };
type Position = Pick<Rect, 'x' | 'y'> & {
  visible: boolean;
  outside: boolean;
};
const overlaps = (a: Rect, b: Rect) =>
  a.x < b.x + b.width + 4 &&
  a.x + a.width + 4 > b.x &&
  a.y < b.y + b.height + 4 &&
  a.y + a.height + 4 > b.y;

/** A bounded canvas overlay: selected Entity first, then active Tasks and readings. */
export function WorldLabels({
  world,
  connected,
  selected,
  activeNodeId,
  root,
  onSelect,
  onLocate,
  onOpenRecentMinute,
}: {
  world: LabWorld;
  connected: boolean;
  selected: string[];
  activeNodeId?: string;
  root: RefObject<Group | null>;
  onSelect: (entityId: string, additive: boolean, nodeId?: string) => void;
  onLocate: (nodeId: string) => void;
  onOpenRecentMinute?: (entityId: string) => void;
}) {
  const message = useAppMessage('lab');
  const { camera, gl, size } = useThree();
  const elements = useRef(new Map<string, HTMLDivElement>());
  const [positions, setPositions] = useState<Record<string, Position>>({});
  const previous = useRef('');
  const candidates = useMemo(() => {
    const entities = new Map(
      world.entities.map((entity) => [entity.id, entity]),
    );
    const nodes = new Map<string, SceneNode>();
    for (const node of world.nodes.slice(0, 1000))
      if (!nodes.has(node.entity_id) || node.id === activeNodeId)
        nodes.set(node.entity_id, node);
    return [...nodes.values()]
      .flatMap((node) => {
        const entity = entities.get(node.entity_id);
        if (!entity || entity.archived_at) return [];
        const readings = readEntityObservations(entity, connected).properties;
        const key =
          entity.definition_id === 'sensor'
            ? 'temperature'
            : entity.definition_id === 'centrifuge'
              ? 'speed'
              : entity.definition_id === 'light'
                ? 'brightness'
                : null;
        const reading = key ? readings[key] : undefined;
        const phase =
          entity.definition_id === 'centrifuge' ? readings.phase : undefined;
        const activeTask =
          entity.task &&
          !['completed', 'cancelled', 'failed', 'interrupted'].includes(
            entity.task.status,
          );
        const isSelected = selected.includes(entity.id);
        const score = isSelected
          ? 10000 + selected.indexOf(entity.id)
          : activeTask
            ? 7000
            : reading?.hasValue
              ? 4000
              : 0;
        return score
          ? [{ node, entity, reading, phase, activeTask, score }]
          : [];
      })
      .sort(
        (a, b) => b.score - a.score || a.entity.id.localeCompare(b.entity.id),
      )
      .slice(0, size.width < 560 ? 4 : 8);
  }, [
    world.entities,
    world.nodes,
    connected,
    selected,
    activeNodeId,
    size.width,
  ]);
  useFrame(() => {
    if (!root.current || !size.width || !size.height) return;
    const viewport = gl.domElement.getBoundingClientRect();
    const page = gl.domElement.closest('.world-page');
    const reservations: Rect[] = [];
    for (const panel of page?.querySelectorAll(
      '.world-directory,.world-inspector,.world-history-surface,.world-canvas-tools,.world-transform-tools,.world-render-error',
    ) ?? []) {
      if (!panel.getClientRects().length) continue;
      const rect = panel.getBoundingClientRect();
      const x = Math.max(0, rect.x - viewport.x),
        y = Math.max(0, rect.y - viewport.y);
      const right = Math.min(size.width, rect.right - viewport.x),
        bottom = Math.min(size.height, rect.bottom - viewport.y);
      if (right > x && bottom > y)
        reservations.push({ x, y, width: right - x, height: bottom - y });
    }
    const objects = new Map(
      root.current.children.map((object) => [object.name, object]),
    );
    const next: Record<string, Position> = {};
    camera.updateMatrixWorld();
    const facing = camera.getWorldDirection(new Vector3());
    for (const item of candidates) {
      const object = objects.get(item.node.id);
      const element = elements.current.get(item.entity.id);
      if (!object || !element) continue;
      const local =
        object.userData.labelAnchor instanceof Vector3
          ? object.userData.labelAnchor
          : new Vector3(0, 0.6, 0);
      const point = local.clone().applyMatrix4(object.matrixWorld);
      const behind = point.clone().sub(camera.position).dot(facing) <= 0;
      const projected = point.project(camera);
      const outside =
        behind || Math.abs(projected.x) > 1 || Math.abs(projected.y) > 1;
      const anchorX = Math.max(
        8,
        Math.min(size.width - 8, ((projected.x + 1) * size.width) / 2),
      );
      const anchorY = behind
        ? size.height / 2
        : Math.max(
            8,
            Math.min(size.height - 8, ((1 - projected.y) * size.height) / 2),
          );
      const actual = element.getBoundingClientRect();
      const width = actual.width,
        height = actual.height;
      const choices = [
        [anchorX - width / 2, anchorY - height - 12],
        [anchorX + 12, anchorY - height / 2],
        [anchorX - width - 12, anchorY - height / 2],
        [anchorX - width / 2, anchorY + 12],
      ];
      // Finite fallback positions also include the actual opaque panel edges.
      const xs = [
        8,
        (size.width - width) / 2,
        size.width - width - 8,
        ...reservations.map((r) => r.x + r.width + 6),
      ];
      const ys = [
        8,
        size.height - height - 8,
        ...reservations.map((r) => r.y + r.height + 6),
      ];
      for (const y of ys) for (const x of xs) choices.push([x, y]);
      let placement: Rect | null = null;
      for (const [x, y] of choices) {
        const rect = {
          x: Math.round(Math.max(8, Math.min(size.width - width - 8, x))),
          y: Math.round(Math.max(8, Math.min(size.height - height - 8, y))),
          width,
          height,
        };
        if (
          rect.x + width <= size.width - 8 &&
          rect.y + height <= size.height - 8 &&
          !reservations.some((r) => overlaps(rect, r))
        ) {
          placement = rect;
          break;
        }
      }
      next[item.entity.id] = {
        x: placement?.x ?? 8,
        y: placement?.y ?? 8,
        visible: !!placement,
        outside,
      };
      if (placement) reservations.push(placement);
    }
    const signature = JSON.stringify(next);
    if (signature !== previous.current) {
      previous.current = signature;
      setPositions(next);
    }
  });
  return (
    <Html
      fullscreen
      calculatePosition={(_object, _camera, viewport) => [
        viewport.width / 2,
        viewport.height / 2,
      ]}
      zIndexRange={[10, 0]}
      style={{ pointerEvents: 'none' }}
    >
      <div className="world-priority-labels">
        {candidates.map(({ entity, node, reading, phase, activeTask }) => {
          const position = positions[entity.id];
          const value =
            reading?.hasValue && reading.property
              ? observationValue(reading.property)
              : null;
          return (
            <div
              key={entity.id}
              ref={(element) => {
                if (element) elements.current.set(entity.id, element);
                else elements.current.delete(entity.id);
              }}
              className="world-priority-label"
              style={{
                left: position?.x ?? 0,
                top: position?.y ?? 0,
                visibility: position?.visible ? 'visible' : 'hidden',
              }}
            >
              <div className="world-label-header">
                <Button
                  variant="ghost"
                  className="world-label-name"
                  onClick={(event) => {
                    event.stopPropagation();
                    onSelect(entity.id, event.shiftKey, node.id);
                  }}
                  onDoubleClick={(event) => {
                    event.stopPropagation();
                    onLocate(node.id);
                  }}
                >
                  <span className="world-label-title" title={entity.name}>
                    {entity.name}
                  </span>
                </Button>
                {position?.outside ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={message('world.locateNamed', {
                      name: entity.name,
                    })}
                    onClick={(event) => {
                      event.stopPropagation();
                      onLocate(node.id);
                    }}
                  >
                    <Crosshair />
                  </Button>
                ) : null}
              </div>
              {reading ? (
                <div
                  role="img"
                  aria-label={`${entity.name}: ${value ?? message('world.unknown')}`}
                  className="world-label-reading"
                  title={
                    reading.hasValue && reading.property
                      ? [
                          reading.property.source,
                          reading.property.observed_at ??
                            message('device.sourceTimeUnknown'),
                          reading.property.received_at,
                          message(`device.quality.${reading.property.quality}`),
                        ].join('\n')
                      : message('world.unknown')
                  }
                >
                  <strong>{value ?? '-'}</strong>
                  <small>
                    {reading.currentValid
                      ? phase?.currentValid && phase.property
                        ? message(`task.${phase.property.value}`)
                        : message('device.freshness.current')
                      : reading.hasValue
                        ? message('device.lastReported')
                        : message('world.unknown')}
                  </small>
                </div>
              ) : (
                <small>
                  {activeTask
                    ? entity.task?.status
                    : message('world.staticRepresentation')}
                </small>
              )}
              <div className="world-label-actions">
                {entity.definition_id === 'sensor' && onOpenRecentMinute ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={(event) => {
                      event.stopPropagation();
                      onOpenRecentMinute(entity.id);
                    }}
                  >
                    {message('world.recentMinute')}
                  </Button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </Html>
  );
}
