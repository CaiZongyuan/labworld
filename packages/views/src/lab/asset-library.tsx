import { useCallback, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Eye,
  Info,
  LoaderCircle,
  Pencil,
  RotateCcw,
  Trash2,
  Upload,
} from 'lucide-react';
import {
  listAssetDefinitions,
  type ApiClient,
  type AssetDefinition,
  type CurrentSession,
} from '@labos-threejs/sdk';
import { Badge } from '@labos-threejs/ui/components/badge';
import { Button } from '@labos-threejs/ui/components/button';
import { Input } from '@labos-threejs/ui/components/input';
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@labos-threejs/ui/components/card';
import {
  NativeSelect,
  NativeSelectOption,
} from '@labos-threejs/ui/components/native-select';
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
} from '@labos-threejs/ui/components/empty';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@labos-threejs/ui/components/alert-dialog';
import { useAppMessage } from '../shell/messages';
import { usePreferences } from '../shell/preferences';
import { useCatalog } from './catalog';
import { ImportFeedback, ModelFileInput, useModelImport } from './model-import';
import {
  AssetFailure,
  DefinitionDialog,
  ImportAssetDialog,
  RenameAssetDialog,
  type ImportDraft,
} from './asset-dialogs';
import { Tool } from './view-controls';
import centrifuge from './images/centrifuge.png';
import light from './images/light.png';
import sensor from './images/sensor.png';
import robot from './images/robot.png';
import labware from './images/labware.png';
import bench from './images/bench.png';
import environment from './images/environment.png';
import model from './images/model.png';
import './lab.css';

const miniatures: Record<string, string> = {
  centrifuge,
  light,
  sensor,
  robot,
  labware,
  bench,
  environment,
  model,
};

