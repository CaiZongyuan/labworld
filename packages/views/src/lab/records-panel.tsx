import { useId, useState, useEffect, useRef } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ArrowDown, RefreshCw } from 'lucide-react';
import {
  listLabRecords,
  type ApiClient,
  type LabEntity,
  type LabRecordType,
  type LabRecord,
  type LabRecordsPage,
} from '@labos-threejs/sdk';
import { Badge } from '@labos-threejs/ui/components/badge';
import RecordDetails from './record-details';
import { Button } from '@labos-threejs/ui/components/button';
import {
  Field,
  FieldGroup,
  FieldLabel,
} from '@labos-threejs/ui/components/field';
import {
  NativeSelect,
  NativeSelectOption,
} from '@labos-threejs/ui/components/native-select';
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
} from '@labos-threejs/ui/components/empty';
import { Input } from '@labos-threejs/ui/components/input';
import { Alert, AlertDescription } from '@labos-threejs/ui/components/alert';
import { ErrorAlert } from '../shell/error-alert';
import { downloadRecordsPage } from './records-csv';
import { useAppMessage } from '../shell/messages';
import './records.css';

export type RecordsPanelProps = {
  apiClient: ApiClient;
  userId: string;
  labId: string;
  entities: LabEntity[];
  onOpenRecord?: (record: LabRecord) => void;
  variant?: 'full' | 'recent';
  visible?: boolean;
  connected?: boolean;
  refreshToken?: string;
  onOpenRecords?: () => void;
};
function localTime(time: number) {
  const date = new Date(time);
  return new Date(time - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}
function initialRange() {
  const end = Date.now() + 60000;
  return { from: localTime(end - 86400000), to: localTime(end) };
}
function OriginalRecord({ record }: { record: LabRecord }) {
  const message = useAppMessage('lab');
  const [open, setOpen] = useState(false);
  return (
    <details
      className="records-original"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary>{message('records.viewOriginal')}</summary>
      {open ? <RecordDetails record={record} /> : null}
    </details>
  );
}
function RecordsQuery({
  apiClient,
  userId,
  labId,
  entities,
  variant = 'full',
  visible = true,
  connected = true,
  refreshToken,
  onOpenRecords,
  onOpenRecord,
}: RecordsPanelProps) {
  const recent = variant === 'recent';
  const message = useAppMessage('lab');
  const [entity, setEntity] = useState('');
  const [kind, setKind] = useState<LabRecordType | ''>('');
  const id = useId();
  const [range, setRange] = useState(initialRange);
  const [draft, setDraft] = useState(range);
  const draftFrom = new Date(draft.from).getTime();
  const draftTo = new Date(draft.to).getTime();
  const valid =
    Number.isFinite(draftFrom) &&
    Number.isFinite(draftTo) &&
    draftTo > draftFrom &&
    draftTo - draftFrom <= 31 * 86400000;
  const from = new Date(range.from).toISOString();
  const to = new Date(range.to).toISOString();
  const [generation, setGeneration] = useState(0);
  const [retainedPage, setRetainedPage] = useState<LabRecordsPage | null>(null);
  const records = useInfiniteQuery({
    queryKey: [
      'lab',
      'records',
      variant,
      apiClient.getConfig().baseUrl,
      userId,
      labId,
      entity,
      kind,
      from,
      to,
      generation,
    ],
    enabled: !!labId && visible && connected,
    initialPageParam: undefined as string | undefined,
    maxPages: 1,
    queryFn: async ({ pageParam, signal }) =>
      (
        await listLabRecords({
          client: apiClient,
          path: { lab_id: labId },
          query: {
            from,
            to,
            entity_id: entity || undefined,
            record_type: kind || undefined,
            limit: recent ? 5 : 20,
            cursor: pageParam,
          },
          signal,
          throwOnError: true,
        })
      ).data,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    retry: false,
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const { refetch } = records;
  const loadedPage = records.data?.pages[0];
  const lastRefresh = useRef(refreshToken);
  useEffect(() => {
    if (
      !visible ||
      !connected ||
      refreshToken === undefined ||
      refreshToken === lastRefresh.current
    )
      return;
    lastRefresh.current = refreshToken;
    if (recent) {
      if (loadedPage) setRetainedPage(loadedPage);
      const next = initialRange();
      setRange(next);
      setDraft(next);
      setGeneration((value) => value + 1);
    } else void refetch();
  }, [visible, connected, refreshToken, recent, loadedPage, refetch]);
  const page = records.data?.pages[0] ?? retainedPage;
  const showingRetained = !!page && !records.data;
  const remember = () => {
    if (page) setRetainedPage(page);
  };
  const matchingFilters =
    !!page &&
    (page.entity_id ?? '') === entity &&
    (page.record_type ?? '') === kind &&
    page.from === from &&
    page.to === to;
  const gapNotice = page?.coverage.some(
    (coverage) => coverage.gaps.length > 0,
  ) ? (
    <Alert role="status" aria-label={message('records.gap')}>
      <AlertDescription>
        {page.coverage.flatMap((coverage) =>
          coverage.gaps.map((gap) => (
            <p key={`${coverage.record_type}:${gap.from}:${gap.reason}`}>
              {message(`records.${coverage.record_type}`)} · {gap.reason} ·{' '}
              <time dateTime={gap.from}>{gap.from}</time> —{' '}
              <time dateTime={gap.to}>{gap.to}</time>
            </p>
          )),
        )}
      </AlertDescription>
    </Alert>
  ) : null;
  return (
    <section
      className="lab-records"
      aria-label={message(recent ? 'records.recentTitle' : 'records.title')}
    >
      <header className="world-history-heading">
        <h2>{message(recent ? 'records.recentTitle' : 'records.title')}</h2>
        <Button
          variant="outline"
          disabled={records.isFetching || !connected}
          onClick={() => {
            remember();
            if (recent) {
              const next = initialRange();
              setRange(next);
              setDraft(next);
            }
            setGeneration((value) => value + 1);
          }}
        >
          <RefreshCw data-icon="inline-start" />
          {message(recent ? 'records.refreshRecent' : 'records.refresh')}
        </Button>
        {!recent ? (
          <Button
            variant="outline"
            disabled={
              !page?.items.length || records.isFetching || !matchingFilters
            }
            onClick={() => page && downloadRecordsPage(page, labId)}
          >
            {message('records.export')}
          </Button>
        ) : null}
      </header>
      {!recent ? <p>{message('records.exportScope')}</p> : null}
      {page ? (
        <p>
          {message('records.queryUpper')}:{' '}
          <time
            aria-label={message('records.queryUpper')}
            dateTime={page.query_upper_bound}
          >
            {page.query_upper_bound}
          </time>
        </p>
      ) : null}
      {showingRetained ? (
        <p role="status" aria-label={message('records.loadedQuery')}>
          {message('records.retainedPage')} ·{' '}
          {page.entity_id ?? message('records.allDevices')} ·{' '}
          {page.record_type
            ? message(`records.${page.record_type}`)
            : message('records.allKinds')}{' '}
          · {page.from} — {page.to}
        </p>
      ) : null}
      {!recent ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) {
              remember();
              setRange({ ...draft });
              setGeneration((value) => value + 1);
            }
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
                onChange={(event) => {
                  remember();
                  setEntity(event.target.value);
                  setGeneration((value) => value + 1);
                }}
              >
                <NativeSelectOption value="">
                  {message('records.allDevices')}
                </NativeSelectOption>
                {entities.map((item) => (
                  <NativeSelectOption key={item.id} value={item.id}>
                    {item.name}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor={`${id}-kind`}>
                {message('records.category')}
              </FieldLabel>
              <NativeSelect
                id={`${id}-kind`}
                value={kind}
                onChange={(event) => {
                  remember();
                  setKind(event.target.value as LabRecordType | '');
                  setGeneration((value) => value + 1);
                }}
              >
                <NativeSelectOption value="">
                  {message('records.allKinds')}
                </NativeSelectOption>
                {(['command', 'task', 'event', 'run'] as const).map((type) => (
                  <NativeSelectOption key={type} value={type}>
                    {message(`records.${type}`)}
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
              disabled={!valid || records.isFetching || !connected}
            >
              {message('records.query')}
            </Button>
          </FieldGroup>
        </form>
      ) : null}
      {!valid ? (
        <Alert>
          <AlertDescription>{message('history.invalidRange')}</AlertDescription>
        </Alert>
      ) : null}
      {records.isPending ? (
        <p role="status">{message('viewer.loading')}</p>
      ) : null}
      {records.isError ? (
        <>
          <ErrorAlert error={records.error} title={message('records.error')} />
          <Button
            variant="outline"
            onClick={() =>
              void (records.isFetchNextPageError
                ? records.fetchNextPage()
                : records.refetch())
            }
          >
            {message('records.retry')}
          </Button>
        </>
      ) : null}
      {page && !page.items.length ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{message('records.empty')}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : null}
      {recent && gapNotice ? (
        <details>
          <summary>{message('records.gap')}</summary>
          {gapNotice}
        </details>
      ) : (
        gapNotice
      )}
      <ol>
        {page?.items.slice(0, 100).map((record) => (
          <li key={`${record.record_type}:${record.id}`}>
            <div className="record-entry-heading">
              <strong>{record.summary}</strong>
              <Badge variant="outline">
                {message(`records.${record.record_type}`)} · {record.state}
              </Badge>
            </div>
            <div className="record-entry-entity">
              <span>{record.entity_name}</span>
              <Badge variant="outline">
                {message(`world.${record.reality}`)}
              </Badge>
              {record.archived_at ? (
                <Badge variant="outline">{message('records.archived')}</Badge>
              ) : null}
            </div>
            <time dateTime={record.recorded_at}>{record.recorded_at}</time>
            <div className="record-entry-provenance">
              <span>
                {record.source && record.source !== 'unknown'
                  ? record.source
                  : message('records.unknown')}
              </span>
              <span>
                {message('records.actor')}:{' '}
                {record.actor_id ?? message('records.unknown')}
              </span>
            </div>
            {onOpenRecord ? (
              <Button variant="outline" onClick={() => onOpenRecord(record)}>
                {message('records.openEntity', { name: record.entity_name })}
              </Button>
            ) : null}
            <OriginalRecord record={record} />
          </li>
        ))}
      </ol>
      {!recent && records.hasNextPage ? (
        <Button
          variant="outline"
          disabled={records.isFetching || !connected}
          onClick={() => void records.fetchNextPage()}
        >
          <ArrowDown data-icon="inline-start" />
          {message('records.more')}
        </Button>
      ) : null}
      {recent && onOpenRecords ? (
        <Button variant="link" onClick={onOpenRecords}>
          {message('records.openAll')}
        </Button>
      ) : null}
    </section>
  );
}
export default function RecordsPanel(props: RecordsPanelProps) {
  return (
    <RecordsQuery
      key={JSON.stringify([
        props.apiClient.getConfig().baseUrl,
        props.userId,
        props.labId,
        props.variant ?? 'full',
      ])}
      {...props}
    />
  );
}
