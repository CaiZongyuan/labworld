import type { ReactNode } from 'react';
import {
  Activity,
  ArrowUpRight,
  Box,
  Grid2X2,
  Layers3,
  RotateCw,
  SlidersHorizontal,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@labos-threejs/ui/components/button';
import { Badge } from '@labos-threejs/ui/components/badge';
import { Switch } from '@labos-threejs/ui/components/switch';
import { useAppMessage } from '../shell/messages';
import { usePreferences } from '../shell/preferences';
import type { ModelAsset, ModelInfo } from './catalog';
import type { RenderMetrics } from './viewport-state';

export function Tool({
  icon: Icon,
  label,
  active,
  onClick,
  disabled = false,
}: {
  icon: LucideIcon;
  label: string;
  active?: boolean;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Button
      variant={active ? 'secondary' : 'ghost'}
      size="icon-sm"
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      disabled={disabled}
    >
      <Icon aria-hidden="true" />
    </Button>
  );
}

function Property({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="lab-property-row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

export function PerformancePanel({
  metrics,
}: {
  metrics: RenderMetrics | null;
}) {
  const message = useAppMessage('lab');
  const { locale } = usePreferences();
  const count = new Intl.NumberFormat(locale);
  if (!metrics) return null;
  return (
    <aside className="lab-perf" aria-label={message('viewer.performance')}>
      <div className="lab-perf-title">
        <Activity />
        <span>{message('viewer.performance')}</span>
        <i />
      </div>
      <div className="lab-perf-main">
        <strong>{Math.round(metrics.fps)}</strong>
        <span>FPS</span>
        <small>{metrics.frameMs.toFixed(1)} ms / frame</small>
      </div>
      <dl className="lab-perf-stats">
        <div>
          <dt>Draw calls</dt>
          <dd>{count.format(metrics.calls)}</dd>
        </div>
        <div>
          <dt>{message('viewer.triangles')}</dt>
          <dd>{count.format(metrics.triangles)}</dd>
        </div>
        <div>
          <dt>JS heap</dt>
          <dd>
            {metrics.heapMiB === null
              ? message('viewer.na')
              : `${metrics.heapMiB.toFixed(1)} MiB`}
          </dd>
        </div>
        <div>
          <dt>GPU ms</dt>
          <dd title={message('viewer.gpuNote')}>{message('viewer.na')}</dd>
        </div>
        <div>
          <dt>Geometries</dt>
          <dd>{metrics.geometries}</dd>
        </div>
        <div>
          <dt>Textures</dt>
          <dd>{metrics.textures}</dd>
        </div>
      </dl>
    </aside>
  );
}

export function AssetInspector({
  asset,
  info,
  selected,
  onSelect,
  grid,
  rotate,
  performance,
  intensity,
  onGrid,
  onRotate,
  onPerformance,
  onIntensity,
}: {
  asset: ModelAsset;
  info: ModelInfo | undefined | null;
  selected: boolean;
  onSelect: () => void;
  grid: boolean;
  rotate: boolean;
  performance: boolean;
  intensity: number;
  onGrid: (value: boolean) => void;
  onRotate: (value: boolean) => void;
  onPerformance: (value: boolean) => void;
  onIntensity: (value: number) => void;
}) {
  const message = useAppMessage('lab');
  const { locale } = usePreferences();
  const count = new Intl.NumberFormat(locale);
  const name =
    asset.source === 'preset' ? message('assets.microscope') : asset.name;
  return (
    <aside className="lab-inspector" aria-label={message('viewer.inspector')}>
      <header className="lab-inspector-heading">
        <Layers3 />
        <h2>{message('viewer.assets')}</h2>
        <span>1</span>
      </header>
      <button
        className={`lab-asset-row${selected ? ' selected' : ''}`}
        onClick={onSelect}
        aria-pressed={selected}
      >
        <span className="lab-asset-icon">
          <Box />
        </span>
        <span className="lab-asset-copy">
          <strong>{name}</strong>
          <small>{asset.fileName}</small>
        </span>
      </button>
      <section className="lab-inspector-section">
        <div className="lab-section-heading">
          <h3>{message('viewer.model')}</h3>
          {selected ? (
            <Badge variant="success">{message('viewer.selected')}</Badge>
          ) : (
            <span>{message('viewer.unselected')}</span>
          )}
        </div>
        <dl>
          <Property label={message('viewer.meshes')}>
            {info ? count.format(info.meshes) : '-'}
          </Property>
          <Property label={message('viewer.materials')}>
            {info ? count.format(info.materials) : '-'}
          </Property>
          <Property label={message('viewer.textures')}>
            {info ? count.format(info.textures) : '-'}
          </Property>
          <Property label={message('viewer.triangles')}>
            {info ? count.format(info.triangles) : '-'}
          </Property>
          <Property label={message('assets.size')}>
            {(asset.bytes / 1024 / 1024).toFixed(2)} MiB
          </Property>
          <Property label={message('assets.source')}>
            {message(
              asset.source === 'preset' ? 'assets.preset' : 'assets.local',
            )}
          </Property>
        </dl>
        <div className="lab-dimension-heading">
          <span>{message('viewer.dimensions')}</span>
          <span>m</span>
        </div>
        <div className="lab-dimensions">
          {(['X', 'Y', 'Z'] as const).map((axis, index) => (
            <div key={axis}>
              <span>{axis}</span>
              <strong>{info?.dimensions[index].toFixed(3) ?? '-'}</strong>
            </div>
          ))}
        </div>
      </section>
      <section className="lab-inspector-section">
        <div className="lab-section-heading">
          <h3>{message('viewer.environment')}</h3>
          <Badge variant="outline">HDR</Badge>
        </div>
        <div className="lab-environment-row">
          <img
            src={`${import.meta.env.BASE_URL}lab-assets/hdr/studio-thumbnail.png`}
            alt=""
          />
          <span>Studio Small 03</span>
        </div>
        <label className="lab-slider-label" htmlFor="lab-intensity">
          <span>{message('viewer.intensity')}</span>
          <output>{intensity.toFixed(1)}</output>
        </label>
        <input
          id="lab-intensity"
          type="range"
          min="0"
          max="2.5"
          step="0.1"
          value={intensity}
          onChange={(event) => onIntensity(Number(event.target.value))}
        />
      </section>
      <section className="lab-inspector-section">
        <div className="lab-section-heading">
          <h3>{message('viewer.display')}</h3>
          <SlidersHorizontal />
        </div>
        <label className="lab-setting-row">
          <span>
            <Grid2X2 />
            {message('viewer.grid')}
          </span>
          <Switch checked={grid} onCheckedChange={onGrid} size="sm" />
        </label>
        <label className="lab-setting-row">
          <span>
            <RotateCw />
            {message('viewer.rotate')}
          </span>
          <Switch checked={rotate} onCheckedChange={onRotate} size="sm" />
        </label>
        <label className="lab-setting-row">
          <span>
            <Activity />
            {message('viewer.performance')}
          </span>
          <Switch
            checked={performance}
            onCheckedChange={onPerformance}
            size="sm"
          />
        </label>
      </section>
      {asset.source === 'preset' ? (
        <a
          className="lab-credit"
          href={asset.sourceUrl}
          target="_blank"
          rel="noreferrer"
        >
          <span>
            Poly Haven{' '}
            <small>
              {asset.license} · {asset.author}
            </small>
          </span>
          <ArrowUpRight />
        </a>
      ) : null}
    </aside>
  );
}