export default function AssetLibrary({
  apiClient,
  identity,
  onOpen,
}: {
  apiClient: ApiClient;
  identity: CurrentSession;
  onOpen: () => void;
}) {
  const catalog = useCatalog(apiClient, identity);
  const message = useAppMessage('lab');
  const { locale } = usePreferences();
  const definitions = useQuery({
    queryKey: [
      'lab',
      'definitions',
      apiClient.getConfig().baseUrl,
      identity.user.id,
    ],
    queryFn: async ({ signal }) =>
      (
        await listAssetDefinitions({
          client: apiClient,
          signal,
          throwOnError: true,
        })
      ).data.data,
    retry: false,
  });
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('all');
  const [draft, setDraft] = useState<ImportDraft | null>(null);
  const [definition, setDefinition] = useState<AssetDefinition | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<unknown>();
  const stageFile = useCallback(
    (file: File, buffer: ArrayBuffer) => setDraft({ file, buffer }),
    [],
  );
  const importer = useModelImport(stageFile, catalog.maxUploadBytes);
  const assetName = (asset: (typeof catalog.assets)[number]) =>
    asset.source === 'preset' ? message('assets.microscope') : asset.name;
  const matches = (text: string) =>
    text.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase());
  const shownDefinitions = (definitions.data ?? []).filter(
    (entry) =>
      (category === 'all' || category === entry.category) &&
      matches(`${entry.name} ${entry.name_en} ${entry.category}`),
  );
  const shownAssets = catalog.assets.filter(
    (asset) =>
      (category === 'all' || category === 'model') &&
      matches(`${assetName(asset)} ${asset.fileName}`),
  );
  const categories = [
    ...new Set((definitions.data ?? []).map((entry) => entry.category)),
  ];
  const removeAsset = catalog.assets.find((asset) => asset.id === removing);
  const renameAsset = catalog.assets.find((asset) => asset.id === renaming);
  const error = catalog.query.error ?? definitions.error;
  return (
    <section className="asset-library flex flex-col gap-6 px-4 py-7 sm:px-8">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-xl font-semibold">{message('assets.title')}</h1>
        <Badge variant="outline">
          {catalog.assets.length + (definitions.data?.length ?? 0)}
        </Badge>
        <Badge variant="secondary">{message('assets.shared')}</Badge>
      </header>
      <div className="flex flex-wrap items-center gap-3">
        <Input
          type="search"
          className="w-full max-w-md"
          aria-label={message('assets.search')}
          placeholder={message('assets.search')}
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Button
          className="ml-auto"
          variant="outline"
          size="sm"
          disabled={
            importer.pending ||
            catalog.query.isPending ||
            catalog.query.isError ||
            !catalog.maxUploadBytes
          }
          onClick={() => importer.input.current?.click()}
        >
          {importer.pending ? (
            <LoaderCircle data-icon="inline-start" className="animate-spin" />
          ) : (
            <Upload data-icon="inline-start" />
          )}
          {message(importer.pending ? 'import.pending' : 'import.title')}
        </Button>
      </div>
      <ModelFileInput importer={importer} />
      <ImportFeedback
        error={importer.error}
        onDismiss={() => importer.setError(null)}
      />
      {error ? (
        <div className="flex flex-col gap-3">
          <AssetFailure error={error} />
          <Button
            className="w-fit"
            variant="outline"
            onClick={() => {
              void catalog.query.refetch();
              void definitions.refetch();
            }}
          >
            <RotateCcw data-icon="inline-start" />
            {message('assets.retry')}
          </Button>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <NativeSelect
          size="sm"
          aria-label={message('assets.category')}
          value={category}
          onChange={(event) => setCategory(event.target.value)}
        >
          <NativeSelectOption value="all">
            {message('assets.all')}
          </NativeSelectOption>
          {categories.map((entry) => (
            <NativeSelectOption key={entry} value={entry}>
              {message(`assets.category.${entry}`)}
            </NativeSelectOption>
          ))}
        </NativeSelect>
        <span className="ml-auto text-xs text-muted-foreground">
          {catalog.query.isPending
            ? message('viewer.loading')
            : message('assets.limit', {
                size: (catalog.maxUploadBytes / 1024 / 1024).toFixed(2),
              })}
          {catalog.maxDecodedResourceBytes
            ? ` · ${message('assets.decodedLimit', { size: (catalog.maxDecodedResourceBytes / 1024 / 1024).toFixed(0) })}`
            : null}
        </span>
      </div>
      <div className="asset-grid">
        {shownDefinitions.map((entry) => (
          <Card
            key={`${entry.id}:${entry.version}`}
            className="gap-0 overflow-hidden py-0"
          >
            <div className="asset-card-visual">
              <img
                src={miniatures[entry.id] ?? model}
                alt=""
                width={144}
                height={108}
              />
              <Badge variant="outline">
                {message(`assets.category.${entry.category}`)}
              </Badge>
            </div>
            <CardHeader className="pt-4">
              <CardTitle>
                {locale === 'zh' ? entry.name : entry.name_en}
              </CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2 py-3">
              <Badge variant="secondary">{message('assets.definition')}</Badge>
              {entry.capabilities.length ? (
                <span className="text-xs text-muted-foreground">
                  {entry.capabilities.length} {message('assets.capabilities')}
                </span>
              ) : null}
            </CardContent>
            <CardFooter className="mt-auto justify-between pb-4 pt-1">
              <code className="text-xs text-muted-foreground">
                v{entry.version}
              </code>
              <Tool
                icon={Info}
                label={message('assets.inspectNamed', {
                  name: locale === 'zh' ? entry.name : entry.name_en,
                })}
                onClick={() => setDefinition(entry)}
              />
            </CardFooter>
          </Card>
        ))}
        {shownAssets.map((asset) => (
          <Card key={asset.id} className="gap-0 overflow-hidden py-0">
            <div className="asset-card-visual">
              <img src={model} alt="" width={144} height={108} />
              <Badge variant="outline">GLB</Badge>
            </div>
            <CardHeader className="pt-4">
              <CardTitle className="break-words">{assetName(asset)}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 py-3">
              <span className="break-all text-xs text-muted-foreground">
                {asset.fileName}
              </span>
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-xs">
                  {(asset.bytes / 1024 / 1024).toFixed(2)} MiB
                </span>
                <Badge variant="secondary">
                  {message(
                    asset.source === 'preset'
                      ? 'assets.preset'
                      : 'assets.saved',
                  )}
                </Badge>
              </div>
              {asset.source === 'remote' ? (
                <dl className="asset-metadata">
                  <dt>{message('assets.source')}</dt>
                  <dd>{asset.asset.source || message('assets.unspecified')}</dd>
                  <dt>{message('assets.license')}</dt>
                  <dd>
                    {asset.asset.license || message('assets.unspecified')}
                  </dd>
                </dl>
              ) : null}
            </CardContent>
            <CardFooter className="mt-auto justify-between pb-4 pt-1">
              <code className="text-xs text-muted-foreground">
                v{asset.source === 'remote' ? asset.asset.version : '1.0'}
              </code>
              <div className="flex gap-1">
                <Tool
                  icon={Eye}
                  label={message('assets.openNamed', {
                    name: assetName(asset),
                  })}
                  onClick={() => {
                    catalog.activate(asset.id);
                    onOpen();
                  }}
                />
                {asset.source === 'remote' ? (
                  <>
                    <Tool
                      icon={Pencil}
                      label={message('assets.renameNamed', {
                        name: assetName(asset),
                      })}
                      onClick={() => setRenaming(asset.id)}
                    />
                    <Tool
                      icon={Trash2}
                      label={message('assets.removeNamed', {
                        name: assetName(asset),
                      })}
                      onClick={() => {
                        setDeleteError(undefined);
                        setRemoving(asset.id);
                      }}
                    />
                  </>
                ) : null}
              </div>
            </CardFooter>
          </Card>
        ))}
      </div>
      {!shownDefinitions.length &&
      !shownAssets.length &&
      !catalog.query.isPending &&
      !definitions.isPending ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{message('assets.noResults')}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : null}
      {catalog.query.hasNextPage ? (
        <Button
          className="w-fit"
          variant="outline"
          disabled={catalog.query.isFetchingNextPage}
          onClick={() => {
            void catalog.query.fetchNextPage();
          }}
        >
          {message('assets.loadMore')}
        </Button>
      ) : null}
      {draft ? (
        <ImportAssetDialog
          draft={draft}
          catalog={catalog}
          onClose={() => setDraft(null)}
        />
      ) : null}
      {renameAsset ? (
        <RenameAssetDialog
          asset={renameAsset}
          catalog={catalog}
          onClose={() => setRenaming(null)}
        />
      ) : null}
      {definition ? (
        <DefinitionDialog
          definition={definition}
          onClose={() => setDefinition(null)}
        />
      ) : null}
      <AlertDialog
        open={!!removeAsset}
        onOpenChange={(open) => {
          if (!open && !deleting) setRemoving(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{message('assets.removeTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {removeAsset ? assetName(removeAsset) : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError ? <AssetFailure error={deleteError} /> : null}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>
              {message('assets.cancel')}
            </AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={deleting}
              onClick={() => {
                if (!removing) return;
                setDeleting(true);
                setDeleteError(undefined);
                void catalog
                  .removeFile(removing)
                  .then(() => setRemoving(null))
                  .catch(setDeleteError)
                  .finally(() => setDeleting(false));
              }}
            >
              <Trash2 data-icon="inline-start" />
              {message('assets.remove')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
