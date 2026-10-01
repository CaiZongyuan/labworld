import { RateLimitHint } from '../system/rate-limit';
import { useEffect, useRef, useState } from 'react';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  createApiKey,
  revokeApiKey,
  listApiKeys,
  listApiKeyScopes,
  type ApiClient,
  type CurrentSession,
} from '@labos-threejs/sdk';
import { errorCodeOf, requestIdFromError } from '@labos-threejs/core';
import { Alert, AlertDescription, AlertTitle } from '@labos-threejs/ui/components/alert';
import { Badge } from '@labos-threejs/ui/components/badge';
import { Button } from '@labos-threejs/ui/components/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from '@labos-threejs/ui/components/card';
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@labos-threejs/ui/components/empty';
import { KeyRoundIcon } from 'lucide-react';
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldSet,
  FieldLegend,
} from '@labos-threejs/ui/components/field';
import { Input } from '@labos-threejs/ui/components/input';
import { Switch } from '@labos-threejs/ui/components/switch';
import {
  NativeSelect,
  NativeSelectOption,
} from '@labos-threejs/ui/components/native-select';
import { sessionKey, sessionQuery } from '../identity';
import { useAppFormat } from '../shell/format';
import { useAppMessage } from '../shell/messages';
import { usePageTitle } from '../shell/page-title';

// API-key management as the settings-group entry of the universal shell
// (docs/ui/design.md §5 Q4). Scope labels arrive from the server's
// capability registration and render as-is; everything around them speaks
// the active language. The one-time creation secret keeps living only in
// page state — never in Query/Mutation caches or persistent storage — so
// hiding it, leaving, reloading or switching the language cannot revive it.

