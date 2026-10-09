import { useRef } from 'react';
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query';
import {
  getJob,
  listJobs,
  retryJob,
  type ApiClient,
  type CurrentSession,
  type JobInfo,
  type ListJobsData,
} from '@labos-threejs/sdk';
import { errorCodeOf } from '@labos-threejs/core';
import { Badge } from '@labos-threejs/ui/components/badge';
import { Button } from '@labos-threejs/ui/components/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@labos-threejs/ui/components/card';
import { Field, FieldLabel } from '@labos-threejs/ui/components/field';
import {
  NativeSelect,
  NativeSelectOption,
} from '@labos-threejs/ui/components/native-select';
import { sessionKey } from '../identity';
import { AdminFrame } from '../shell/admin-frame';
import { ErrorAlert } from '../shell/error-alert';
import { useAppFormat } from '../shell/format';
import { useAppMessage } from '../shell/messages';

// Background-job tracking inside the universal shell (docs/ui/design.md
// §4): the administration group reaches list and detail, and every fixed
// string speaks the active language. Job states stay server facts — the
// view never invents a second source for can_retry, batch numbers or
// authorization; job kinds, identifiers and error summaries render as
// the raw protocol values. The status filter travels through the router
// (URL), so switching the language or theme cannot clear it.

export type JobStatusFilter = NonNullable<
  NonNullable<ListJobsData['query']>['status']
