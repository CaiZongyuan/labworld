import { useEffect, useRef, useState } from 'react';
import { Save, Upload, X } from 'lucide-react';
import type { AssetDefinition } from '@labos-threejs/sdk';
import { Button } from '@labos-threejs/ui/components/button';
import { Badge } from '@labos-threejs/ui/components/badge';
import { Input } from '@labos-threejs/ui/components/input';
import {
  Field,
  FieldGroup,
  FieldLabel,
} from '@labos-threejs/ui/components/field';
import {
  Dialog,
  DialogContent,
  DialogClose,
  DialogDescription,
  DialogTitle,
} from '@labos-threejs/ui/components/dialog';
import { ErrorAlert } from '../shell/error-alert';
import { useAppMessage } from '../shell/messages';
import { usePreferences } from '../shell/preferences';
import type { useCatalog } from './catalog';

export type ImportDraft = { file: File; buffer: ArrayBuffer };
type Catalog = ReturnType<typeof useCatalog>;

export function AssetFailure({ error }: { error: unknown }) {
  const message = useAppMessage('lab');
  return (
    <ErrorAlert
      error={error}
      title={message('assets.error')}
      codes={{
        'auth.unauthorized': message('import.denied'),
        'auth.csrf': message('import.denied'),
        'files.too_large': message('import.tooLarge'),
        'files.upload_rejected': message('import.invalid'),
        'lab.asset_in_use': message('assets.inUse'),
        'lab.invalid_input': message('assets.invalidMetadata'),
      }}
      genericKey="lab.import.storage"
    />
  );
}

