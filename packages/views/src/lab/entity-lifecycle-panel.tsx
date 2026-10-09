import { useState } from 'react';
import { Archive, Palette, Replace, Save } from 'lucide-react';
import {
  archiveLabEntity,
  changeLabEntityAppearance,
  changeLabEntityDefinition,
  type ApiClient,
  type AssetDefinition,
  type CurrentSession,
  type LabAsset,
  type LabEntity,
} from '@labos-threejs/sdk';
import { Button } from '@labos-threejs/ui/components/button';
import { Badge } from '@labos-threejs/ui/components/badge';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@labos-threejs/ui/components/dialog';
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
import { ErrorAlert } from '../shell/error-alert';
import { Tool } from './view-controls';

type Operation = 'archive' | 'appearance' | 'definition';
export default function EntityLifecyclePanel({
  entity,
  definitions,
  assets,
  apiClient,
  identity,
  disabled,
  onRefresh,
  onArchived,
  hasMoreAssets,
  loadingAssets,
  onMoreAssets,
}: {
  entity: LabEntity;
  definitions: AssetDefinition[];
  assets: LabAsset[];
  apiClient: ApiClient;
  identity: CurrentSession;
  disabled: boolean;
  onRefresh: () => Promise<unknown>;
  onArchived: () => void;
  hasMoreAssets: boolean;
  loadingAssets: boolean;
  onMoreAssets: () => void;
}) {
  const message = useAppMessage('lab');
  const { locale } = usePreferences();
  const [operation, setOperation] = useState<Operation | null>(null);
  const [representation, setRepresentation] = useState(
    entity.representation_id ?? '',
  );
  const [definition, setDefinition] = useState(
    `${entity.definition_id}@${entity.definition_version}`,
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  function open(value: Operation) {
    setError(null);
    setRepresentation(entity.representation_id ?? '');
    setDefinition(`${entity.definition_id}@${entity.definition_version}`);
    setOperation(value);
  }
  async function submit() {
    setPending(true);
    setError(null);
    const options = {
      client: apiClient,
      path: { lab_id: entity.lab_id, entity_id: entity.id },
      headers: { 'x-csrf-token': identity.csrf_token },
      throwOnError: true as const,
    };
    try {
      if (operation === 'archive') await archiveLabEntity(options);
      else if (operation === 'appearance')
        await changeLabEntityAppearance({
          ...options,
          body: { representation_id: representation || null },
        });
      else {
        const selected = definitions.find(
          (entry) => `${entry.id}@${entry.version}` === definition,
        );
        if (!selected) return;
        await changeLabEntityDefinition({
          ...options,
          body: {
            definition_id: selected.id,
            definition_version: selected.version,
            configuration:
              selected.id === entity.definition_id
                ? entity.configuration
                : { label: entity.configuration.label ?? '' },
          },
        });
      }
      await onRefresh();
      if (operation === 'archive') onArchived();
      setOperation(null);
    } catch (cause) {
      setError(cause);
    } finally {
      setPending(false);
    }
  }
  return (
    <section className="lab-inspector-section">
      <div className="lab-section-heading">
        <h3>{message('lifecycle.title')}</h3>
        {entity.archived_at ? (
          <Badge variant="outline">{message('lifecycle.archived')}</Badge>
        ) : null}
      </div>
      <div className="world-node-actions">
        <Tool
          icon={Palette}
          label={message('lifecycle.appearance')}
          disabled={disabled}
          onClick={() => open('appearance')}
        />
        <Tool
          icon={Replace}
          label={message('lifecycle.definition')}
          disabled={disabled || !!entity.archived_at}
          onClick={() => open('definition')}
        />
        <Tool
          icon={Archive}
          label={message('lifecycle.archive')}
          disabled={disabled || !!entity.archived_at}
          onClick={() => open('archive')}
        />
      </div>
      {operation ? (
        <Dialog
          open
          onOpenChange={(value) => {
            if (!value && !pending) setOperation(null);
          }}
        >
          <DialogContent>
            <DialogTitle>{message(`lifecycle.${operation}`)}</DialogTitle>
            <DialogDescription>
              {operation === 'archive'
                ? message('lifecycle.archiveConfirm', { name: entity.name })
                : entity.name}
            </DialogDescription>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <FieldGroup>
                {operation === 'appearance' ? (
                  <Field data-disabled={pending}>
                    <FieldLabel htmlFor="entity-appearance">
                      {message('world.representation')}
                    </FieldLabel>
                    <NativeSelect
                      id="entity-appearance"
                      value={representation}
                      onChange={(event) =>
                        setRepresentation(event.target.value)
                      }
                      disabled={pending}
                    >
                      <NativeSelectOption value="">
                        {message('world.builtinAppearance')}
                      </NativeSelectOption>
                      {entity.representation_id &&
                      !assets.some(
                        (asset) =>
                          asset.representation.id === entity.representation_id,
                      ) ? (
                        <NativeSelectOption value={entity.representation_id}>
                          {entity.representation_id}
                        </NativeSelectOption>
                      ) : null}
                      {assets.map((asset) => (
                        <NativeSelectOption
                          key={asset.id}
                          value={asset.representation.id}
                        >
                          {asset.name} · {asset.version}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                    {hasMoreAssets ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={pending || loadingAssets}
                        onClick={onMoreAssets}
                      >
                        {message('assets.loadMore')}
                      </Button>
                    ) : null}
                  </Field>
                ) : null}
                {operation === 'definition' ? (
                  <Field data-disabled={pending}>
                    <FieldLabel htmlFor="entity-definition">
                      {message('world.definitionVersion')}
                    </FieldLabel>
                    <NativeSelect
                      id="entity-definition"
                      value={definition}
                      onChange={(event) => setDefinition(event.target.value)}
                      disabled={pending}
                    >
                      {definitions.map((entry) => (
                        <NativeSelectOption
                          key={`${entry.id}@${entry.version}`}
                          value={`${entry.id}@${entry.version}`}
                        >
                          {locale === 'en' ? entry.name_en : entry.name} ·{' '}
                          {entry.version}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </Field>
                ) : null}
                {error ? (
                  <ErrorAlert
                    error={error}
                    title={message('assets.error')}
                    codes={{
                      'lab.entity_in_use': message('lifecycle.inUse'),
                      'lab.entity_archived': message('lifecycle.archived'),
                      'lab.invalid_reference': message(
                        'lifecycle.invalidReference',
                      ),
                    }}
                  />
                ) : null}
                <div className="lab-dialog-actions">
                  <Button
                    type="button"
                    variant="outline"
                    disabled={pending}
                    onClick={() => setOperation(null)}
                  >
                    {message('assets.cancel')}
                  </Button>
                  <Button
                    type="submit"
                    disabled={
                      pending ||
                      (operation === 'definition' && !definitions.length)
                    }
                  >
                    {operation === 'archive' ? (
                      <Archive data-icon="inline-start" />
                    ) : (
                      <Save data-icon="inline-start" />
                    )}
                    {message(
                      operation === 'archive'
                        ? 'lifecycle.archiveSubmit'
                        : 'assets.save',
                    )}
                  </Button>
                </div>
              </FieldGroup>
            </form>
          </DialogContent>
        </Dialog>
      ) : null}
    </section>
  );
}
