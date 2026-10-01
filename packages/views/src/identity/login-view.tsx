import { useMutation, useQueryClient } from '@tanstack/react-query';
import { loginUser, type ApiClient, type Login } from '@labos-threejs/sdk';
import { errorCodeOf, requestIdFromError, retryAfterSeconds } from '@labos-threejs/core';
import { Alert, AlertDescription, AlertTitle } from '@labos-threejs/ui/components/alert';
import { Button } from '@labos-threejs/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@labos-threejs/ui/components/card';
import { Field, FieldGroup, FieldLabel } from '@labos-threejs/ui/components/field';
import { Input } from '@labos-threejs/ui/components/input';
import { AuthPreferencesRow } from '../shell/appearance-controls';
import { useAppMessage } from '../shell/messages';
import { usePageTitle } from '../shell/page-title';
import { replaceSession } from './session';
import { useRetryDelay } from '../system/rate-limit';

export function LoginView({
  apiClient,
  onLoggedIn,
}: {
  apiClient: ApiClient;
  onLoggedIn: () => void;
}) {
  const message = useAppMessage();
  usePageTitle('login.docTitle');
  const queryClient = useQueryClient();
  const cooldown = useRetryDelay();
  const mutation = useMutation({
    mutationFn: async (body: Login) =>
      (await loginUser({ client: apiClient, body, throwOnError: true })).data,
    retry: false,
    onError: cooldown.start,
    gcTime: 0,
    onSuccess: async (session) => {
      await replaceSession(queryClient, apiClient, session);
    },
  });
  const errorCode = errorCodeOf(mutation.error);
  const requestId = requestIdFromError(mutation.error);
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background px-6 py-12">
      <AuthPreferencesRow />
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>
            <h1 className="text-xl font-semibold">{message('login.title')}</h1>
          </CardTitle>
          <CardDescription>{message('login.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              if (cooldown.remaining > 0 || mutation.isPending) return;
              const data = new FormData(event.currentTarget);
              mutation.mutate(
                {
                  email: String(data.get('email')).trim(),
                  password: String(data.get('password')),
                },
                { onSuccess: onLoggedIn },
              );
            }}
          >
            <FieldGroup>
              <Field data-disabled={mutation.isPending}>
                <FieldLabel htmlFor="login-email">
                  {message('login.email')}
                </FieldLabel>
                <Input
                  id="login-email"
                  name="email"
                  type="email"
                  autoComplete="username"
                  required
                  maxLength={254}
                  disabled={mutation.isPending}
                />
              </Field>
              <Field data-disabled={mutation.isPending}>
                <FieldLabel htmlFor="login-password">
                  {message('login.password')}
                </FieldLabel>
                <Input
                  id="login-password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  maxLength={128}
                  disabled={mutation.isPending}
                />
              </Field>
              {mutation.isError ? (
                <Alert variant="destructive">
                  <AlertTitle>{message('login.error.title')}</AlertTitle>
                  <AlertDescription>
                    {retryAfterSeconds(mutation.error)
                      ? cooldown.remaining > 0
                        ? message('login.error.rateLimitedWait')
                        : message('login.error.rateLimitedReady')
                      : errorCode === 'auth.invalid_credentials'
                        ? message('login.error.invalidCredentials')
                        : message('login.error.generic')}
                    {requestId ? (
                      <p>{message('common.requestId', { id: requestId })}</p>
                    ) : null}
                  </AlertDescription>
                </Alert>
              ) : null}
              <Button
                type="submit"
                disabled={mutation.isPending || cooldown.remaining > 0}
              >
                {mutation.isPending
                  ? message('login.pending')
                  : cooldown.remaining > 0
                    ? message('login.cooldown', {
                        seconds: cooldown.remaining,
                      })
                    : message('login.submit')}
              </Button>
            </FieldGroup>
          </form>
        </CardContent>
        <CardFooter className="flex gap-4">
          <a className="text-sm underline" href="/forgot-password">
            {message('login.forgotPassword')}
          </a>
          <a className="text-sm underline" href="/register">
            {message('login.createAccount')}
          </a>
        </CardFooter>
      </Card>
    </main>
  );
}
