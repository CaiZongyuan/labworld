import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  requestPasswordReset,
  completePasswordReset,
  type ApiClient,
} from '@labos-threejs/sdk';
import { errorCodeOf, requestIdFromError } from '@labos-threejs/core';
import { Alert, AlertDescription, AlertTitle } from '@labos-threejs/ui/components/alert';
import { Button } from '@labos-threejs/ui/components/button';
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from '@labos-threejs/ui/components/card';
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
} from '@labos-threejs/ui/components/field';
import { Input } from '@labos-threejs/ui/components/input';
import { RateLimitHint, useRetryDelay } from '../system/rate-limit';
import { AuthPreferencesRow } from '../shell/appearance-controls';
import { useAppMessage } from '../shell/messages';
import { usePageTitle } from '../shell/page-title';
import { usePreferences } from '../shell/preferences';
import { replaceSession } from './session';

// Reset errors map from stable backend codes; an unknown code gets the
// localized generic hint (docs/ui/design.md §6 Q1).
function resetErrorKey(error: unknown) {
  switch (errorCodeOf(error)) {
    case 'auth.reset_invalid':
      return 'reset.error.invalidLink';
    case 'auth.invalid_input':
      return 'reset.error.invalidInput';
    default:
      return 'reset.error.generic';
  }
}

function Failure({ error }: { error: unknown }) {
  const message = useAppMessage();
  const id = requestIdFromError(error);
  return (
    <Alert variant="destructive">
      <AlertTitle>{message('reset.error.title')}</AlertTitle>
      <AlertDescription>
        {message(resetErrorKey(error))}
        <RateLimitHint error={error} />
        {id ? <p>{message('common.requestId', { id })}</p> : null}
      </AlertDescription>
    </Alert>
  );
}

