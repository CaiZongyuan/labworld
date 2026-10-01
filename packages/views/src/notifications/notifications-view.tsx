import { RateLimitHint } from '../system/rate-limit';
import { useState } from 'react';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  listNotifications,
  readNotification,
  type ApiClient,
  type CurrentSession,
  type Notification,
  type NotificationTarget,
} from '@labos-threejs/sdk';
import { requestIdFromError } from '@labos-threejs/core';
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@labos-threejs/ui/components/alert';
import { Badge } from '@labos-threejs/ui/components/badge';
import { Button } from '@labos-threejs/ui/components/button';
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@labos-threejs/ui/components/empty';
import { BellOffIcon } from 'lucide-react';
import type { NotificationDisplay } from '../shell/app-contract';
import { sessionKey, sessionQuery } from '../identity';
import { useAppMessage, type MessageParams } from '../shell/messages';
import { useAppFormat } from '../shell/format';

function Failure({ error }: { error: unknown }) {
  const message = useAppMessage();
  const id = requestIdFromError(error);
  return (
    <Alert variant="destructive">
      <AlertTitle>{message('notifications.errorTitle')}</AlertTitle>
      <AlertDescription>
        {message('notifications.errorHint')}
        <RateLimitHint error={error} />
        {id ? <p>{message('common.requestId', { id })}</p> : null}
      </AlertDescription>
    </Alert>
  );
}
export type NotificationTargetResolver = (
  target: NotificationTarget,
) => (() => void) | undefined;

// One heading for every notice: a display registered by the notice's
// business wins; anything else keeps the original server subject with
// only the outcome word translated (docs/ui/design.md §6 Q1) — the
// subject travels as a param so each locale owns its own layout.
export function notificationHeading(
  notice: Pick<Notification, 'subject' | 'outcome'>,
  display: NotificationDisplay | undefined,
  text: (key: string, params?: MessageParams) => string,
): string {
  if (display) return text(display.titleKey);
  return text(
    notice.outcome === 'succeeded'
      ? 'notifications.outcomeSucceeded'
      : 'notifications.outcomeFailed',
    { subject: notice.subject },
  );
}

