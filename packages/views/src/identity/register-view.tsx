import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  registerUser,
  type ApiClient,
  type Registration,
} from '@labos-threejs/sdk';
import {
  errorCodeOf,
  requestIdFromError,
  retryAfterSeconds,
} from '@labos-threejs/core';
import {
  Alert,
  AlertDescription,
  AlertTitle,
} from '@labos-threejs/ui/components/alert';
import { Button } from '@labos-threejs/ui/components/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@labos-threejs/ui/components/card';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from '@labos-threejs/ui/components/field';
import { Input } from '@labos-threejs/ui/components/input';
import { AuthPreferencesRow } from '../shell/appearance-controls';
import { useAppMessage } from '../shell/messages';
import { usePageTitle } from '../shell/page-title';
import { replaceSession } from './session';
import { useRetryDelay } from '../system/rate-limit';

// Registration errors map from stable backend codes; an unknown code gets
// the localized generic hint (docs/ui/design.md §6 Q1).
function registrationErrorCode(error: unknown) {
  switch (errorCodeOf(error)) {
    case 'auth.email_exists':
      return 'register.error.emailExists';
    case 'auth.session_unavailable':
      return 'register.error.sessionUnavailable';
    case 'auth.invalid_input':
      return 'register.error.invalidInput';
    default:
      return 'register.error.generic';
  }
}

export function RegisterView({
  apiClient,
  onRegistered,
}: {
  apiClient: ApiClient;
  onRegistered: () => void;
}) {
  const message = useAppMessage();
  usePageTitle('register.docTitle');
  const queryClient = useQueryClient();
  const cooldown = useRetryDelay();
  const mutation = useMutation({
    mutationFn: async (body: Registration) =>
      (await registerUser({ client: apiClient, body, throwOnError: true }))
        .data,
    retry: false,
    onError: cooldown.start,
    gcTime: 0,
    onSuccess: async (session) => {
      await replaceSession(queryClient, apiClient, session);
    },
  });
  const requestId = requestIdFromError(mutation.error);
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background px-6 py-12">
      <AuthPreferencesRow />
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>
            <h1 className="text-xl font-semibold">
              {message('register.title')}
            </h1>
          </CardTitle>
          <CardDescription>{message('register.description')}</CardDescription>
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
                  display_name: String(data.get('display_name')).trim() || null,
                },
                { onSuccess: onRegistered },
              );
            }}
          >
            <FieldGroup>
              <Field data-disabled={mutation.isPending}>
                <FieldLabel htmlFor="email">
                  {message('login.email')}
                </FieldLabel>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="email"
                  required
                  maxLength={254}
                  disabled={mutation.isPending}
                />
              </Field>
              <Field data-disabled={mutation.isPending}>
                <FieldLabel htmlFor="password">
                  {message('login.password')}
                </FieldLabel>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  required
                  minLength={12}
                  maxLength={128}
                  aria-describedby="password-help"
                  disabled={mutation.isPending}
                />
                <FieldDescription id="password-help">
                  {message('register.passwordHint')}
                </FieldDescription>
              </Field>
              <Field data-disabled={mutation.isPending}>
                <FieldLabel htmlFor="display-name">
                  {message('register.displayName')}
                </FieldLabel>
                <Input
                  id="display-name"
                  name="display_name"
                  autoComplete="nickname"
                  maxLength={80}
                  disabled={mutation.isPending}
                />
              </Field>
              {mutation.isError ? (
                <Alert variant="destructive">
                  <AlertTitle>{message('register.error.title')}</AlertTitle>
                  <AlertDescription>
                    {retryAfterSeconds(mutation.error)
                      ? cooldown.remaining > 0
                        ? message('login.error.rateLimitedWait')
                        : message('login.error.rateLimitedReady')
                      : message(registrationErrorCode(mutation.error))}
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
                  ? message('register.pending')
                  : cooldown.remaining > 0
                    ? message('login.cooldown', {
                        seconds: cooldown.remaining,
                      })
                    : message('home.registerAccount')}
              </Button>
            </FieldGroup>
          </form>
        </CardContent>
        <CardFooter className="flex gap-6">
          <a className="text-sm underline" href="/login">
            {message('register.haveAccount')}
          </a>
          <a className="text-sm text-muted-foreground underline" href="/">
            {message('common.backHome')}
          </a>
        </CardFooter>
      </Card>
    </main>
  );
}