export function ImportAssetDialog({
  draft,
  catalog,
  onClose,
}: {
  draft: ImportDraft;
  catalog: Catalog;
  onClose: () => void;
}) {
  const message = useAppMessage('lab');
  const [metadata, setMetadata] = useState({
    name: draft.file.name.replace(/\.glb$/i, ''),
    source: '',
    license: '',
    version: '1.0',
  });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const controller = useRef<AbortController | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          controller.current?.abort();
          onClose();
        }
      }}
    >
      <DialogContent>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const attempt = new AbortController();
            controller.current = attempt;
            setPending(true);
            setError(undefined);
            void catalog
              .addFile(draft.file, draft.buffer, attempt.signal, metadata)
              .then(() => {
                if (!attempt.signal.aborted) onClose();
              })
              .catch((cause: unknown) => {
                if (!attempt.signal.aborted) setError(cause);
              })
              .finally(() => {
                if (!attempt.signal.aborted) setPending(false);
              });
          }}
          className="flex flex-col gap-5"
        >
          <header className="flex flex-col gap-2">
            <DialogTitle>{message('assets.importTitle')}</DialogTitle>
            <DialogDescription className="break-all">
              {draft.file.name} · {(draft.file.size / 1024 / 1024).toFixed(2)}{' '}
              MiB
            </DialogDescription>
          </header>
          <FieldGroup>
            {(['name', 'source', 'license', 'version'] as const).map(
              (field) => (
                <Field key={field} data-disabled={pending}>
                  <FieldLabel htmlFor={`asset-${field}`}>
                    {message(`assets.${field}`)}
                  </FieldLabel>
                  <Input
                    id={`asset-${field}`}
                    value={metadata[field]}
                    maxLength={
                      field === 'name'
                        ? 120
                        : field === 'source'
                          ? 2048
                          : field === 'license'
                            ? 200
                            : 80
                    }
                    required={field === 'name' || field === 'version'}
                    disabled={pending}
                    onChange={(event) =>
                      setMetadata((old) => ({
                        ...old,
                        [field]: event.target.value,
                      }))
                    }
                  />
                </Field>
              ),
            )}
          </FieldGroup>
          {error ? <AssetFailure error={error} /> : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                controller.current?.abort();
                onClose();
              }}
            >
              {message('assets.cancel')}
            </Button>
            <Button
              type="submit"
              disabled={
                pending || !metadata.name.trim() || !metadata.version.trim()
              }
            >
              <Upload data-icon="inline-start" />
              {message(pending ? 'import.pending' : 'assets.publish')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function RenameAssetDialog({
  asset,
  catalog,
  onClose,
}: {
  asset: Catalog['assets'][number];
  catalog: Catalog;
  onClose: () => void;
}) {
  const message = useAppMessage('lab');
  const [name, setName] = useState(asset.name);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !pending) onClose();
      }}
    >
      <DialogContent>
        <form
          className="flex flex-col gap-5"
          onSubmit={(event) => {
            event.preventDefault();
            setPending(true);
            setError(undefined);
            void catalog
              .rename(asset.id, name)
              .then(onClose)
              .catch(setError)
              .finally(() => setPending(false));
          }}
        >
          <header className="flex flex-col gap-2">
            <DialogTitle>{message('assets.rename')}</DialogTitle>
            <DialogDescription className="break-all">
              {asset.fileName}
            </DialogDescription>
          </header>
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="asset-rename">
                {message('assets.name')}
              </FieldLabel>
              <Input
                id="asset-rename"
                required
                maxLength={120}
                value={name}
                disabled={pending}
                onChange={(event) => setName(event.target.value)}
              />
            </Field>
          </FieldGroup>
          {error ? <AssetFailure error={error} /> : null}
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={onClose}
            >
              {message('assets.cancel')}
            </Button>
            <Button type="submit" disabled={pending || !name.trim()}>
              <Save data-icon="inline-start" />
              {message('assets.save')}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function DefinitionDialog({
  definition,
  onClose,
}: {
  definition: AssetDefinition;
  onClose: () => void;
}) {
  const message = useAppMessage('lab');
  const { locale } = usePreferences();
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[85dvh] overflow-y-auto">
        <DialogClose
          render={
            <Button
              variant="ghost"
              size="icon-sm"
              className="absolute top-3 right-3"
              aria-label={message('import.dismiss')}
            />
          }
        >
          <X />
        </DialogClose>
        <header className="flex flex-col gap-2 pr-8">
          <DialogTitle>
            {locale === 'zh' ? definition.name : definition.name_en}
          </DialogTitle>
          <DialogDescription>
            {definition.id} · v{definition.version}
          </DialogDescription>
        </header>
        <dl className="flex flex-col gap-3 text-sm">
          <dt>{message('assets.specifications')}</dt>
          <dd>
            <pre className="asset-schema">
              {JSON.stringify(definition.specifications, null, 2)}
            </pre>
          </dd>
          <dt>{message('assets.capabilities')}</dt>
          <dd className="flex flex-col gap-3">
            {definition.capabilities.length
              ? definition.capabilities.map((capability) => (
                  <div key={capability.id}>
                    <div className="flex flex-wrap items-center gap-2">
                      <code>{capability.id}</code>
                      <Badge variant="secondary">
                        {message(
                          capability.implemented
                            ? 'assets.implemented'
                            : 'assets.declared',
                        )}
                      </Badge>
                    </div>
                    <pre className="asset-schema mt-2">
                      {JSON.stringify(capability.parameters, null, 2)}
                    </pre>
                  </div>
                ))
              : message('assets.none')}
          </dd>
          <dt>{message('assets.state')}</dt>
          <dd>
            <pre className="asset-schema">
              {JSON.stringify(definition.state, null, 2)}
            </pre>
          </dd>
          <dt>{message('assets.interfaces')}</dt>
          <dd className="flex flex-col gap-2">
            {definition.interfaces.map((entry) => (
              <div className="flex flex-wrap items-center gap-2" key={entry.id}>
                <code>{entry.id}</code>
                <Badge variant="outline">
                  {message(
                    entry.implemented
                      ? 'assets.implemented'
                      : 'assets.declared',
                  )}
                </Badge>
              </div>
            ))}
          </dd>
        </dl>
      </DialogContent>
    </Dialog>
  );
}
