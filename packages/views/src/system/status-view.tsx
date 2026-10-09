import { RateLimitHint } from './rate-limit';
import { requestIdFromError } from '@labos-threejs/core';
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@labos-threejs/ui/components/alert';
import { useQuery } from '@tanstack/react-query';
import { getSystemStatus, type ApiClient } from '@labos-threejs/sdk';
import { Badge } from '@labos-threejs/ui/components/badge';
import { Button } from '@labos-threejs/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@labos-threejs/ui/components/card';
import { Skeleton } from '@labos-threejs/ui/components/skeleton';
import { useAppMessage } from '../shell/messages';
import { usePageTitle } from '../shell/page-title';

// The public system-status landing (T01) inside the universal shell
// (docs/ui/design.md §4/§6 Q1). The session resolves opportunistically —
// only to pick the sidebar's role — so the page stays readable even while
// the API it checks is down. Service name, version and migration version
// are protocol values and render untranslated.

export function StatusView({
  apiClient,
  docsUrl,
  embedded = false,
}: {
  apiClient: ApiClient;
  docsUrl: string;
  embedded?: boolean;
}) {
  const message = useAppMessage();
  usePageTitle(embedded ? undefined : 'status.title');
  const query = useQuery({
    queryKey: ['system-status', apiClient.getConfig().baseUrl],
    queryFn: async ({ signal }) =>
      (await getSystemStatus({ client: apiClient, signal, throwOnError: true }))
        .data,
    retry: false,
    staleTime: 15_000,
  });
  const data = query.data;
  const requestId = requestIdFromError(query.error);
  const heading = query.isPending
    ? message('status.connecting')
    : query.isError
      ? message('status.unavailable')
      : message('status.ready');

  return (
    <div
      className={
        embedded
          ? 'status-content flex min-w-0 flex-col gap-6'
          : 'app-page status-content flex flex-col gap-6'
      }
    >
      <section className="flex flex-col items-start gap-4">
        <Badge variant="outline">{message('status.badge')}</Badge>
        {embedded ? (
          <h2 className="text-base font-semibold">{heading}</h2>
        ) : (
          <h1 className="text-xl font-semibold">{heading}</h1>
        )}
        <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
          {message('status.intro')}
        </p>
        <div className="flex flex-wrap gap-3 pt-2">
          <Button
            onClick={() => void query.refetch()}
            disabled={query.isFetching}
          >
            {message('status.recheck')}
          </Button>
          <Button
            variant="outline"
            role="link"
            nativeButton={false}
            render={<a href={docsUrl} />}
          >
            {message('status.tutorial')}
          </Button>
        </div>
      </section>

      {query.isPending ? (
        <Card>
          <CardHeader>
            <CardTitle>{message('status.check.title')}</CardTitle>
            <CardDescription>{message('status.check.desc')}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p role="status">{message('status.check.checking')}</p>
            <Skeleton className="h-5 w-56" />
            <Skeleton className="h-5 w-40" />
          </CardContent>
          <CardFooter>{message('status.check.footer')}</CardFooter>
        </Card>
      ) : null}

      {query.isError ? (
        <Alert variant="destructive">
          <AlertTitle>{message('status.error.title')}</AlertTitle>
          <AlertDescription>
            <p>{message('status.error.hint')}</p>
            <RateLimitHint error={query.error} />
            {requestId ? (
              <p>{message('common.requestId', { id: requestId })}</p>
            ) : null}
          </AlertDescription>
        </Alert>
      ) : null}

      {data && !query.isError ? (
        <div className="grid gap-5 md:grid-cols-3">
          <Card>
            <CardHeader>
              <CardTitle>API</CardTitle>
              <CardDescription>
                {message('status.card.apiDesc')}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col items-start gap-3">
              <Badge>{message('status.card.connected')}</Badge>
              <p className="font-mono">{data.service}</p>
            </CardContent>
            <CardFooter>
              {message('status.card.version', { version: data.version })}
            </CardFooter>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{message('status.card.dbTitle')}</CardTitle>
              <CardDescription>{message('status.card.dbDesc')}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col items-start gap-3">
              <Badge>{message('status.card.connected')}</Badge>
              <p>{message('status.card.dbConnected')}</p>
            </CardContent>
            <CardFooter>
              {message('status.card.schema', {
                version: data.schema_version,
              })}
            </CardFooter>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{message('status.card.contractTitle')}</CardTitle>
              <CardDescription>
                {message('status.card.contractDesc')}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col items-start gap-3">
              <Badge variant="secondary">
                {message('status.card.typesSynced')}
              </Badge>
              <p>{message('status.card.generatedClient')}</p>
            </CardContent>
            <CardFooter>
              <a
                href="/api/openapi.json"
                className="underline underline-offset-4"
              >
                {message('status.card.openapi')}
              </a>
            </CardFooter>
          </Card>
        </div>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>{message('status.next.title')}</CardTitle>
          <CardDescription>{message('status.next.desc')}</CardDescription>
        </CardHeader>
        <CardContent>
          <ol className="grid gap-6 md:grid-cols-3">
            <li className="flex flex-col gap-2">
              <span className="font-mono text-sm text-muted-foreground">
                {message('status.step1.label')}
              </span>
              <p>{message('status.step1.text')}</p>
            </li>
            <li className="flex flex-col gap-2">
              <span className="font-mono text-sm text-muted-foreground">
                {message('status.step2.label')}
              </span>
              <p>{message('status.step2.text')}</p>
            </li>
            <li className="flex flex-col gap-2">
              <span className="font-mono text-sm text-muted-foreground">
                {message('status.step3.label')}
              </span>
              <p>{message('status.step3.text')}</p>
            </li>
          </ol>
        </CardContent>
        <CardFooter>{message('status.next.footer')}</CardFooter>
      </Card>

      <footer className="border-t border-border pt-6 text-sm text-muted-foreground">
        {message('status.footer')}
      </footer>
    </div>
  );
}
