import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, Radio } from 'lucide-react';
import {
  createLabSourceConfiguration,
  listLabSources,
  registerLabSource,
  revokeLabSource,
  type ApiClient,
  type LabSourceConfiguration,
} from '@labos-threejs/sdk';
import { Button } from '@labos-threejs/ui/components/button';
import { Badge } from '@labos-threejs/ui/components/badge';
import { Input } from '@labos-threejs/ui/components/input';
import { Textarea } from '@labos-threejs/ui/components/textarea';
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
} from '@labos-threejs/ui/components/dialog';
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
} from '@labos-threejs/ui/components/field';
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  EmptyDescription,
} from '@labos-threejs/ui/components/empty';
import { Alert, AlertDescription } from '@labos-threejs/ui/components/alert';
import { errorCodeOf } from '@labos-threejs/core';
import { useAppMessage } from '../shell/messages';

type Props = {
  apiClient: ApiClient;
  userId: string;
  labId: string | null;
  csrfToken: string;
  disabled?: boolean;
};
export function SourceControls(props: Props) {
  // Scope changes unmount the credential surface and cancel its owned requests.
  return (
    <SourcePanel
      key={`${props.apiClient.getConfig().baseUrl}:${props.userId}:${props.labId}`}
      {...props}
    />
  );
}

