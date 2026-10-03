import { useState } from 'react';
import { cn } from 'cn';
import type {
  AssetDefinition,
  LabAsset,
  LabEntity,
  RegisterEntity,
  CreateLab,
  ConfigureEntity,
} from '@labos-threejs/sdk';
import { Button } from '@labos-threejs/ui/components/button';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from '@labos-threejs/ui/components/dialog';
import {
  Field,
  FieldGroup,
  FieldLabel,
} from '@labos-threejs/ui/components/field';
import { Input } from '@labos-threejs/ui/components/input';
import {
  NativeSelect,
  NativeSelectOption,
} from '@labos-threejs/ui/components/native-select';
import { ErrorAlert } from '../shell/error-alert';
import { useAppMessage } from '../shell/messages';
import { usePreferences } from '../shell/preferences';

export type WorldDialogMode = 'lab' | 'register' | LabEntity;
export type WorldSubmission =
  | { kind: 'lab'; input: CreateLab }
  | { kind: 'register'; input: RegisterEntity }
  | { kind: 'configure'; entityId: string; input: ConfigureEntity };

export default function WorldDialog({
  mode,
  definitions,
  assets,
  onClose,
  onSubmit,
  hasMoreAssets,
  loadingAssets,
  onMoreAssets,
}: {
  mode: WorldDialogMode;
  definitions: AssetDefinition[];
  assets: LabAsset[];
  onClose: () => void;
  onSubmit: (submission: WorldSubmission) => Promise<void>;
  hasMoreAssets: boolean;
  loadingAssets: boolean;
  onMoreAssets: () => void;
}) {
  const message = useAppMessage('lab');
  const { locale } = usePreferences();
  const entity = typeof mode === 'object' ? mode : null;
  const [name, setName] = useState(entity?.name ?? '');
  const [label, setLabel] = useState(
    typeof entity?.configuration?.label === 'string'
      ? entity.configuration.label
      : '',
  );
  const [definition, setDefinition] = useState('light@1.0');
  const [representation, setRepresentation] = useState('');
  const [reality, setReality] = useState<'simulated' | 'physical'>('simulated');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const title = message(
    mode === 'lab'
      ? 'world.createLab'
      : mode === 'register'
        ? 'world.register'
        : 'world.configure',
  );
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription className={cn(mode !== 'register' && 'sr-only')}>
          {mode === 'register' ? message('world.registrationNote') : title}
        </DialogDescription>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const selected = definitions.find(
              (entry) => `${entry.id}@${entry.version}` === definition,
            );
            const configuration = { ...(entity?.configuration ?? {}), label };
            let submission: WorldSubmission;
            if (mode === 'lab') submission = { kind: 'lab', input: { name } };
            else if (mode === 'register') {
              if (!selected) return;
              submission = {
                kind: 'register',
                input: {
                  name,
                  definition_id: selected.id,
                  definition_version: selected.version,
                  reality,
                  representation_id: representation || null,
                  configuration,
                },
              };
            } else
              submission = {
                kind: 'configure',
                entityId: mode.id,
                input: { name, configuration },
              };
            setPending(true);
            setError(null);
            void onSubmit(submission)
              .then(onClose)
              .catch(setError)
              .finally(() => setPending(false));
          }}
        >
          <FieldGroup>
            {mode === 'register' ? (
              <>
                <Field data-disabled={pending}>
                  <FieldLabel htmlFor="world-definition">
                    {message('world.definitionVersion')}
                  </FieldLabel>
                  <NativeSelect
                    id="world-definition"
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
                <Field data-disabled={pending}>
                  <FieldLabel htmlFor="world-representation">
                    {message('world.representation')}
                  </FieldLabel>
                  <NativeSelect
                    id="world-representation"
                    value={representation}
                    onChange={(event) => setRepresentation(event.target.value)}
                    disabled={pending}
                  >
                    <NativeSelectOption value="">
                      {message('world.builtinAppearance')}
                    </NativeSelectOption>
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
                      onClick={onMoreAssets}
                      disabled={pending || loadingAssets}
                    >
                      {message('assets.loadMore')}
                    </Button>
                  ) : null}
                </Field>
                <Field data-disabled={pending}>
                  <FieldLabel htmlFor="world-reality">
                    {message('world.reality')}
                  </FieldLabel>
                  <NativeSelect
                    id="world-reality"
                    value={reality}
                    onChange={(event) =>
                      setReality(event.target.value as typeof reality)
                    }
                    disabled={pending}
                  >
                    <NativeSelectOption value="simulated">
                      {message('world.simulated')}
                    </NativeSelectOption>
                    <NativeSelectOption value="physical">
                      {message('world.physical')}
                    </NativeSelectOption>
                  </NativeSelect>
                </Field>
              </>
            ) : null}
            <Field data-disabled={pending}>
              <FieldLabel htmlFor="world-name">
                {message('assets.name')}
              </FieldLabel>
              <Input
                id="world-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={120}
                required
                disabled={pending}
              />
            </Field>
            {mode !== 'lab' ? (
              <Field data-disabled={pending}>
                <FieldLabel htmlFor="world-label">
                  {message('world.label')}
                </FieldLabel>
                <Input
                  id="world-label"
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  maxLength={120}
                  disabled={pending}
                />
              </Field>
            ) : null}
            {error ? (
              <ErrorAlert error={error} title={message('assets.error')} />
            ) : null}
            <div className="lab-dialog-actions">
              <Button
                type="button"
                variant="outline"
                onClick={onClose}
                disabled={pending}
              >
                {message('assets.cancel')}
              </Button>
              <Button
                type="submit"
                disabled={
                  pending ||
                  !name.trim() ||
                  (mode === 'register' && !definitions.length)
                }
              >
                {message(
                  mode === 'lab'
                    ? 'world.create'
                    : mode === 'register'
                      ? 'world.registerSubmit'
                      : 'assets.save',
                )}
              </Button>
            </div>
          </FieldGroup>
        </form>
      </DialogContent>
    </Dialog>
  );
}