>;
/** Select value `all` means no status condition; the router owns it. */
export type JobsListStatus = JobStatusFilter | 'all';
const statusKeys = {
  queued: 'jobs.status.queued',
  running: 'jobs.status.running',
  retry_wait: 'jobs.status.retry_wait',
  succeeded: 'jobs.status.succeeded',
  failed: 'jobs.status.failed',
  lease_expired: 'jobs.status.lease_expired',
} as const satisfies Record<string, `jobs.status.${string}`>;
type KnownJobStatus = keyof typeof statusKeys;
export const filterableStatuses: JobStatusFilter[] = [
  'failed',
  'queued',
  'running',
  'retry_wait',
  'succeeded',
];
const active = new Set(['queued', 'running', 'retry_wait']);
function statusText(status: string, translate: (key: string) => string) {
  const key = statusKeys[status as KnownJobStatus];
  return key ? translate(key) : status;
}
function Failure({ error }: { error: unknown }) {
  const message = useAppMessage();
  return (
    <ErrorAlert
      error={error}
      title={message('jobs.error.title')}
      genericKey="jobs.error.generic"
      codes={{
        'jobs.forbidden': message('jobs.adminOnly'),
        'jobs.not_failed': message('jobs.error.notFailed'),
        'jobs.not_found': message('jobs.error.notFound'),
        'auth.unauthorized': message('common.sessionExpired'),
      }}
    />
  );
}
export function JobsView({
  apiClient,
  onOpenJob,
  status,
  onStatusChange,
}: {
  apiClient: ApiClient;
  onOpenJob: (id: string) => void;
  /** Active status filter, owned by the router's search params. */
  status: JobsListStatus;
  onStatusChange: (status: JobsListStatus) => void;
}) {
  return (
    <AdminFrame
      apiClient={apiClient}
      titleKey="jobs.title"
      adminOnlyKey="jobs.adminOnly"
    >
      {(identity) => (
        <JobList
          key={identity.user.id}
          apiClient={apiClient}
          identity={identity}
          onOpenJob={onOpenJob}
          status={status}
          onStatusChange={onStatusChange}
        />
      )}
    </AdminFrame>
  );
}
function JobList({
  apiClient,
  identity,
  onOpenJob,
  status,
  onStatusChange,
}: {
  apiClient: ApiClient;
  identity: CurrentSession;
  onOpenJob: (id: string) => void;
  status: JobsListStatus;
  onStatusChange: (status: JobsListStatus) => void;
}) {
  const message = useAppMessage();
  const queryClient = useQueryClient();
  const queryKey = ['jobs', 'list', identity.user.id, status];
  const jobs = useInfiniteQuery({
    queryKey,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) =>
      (
        await listJobs({
          client: apiClient,
          query: {
            status: status === 'all' ? undefined : status,
            limit: 20,
            cursor: pageParam,
          },
          signal,
          throwOnError: true,
        })
      ).data,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    maxPages: 5,
    retry: false,
    refetchInterval: (query) =>
      !query.state.error &&
      query.state.data?.pages.some((page) =>
        page.data.some((job) => active.has(job.status)),
      )
        ? 2000
        : false,
  });
  return (
    <>
      <p>{message('jobs.hint')}</p>
      <Field>
        <FieldLabel htmlFor="job-status">
          {message('jobs.form.status')}
        </FieldLabel>
        <NativeSelect
          id="job-status"
          value={status}
          onChange={(event) =>
            onStatusChange(event.target.value as JobsListStatus)
          }
        >
          <NativeSelectOption value="all">
            {message('jobs.form.allStatuses')}
          </NativeSelectOption>
          {filterableStatuses.map((value) => (
            <NativeSelectOption key={value} value={value}>
              {message(statusKeys[value])}
            </NativeSelectOption>
          ))}
        </NativeSelect>
      </Field>
      <Button
        variant="outline"
        disabled={jobs.isFetching}
        onClick={() => {
          void queryClient.resetQueries({ queryKey, exact: true });
        }}
      >
        {message('jobs.reload')}
      </Button>
      {jobs.isPending ? <p role="status">{message('jobs.loading')}</p> : null}
      {jobs.isError ? <Failure error={jobs.error} /> : null}
      {!jobs.isPending &&
      !jobs.isError &&
      jobs.data.pages.every((page) => page.data.length === 0) ? (
        <p>{message('jobs.empty')}</p>
      ) : null}
      {!jobs.isError
        ? jobs.data?.pages.flatMap((page) =>
            page.data.map((job) => (
              <Card key={job.id}>
                <CardHeader>
                  <CardTitle>{job.kind}</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <Badge
                    variant={
                      job.status === 'failed' ? 'destructive' : 'secondary'
                    }
                  >
                    {statusText(job.status, message)}
                  </Badge>
                  <p className="break-all text-sm">
                    {message('jobs.item.id', { id: job.id })}
                  </p>
                  <p>
                    {message('jobs.item.batch', {
                      batch: job.batch,
                      attempts: job.attempts,
                      max: job.max_attempts,
                    })}
                  </p>
                  {job.last_error ? (
                    <p className="break-all text-sm">
                      {message('jobs.item.lastError', {
                        error: job.last_error,
                      })}
                    </p>
                  ) : null}
                  <Button
                    variant="outline"
                    aria-label={message('jobs.item.openName', { id: job.id })}
                    onClick={() => onOpenJob(job.id)}
                  >
                    {message('jobs.item.open')}
                  </Button>
                </CardContent>
              </Card>
            )),
          )
        : null}
      {jobs.hasNextPage ? (
        <Button
          variant="outline"
          disabled={jobs.isFetching}
          onClick={() => {
            void jobs.fetchNextPage();
          }}
        >
          {jobs.isFetchingNextPage
            ? message('common.loadingMore')
            : message('jobs.loadMore')}
        </Button>
      ) : null}
    </>
  );
}
export function JobView({
  apiClient,
  onOpen,
  jobId,
}: {
  apiClient: ApiClient;
  /** Router port for opening paths without a full page load. */
  onOpen?: (path: string) => void;
  jobId: string;
}) {
  const message = useAppMessage();
  return (
    <AdminFrame
      apiClient={apiClient}
      titleKey="jobs.detail.title"
      adminOnlyKey="jobs.adminOnly"
    >
      {(identity) => (
        <>
          <Button
            variant="link"
            className="self-start px-0"
            onClick={() => onOpen?.('/jobs')}
          >
            {message('jobs.back')}
          </Button>
          <JobRecord
            key={`${identity.user.id}:${jobId}`}
            apiClient={apiClient}
            identity={identity}
            jobId={jobId}
          />
        </>
      )}
    </AdminFrame>
  );
}
function JobRecord({
  apiClient,
  identity,
  jobId,
}: {
  apiClient: ApiClient;
  identity: CurrentSession;
  jobId: string;
}) {
  const message = useAppMessage();
  const { formatDateTime } = useAppFormat();
  const queryClient = useQueryClient();
  const queryKey = ['jobs', 'detail', identity.user.id, jobId];
  const requestKey = useRef(crypto.randomUUID());
  const details = useInfiniteQuery({
    queryKey,
    initialPageParam: undefined as number | undefined,
    queryFn: async ({ pageParam, signal }) =>
      (
        await getJob({
          client: apiClient,
          path: { id: jobId },
          query: { before_batch: pageParam },
          signal,
          throwOnError: true,
        })
      ).data,
    getNextPageParam: (page) => page.next_before_batch ?? undefined,
    maxPages: 5,
    retry: false,
    refetchInterval: (query) =>
      !query.state.error &&
      active.has(query.state.data?.pages[0]?.job.status ?? '')
        ? 2000
        : false,
  });
  const retry = useMutation({
    mutationFn: async () =>
      (
        await retryJob({
          client: apiClient,
          path: { id: jobId },
          headers: {
            'x-csrf-token': identity.csrf_token,
            'idempotency-key': requestKey.current,
          },
          signal: AbortSignal.timeout(10_000),
          throwOnError: true,
        })
      ).data,
    retry: false,
    onSuccess: async () => {
      requestKey.current = crypto.randomUUID();
      await queryClient.resetQueries({ queryKey, exact: true });
      void queryClient.invalidateQueries({
        queryKey: ['jobs', 'list', identity.user.id],
      });
    },
    onError: (error) => {
      if (
        [
          'jobs.forbidden',
          'jobs.not_found',
          'jobs.not_failed',
          'auth.unauthorized',
        ].includes(errorCodeOf(error) ?? '')
      ) {
        void queryClient.invalidateQueries({ queryKey: ['jobs'] });
        void queryClient.invalidateQueries({ queryKey: sessionKey(apiClient) });
      }
    },
  });
  const job = details.data?.pages[0]?.job;
  return (
    <>
      <Button
        variant="outline"
        disabled={details.isFetching}
        onClick={() => {
          void queryClient.resetQueries({ queryKey, exact: true });
        }}
      >
        {message('jobs.detail.reload')}
      </Button>
      {details.isPending ? (
        <p role="status">{message('jobs.detail.loading')}</p>
      ) : null}
      {details.isError ? <Failure error={details.error} /> : null}
      {retry.isError ? <Failure error={retry.error} /> : null}
      {job && !details.isError ? (
        <>
          <JobSummary job={job} />
          {job.can_retry ? (
            <section className="flex flex-col gap-3">
              <p>
                {message('jobs.detail.retryHint', { max: job.max_attempts })}
              </p>
              <Button
                disabled={retry.isPending || details.isFetching}
                onClick={() => retry.mutate()}
              >
                {retry.isPending
                  ? message('jobs.detail.submitting')
                  : message('jobs.detail.retry')}
              </Button>
            </section>
          ) : null}
          <h2 className="text-xl font-semibold">
            {message('jobs.detail.history')}
          </h2>
          {details.data?.pages.flatMap((page) =>
            page.batches.map((batch) => (
              <Card key={batch.number}>
                <CardHeader>
                  <CardTitle>
                    {message('jobs.detail.batchTitle', {
                      number: batch.number,
                    })}
                  </CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-3">
                  <p>
                    {message('jobs.detail.batchLine', {
                      status: statusText(batch.status, message),
                      attempts: batch.attempts,
                      max: batch.max_attempts,
                    })}
                  </p>
                  {batch.legacy_attempts > 0 ? (
                    <p>
                      {message('jobs.detail.legacy', {
                        count: batch.legacy_attempts,
                      })}
                    </p>
                  ) : null}
                  <ul className="flex flex-col gap-2">
                    {page.attempts
                      .filter((attempt) => attempt.batch === batch.number)
                      .map((attempt) => (
                        <li
                          key={attempt.number}
                          className="rounded-lg border p-3"
                        >
                          <p>
                            {message('jobs.detail.attempt', {
                              number: attempt.number,
                              status: statusText(attempt.status, message),
                            })}
                          </p>
                          <p className="text-sm">
                            {formatDateTime(attempt.started_at)}
                          </p>
                          {attempt.last_error ? (
                            <p className="break-all text-sm">
                              {attempt.last_error}
                            </p>
                          ) : null}
                        </li>
                      ))}
                  </ul>
                </CardContent>
              </Card>
            )),
          )}
        </>
      ) : null}
      {details.hasNextPage ? (
        <Button
          variant="outline"
          disabled={details.isFetching}
          onClick={() => {
            void details.fetchNextPage();
          }}
        >
          {message('jobs.detail.earlier')}
        </Button>
      ) : null}
    </>
  );
}
function JobSummary({ job }: { job: JobInfo }) {
  const message = useAppMessage();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{job.kind}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Badge variant={job.status === 'failed' ? 'destructive' : 'secondary'}>
          {statusText(job.status, message)}
        </Badge>
        <p className="break-all text-sm">
          {message('jobs.item.id', { id: job.id })}
        </p>
        <p>
          {message('jobs.summary.batch', {
            batch: job.batch,
            attempts: job.attempts,
            max: job.max_attempts,
          })}
        </p>
        <p className="break-all text-sm">
          {message('jobs.summary.correlation', { id: job.correlation_id })}
        </p>
        {job.last_error ? (
          <p className="break-all text-sm">
            {message('jobs.summary.lastError', { error: job.last_error })}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
