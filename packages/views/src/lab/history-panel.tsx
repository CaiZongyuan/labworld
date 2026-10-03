import { useId, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ArrowDown, RefreshCw, Search } from 'lucide-react';
import {
  listLabDeviceHistory,
  type ApiClient,
  type LabEntity,
  type HistoryRecordType,
  type HistoryRecord,
} from '@labos-threejs/sdk';
import { Button } from '@labos-threejs/ui/components/button';
import { Badge } from '@labos-threejs/ui/components/badge';
import { Input } from '@labos-threejs/ui/components/input';
import {
  Field,
  FieldGroup,
  FieldLabel,
} from '@labos-threejs/ui/components/field';
import { Tabs, TabsList, TabsTrigger } from '@labos-threejs/ui/components/tabs';
import {
  NativeSelect,
  NativeSelectOption,
} from '@labos-threejs/ui/components/native-select';
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
} from '@labos-threejs/ui/components/empty';
import { Alert, AlertDescription } from '@labos-threejs/ui/components/alert';
import { useAppMessage } from '../shell/messages';
import { usePreferences } from '../shell/preferences';
import { ErrorAlert } from '../shell/error-alert';

function localTime(time: number) {
  const date = new Date(time);
  return new Date(time - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}
function initialRange() {
  const to = Date.now() + 60000;
  return { from: localTime(to - 86400000), to: localTime(to) };
}
function valueText(value: unknown): string {
  return typeof value === 'object' ? JSON.stringify(value) : String(value);
}
function RecordRow({
  record,
  kind,
}: {
  record: HistoryRecord;
  kind: HistoryRecordType;
}) {
  const msg = useAppMessage();
  const message = (key: string) => msg(`lab.${key}`);
  const { locale } = usePreferences();
  const data = record.data as Record<string, unknown>;
  const status = typeof data.status === 'string' ? data.status : null;
  const values = (data.values ?? data.parameters ?? {}) as Record<
    string,
    unknown
  >;
  const properties = (data.properties ?? {}) as Record<
    string,
    {
      unit?: string;
      observed_at?: string | null;
      received_at?: string;
      quality?: string;
      source?: string;
    }
  >;
  const time = (value: string | null | undefined) =>
    value ? new Date(value).toLocaleString(locale) : message('world.unknown');
  return (
    <li className="world-history-record">
      <div className="world-history-record-heading">
        <time dateTime={record.recorded_at}>{time(record.recorded_at)}</time>
        {status ? (
          <Badge variant="outline">
            {message(
              `${kind === 'command' || data.record_type === 'command' ? 'device.command' : data.record_type === 'program' ? 'device' : 'task'}.${status}`,
            )}
          </Badge>
        ) : null}
        {typeof data.capability === 'string' ? (
          <code>{data.capability}</code>
        ) : null}
      </div>
      <dl className="world-history-values">
        {Object.entries(values).map(([name, value]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd>
              {valueText(value)}{' '}
              {properties[name]?.unit ??
                (name === 'rpm'
                  ? 'rpm'
                  : name === 'temperature'
                    ? 'degC'
                    : name === 'duration_seconds'
                      ? 's'
                      : '')}
            </dd>
          </div>
        ))}
      </dl>
      <details>
        <summary>{message('history.details')}</summary>
        <dl className="world-properties">
          <dt>ID</dt>
          <dd>{record.id}</dd>
          <dt>Run</dt>
          <dd>{record.run_id}</dd>
          <dt>{message('history.sourceTime')}</dt>
          <dd>{time(record.observed_at)}</dd>
          <dt>{message('history.receivedTime')}</dt>
          <dd>{time(record.received_at)}</dd>
          {Object.entries(data)
            .filter(
              ([key]) =>
                ![
                  'id',
                  'entity_id',
                  'run_id',
                  'created_at',
                  'values',
                  'properties',
                  'parameters',
                ].includes(key),
            )
            .map(([key, value]) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{valueText(value)}</dd>
              </div>
            ))}
          {Object.entries(properties).map(([key, property]) => (
            <div key={key}>
              <dt>{key}</dt>
              <dd>
                {property.source} / {property.quality} /{' '}
                {time(property.observed_at)} / {time(property.received_at)}
              </dd>
            </div>
          ))}
        </dl>
      </details>
    </li>
  );
}

