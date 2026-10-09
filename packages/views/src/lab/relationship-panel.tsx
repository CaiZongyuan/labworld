import { useMemo, useState } from 'react';
import { Link2, X } from 'lucide-react';
import type {
  LabEntity,
  LabWorld,
  LayoutRelationship,
} from '@labos-threejs/sdk';
import { Button } from '@labos-threejs/ui/components/button';
import { Badge } from '@labos-threejs/ui/components/badge';
import {
  Field,
  FieldGroup,
  FieldLabel,
} from '@labos-threejs/ui/components/field';
import {
  NativeSelect,
  NativeSelectOption,
} from '@labos-threejs/ui/components/native-select';
import { useAppMessage } from '../shell/messages';
import { usePreferences } from '../shell/preferences';
import { Tool } from './view-controls';

export default function RelationshipPanel({
  world,
  entity,
  relationships,
  editing,
  disabled,
  onChange,
}: {
  world: LabWorld;
  entity: LabEntity;
  relationships: LayoutRelationship[];
  editing: boolean;
  disabled: boolean;
  onChange: (relationships: LayoutRelationship[]) => void;
}) {
  const message = useAppMessage('lab');
  const { locale } = usePreferences();
  const entityById = useMemo(
    () => new Map(world.entities.map((entry) => [entry.id, entry])),
    [world.entities],
  );
  const relationById = useMemo(
    () =>
      new Map((world.relationships ?? []).map((entry) => [entry.id, entry])),
    [world.relationships],
  );
  const [kind, setKind] = useState<LayoutRelationship['kind']>('located_in');
  const [targetId, setTargetId] = useState('');
  const container = (entry: LabEntity) =>
    ['furniture', 'location', 'labware'].includes(entry.kind);
  const candidates = world.entities.filter(
    (entry) =>
      entry.id !== entity.id &&
      (kind === 'located_in'
        ? container(entry)
        : kind === 'simulates'
          ? entity.reality === 'simulated' &&
            entry.reality === 'physical' &&
            entry.definition_id === entity.definition_id
          : true),
  );
  const target = candidates.find((entry) => entry.id === targetId)?.id ?? '';
  const visible = relationships.filter(
    (relation) =>
      relation.source_id === entity.id || relation.target_id === entity.id,
  );
  const name = (id: string) => entityById.get(id)?.name ?? id;
  function register() {
    if (!target) return;
    const child = kind === 'located_in' ? entity.id : target;
    const retained = relationships.filter((relation) => {
      if (kind === 'simulates')
        return (
          relation.kind !== 'simulates' || relation.source_id !== entity.id
        );
      const existingChild =
        relation.kind === 'located_in'
          ? relation.source_id
          : relation.kind === 'contains'
            ? relation.target_id
            : null;
      return existingChild !== child;
    });
    onChange([
      ...retained,
      {
        id: crypto.randomUUID(),
        source_id: entity.id,
        target_id: target,
        kind,
      },
    ]);
  }
  return (
    <section className="lab-inspector-section">
      <h3>{message('relationship.title')}</h3>
      {visible.length ? (
        visible.map((relation) => {
          const stored = relationById.get(relation.id);
          return (
            <div key={relation.id} className="world-relationship">
              <span>
                {name(relation.source_id)} ·{' '}
                {message(`relationship.${relation.kind}`)} ·{' '}
                {name(relation.target_id)}
              </span>
              <Badge variant="outline">
                {message(
                  stored ? 'relationship.manual' : 'relationship.manualDraft',
                )}
              </Badge>
              {stored ? (
                <small>
                  {stored.registered_by} ·{' '}
                  {new Intl.DateTimeFormat(locale, {
                    dateStyle: 'short',
                    timeStyle: 'short',
                  }).format(new Date(stored.registered_at))}
                </small>
              ) : null}
              {editing ? (
                <Tool
                  icon={X}
                  label={message('relationship.remove')}
                  disabled={disabled}
                  onClick={() =>
                    onChange(
                      relationships.filter((entry) => entry.id !== relation.id),
                    )
                  }
                />
              ) : null}
            </div>
          );
        })
      ) : (
        <span className="world-no-relationship">
          {message('relationship.none')}
        </span>
      )}
      {editing ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            register();
          }}
        >
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="relationship-kind">
                {message('relationship.kind')}
              </FieldLabel>
              <NativeSelect
                id="relationship-kind"
                value={kind}
                disabled={disabled}
                onChange={(event) => {
                  setKind(event.target.value as LayoutRelationship['kind']);
                  setTargetId('');
                }}
              >
                <NativeSelectOption value="located_in">
                  {message('relationship.located_in')}
                </NativeSelectOption>
                <NativeSelectOption
                  value="contains"
                  disabled={!container(entity)}
                >
                  {message('relationship.contains')}
                </NativeSelectOption>
                <NativeSelectOption
                  value="simulates"
                  disabled={entity.reality !== 'simulated'}
                >
                  {message('relationship.simulates')}
                </NativeSelectOption>
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="relationship-target">
                {message('relationship.target')}
              </FieldLabel>
              <NativeSelect
                id="relationship-target"
                value={target}
                disabled={disabled}
                onChange={(event) => setTargetId(event.target.value)}
              >
                <NativeSelectOption value="">
                  {message('relationship.selectTarget')}
                </NativeSelectOption>
                {candidates.map((entry) => (
                  <NativeSelectOption key={entry.id} value={entry.id}>
                    {entry.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Button
              type="submit"
              variant="outline"
              size="sm"
              disabled={!target || disabled}
            >
              <Link2 data-icon="inline-start" />
              {message('relationship.register')}
            </Button>
          </FieldGroup>
        </form>
      ) : null}
    </section>
  );
}