function Failure({
  error,
  creation = false,
}: {
  error: unknown;
  creation?: boolean;
}) {
  const message = useAppMessage();
  const id = requestIdFromError(error);
  return (
    <Alert variant="destructive">
      <AlertTitle>{message('apiKeys.error.title')}</AlertTitle>
      <AlertDescription>
        {creation
          ? message('apiKeys.error.creation')
          : message('apiKeys.error.generic')}
        <RateLimitHint error={error} />
        {id ? <p>{message('common.requestId', { id })}</p> : null}
      </AlertDescription>
    </Alert>
  );
}
export function ApiKeysView({
  apiClient,
  copySecret,
  embedded = false,
}: {
  apiClient: ApiClient;
  copySecret: (secret: string) => Promise<void>;
  embedded?: boolean;
}) {
  const message = useAppMessage();
  usePageTitle(embedded ? undefined : 'apiKeys.title');
  const client = useQueryClient();
  const session = useQuery(sessionQuery(apiClient, client));
  return (
    <div
      className={
        embedded
          ? 'flex min-w-0 flex-col gap-6'
          : 'app-page flex flex-col gap-6'
      }
    >
      {embedded ? null : (
        <h1 className="text-xl font-semibold">{message('apiKeys.title')}</h1>
      )}
      {session.isPending ? (
        <p role="status">{message('common.loadingSession')}</p>
      ) : session.isError ? (
        <Failure error={session.error} />
      ) : !session.data ? (
        <p>{message('apiKeys.signedOut')}</p>
      ) : (
        <Settings
          key={session.data.user.id}
          apiClient={apiClient}
          identity={session.data}
          copySecret={copySecret}
        />
      )}
    </div>
  );
}
function Settings({
  apiClient,
  identity,
  copySecret,
}: {
  apiClient: ApiClient;
  identity: CurrentSession;
  copySecret: (secret: string) => Promise<void>;
}) {
  const message = useAppMessage();
  const { formatDateTime } = useAppFormat();
  const client = useQueryClient();
  const queryKey = [
    'api-keys',
    apiClient.getConfig().baseUrl,
    identity.user.id,
  ];
  const keys = useInfiniteQuery({
    queryKey,
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ signal, pageParam }) =>
      (
        await listApiKeys({
          client: apiClient,
          query: { limit: 20, cursor: pageParam },
          signal,
          throwOnError: true,
        })
      ).data,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    maxPages: 5,
    retry: false,
  });
  const scopes = useQuery({
    queryKey: [...queryKey, 'scopes'],
    queryFn: async ({ signal }) =>
      (
        await listApiKeyScopes({
          client: apiClient,
          signal,
          throwOnError: true,
        })
      ).data,
    retry: false,
  });
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<string[]>([]);
  const [days, setDays] = useState('30');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [secret, setSecret] = useState<string>();
  const [copyStatus, setCopyStatus] = useState('');
  const abort = useRef<AbortController | null>(null);
  const revealedKey = useRef<string | undefined>(undefined);
  useEffect(() => () => abort.current?.abort(), []);
  async function create() {
    if (abort.current) return;
    const controller = new AbortController();
    abort.current = controller;
    setPending(true);
    setError(undefined);
    setSecret(undefined);
    setCopyStatus('');
    try {
      // Keep the one-time response out of both Query and Mutation caches.
      const issued = (
        await createApiKey({
          client: apiClient,
          body: {
            name: name.trim(),
            scopes: selected,
            expires_in_days: Number(days),
          },
          headers: { 'x-csrf-token': identity.csrf_token },
          signal: controller.signal,
          throwOnError: true,
        })
      ).data;
      if (!controller.signal.aborted) {
        revealedKey.current = issued.key.id;
        setSecret(issued.secret);
        await client.resetQueries({ queryKey, exact: true });
      }
    } catch (error) {
      if (!controller.signal.aborted) setError(error);
    } finally {
      abort.current = null;
      if (!controller.signal.aborted) setPending(false);
    }
  }
  async function copy() {
    if (!secret) return;
    try {
      await copySecret(secret);
      setCopyStatus(message('apiKeys.secret.copied'));
    } catch {
      setCopyStatus(message('apiKeys.secret.copyFailed'));
    }
  }
  const revoke = useMutation({
    mutationFn: async (id: string) => {
      await revokeApiKey({
        client: apiClient,
        path: { id },
        headers: { 'x-csrf-token': identity.csrf_token },
        throwOnError: true,
      });
    },
    retry: false,
    onSuccess: async (_, id) => {
      if (revealedKey.current === id) {
        setSecret(undefined);
        setCopyStatus('');
      }
      await client.resetQueries({ queryKey, exact: true });
    },
    onError: (error) => {
      if (errorCodeOf(error) === 'auth.unauthorized')
        void client.invalidateQueries({ queryKey: sessionKey(apiClient) });
    },
  });
  const items = keys.data?.pages.flatMap((page) => page.data) ?? [];
  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle>{message('apiKeys.create.title')}</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="flex flex-col gap-4"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="key-name">
                  {message('apiKeys.form.name')}
                </FieldLabel>
                <Input
                  id="key-name"
                  maxLength={100}
                  required
                  disabled={pending}
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                />
              </Field>
              <Field>
                <FieldLabel htmlFor="key-expiry">
                  {message('apiKeys.form.expiry')}
                </FieldLabel>
                <NativeSelect
                  id="key-expiry"
                  disabled={pending}
                  value={days}
                  onChange={(event) => setDays(event.target.value)}
                >
                  {['7', '30', '90', '365'].map((value) => (
                    <NativeSelectOption key={value} value={value}>
                      {message('apiKeys.form.expiryDays', { days: value })}
                    </NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
              <FieldSet>
                <FieldLegend>{message('apiKeys.form.scopes')}</FieldLegend>
                {scopes.isPending ? (
                  <p role="status">{message('apiKeys.form.scopesLoading')}</p>
                ) : scopes.isError ? (
                  <Failure error={scopes.error} />
                ) : (
                  scopes.data.data.map((scope) => (
                    <Field key={scope.id} orientation="horizontal">
                      <FieldLabel htmlFor={`scope-${scope.id}`}>
                        {scope.label}
                      </FieldLabel>
                      <Switch
                        id={`scope-${scope.id}`}
                        disabled={pending}
                        checked={selected.includes(scope.id)}
                        onCheckedChange={(checked) =>
                          setSelected((previous) =>
                            checked
                              ? [...previous, scope.id]
                              : previous.filter((id) => id !== scope.id),
                          )
                        }
                      />
                    </Field>
                  ))
                )}
              </FieldSet>
            </FieldGroup>
            <Button
              type="submit"
              disabled={
                pending ||
                !name.trim() ||
                selected.length === 0 ||
                scopes.isError
              }
            >
              {pending
                ? message('apiKeys.form.creating')
                : message('apiKeys.form.create')}
            </Button>
          </form>
        </CardContent>
      </Card>
      {error ? <Failure error={error} creation /> : null}
      {revoke.isError ? <Failure error={revoke.error} /> : null}
      {secret ? (
        <Card>
          <CardHeader>
            <CardTitle>{message('apiKeys.secret.title')}</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <p>{message('apiKeys.secret.hint')}</p>
            <Field>
              <FieldLabel htmlFor="new-key-secret">
                {message('apiKeys.secret.label')}
              </FieldLabel>
              <Input
                id="new-key-secret"
                value={secret}
                readOnly
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
            <div className="flex gap-3">
              <Button
                onClick={() => {
                  void copy();
                }}
              >
                {message('apiKeys.secret.copy')}
              </Button>
              <Button
                variant="outline"
                onClick={() => {
                  setSecret(undefined);
                  setCopyStatus('');
                }}
              >
                {message('apiKeys.secret.hide')}
              </Button>
            </div>
            {copyStatus ? <p role="status">{copyStatus}</p> : null}
          </CardContent>
        </Card>
      ) : null}
      <div>
        <Button
          variant="outline"
          disabled={keys.isFetching}
          onClick={() => {
            void client.resetQueries({ queryKey, exact: true });
            void scopes.refetch();
          }}
        >
          {message('apiKeys.list.refresh')}
        </Button>
      </div>
      {keys.isPending ? (
        <p role="status">{message('apiKeys.list.loading')}</p>
      ) : keys.isError ? (
        <Failure error={keys.error} />
      ) : items.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <KeyRoundIcon aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>{message('apiKeys.list.empty')}</EmptyTitle>
          </EmptyHeader>
        </Empty>
      ) : null}
      {!keys.isError ? (
        <ul className="flex flex-col gap-3">
          {items.map((key) => (
            <li
              key={key.id}
              className="flex flex-col gap-2 rounded-lg border p-4"
            >
              <h2 className="font-semibold">{key.name}</h2>
              <span>{key.prefix}</span>
              <p className="text-sm text-muted-foreground">
                {key.scopes.join(' · ')} ·{' '}
                {message('apiKeys.list.expires', {
                  date: formatDateTime(key.expires_at),
                })}
              </p>
              <div>
                <Badge variant={key.revoked_at ? 'outline' : 'secondary'}>
                  {key.revoked_at
                    ? message('apiKeys.list.revoked')
                    : new Date(key.expires_at).getTime() <= keys.dataUpdatedAt
                      ? message('apiKeys.list.expired')
                      : message('apiKeys.list.active')}
                </Badge>
              </div>
              {!key.revoked_at ? (
                <Button
                  variant="outline"
                  disabled={revoke.isPending}
                  aria-label={message('apiKeys.list.revokeName', {
                    name: key.name,
                  })}
                  onClick={() => revoke.mutate(key.id)}
                >
                  {message('apiKeys.list.revoke')}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {keys.hasNextPage ? (
        <Button
          variant="outline"
          disabled={keys.isFetching}
          onClick={() => {
            void keys.fetchNextPage();
          }}
        >
          {keys.isFetchingNextPage
            ? message('common.loadingMore')
            : message('apiKeys.list.loadMore')}
        </Button>
      ) : null}
    </>
  );
}
