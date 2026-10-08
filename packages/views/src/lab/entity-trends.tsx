import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { errorCodeOf } from '@labos-threejs/core';
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
import { sessionKey } from '../identity/session';
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
            if (!values.length) return [];
            const trusted =
              segment.quality === 'good' && segment.source_time_known;
            const points = dot(values, {
              x: 'received',
              y: 'value',
              r: trusted ? 3 : 4,
              fill: trusted ? 'var(--primary)' : 'var(--background)',
              stroke: trusted ? 'var(--primary)' : 'var(--warning)',
              strokeWidth: trusted ? 1 : 2,
              key: 'id',
            });
            if (values.length < 2) return [points];
            return [
              lineY(values, {
                x: 'received',
                y: 'value',
                stroke: trusted ? 'var(--primary)' : 'var(--muted-foreground)',
                strokeDasharray: trusted ? undefined : '4 3',
              }),
              points,
            ];
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
          <p>{message('trend.qualityKey')}</p>
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
  worldVersion,
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
  const client = useQueryClient();
  const lastStarted = useRef(0);
  const queriedVersion = useRef(worldVersion);
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
    staleTime: 5000,
    refetchOnWindowFocus: false,
    queryFn: async ({ signal }) => {
      lastStarted.current = Date.now();
      queriedVersion.current = worldVersion;
      const to = new Date().toISOString();
      const from = new Date(
        Date.parse(to) - Number(range) * 3600000,
      ).toISOString();
      try {
        return (
          await getLabEntityTrend({
            client: apiClient,
            path: { lab_id: entity.lab_id, entity_id: entity.id },
            query: { property, from, to, max_points: 600 },
            signal,
            throwOnError: true,
          })
        ).data;
      } catch (cause) {
        if (!signal.aborted && errorCodeOf(cause) === 'auth.unauthorized')
          void client.invalidateQueries({ queryKey: sessionKey(apiClient) });
        throw cause;
      }
    },
  });
  const { refetch, isPending } = query;
  useEffect(() => {
    if (!visible || isPending || queriedVersion.current === worldVersion)
      return;
    const timer = setTimeout(
      () => void refetch(),
      Math.max(0, 5000 - (Date.now() - lastStarted.current)),
    );
    return () => clearTimeout(timer);
  }, [visible, worldVersion, refetch, isPending]);
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
      {query.isPending ? (
        <div role="status" aria-label={message('trend.loadingState')}>
          <p>{message('trend.loading')}</p>
          <Skeleton className="h-56" />
        </div>
      ) : null}
      {query.error ? (
        <>
          <ErrorAlert error={query.error} title={message('trend.error')} />
          {errorCodeOf(query.error) === 'lab.trend_budget_exceeded' ? (
            <Alert>
              <AlertDescription>{message('trend.budget')}</AlertDescription>
            </Alert>
          ) : null}
          {query.data ? <p>{message('trend.retainedData')}</p> : null}
        </>
      ) : null}
      {query.data ? <TrendResult trend={query.data} /> : null}
    </div>
  );
}
