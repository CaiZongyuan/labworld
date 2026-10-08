import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { defineChart } from '@tanstack/charts';
import { Chart } from '@tanstack/charts/react';
import { lineY } from '@tanstack/charts/line';
import { dot } from '@tanstack/charts/dot';
import { tooltip } from '@tanstack/charts/tooltip';
import { scaleLinear } from '@tanstack/charts/scales/linear';
import { scaleUtc } from 'd3-scale';
import {
  getLabEntityTrend,
  type ApiClient,
  type LabEntity,
  type EntityTrend,
  type TrendSample,
  type TrendSegment,
} from '@labos-threejs/sdk';
import { Button } from '@labos-threejs/ui/components/button';
import { Alert, AlertDescription } from '@labos-threejs/ui/components/alert';
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
} from '@labos-threejs/ui/components/empty';
import { Skeleton } from '@labos-threejs/ui/components/skeleton';
import {
  ToggleGroup,
  ToggleGroupItem,
} from '@labos-threejs/ui/components/toggle-group';
import { useAppMessage } from '../shell/messages';
import { ErrorAlert } from '../shell/error-alert';
import './entity-trends.css';

type Reading = TrendSample &
  Omit<TrendSegment, 'samples'> & { received: Date; segment: number };

function rows(trend: EntityTrend): Reading[] {
  return trend.segments.flatMap(({ samples, ...segment }, index) =>
    samples.map((sample) => ({
      ...segment,
      ...sample,
      received: new Date(sample.received_at),
      segment: index,
    })),
  );
}

function TrendPlot({
  trend,
  unit,
  readings,
}: {
  trend: EntityTrend;
  unit: string;
  readings: Reading[];
}) {
  const message = useAppMessage('lab');
  const definition = useMemo(
    () =>
      defineChart({
        marks: [
          ...trend.segments.flatMap((segment, index) => {
            const values = readings.filter(
              (reading) => reading.segment === index,
            );
            if (values.length < 2) return [];
            return [
              lineY(values, {
                x: 'received',
                y: 'value',
                stroke:
                  segment.quality === 'good' && segment.source_time_known
                    ? 'var(--primary)'
                    : 'var(--muted-foreground)',
                strokeDasharray:
                  segment.quality === 'good' && segment.source_time_known
                    ? undefined
                    : '4 3',
              }),
            ];
          }),
          dot(readings, {
            x: 'received',
            y: 'value',
            r: 3,
            fill: 'var(--primary)',
            key: 'id',
          }),
        ],
        scales: {
          x: {
            scale: scaleUtc().domain([
              new Date(trend.from),
              new Date(trend.to),
            ]),
            axis: {
              label: message('trend.receivedUtc'),
              ticks: {
                count: 4,
                format: (value: Date) => value.toISOString().slice(11, 16),
              },
            },
          },
          y: {
            scale: scaleLinear,
            nice: true,
            grid: true,
            axis: { label: unit || message('trend.unknownUnit') },
          },
        },
        theme: {
          foreground: 'var(--foreground)',
          muted: 'var(--muted-foreground)',
          grid: 'var(--border)',
          background: 'var(--background)',
        },
        svgAnimation: false,
        tooltip: {
          use: tooltip,
          format: (point) => {
            const value = point.datum;
            return `${value.value} ${unit}\n${message('device.receivedAt')}: ${value.received_at}\n${message('device.observedAt')}: ${value.observed_at ?? message('device.sourceTimeUnknown')}\n${value.source}\nRun: ${value.run_id}\n${message(`device.quality.${value.quality}`)}`;
          },
        },
      }),
    [trend, unit, readings, message],
  );
  return (
    <Chart
      definition={definition}
      height={220}
      initialWidth={640}
      ariaLabel={`${message(`trend.${trend.property}`)} · ${unit || message('trend.unknownUnit')}`}
    />
  );
}