export function NotificationsView({
  apiClient,
  onBack,
  resolveTarget,
  describeNotification,
}: {
  apiClient: ApiClient;
  onBack: () => void;
  resolveTarget?: NotificationTargetResolver;
  describeNotification?: (
    notice: Notification,
  ) => NotificationDisplay | undefined;
}) {
  const queryClient = useQueryClient();
  const session = useQuery(sessionQuery(apiClient, queryClient));
  const message = useAppMessage();
  return (
    // Content-only (docs/ui/design.md §4.2): the shell's main landmark
    // wraps this page on the router's layout route, so a plain div here.
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-6 py-10">
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-2xl font-semibold">
          {message('notifications.title')}
        </h1>
        <Button variant="link" onClick={onBack}>
          {message('common.backHome')}
        </Button>
      </header>
      {session.isPending ? (
        <p role="status">{message('common.loadingSession')}</p>
      ) : session.isError ? (
        <Failure error={session.error} />
      ) : !session.data ? (
        <p>{message('notifications.signInFirst')}</p>
      ) : (
        <Inbox
          key={session.data.user.id}
          apiClient={apiClient}
          identity={session.data}
          resolveTarget={resolveTarget}
          describeNotification={describeNotification}
        />
      )}
    </div>
  );
}
function Inbox({
  apiClient,
  identity,
  resolveTarget,
  describeNotification,
}: {
  apiClient: ApiClient;
  identity: CurrentSession;
  resolveTarget?: NotificationTargetResolver;
  describeNotification?: (
    notice: Notification,
  ) => NotificationDisplay | undefined;
}) {
  const queryClient = useQueryClient();
  const message = useAppMessage();
  const { formatDateTime, formatNumber } = useAppFormat();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const inboxKey = [
    'notifications',
    apiClient.getConfig().baseUrl,
    identity.user.id,
  ];
  const queryKey = [...inboxKey, unreadOnly];
  const query = useInfiniteQuery({
    queryKey,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ signal, pageParam }) =>
      (
        await listNotifications({
          client: apiClient,
          query: { limit: 20, cursor: pageParam, unread_only: unreadOnly },
          signal,
          throwOnError: true,
        })
      ).data,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    maxPages: 5,
    retry: false,
  });
  const read = useMutation({
    mutationFn: async ({ notice }: { notice: Notification }) =>
      (
        await readNotification({
          client: apiClient,
          path: { id: notice.id },
          headers: { 'x-csrf-token': identity.csrf_token },
          throwOnError: true,
        })
      ).data,
    retry: false,
    onError: (error) => {
      if (
        error &&
        typeof error === 'object' &&
        'error' in error &&
        (error.error as { code?: string }).code === 'auth.unauthorized'
      ) {
        void queryClient.invalidateQueries({ queryKey: sessionKey(apiClient) });
      }
    },
    onSuccess: async () => {
      await queryClient.resetQueries({ queryKey: inboxKey });
    },
  });
  const items = query.data?.pages.flatMap((page) => page.data) ?? [];
  return (
    <>
      <div className="flex flex-wrap items-center gap-3">
        <p>
          {message('notifications.unreadCount', {
            count: formatNumber(query.data?.pages.at(-1)?.unread_count ?? 0),
          })}
        </p>
        <Button
          variant="outline"
          disabled={query.isFetching}
          onClick={() => {
            read.reset();
            void queryClient.resetQueries({ queryKey, exact: true });
          }}
        >
          {message('notifications.refresh')}
        </Button>
        <Button
          variant={unreadOnly ? 'secondary' : 'outline'}
          aria-pressed={unreadOnly}
          onClick={() => {
            read.reset();
            setUnreadOnly((value) => !value);
          }}
        >
          {message('notifications.unreadOnly')}
        </Button>
      </div>
      {query.isPending ? (
        <p role="status">{message('notifications.loading')}</p>
      ) : query.isError ? (
        <Failure error={query.error} />
      ) : items.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BellOffIcon aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>
              {message(
                unreadOnly
                  ? 'notifications.emptyUnread'
                  : 'notifications.empty',
              )}
            </EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : null}
      {read.isError ? <Failure error={read.error} /> : null}
      {!query.isError ? (
        <ul className="flex flex-col gap-3">
          {items.map((notice) => {
            const open = resolveTarget?.(notice.target);
            const display = describeNotification?.(notice);
            return (
              <li
                key={notice.id}
                className="flex flex-col gap-3 rounded-lg border p-4"
              >
                <div className="flex flex-wrap items-center gap-3">
                  <h2 className="font-semibold">
                    {notificationHeading(notice, display, message)}
                  </h2>
                  <Badge variant={notice.read_at ? 'outline' : 'secondary'}>
                    {message(
                      notice.read_at
                        ? 'notifications.read'
                        : 'notifications.unread',
                    )}
                  </Badge>
                </div>
                <time
                  className="text-sm text-muted-foreground"
                  dateTime={notice.created_at}
                >
                  {formatDateTime(notice.created_at)}
                </time>
                <div className="flex flex-wrap items-center gap-3">
                  {open ? (
                    <Button
                      disabled={read.isPending}
                      onClick={() => {
                        // Observer callbacks stop on unmount; a late read must not override navigation.
                        read.mutate({ notice }, { onSuccess: open });
                      }}
                    >
                      {message('notifications.openResult')}
                    </Button>
                  ) : (
                    <p className="text-sm text-muted-foreground">
                      {message('notifications.targetUnavailable')}
                    </p>
                  )}
                  {!notice.read_at ? (
                    <Button
                      variant="outline"
                      disabled={read.isPending}
                      onClick={() => {
                        read.mutate({ notice });
                      }}
                    >
                      {message('notifications.markRead')}
                    </Button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      {query.hasNextPage ? (
        <Button
          variant="outline"
          disabled={query.isFetching}
          onClick={() => {
            void query.fetchNextPage();
          }}
        >
          {message('notifications.loadMore')}
        </Button>
      ) : null}
    </>
  );
}
