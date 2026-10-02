import {
  Activity,
  Archive,
  Box,
  FlaskConical,
  LampDesk,
  Layers3,
  LayoutGrid,
  Bot,
  Thermometer,
  CircleDot,
} from 'lucide-react';
import { Button } from '@labos-threejs/ui/components/button';
import { Badge } from '@labos-threejs/ui/components/badge';
import type { Kind, Observation } from './world';
export type Translate = (zh: string, en: string) => string;
export const icons = {
  centrifuge: CircleDot,
  light: LampDesk,
  sensor: Thermometer,
  robot: Bot,
  bench: LayoutGrid,
  labware: FlaskConical,
  environment: Layers3,
  model: Box,
};
export function EntityIcon({
  kind,
  large = false,
}: {
  kind: Kind;
  large?: boolean;
}) {
  const Icon = icons[kind] ?? Box;
  return (
    <span className={`entity-icon entity-icon-${kind}${large ? ' large' : ''}`}>
      <Icon />
    </span>
  );
}
export function Tool({ icon: Icon, label, active, ...props }: any) {
  return (
    <Button
      variant={active ? 'secondary' : 'ghost'}
      size="icon-sm"
      title={label}
      aria-label={label}
      aria-pressed={active}
      {...props}
    >
      <Icon />
    </Button>
  );
}
export function Property({ label, children }: any) {
  return (
    <div className="property">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
export function Status({
  observation: d,
  kind,
  archived,
  online = true,
  t,
}: {
  observation?: Observation;
  kind: Kind;
  archived?: boolean;
  online?: boolean;
  t: Translate;
}) {
  if (archived)
    return (
      <Badge variant="secondary">
        <Archive />
        {t('已归档', 'Archived')}
      </Badge>
    );
  if (!['centrifuge', 'light', 'sensor'].includes(kind))
    return (
      <Badge variant="outline">
        {kind === 'robot'
          ? t('未接入', 'Not connected')
          : t('静态对象', 'Static')}
      </Badge>
    );
  if (!online) return <Badge variant="warning">{t('数据过期', 'Stale')}</Badge>;
  if (d?.phase === 'interrupted')
    return <Badge variant="warning">{t('已中断', 'Interrupted')}</Badge>;
  if (d?.phase === 'failed')
    return <Badge variant="destructive">{t('运行异常', 'Failed')}</Badge>;
  if (!d?.program)
    return (
      <Badge variant="secondary">{t('程序已停止', 'Program stopped')}</Badge>
    );
  if (d?.phase === 'preparing')
    return (
      <Badge variant="info">
        <Activity />
        {t('准备中', 'Preparing')}
      </Badge>
    );
  if (d?.phase === 'running')
    return (
      <Badge variant="success">
        <Activity />
        {t('运行中', 'Running')}
      </Badge>
    );
  if (d?.phase === 'decelerating')
    return <Badge variant="warning">{t('减速中', 'Decelerating')}</Badge>;
  if (kind === 'light')
    return (
      <Badge variant={d?.on ? 'success' : 'secondary'}>
        {d?.on ? t('已开启', 'On') : t('已关闭', 'Off')}
      </Badge>
    );
  return (
    <Badge variant="success">
      {kind === 'sensor' ? t('采样中', 'Sampling') : t('空闲', 'Idle')}
    </Badge>
  );
}
export function Miniature({ kind }: { kind: Kind }) {
  const shared = {
    stroke: 'currentColor',
    strokeWidth: 1.3,
    strokeLinejoin: 'round' as const,
  };
  return (
    <svg
      viewBox="0 0 120 90"
      className={`asset-miniature miniature-${kind}`}
      aria-hidden="true"
    >
      <ellipse
        cx="60"
        cy="73"
        rx="36"
        ry="8"
        fill="currentColor"
        opacity=".08"
      />
      {kind === 'centrifuge' ? (
        <g {...shared}>
          <path d="M24 41 61 23 97 41 61 62Z" fill="var(--surface-muted)" />
          <path d="M24 41v23l37 16V62Z" fill="var(--secondary)" />
          <path d="M61 62v18l36-17V41Z" fill="var(--accent)" />
          <ellipse
            cx="60"
            cy="43"
            rx="21"
            ry="10"
            fill="currentColor"
            opacity=".2"
          />
          <ellipse cx="60" cy="43" rx="12" ry="5" fill="none" />
          <path d="m33 58 15 6v7l-15-6Z" fill="currentColor" opacity=".6" />
        </g>
      ) : kind === 'bench' ? (
        <g {...shared}>
          <path d="m13 36 54-23 42 19-53 23Z" fill="var(--surface-muted)" />
          <path d="M13 36v7l43 20 53-24v-7" fill="var(--accent)" />
          <path
            d="M19 46v24l12 5V51m55-1v25l12-5V43M44 57v25l12 5V62"
            fill="var(--secondary)"
          />
        </g>
      ) : kind === 'light' ? (
        <g {...shared}>
          <ellipse cx="59" cy="72" rx="22" ry="7" fill="var(--accent)" />
          <path d="M59 70V24l21-7" fill="none" strokeWidth="3" />
          <path d="M70 15h18l13 22H57Z" fill="var(--secondary)" />
          <ellipse
            cx="79"
            cy="37"
            rx="22"
            ry="5"
            fill="currentColor"
            opacity=".18"
          />
        </g>
      ) : kind === 'robot' ? (
        <g {...shared}>
          <ellipse cx="58" cy="73" rx="23" ry="8" fill="var(--accent)" />
          <path
            d="M49 67V50l-12-20 12-8 23 19 18-8 6 11-29 14-5 16Z"
            fill="var(--secondary)"
          />
          <circle cx="44" cy="27" r="7" fill="currentColor" opacity=".5" />
          <circle cx="71" cy="44" r="7" fill="currentColor" opacity=".5" />
          <path d="m95 39 10 10m-7-13 12 3" fill="none" strokeWidth="4" />
        </g>
      ) : kind === 'sensor' ? (
        <g {...shared}>
          <path d="m43 20 30-8 9 8v50l-30 9-9-8Z" fill="var(--secondary)" />
          <path d="m52 28 23-7v25l-23 7Z" fill="currentColor" opacity=".28" />
          <path d="m56 39 13-4m-10 28 5-2" />
          <path d="m43 20 9 8v51" fill="none" />
        </g>
      ) : kind === 'labware' ? (
        <g {...shared}>
          <path
            d="M39 22v41c0 13 42 13 42 0V22"
            fill="var(--secondary)"
            opacity=".8"
          />
          <ellipse cx="60" cy="22" rx="21" ry="8" fill="var(--background)" />
          <path
            d="M40 48v15c0 12 40 12 40 0V48"
            fill="currentColor"
            opacity=".20"
          />
          <ellipse
            cx="60"
            cy="48"
            rx="20"
            ry="7"
            fill="currentColor"
            opacity=".3"
          />
          <path d="M44 35h8m-8 9h5m-5 9h8m-8 9h5" />
        </g>
      ) : (
        <g {...shared}>
          <path d="m17 42 40-20 47 22-43 25Z" fill="var(--secondary)" />
          <path
            d="M17 42V20l40-19v21m0-21 47 22v21M17 20l44 22 43-19M61 42v27"
            fill="none"
          />
          <path
            d="m29 43 20-10 25 12-22 10Z"
            fill="currentColor"
            opacity=".2"
          />
        </g>
      )}
    </svg>
  );
}
export const time = (date: number, locale = 'zh') =>
  new Date(date).toLocaleTimeString(locale === 'zh' ? 'zh-CN' : 'en-GB', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
export const duration = (value: number) =>
  `${String(Math.floor(value / 60)).padStart(2, '0')}:${String(Math.floor(value % 60)).padStart(2, '0')}`;
