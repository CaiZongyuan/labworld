import { useEffect, useRef, useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { Download, Info, LoaderCircle, Upload, X } from 'lucide-react';
import {
  downloadAssetVersionResource,
  importCompleteAssetVersion,
  listCompleteAssetVersions,
  type ApiClient,
  type CompleteAssetVersion,
  type CurrentSession,
  type ImportAssetVersion,
} from '@labos-threejs/sdk';
import { Badge } from '@labos-threejs/ui/components/badge';
import { Button } from '@labos-threejs/ui/components/button';
import {
  Card,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@labos-threejs/ui/components/card';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@labos-threejs/ui/components/dialog';
import { usePreferences } from '../shell/preferences';
import { AssetFailure } from './asset-dialogs';

const words = {
  zh: {
    title: '资产版本',
    import: '导入资产描述',
    importing: '正在导入描述',
    file: '资产描述 JSON 文件',
    info: '查看资产信息',
    fixed: '固定版本',
    configuration: '配置字段',
    state: '状态字段',
    capabilities: '能力说明',
    specifications: '规格',
    source: '来源',
    license: '许可',
    manufacturer: '厂商',
    model: '型号',
    representations: '资产表示',
    components: '组件',
    visual: '外观',
    simulation: '物理表示',
    documentation: '文档',
    download: '下载',
    close: '关闭',
    retry: '重试',
    more: '加载更多资产版本',
    empty: '尚未导入完整资产版本',
    glb: '模型已校验',
    json: 'JSON 已解析',
    pdf: '已识别 PDF 格式',
    usd: '已识别 USD 格式；未验证物理模型',
    opaque: '仅保存；未验证物理模型',
    declared: '描述不授予执行权限',
    invalid: '无法读取 JSON 描述文件',
    note: '描述文件引用已上传资源。建模和信息编写在外部工具完成。',
  },
  en: {
    title: 'Asset versions',
    import: 'Import asset description',
    importing: 'Importing description',
    file: 'Asset description JSON file',
    info: 'View asset information',
    fixed: 'Fixed version',
    configuration: 'Configuration fields',
    state: 'State fields',
    capabilities: 'Capability descriptions',
    specifications: 'Specifications',
    source: 'Source',
    license: 'License',
    manufacturer: 'Manufacturer',
    model: 'Model',
    representations: 'Representations',
    components: 'Components',
    visual: 'Appearance',
    simulation: 'Physics representation',
    documentation: 'Documentation',
    download: 'Download',
    close: 'Close',
    retry: 'Retry',
    more: 'Load more asset versions',
    empty: 'No complete asset versions imported',
    glb: 'Model validated',
    json: 'JSON parsed',
    pdf: 'PDF format recognized',
    usd: 'USD format recognized; physics model not validated',
    opaque: 'Stored only; physics model not validated',
    declared: 'Descriptions do not grant execution permission',
    invalid: 'Cannot read the JSON description file',
    note: 'The description references uploaded resources. Author models and information in external tools.',
  },
};
function readDescription(file: File): Promise<ImportAssetVersion> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        resolve(JSON.parse(String(reader.result)) as ImportAssetVersion);
      } catch (error) {
        reject(error);
      }
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsText(file);
  });
}
export function CompleteAssets({
  apiClient,
  identity,
  search,
  category,
}: {
  apiClient: ApiClient;
  identity: CurrentSession;
  search: string;
  category: string;
}) {
  const { locale } = usePreferences(),
    copy = words[locale];
  const client = useQueryClient();
  const query = useInfiniteQuery({
    queryKey: [
      'lab',
      'asset-versions',
      apiClient.getConfig().baseUrl,
      identity.user.id,
    ],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ signal, pageParam }) =>
      (
        await listCompleteAssetVersions({
          client: apiClient,
          signal,
          query: { cursor: pageParam },
          throwOnError: true,
        })
      ).data,
    getNextPageParam: (page) =>
      page.has_more ? (page.next_cursor ?? undefined) : undefined,
    retry: false,
  });
  const input = useRef<HTMLInputElement>(null),
    controller = useRef<AbortController | null>(null);
  const [selected, setSelected] = useState<CompleteAssetVersion | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [draft, setDraft] = useState<File | null>(null);
  useEffect(() => () => controller.current?.abort(), []);
  const importFile = async (file: File) => {
    const attempt = new AbortController();
    controller.current?.abort();
    controller.current = attempt;
    setDraft(file);
    setPending(true);
    setError(undefined);
    try {
      if (file.size > 192 * 1024) throw new Error(copy.invalid);
      const body = await readDescription(file);
      await importCompleteAssetVersion({
        client: apiClient,
        body,
        signal: attempt.signal,
        headers: { 'x-csrf-token': identity.csrf_token },
        throwOnError: true,
      });
      setDraft(null);
      await Promise.all([
        client.invalidateQueries({ queryKey: ['lab', 'asset-versions'] }),
        client.invalidateQueries({ queryKey: ['lab', 'definitions'] }),
      ]);
    } catch (error) {
      if (!attempt.signal.aborted) setError(error);
    } finally {
      if (!attempt.signal.aborted) setPending(false);
    }
  };
  const versions = (
    query.data?.pages.flatMap((page) => page.data) ?? []
  ).filter(
    (version) =>
      (category === 'all' || category === version.definition.category) &&
      `${version.asset_id} ${version.version} ${version.definition.name} ${version.definition.name_en ?? ''} ${version.definition.manufacturer ?? ''} ${version.definition.model ?? ''}`
        .toLocaleLowerCase()
        .includes(search.trim().toLocaleLowerCase()),
  );
  return (
    <section className="flex flex-col gap-4" aria-label={copy.title}>
      <header className="flex flex-wrap items-center gap-3">
        <h2 className="text-base font-semibold">{copy.title}</h2>
        <Button
          variant="outline"
          size="sm"
          disabled={pending}
          onClick={() => input.current?.click()}
        >
          {pending ? (
            <LoaderCircle data-icon="inline-start" className="animate-spin" />
          ) : (
            <Upload data-icon="inline-start" />
          )}
          {pending ? copy.importing : copy.import}
        </Button>
        <input
          ref={input}
          hidden
          type="file"
          accept="application/json,.json"
          aria-label={copy.file}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (file) void importFile(file);
            event.target.value = '';
          }}
        />
      </header>
      <p className="text-sm text-muted-foreground">{copy.note}</p>
      {query.error || error ? (
        <div className="flex flex-col gap-2">
          <AssetFailure error={error ?? query.error} />
          <Button
            variant="outline"
            className="w-fit"
            disabled={pending}
            onClick={() => {
              if (draft) void importFile(draft);
              else void query.refetch();
            }}
          >
            {copy.retry}
          </Button>
        </div>
      ) : null}
      <div className="asset-grid">
        {versions.map((version) => (
          <Card key={version.id}>
            <CardHeader>
              <CardTitle>
                {locale === 'zh'
                  ? version.definition.name
                  : (version.definition.name_en ?? version.definition.name)}
              </CardTitle>
              <div className="flex flex-wrap gap-2">
                <Badge variant="outline">v{version.version}</Badge>
                <Badge variant="secondary">{copy.fixed}</Badge>
              </div>
            </CardHeader>
            <CardContent className="flex flex-col gap-2 text-sm">
              <p>
                {version.definition.manufacturer} {version.definition.model}
              </p>
              <code>{version.asset_id}</code>
            </CardContent>
            <CardFooter>
              <Button
                variant="outline"
                size="sm"
                aria-label={`${copy.info} ${locale === 'zh' ? version.definition.name : (version.definition.name_en ?? version.definition.name)} v${version.version}`}
                onClick={() => setSelected(version)}
              >
                <Info data-icon="inline-start" />
                {copy.info}
              </Button>
            </CardFooter>
          </Card>
        ))}
      </div>
      {query.hasNextPage ? (
        <Button
          variant="outline"
          className="w-fit"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {copy.more}
        </Button>
      ) : null}
      {selected ? (
        <CompleteAssetInformation
          version={selected}
          apiClient={apiClient}
          onClose={() => setSelected(null)}
        />
      ) : null}
    </section>
  );
}
function CompleteAssetInformation({
  version,
  apiClient,
  onClose,
}: {
  version: CompleteAssetVersion;
  apiClient: ApiClient;
  onClose: () => void;
}) {
  const { locale } = usePreferences(),
    copy = words[locale],
    definition = version.definition;
  const [error, setError] = useState<unknown>();
  const [pending, setPending] = useState<string | null>(null);
  const download = async (key: string) => {
    setPending(key);
    setError(undefined);
    try {
      const { data } = await downloadAssetVersionResource({
        client: apiClient,
        path: { version_id: version.id, resource_key: key },
        throwOnError: true,
      });
      const link = document.createElement('a');
      link.href = data.url;
      link.download = data.file.file_name;
      link.referrerPolicy = 'no-referrer';
      link.click();
    } catch (error) {
      setError(error);
    } finally {
      setPending(null);
    }
  };
  const verification = {
    'glb-validated': copy.glb,
    'json-parsed': copy.json,
    'pdf-header': copy.pdf,
    'usd-header': copy.usd,
    opaque: copy.opaque,
  };
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
              aria-label={copy.close}
            />
          }
        >
          <X />
        </DialogClose>
        <header className="flex flex-col gap-2 pr-8">
          <DialogTitle>
            {locale === 'zh'
              ? definition.name
              : (definition.name_en ?? definition.name)}
          </DialogTitle>
          <DialogDescription>
            {version.asset_id} · v{version.version} · {copy.fixed}
          </DialogDescription>
        </header>
        <dl className="flex flex-col gap-3 text-sm">
          {(
            [
              ['manufacturer', definition.manufacturer],
              ['model', definition.model],
              ['source', definition.source],
              ['license', definition.license],
            ] as const
          ).map(([key, value]) =>
            value ? (
              <div key={key}>
                <dt className="text-muted-foreground">{copy[key]}</dt>
                <dd>{value}</dd>
              </div>
            ) : null,
          )}
          {(
            [
              ['specifications', definition.specifications],
              ['configuration', definition.configuration_schema],
              ['state', definition.state_schema],
              ['capabilities', definition.capabilities],
            ] as const
          ).map(([key, value]) => (
            <div key={key}>
              <dt>{copy[key]}</dt>
              <dd>
                <pre className="asset-schema">
                  {JSON.stringify(value, null, 2)}
                </pre>
              </dd>
            </div>
          ))}
        </dl>
        <p className="text-sm text-muted-foreground">{copy.declared}</p>
        <h3 className="font-medium">{copy.representations}</h3>
        {version.representations.map((representation) => (
          <section
            key={representation.key}
            className="flex flex-col gap-2 text-sm"
          >
            <div className="flex flex-wrap gap-2">
              <Badge variant="secondary">{copy[representation.purpose]}</Badge>
              <code>{representation.key}</code>
            </div>
            {representation.components.length ? (
              <p>
                {copy.components}:{' '}
                {representation.components
                  .map((component) => component.key)
                  .join(', ')}
              </p>
            ) : null}
            {representation.resource_keys.map((key) => {
              const resource = version.resources.find(
                (resource) => resource.key === key,
              );
              return resource ? (
                <div key={key} className="flex flex-col gap-1">
                  <span>
                    {resource.format.toUpperCase()} ·{' '}
                    {verification[resource.verification]}
                  </span>
                  <Button
                    className="w-fit"
                    variant="outline"
                    size="sm"
                    disabled={!!pending}
                    onClick={() => void download(key)}
                  >
                    <Download data-icon="inline-start" />
                    {copy.download} {resource.file_name}
                  </Button>
                </div>
              ) : null;
            })}
          </section>
        ))}
        {error ? <AssetFailure error={error} /> : null}
      </DialogContent>
    </Dialog>
  );
}