export default function HistoryPanel({
  labId,
  entities,
  selectedId,
  apiClient,
}: {
  labId: string;
  entities: LabEntity[];
  selectedId?: string;
  apiClient: ApiClient;
}) {
  const msg = useAppMessage();
  const message = (key: string, values?: Record<string, string | number>) =>
    msg(`lab.${key}`, values);
  const { locale } = usePreferences();
  const id = useId();
  const [entity, setEntity] = useState(selectedId ?? entities[0]?.id ?? '');
  const [kind, setKind] = useState<HistoryRecordType>('event');
  const [draft, setDraft] = useState(initialRange);
  const [range, setRange] = useState(draft);
  const from = new Date(draft.from).getTime(),
    to = new Date(draft.to).getTime();
  const valid =
    Number.isFinite(from) &&
    Number.isFinite(to) &&
    to > from &&
    to - from <= 31 * 86400000;
  const history = useInfiniteQuery({
    queryKey: ['lab', labId, 'history', entity, kind, range],
    enabled: !!entity,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      const response = await listLabDeviceHistory({
        client: apiClient,
        path: { lab_id: labId, entity_id: entity },
        query: {
          record_type: kind,
          from: new Date(range.from).toISOString(),
          to: new Date(range.to).toISOString(),
          limit: 20,
          cursor: pageParam,
        },
        signal,
        throwOnError: true,
      });
      return response.data;
    },
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    retry: false,
  });
  const first = history.data?.pages[0];
  const items = history.data?.pages.flatMap((page) => page.items) ?? [];
  return (
    <section className="world-history" aria-label={message('history.title')}>
      <header className="world-history-heading">
        <h2>{message('history.title')}</h2>
        {first ? (
          <small>
            {message('history.retention', {
              observations:
                first.retention.observation_seconds % 3600 === 0
                  ? `${first.retention.observation_seconds / 3600}\u00a0h`
                  : `${first.retention.observation_seconds}\u00a0s`,
              records:
                first.retention.record_seconds % 86400 === 0
                  ? `${first.retention.record_seconds / 86400}\u00a0d`
                  : `${first.retention.record_seconds}\u00a0s`,
            })}
          </small>
        ) : null}
        <Button
          variant="ghost"
          size="icon"
          title={message('history.refresh')}
          aria-label={message('history.refresh')}
          disabled={!entity || history.isFetching}
          onClick={() => void history.refetch()}
        >
          <RefreshCw />
        </Button>
      </header>
      <Tabs
        value={kind}
        onValueChange={(value) => setKind(value as HistoryRecordType)}
      >
        <TabsList>
          {(['event', 'task', 'command', 'observation'] as const).map(
            (type) => (
              <TabsTrigger key={type} value={type}>
                {message(`history.${type}`)}
              </TabsTrigger>
            ),
          )}
        </TabsList>
      </Tabs>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (valid) setRange({ ...draft });
        }}
      >
        <FieldGroup className="world-history-filters">
          <Field>
            <FieldLabel htmlFor={`${id}-entity`}>
              {message('history.device')}
            </FieldLabel>
            <NativeSelect
              id={`${id}-entity`}
              value={entity}
              onChange={(event) => setEntity(event.target.value)}
            >
              <NativeSelectOption value="">
                {message('viewer.unselected')}
              </NativeSelectOption>
              {entities.map((item) => (
                <NativeSelectOption key={item.id} value={item.id}>
                  {item.name}
                </NativeSelectOption>
              ))}
            </NativeSelect>
          </Field>
          <Field data-invalid={!valid}>
            <FieldLabel htmlFor={`${id}-from`}>
              {message('history.from')}
            </FieldLabel>
            <Input
              id={`${id}-from`}
              type="datetime-local"
              value={draft.from}
              onChange={(event) =>
                setDraft({ ...draft, from: event.target.value })
              }
              aria-invalid={!valid}
            />
          </Field>
          <Field data-invalid={!valid}>
            <FieldLabel htmlFor={`${id}-to`}>
              {message('history.to')}
            </FieldLabel>
            <Input
              id={`${id}-to`}
              type="datetime-local"
              value={draft.to}
              onChange={(event) =>
                setDraft({ ...draft, to: event.target.value })
              }
              aria-invalid={!valid}
            />
          </Field>
          <Button
            type="submit"
            variant="outline"
            disabled={!entity || !valid || history.isFetching}
          >
            <Search data-icon="inline-start" />
            {message('history.query')}
          </Button>
        </FieldGroup>
      </form>
      {!valid ? (
        <Alert>
          <AlertDescription>{message('history.invalidRange')}</AlertDescription>
        </Alert>
      ) : null}
      {first?.gap ? (
        <Alert role="status" aria-label={message('history.gap')}>
          <AlertDescription>
            {message('history.gapSince', {
              time: new Date(first.available_since).toLocaleString(locale),
            })}
          </AlertDescription>
        </Alert>
      ) : null}
      {history.isError ? (
        <>
          <ErrorAlert
            error={history.error}
            title={message('history.error')}
            genericKey="lab.assets.unavailable"
          />
          <Button
            variant="outline"
            disabled={history.isFetching}
            onClick={() =>
              void (history.isFetchNextPageError
                ? history.fetchNextPage()
                : history.refetch())
            }
          >
            <RefreshCw data-icon="inline-start" />
            {message('history.retry')}
          </Button>
        </>
      ) : null}
      {history.isPending && entity ? (
        <p role="status">{message('viewer.loading')}</p>
      ) : null}
      {!history.isPending && !history.isError && !items.length ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{message('history.empty')}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : null}
      {!entity ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{message('viewer.unselected')}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : null}
      <ol className="world-history-records">
        {items.map((record) => (
          <RecordRow key={record.id} record={record} kind={kind} />
        ))}
      </ol>
      {history.hasNextPage ? (
        <Button
          variant="outline"
          disabled={history.isFetching}
          onClick={() => void history.fetchNextPage()}
        >
          <ArrowDown data-icon="inline-start" />
          {message('history.more')}
        </Button>
      ) : null}
    </section>
  );
}