function TrendResult({ trend }: { trend: EntityTrend }) {
  const message = useAppMessage('lab');
  const readings = useMemo(() => rows(trend), [trend]);
  const units = [...new Set(readings.map((reading) => reading.unit ?? ''))];
  return (
    <>
      <p className="trend-query-time">
        {message('trend.asOf')}: <time dateTime={trend.to}>{trend.to}</time>
      </p>
      <p>
        {message('trend.sampling')}: {trend.returned_sample_count} /{' '}
        {trend.raw_sample_count} · {message('trend.resolution')}:{' '}
        {[
          ...new Set(
            trend.segments.map((segment) => `${segment.resolution_seconds} s`),
          ),
        ].join(', ')}
      </p>
      {trend.gaps.length ? (
        <Alert>
          <AlertDescription>
            {message('trend.gaps')}:{' '}
            {trend.gaps.map((gap, index) => (
              <span key={index}>
                {gap.reasons.map((reason) => (
                  <span key={reason}>{message(`trend.gap.${reason}`)} </span>
                ))}
                <time dateTime={gap.from}>{gap.from}</time> →{' '}
                <time dateTime={gap.to}>{gap.to}</time>
              </span>
            ))}
          </AlertDescription>
        </Alert>
      ) : null}
      {!readings.length ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{message('trend.empty')}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          {units.map((unit) => (
            <div className="trend-plot" key={unit}>
              <TrendPlot
                trend={trend}
                unit={unit}
                readings={readings.filter(
                  (reading) => (reading.unit ?? '') === unit,
                )}
              />
            </div>
          ))}
          <div className="trend-table-scroll">
            <table aria-label={message('trend.table')}>
              <thead>
                <tr>
                  <th>{message('device.value')}</th>
                  <th>{message('device.receivedAt')}</th>
                  <th>{message('device.observedAt')}</th>
                  <th>{message('assets.source')}</th>
                  <th>{message('device.quality')}</th>
                  <th>Run / Binding</th>
                </tr>
              </thead>
              <tbody>
                {readings.map((reading) => (
                  <tr key={`${reading.segment}-${reading.id}`}>
                    <td>
                      {reading.value} {reading.unit}
                    </td>
                    <td>
                      <time dateTime={reading.received_at}>
                        {reading.received_at}
                      </time>
                    </td>
                    <td>
                      {reading.observed_at ? (
                        <time dateTime={reading.observed_at}>
                          {reading.observed_at}
                        </time>
                      ) : (
                        message('device.sourceTimeUnknown')
                      )}
                    </td>
                    <td>{reading.source}</td>
                    <td>{message(`device.quality.${reading.quality}`)}</td>
                    <td>
                      {reading.run_id} / {reading.binding_id}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </>
  );
}

export default function EntityTrends({
  entity,
  apiClient,
  userId,
  visible,
}: {
  entity: LabEntity;
  apiClient: ApiClient;
  userId: string;
  visible: boolean;
  worldVersion: string;
  connected: boolean;
}) {
  const message = useAppMessage('lab');
  const [range, setRange] = useState('1');
  const [property, setProperty] = useState('temperature');
  const query = useQuery({
    queryKey: [
      'lab',
      'trend',
      apiClient.getConfig().baseUrl,
      userId,
      entity.lab_id,
      entity.id,
      property,
      range,
    ],
    enabled: visible,
    retry: false,
    refetchOnWindowFocus: false,
    queryFn: async ({ signal }) => {
      const to = new Date().toISOString();
      const from = new Date(
        Date.parse(to) - Number(range) * 3600000,
      ).toISOString();
      return (
        await getLabEntityTrend({
          client: apiClient,
          path: { lab_id: entity.lab_id, entity_id: entity.id },
          query: { property, from, to, max_points: 600 },
          signal,
          throwOnError: true,
        })
      ).data;
    },
  });
  return (
    <div className="entity-trends">
      <div className="lab-section-heading">
        <h3>{message(`trend.${property}`)}</h3>
        <Button
          variant="ghost"
          size="sm"
          disabled={query.isFetching}
          onClick={() => void query.refetch()}
        >
          {message('trend.refresh')}
        </Button>
      </div>
      <ToggleGroup
        multiple={false}
        value={[range]}
        onValueChange={(value) => {
          if (value[0]) setRange(value[0]);
        }}
        aria-label={message('trend.range')}
      >
        {['1', '6', '24'].map((value) => (
          <ToggleGroupItem key={value} value={value}>
            {message(`trend.range.${value}`)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {entity.definition_id === 'centrifuge' ? (
        <ToggleGroup
          multiple={false}
          value={[property]}
          onValueChange={(value) => {
            if (value[0]) setProperty(value[0]);
          }}
          aria-label={message('trend.property')}
        >
          <ToggleGroupItem value="temperature">
            {message('trend.temperature')}
          </ToggleGroupItem>
          <ToggleGroupItem value="speed">
            {message('trend.speed')}
          </ToggleGroupItem>
        </ToggleGroup>
      ) : null}
      {query.isPending ? <Skeleton className="h-56" /> : null}
      {query.error ? (
        <ErrorAlert error={query.error} title={message('trend.error')} />
      ) : null}
      {query.data ? <TrendResult trend={query.data} /> : null}
    </div>
  );
}
