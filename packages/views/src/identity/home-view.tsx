import { RateLimitHint } from '../system/rate-limit';
import { usePageTitle } from '../shell/page-title';
import { roleMessageKeys, useAppMessage } from '../shell/messages';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { logoutUser, type ApiClient } from '@labos-threejs/sdk';
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@labos-threejs/ui/components/alert';
import { Badge } from '@labos-threejs/ui/components/badge';
import { Button, buttonVariants } from '@labos-threejs/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@labos-threejs/ui/components/card';
import { replaceSession, sessionQuery } from './session';

// Content-only home page (docs/ui/design.md §4.2): the shell — and the
// permission-gated navigation on it — mounts once on the router's layout
// route, so this view renders the identity card alone.
export function HomeView({ apiClient }: { apiClient: ApiClient }) {
  const message = useAppMessage();
  usePageTitle('shell.nav.home');
  const queryClient = useQueryClient();
  const session = useQuery(sessionQuery(apiClient, queryClient));
  const logout = useMutation({
    mutationFn: async () => {
      if (!session.data) return;
      const result = await logoutUser({
        client: apiClient,
        headers: { 'x-csrf-token': session.data.csrf_token },
      });
      if (result.response?.status === 401) return;
      if (result.error) throw result.error;
    },
    retry: false,
    gcTime: 0,
    onSuccess: async () => {
      await replaceSession(queryClient, apiClient, null);
    },
  });
  const user = session.data?.user;
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col justify-center gap-6 px-6 py-12">
      <Card>
        <CardHeader>
          <CardTitle>
            <h1 className="text-xl font-semibold">
              {user
                ? message('home.greeting', {
                    name: user.display_name || user.email,
                  })
                : message('home.title')}
            </h1>
          </CardTitle>
          <CardDescription>
            {user
              ? message('home.signedInHint')
              : message('home.signedOutHint')}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {session.isPending ? (
            <p role="status">{message('common.loadingSession')}</p>
          ) : null}
          {session.isError ? (
            <>
              <Alert variant="destructive">
                <AlertTitle>{message('home.sessionError')}</AlertTitle>
                <AlertDescription>
                  {message('home.sessionErrorHint')}
                  <RateLimitHint error={session.error} />
                </AlertDescription>
              </Alert>
              <Button
                className="w-fit"
                onClick={() => {
                  void session.refetch();
                }}
              >
                {message('common.retry')}
              </Button>
            </>
          ) : null}
          {user ? (
            <>
              <p>{user.email}</p>
              <Badge variant="secondary">
                {message(roleMessageKeys[user.role])}
              </Badge>
              {logout.isError ? (
                <Alert variant="destructive">
                  <AlertTitle>{message('home.logoutError')}</AlertTitle>
                  <AlertDescription>
                    {message('home.sessionErrorHint')}
                    <RateLimitHint error={logout.error} />
                  </AlertDescription>
                </Alert>
              ) : null}
              <Button
                variant="outline"
                className="w-fit"
                disabled={logout.isPending}
                onClick={() => logout.mutate()}
              >
                {logout.isPending
                  ? message('home.loggingOut')
                  : message('home.logout')}
              </Button>
            </>
          ) : session.isSuccess ? (
            <>
              <a href="/login" className={buttonVariants() + ' w-fit'}>
                {message('login.submit')}
              </a>
              <a
                href="/register"
                className={buttonVariants({ variant: 'outline' }) + ' w-fit'}
              >
                {message('home.registerAccount')}
              </a>
            </>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
