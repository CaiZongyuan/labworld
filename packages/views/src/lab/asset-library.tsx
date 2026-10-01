import { useState } from 'react';
import { Box, Eye, LoaderCircle, Trash2, Upload } from 'lucide-react';
import { Badge } from '@labos-threejs/ui/components/badge';
import { Button } from '@labos-threejs/ui/components/button';
import { Input } from '@labos-threejs/ui/components/input';
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
} from '@labos-threejs/ui/components/empty';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@labos-threejs/ui/components/alert-dialog';
import { useAppMessage } from '../shell/messages';
import { useCatalog } from './catalog';
import { ImportFeedback, ModelFileInput, useModelImport } from './model-import';

export default function AssetLibrary({
  userId,
  onOpen,
}: {
  userId: string;
  onOpen: () => void;
}) {
  const catalog = useCatalog(userId);
  const message = useAppMessage('lab');
  const importer = useModelImport(catalog.addFile);
  const [search, setSearch] = useState('');
  const [removing, setRemoving] = useState<string | null>(null);
  const removeAsset = catalog.assets.find((asset) => asset.id === removing);
  const assetName = (asset: (typeof catalog.assets)[number]) =>
    asset.source === 'preset' ? message('assets.microscope') : asset.name;
  const matching = catalog.assets.filter((asset) =>
    `${assetName(asset)} ${asset.fileName}`
      .toLocaleLowerCase()
      .includes(search.trim().toLocaleLowerCase()),
  );
  return (
    <section className="asset-library flex flex-col gap-6 px-6 py-7">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="text-lg font-semibold">{message('assets.title')}</h1>
        <Badge variant="outline">{catalog.assets.length}</Badge>
        <Badge variant="secondary">{message('assets.session')}</Badge>
        <Button
          className="ml-auto"
          size="sm"
          disabled={importer.pending}
          onClick={() => importer.input.current?.click()}
        >
          {importer.pending ? (
            <LoaderCircle data-icon="inline-start" className="animate-spin" />
          ) : (
            <Upload data-icon="inline-start" />
          )}
          {message(importer.pending ? 'import.pending' : 'import.title')}
        </Button>
      </header>
      <ModelFileInput importer={importer} />
      <ImportFeedback
        error={importer.error}
        onDismiss={() => importer.setError(null)}
      />
      <Input
        type="search"
        className="max-w-xs"
        aria-label={message('assets.search')}
        placeholder={message('assets.search')}
        value={search}
        onChange={(event) => setSearch(event.target.value)}
      />
      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead className="border-b border-border text-xs text-muted-foreground">
            <tr>
              <th className="py-3 font-medium">{message('assets.name')}</th>
              <th className="py-3 font-medium">{message('assets.type')}</th>
              <th className="py-3 font-medium">{message('assets.size')}</th>
              <th className="py-3 font-medium">{message('assets.source')}</th>
              <th className="w-24">
                <span className="sr-only">{message('assets.open')}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {matching.map((asset) => (
              <tr key={asset.id} className="border-b border-border">
                <td className="py-4">
                  <div className="flex items-center gap-3">
                    <Box className="size-5 text-success" />
                    <div className="flex flex-col gap-1">
                      <strong className="font-medium">
                        {assetName(asset)}
                      </strong>
                      <span className="break-all text-xs text-muted-foreground">
                        {asset.fileName}
                      </span>
                    </div>
                  </div>
                </td>
                <td>
                  <Badge variant="outline">GLB</Badge>
                </td>
                <td className="whitespace-nowrap font-mono text-xs">
                  {(asset.bytes / 1024 / 1024).toFixed(2)} MiB
                </td>
                <td className="text-xs">
                  {message(
                    asset.source === 'preset'
                      ? 'assets.preset'
                      : 'assets.local',
                  )}
                </td>
                <td>
                  <div className="flex justify-end gap-1">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label={message('assets.openNamed', {
                        name: assetName(asset),
                      })}
                      title={message('assets.open')}
                      onClick={() => {
                        catalog.activate(asset.id);
                        onOpen();
                      }}
                    >
                      <Eye />
                    </Button>
                    {asset.source === 'local' ? (
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={message('assets.removeNamed', {
                          name: assetName(asset),
                        })}
                        title={message('assets.remove')}
                        onClick={() => setRemoving(asset.id)}
                      >
                        <Trash2 />
                      </Button>
                    ) : null}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!matching.length ? (
          <Empty>
            <EmptyHeader>
              <EmptyTitle>{message('assets.noResults')}</EmptyTitle>
            </EmptyHeader>
          </Empty>
        ) : null}
      </div>
      <AlertDialog
        open={!!removeAsset}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{message('assets.removeTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {removeAsset ? assetName(removeAsset) : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{message('assets.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                if (removing) catalog.removeFile(removing);
                setRemoving(null);
              }}
            >
              {message('assets.remove')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
