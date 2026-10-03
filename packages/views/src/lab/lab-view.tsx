import { Suspense, lazy, useCallback, useMemo, useRef, useState } from 'react';
import {
  Activity,
  Box,
  Cpu,
  Crosshair,
  FileBox,
  Grid2X2,
  LoaderCircle,
  PanelRightClose,
  PanelRightOpen,
  RotateCcw,
  RotateCw,
  Upload,
} from 'lucide-react';
import { Button } from '@labos-threejs/ui/components/button';
import { Badge } from '@labos-threejs/ui/components/badge';
import { Alert, AlertTitle } from '@labos-threejs/ui/components/alert';
import { useAppMessage } from '../shell/messages';
import { usePreferences } from '../shell/preferences';
import { presetAsset, useCatalog } from './catalog';
import { ImportFeedback, ModelFileInput, useModelImport } from './model-import';
import { AssetInspector, PerformancePanel, Tool } from './view-controls';
import type { RenderMetrics, ViewSettings, ViewStatus } from './viewport-state';
import type { ModelErrorKey } from './glb';
import { ViewportBoundary } from './viewport-boundary';
import type { ApiClient, CurrentSession } from '@labos-threejs/sdk';
import './lab.css';

const Viewport = lazy(() => import('./viewport'));

export default function LabView({
  apiClient,
  identity,
}: {
  apiClient: ApiClient;
  identity: CurrentSession;
}) {
  const catalog = useCatalog(apiClient, identity);
  const { addFile, activate } = catalog;
  const asset =
    catalog.assets.find((entry) => entry.id === catalog.activeId) ??
    presetAsset;
  const message = useAppMessage('lab');
  const { locale, resolvedTheme } = usePreferences();
  const [selected, setSelected] = useState(false);
  const [grid, setGrid] = useState(true);
  const [rotate, setRotate] = useState(false);
  const [performance, setPerformance] = useState(true);
  const [inspector, setInspector] = useState(true);
  const [intensity, setIntensity] = useState(1);
  const [fit, setFit] = useState(0);
  const [reset, setReset] = useState(0);
  const [metrics, setMetrics] = useState<RenderMetrics | null>(null);
  const [status, setStatus] = useState<ViewStatus>({
    renderedId: null,
    info: null,
    loading: false,
    error: null,
  });
  const [dragging, setDragging] = useState(false);
  const [renderError, setRenderError] = useState<ModelErrorKey | null>(null);
  const dragDepth = useRef(0);
  const activeId = useRef(asset.id);
  const importAsset = useCallback(
    async (file: File, buffer: ArrayBuffer, signal: AbortSignal) => {
      setRenderError(null);
      const id = await addFile(file, buffer, signal);
      if (!signal.aborted) activate(id);
    },
    [addFile, activate],
  );
  const importer = useModelImport(importAsset, catalog.maxUploadBytes);
  const settings = useMemo<ViewSettings>(
    () => ({
      dark: resolvedTheme === 'dark',
      grid,
      rotate,
      intensity,
      fit,
      reset,
    }),
    [resolvedTheme, grid, rotate, intensity, fit, reset],
  );
  const onSelect = useCallback((value: boolean) => setSelected(value), []);
  const onMetrics = useCallback(
    (value: RenderMetrics) => setMetrics(value),
    [],
  );
  const onStatus = useCallback(
    (value: ViewStatus) => {
      setStatus(value);
      if (value.error) {
        setRenderError(value.error);
        activate(value.renderedId ?? presetAsset.id);
      }
      if (value.renderedId && activeId.current !== value.renderedId) {
        activeId.current = value.renderedId;
        setSelected(false);
      }
    },
    [activate],
  );
  const shown =
    catalog.assets.find((entry) => entry.id === status.renderedId) ?? asset;
  const info =
    status.renderedId === shown.id ? (status.info ?? shown.info) : shown.info;
  const name =
    shown.source === 'preset' ? message('assets.microscope') : shown.name;
  const unavailable = (
    <div className="lab-unavailable">
      <Alert>
        <AlertTitle>{message('viewer.unavailable')}</AlertTitle>
      </Alert>
    </div>
  );
  const supported = typeof WebGL2RenderingContext !== 'undefined';
  const busy =
    importer.pending ||
    (supported &&
      (status.loading || (status.renderedId !== asset.id && !renderError)));
  const count = new Intl.NumberFormat(locale);
  return (
    <section className="lab-page" aria-busy={busy}>
      <header className="lab-toolbar">
        <div className="lab-heading">
          <Box />
          <h1>{message('viewer.title')}</h1>
          <Badge variant="outline">GLB</Badge>
        </div>
        <div className="lab-toolbar-actions">
          <Button
            size="sm"
            aria-label={message('import.title')}
            disabled={
              importer.pending ||
              catalog.query.isPending ||
              catalog.query.isError ||
              !catalog.maxUploadBytes
            }
            onClick={() => importer.input.current?.click()}
          >
            <Upload data-icon="inline-start" />
            <span className="lab-import-full">{message('import.title')}</span>
            <span className="lab-import-short">GLB</span>
          </Button>
          <Tool
            icon={FileBox}
            label={message('viewer.restore')}
            onClick={() => {
              importer.cancel();
              setRenderError(null);
              catalog.activate(presetAsset.id);
              setReset((value) => value + 1);
              setSelected(false);
              importer.setError(null);
            }}
          />
          <span className="lab-toolbar-divider" />
          <Tool
            icon={Crosshair}
            label={message('viewer.focus')}
            onClick={() => setFit((value) => value + 1)}
          />
          <Tool
            icon={RotateCcw}
            label={message('viewer.reset')}
            onClick={() => setReset((value) => value + 1)}
          />
          <Tool
            icon={Grid2X2}
            label={message('viewer.grid')}
            active={grid}
            onClick={() => setGrid(!grid)}
          />
          <Tool
            icon={Activity}
            label={message('viewer.performance')}
            active={performance}
            onClick={() => setPerformance(!performance)}
          />
          <Tool
            icon={inspector ? PanelRightClose : PanelRightOpen}
            label={message(
              inspector ? 'viewer.hideInspector' : 'viewer.showInspector',
            )}
            onClick={() => setInspector(!inspector)}
          />
        </div>
      </header>
      <ModelFileInput importer={importer} />
      {importer.error || renderError || status.error ? (
        <div className="lab-error">
          <ImportFeedback
            error={importer.error ?? renderError ?? status.error}
            onDismiss={() => {
              importer.setError(null);
              setRenderError(null);
              setStatus((previous) => ({ ...previous, error: null }));
            }}
          />
        </div>
      ) : null}
      <div className={`lab-body${inspector ? ' with-inspector' : ''}`}>
        <div
          className="lab-viewport"
          aria-label={message('viewer.viewport')}
          onDragEnter={(event) => {
            if (event.dataTransfer.types.includes('Files')) {
              event.preventDefault();
              dragDepth.current++;
              setDragging(true);
            }
          }}
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes('Files')) {
              event.preventDefault();
              event.dataTransfer.dropEffect = 'copy';
            }
          }}
          onDragLeave={() => {
            dragDepth.current = Math.max(0, dragDepth.current - 1);
            if (!dragDepth.current) setDragging(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            dragDepth.current = 0;
            setDragging(false);
            const files = event.dataTransfer.files;
            if (files.length !== 1) {
              importer.cancel();
              importer.setError('single');
            } else void importer.importFile(files[0]);
          }}
        >
          {supported ? (
            <ViewportBoundary resetKey={asset.id} fallback={unavailable}>
              <Suspense
                fallback={
                  <div className="lab-loading" role="status">
                    <LoaderCircle className="animate-spin" />
                    {message('viewer.loading')}
                  </div>
                }
              >
                <Viewport
                  asset={asset}
                  settings={settings}
                  selected={selected}
                  label={message('viewer.viewport')}
                  onSelect={onSelect}
                  onMetrics={onMetrics}
                  onStatus={onStatus}
                  onInfo={catalog.updateInfo}
                />
              </Suspense>
            </ViewportBoundary>
          ) : (
            unavailable
          )}
          {performance && supported ? (
            <PerformancePanel metrics={metrics} />
          ) : null}
          <div className="lab-viewport-tools">
            <Tool
              icon={RotateCw}
              label={message('viewer.rotate')}
              active={rotate}
              onClick={() => setRotate(!rotate)}
            />
          </div>
          {busy ? (
            <div className="lab-loading" role="status">
              <LoaderCircle className="animate-spin" />
              <span>{message('viewer.loading')}</span>
              <small>{asset.fileName}</small>
            </div>
          ) : null}
          {dragging ? (
            <div className="lab-drop-overlay">
              <Upload />
              <strong>{message('import.title')}</strong>
            </div>
          ) : null}
          <div className="lab-axis" aria-hidden="true">
            <span className="y">Y</span>
            <span className="x">X</span>
            <span className="z">Z</span>
          </div>
        </div>
        {inspector ? (
          <AssetInspector
            asset={shown}
            info={info}
            selected={selected}
            onSelect={() => setSelected(!selected)}
            grid={grid}
            rotate={rotate}
            performance={performance}
            intensity={intensity}
            onGrid={setGrid}
            onRotate={setRotate}
            onPerformance={setPerformance}
            onIntensity={setIntensity}
          />
        ) : null}
      </div>
      <footer className="lab-status">
        <span>
          <i />1 {message('viewer.assetCount')}
          <span className="divider">/</span>
          {info ? count.format(info.triangles) : '-'}{' '}
          {message('viewer.triangles')}
        </span>
        <span>{selected ? name : message('viewer.unselected')}</span>
        <span>
          <Cpu />
          WebGL 2
        </span>
      </footer>
    </section>
  );
}