function SourcePanel({
  apiClient,
  userId,
  labId,
  csrfToken,
  disabled = false,
}: Props) {
  const message = useAppMessage('lab');
  const queries = useQueryClient();
  const key = ['lab', 'sources', apiClient.getConfig().baseUrl, userId, labId];
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [configuration, setConfiguration] =
    useState<LabSourceConfiguration | null>(null);
  const [pending, setPending] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const owner = useRef<AbortController | null>(null);
  const request = {
    client: apiClient,
    path: { lab_id: labId ?? '' },
    headers: { 'x-csrf-token': csrfToken },
    throwOnError: true as const,
  };
  const sources = useQuery({
    queryKey: key,
    enabled: !!labId,
    retry: false,
    refetchInterval: open ? 1000 : 5000,
    queryFn: async ({ signal }) =>
      (await listLabSources({ ...request, signal })).data.data,
  });
  useEffect(() => () => owner.current?.abort(), []);
  function changeOpen(next: boolean) {
    if (!next) {
      owner.current?.abort();
      setPending(false);
      setConfiguration(null);
      setCopied(false);
      setError(null);
    }
    setOpen(next);
  }
  async function write(
    action: 'create' | 'configure' | 'revoke',
    sourceId?: string,
  ) {
    if (!labId || pending || disabled) return;
    const controller = new AbortController();
    owner.current?.abort();
    owner.current = controller;
    setPending(true);
    setError(null);
    setConfiguration(null);
    setCopied(false);
    try {
      if (action === 'create') {
        const { data: source } = await registerLabSource({
          ...request,
          signal: controller.signal,
          body: { name },
        });
        sourceId = source.id;
        if (controller.signal.aborted) return;
        setName('');
        await queries.invalidateQueries({ queryKey: key });
      }
      if (sourceId && action !== 'revoke') {
        const { data } = await createLabSourceConfiguration({
          ...request,
          signal: controller.signal,
          path: { lab_id: labId, source_id: sourceId },
          body: {},
        });
        if (!controller.signal.aborted) setConfiguration(data);
      } else if (sourceId) {
        await revokeLabSource({
          ...request,
          signal: controller.signal,
          path: { lab_id: labId, source_id: sourceId },
          body: {},
        });
      }
    } catch (failure) {
      if (!controller.signal.aborted) setError(failure);
    } finally {
      if (!controller.signal.aborted) {
        setPending(false);
        await queries.invalidateQueries({ queryKey: key });
      }
    }
  }
  const failure = error ?? sources.error;
  const denied = [
    'auth.unauthorized',
    'auth.csrf',
    'api_keys.scope_forbidden',
  ].includes(errorCodeOf(failure) ?? '');
  const ready = !disabled && !pending && !sources.isPending && !sources.isError;
  return (
    <>
      <Button
        variant="outline"
        size="sm"
        disabled={!labId}
        onClick={() => changeOpen(true)}
      >
        <Radio data-icon="inline-start" />
        {message('source.title')}
        <Badge variant="secondary">
          {sources.data?.filter((s) => s.connection_state === 'connected')
            .length ?? 0}
        </Badge>
      </Button>
      <Dialog open={open} onOpenChange={changeOpen}>
        <DialogContent className="flex max-h-[85vh] flex-col gap-4 overflow-y-auto">
          <DialogTitle>{message('source.title')}</DialogTitle>
          <DialogDescription>{message('source.description')}</DialogDescription>
          {failure ? (
            <Alert variant="destructive">
              <AlertDescription>
                {message(denied ? 'source.denied' : 'source.failure')}
              </AlertDescription>
            </Alert>
          ) : null}
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void write('create');
            }}
          >
            <FieldGroup>
              <Field data-disabled={!ready}>
                <FieldLabel htmlFor="lab-source-name">
                  {message('source.name')}
                </FieldLabel>
                <Input
                  id="lab-source-name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  maxLength={120}
                  required
                  disabled={!ready}
                />
              </Field>
              <Button type="submit" disabled={!ready || !name.trim()}>
                {message('source.create')}
              </Button>
            </FieldGroup>
          </form>
          {sources.isPending ? (
            <p role="status">{message('source.loading')}</p>
          ) : null}
          {sources.data?.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>{message('source.empty')}</EmptyTitle>
                <EmptyDescription>
                  {message('source.emptyHint')}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : null}
          {sources.data?.map((source) => (
            <section
              key={source.id}
              className="flex flex-col gap-2"
              aria-label={source.name}
            >
              <p>{source.name}</p>
              <div
                className="flex flex-wrap gap-2"
                role="status"
                aria-label={message('source.status', { name: source.name })}
              >
                <Badge
                  variant={
                    source.connection_state === 'connected'
                      ? 'success'
                      : 'secondary'
                  }
                >
                  {message(`source.${source.connection_state}`)}
                </Badge>
                {source.connection_state === 'connected' && source.phase ? (
                  <Badge variant="outline">
                    {message(`source.${source.phase}`)}
                  </Badge>
                ) : null}
                <Badge
                  variant={
                    ['expired', 'revoked'].includes(source.authorization)
                      ? 'warning'
                      : 'outline'
                  }
                >
                  {message(`source.${source.authorization}`)}
                </Badge>
              </div>
              {source.last_seen_at ? (
                <p className="text-sm text-muted-foreground">
                  {message('source.lastSeen')}{' '}
                  <time dateTime={source.last_seen_at}>
                    {source.last_seen_at}
                  </time>
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  disabled={!ready}
                  onClick={() => void write('configure', source.id)}
                >
                  {message(
                    source.authorization === 'unconfigured'
                      ? 'source.configure'
                      : 'source.rotate',
                  )}
                </Button>
                <Button
                  variant="outline"
                  disabled={!ready || source.authorization !== 'authorized'}
                  onClick={() => void write('revoke', source.id)}
                >
                  {message('source.revoke')}
                </Button>
              </div>
            </section>
          ))}
          {configuration ? (
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="lab-source-configuration">
                  {message('source.configuration')}
                </FieldLabel>
                <Textarea
                  id="lab-source-configuration"
                  variant="code"
                  readOnly
                  value={JSON.stringify(configuration, null, 2)}
                  spellCheck={false}
                  className="h-52"
                />
                <FieldDescription>{message('source.once')}</FieldDescription>
              </Field>
              <Button
                variant="outline"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(JSON.stringify(configuration, null, 2))
                    .then(() => setCopied(true))
                    .catch(() => setError(new Error('clipboard')))
                }
              >
                <Copy data-icon="inline-start" />
                {message('source.copy')}
              </Button>
              {copied ? <p role="status">{message('source.copied')}</p> : null}
            </FieldGroup>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={pending}
              onClick={() => {
                setError(null);
                void sources.refetch();
              }}
            >
              {message('source.retry')}
            </Button>
            <DialogClose render={<Button variant="ghost" />}>
              {message('source.close')}
            </DialogClose>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
