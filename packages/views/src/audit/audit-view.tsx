import { useState } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import {
  listAuditEvents,
  type ApiClient,
  type CurrentSession,
  type AuditEvent,
  type ListAuditEventsData,
} from '@labos-threejs/sdk';
import { Button } from '@labos-threejs/ui/components/button';
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@labos-threejs/ui/components/empty';
import { ScrollTextIcon } from 'lucide-react';
import {
  Field,
  FieldGroup,
  FieldLabel,
} from '@labos-threejs/ui/components/field';
import { Input } from '@labos-threejs/ui/components/input';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@labos-threejs/ui/components/card';
import { AdminFrame } from '../shell/admin-frame';
import { ErrorAlert } from '../shell/error-alert';
import { useAppFormat } from '../shell/format';
import { useAppMessage } from '../shell/messages';

// The administrator audit trail inside the universal shell (docs/ui/
// design.md §4). Filter conditions travel through the router's search
// params, so switching the language or theme, a browser back or a
// bookmark keeps the legitimate query; the draft follows the applied
// URL state. Actions, resource and request identifiers are raw protocol
// values; every fixed label, the system fallback and accessibility
// names speak the active language.

export type AuditFilters = Omit<
  NonNullable<ListAuditEventsData['query']>,
  'cursor' | 'limit'
>;
export const auditFilterFields = [
  'action',
  'resource_id',
  'resource_type',
  'actor_id',
  'request_id',
  'correlation_id',
  'job_id',
] as const satisfies readonly (keyof AuditFilters)[];
function Failure({ error }: { error: unknown }) {
  const message = useAppMessage();
  return (
    <ErrorAlert
      error={error}
      title={message('audit.error.title')}
      genericKey="audit.error.generic"
      codes={{
        'audit.forbidden': message('audit.error.forbidden'),
        'audit.invalid_page': message('audit.error.invalidPage'),
        'auth.unauthorized': message('common.sessionExpired'),
      }}
    />
  );
}
export function AuditView({
  apiClient,
  filters,
  onApplyFilters,
}: {
  apiClient: ApiClient;
  /** Applied filter conditions, owned by the router's search params. */
  filters: AuditFilters;
  onApplyFilters: (filters: AuditFilters) => void;
}) {
  return (
    <AdminFrame
      apiClient={apiClient}
      titleKey="audit.title"
      adminOnlyKey="audit.adminOnly"
    >
      {(identity) => (
        // Remounting on every applied filter change makes the draft follow
        // the URL state after a back navigation or a language switch.
        <History
          key={`${identity.user.id}:${JSON.stringify(filters)}`}
          apiClient={apiClient}
          identity={identity}
          filters={filters}
          onApplyFilters={onApplyFilters}
        />
      )}
    </AdminFrame>
  );
}
function History({
  apiClient,
  identity,
  filters,
  onApplyFilters,
}: {
  apiClient: ApiClient;
  identity: CurrentSession;
  filters: AuditFilters;
  onApplyFilters: (filters: AuditFilters) => void;
}) {
  const message = useAppMessage();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<AuditFilters>(filters);
  const historyKey = ['audit', apiClient.getConfig().baseUrl, identity.user.id];
  const queryKey = [...historyKey, filters];
  const query = useInfiniteQuery({
    queryKey,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ signal, pageParam }) =>
      (
        await listAuditEvents({
          client: apiClient,
          query: { ...filters, cursor: pageParam, limit: 20 },
          signal,
          throwOnError: true,
        })
      ).data,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    maxPages: 5,
    retry: false,
  });
  const items = query.data?.pages.flatMap((page) => page.data) ?? [];
  function applyFilters() {
    const next: AuditFilters = {};
    for (const key of auditFilterFields) {
      const value = draft[key]?.trim();
      if (value) next[key] = value;
    }
    // Start at recent records even if the same filter has older cached pages.
    void queryClient.resetQueries({
      queryKey: [...historyKey, next],
      exact: true,
    });
    onApplyFilters(next);
  }
  return (
    <>
      <form
        className="flex flex-col gap-4"
        onSubmit={(event) => {
          event.preventDefault();
          applyFilters();
        }}
      >
        <FieldGroup className="grid gap-4 sm:grid-cols-2">
          {auditFilterFields.map((key) => (
            <Field key={key}>
              <FieldLabel htmlFor={`audit-${key}`}>
                {message(`audit.field.${key}`)}
              </FieldLabel>
              <Input
                id={`audit-${key}`}
                value={draft[key] ?? ''}
                maxLength={200}
                onChange={(event) =>
                  setDraft((previous) => ({
                    ...previous,
                    [key]: event.target.value,
                  }))
                }
              />
            </Field>
          ))}
        </FieldGroup>
        <div className="flex gap-3">
          <Button type="submit">{message('audit.filter')}</Button>
          <Button
            type="button"
            variant="outline"
            disabled={query.isFetching}
            onClick={() => {
              void queryClient.resetQueries({ queryKey, exact: true });
            }}
          >
            {message('audit.refresh')}
          </Button>
        </div>
      </form>
      {query.isPending ? (
        <p role="status">{message('audit.loading')}</p>
      ) : query.isError ? (
        <Failure error={query.error} />
      ) : items.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <ScrollTextIcon aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>{message('audit.empty')}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : null}
      {!query.isError ? (
        <ol className="flex flex-col gap-4">
          {items.map((event) => (
            <li key={event.id}>
              <Entry event={event} />
            </li>
          ))}
        </ol>
      ) : null}
      {query.hasNextPage ? (
        <Button
          variant="outline"
          disabled={query.isFetching}
          onClick={() => {
            void query.fetchNextPage();
          }}
        >
          {query.isFetchingNextPage
            ? message('common.loadingMore')
            : message('audit.loadMore')}
        </Button>
      ) : null}
    </>
  );
}
function Entry({ event }: { event: AuditEvent }) {
  const message = useAppMessage();
  const { formatDateTime } = useAppFormat();
  const context = [
    ['audit.entry.actor', event.actor_id ?? message('audit.entry.system')],
    ['audit.field.resource_type', event.resource_type],
    ['audit.entry.resource', event.resource_id],
    ['audit.field.request_id', event.request_id],
    ['audit.field.correlation_id', event.correlation_id],
    ['audit.field.job_id', event.job_id],
    ['audit.entry.trace', event.trace_id],
    ['audit.entry.subject', event.metadata.subject_user_id],
  ] as const;
  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>{event.action}</h2>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        <time
          dateTime={event.created_at}
          className="text-sm text-muted-foreground"
        >
          {formatDateTime(event.created_at)}
        </time>
        <dl className="grid gap-3 text-sm sm:grid-cols-2">
          {context
            .filter(([, value]) => !!value)
            .map(([labelKey, value]) => (
              <div key={labelKey}>
                <dt className="text-muted-foreground">{message(labelKey)}</dt>
                <dd className="break-all">{value}</dd>
              </div>
            ))}
        </dl>
      </CardContent>
    </Card>
  );
}