export function ForgotPasswordView({
  apiClient,
  onLogin,
}: {
  apiClient: ApiClient;
  onLogin: () => void;
}) {
  const message = useAppMessage();
  usePageTitle('forgot.docTitle');
  const { locale } = usePreferences();
  const [email, setEmail] = useState('');
  const [pending, setPending] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<unknown>();
  const abort = useRef<AbortController | null>(null);
  const cooldown = useRetryDelay();
  useEffect(() => () => abort.current?.abort(), []);
  async function submit() {
    if (abort.current || cooldown.remaining > 0) return;
    const controller = new AbortController();
    abort.current = controller;
    setPending(true);
    setError(undefined);
    try {
      // New clients carry the page language so the email speaks it;
      // the backend treats an omitted field as the original behavior.
      await requestPasswordReset({
        client: apiClient,
        body: { email: email.trim(), locale },
        signal: controller.signal,
        throwOnError: true,
      });
      if (!controller.signal.aborted) setSent(true);
    } catch (error) {
      if (!controller.signal.aborted) {
        setError(error);
        cooldown.start(error);
      }
    } finally {
      abort.current = null;
      if (!controller.signal.aborted) setPending(false);
    }
  }
  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-5 px-6 py-10">
      <AuthPreferencesRow className="w-full max-w-lg" />
      <Card>
        <CardHeader>
          <CardTitle>
            <h1 className="text-xl font-semibold">{message('forgot.title')}</h1>
          </CardTitle>
          <CardDescription>{message('forgot.description')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {sent ? (
            <>
              <p role="status">{message('forgot.sent')}</p>
              <Button
                variant="outline"
                onClick={() => {
                  setSent(false);
                  setError(undefined);
                }}
              >
                {message('forgot.refill')}
              </Button>
            </>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void submit();
              }}
            >
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="reset-email">
                    {message('login.email')}
                  </FieldLabel>
                  <Input
                    id="reset-email"
                    type="email"
                    autoComplete="email"
                    required
                    maxLength={254}
                    value={email}
                    disabled={pending}
                    onChange={(event) => setEmail(event.target.value)}
                  />
                </Field>
                <Button
                  type="submit"
                  disabled={pending || cooldown.remaining > 0}
                >
                  {pending
                    ? message('forgot.pending')
                    : cooldown.remaining > 0
                      ? message('login.cooldown', {
                          seconds: cooldown.remaining,
                        })
                      : message('forgot.submit')}
                </Button>
              </FieldGroup>
            </form>
          )}
          {error ? <Failure error={error} /> : null}
          <Button variant="link" onClick={onLogin}>
            {message('forgot.backToLogin')}
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
export function ResetPasswordView({
  apiClient,
  token,
  onConsumed,
  onLogin,
  onRequest,
}: {
  apiClient: ApiClient;
  token: string | undefined;
  onConsumed: () => void;
  onLogin: () => void;
  onRequest: () => void;
}) {
  const message = useAppMessage();
  usePageTitle('reset.docTitle');
  const client = useQueryClient();
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<unknown>();
  const [validation, setValidation] = useState<string>();
  const abort = useRef<AbortController | null>(null);
  const cooldown = useRetryDelay();
  useEffect(() => () => abort.current?.abort(), []);
  async function submit(form: HTMLFormElement) {
    if (!token || abort.current || cooldown.remaining > 0) return;
    const values = new FormData(form);
    const password = String(values.get('password'));
    if (password !== String(values.get('confirmation'))) {
      setValidation(message('reset.mismatch'));
      return;
    }
    setValidation(undefined);
    setError(undefined);
    setPending(true);
    const controller = new AbortController();
    abort.current = controller;
    try {
      // The token and password stay in this component's request, never in mutation/query caches.
      await completePasswordReset({
        client: apiClient,
        body: { token, password },
        signal: controller.signal,
        throwOnError: true,
      });
      if (!controller.signal.aborted) {
        await replaceSession(client, apiClient, null);
        if (!controller.signal.aborted) {
          setDone(true);
          onConsumed();
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        setError(error);
        cooldown.start(error);
      }
    } finally {
      abort.current = null;
      if (!controller.signal.aborted) setPending(false);
    }
  }
  return (
    <main className="mx-auto flex min-h-screen max-w-lg flex-col justify-center gap-5 px-6 py-10">
      <AuthPreferencesRow className="w-full max-w-lg" />
      <Card>
        <CardHeader>
          <CardTitle>
            <h1 className="text-xl font-semibold">{message('reset.title')}</h1>
          </CardTitle>
          <CardDescription>{message('reset.description')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {done ? (
            <p role="status">{message('reset.done')}</p>
          ) : !token ? (
            <Alert variant="destructive">
              <AlertTitle>{message('reset.linkIncompleteTitle')}</AlertTitle>
              <AlertDescription>
                {message('reset.linkIncomplete')}
              </AlertDescription>
            </Alert>
          ) : (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                void submit(event.currentTarget);
              }}
            >
              <FieldGroup>
                <Field>
                  <FieldLabel htmlFor="new-password">
                    {message('reset.newPassword')}
                  </FieldLabel>
                  <Input
                    id="new-password"
                    name="password"
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={12}
                    maxLength={128}
                    disabled={pending}
                  />
                  <FieldDescription>
                    {message('reset.passwordHint')}
                  </FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="confirm-password">
                    {message('reset.confirmPassword')}
                  </FieldLabel>
                  <Input
                    id="confirm-password"
                    name="confirmation"
                    type="password"
                    autoComplete="new-password"
                    required
                    minLength={12}
                    maxLength={128}
                    disabled={pending}
                  />
                </Field>
                {validation ? <p role="alert">{validation}</p> : null}
                <Button
                  type="submit"
                  disabled={pending || cooldown.remaining > 0}
                >
                  {pending
                    ? message('reset.pending')
                    : cooldown.remaining > 0
                      ? message('login.cooldown', {
                          seconds: cooldown.remaining,
                        })
                      : message('reset.submit')}
                </Button>
              </FieldGroup>
            </form>
          )}
          {error ? <Failure error={error} /> : null}
          <div className="flex flex-wrap gap-3">
            <Button variant="link" onClick={onLogin}>
              {message('forgot.backToLogin')}
            </Button>
            {!done ? (
              <Button variant="outline" onClick={onRequest}>
                {message('reset.requestNew')}
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </main>
  );
}
