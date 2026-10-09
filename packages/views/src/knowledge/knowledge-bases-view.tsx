import { useEffect, useRef, useState } from 'react';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  renameKnowledgeBase,
  listKnowledgeBases,
  createKnowledgeBase,
  listMembers,
  listKnowledgeBaseGrants,
  setKnowledgeBaseGrant,
  revokeKnowledgeBaseGrant,
  type ApiClient,
  type CurrentSession,
  type GrantAccess,
} from '@labos-threejs/sdk';
import { RequestErrorAlert } from './request-error';
import { Button } from '@labos-threejs/ui/components/button';
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldDescription,
} from '@labos-threejs/ui/components/field';
import {
  NativeSelect,
  NativeSelectOption,
} from '@labos-threejs/ui/components/native-select';
import { sessionKey, sessionQuery } from '../identity';
import { useAppMessage } from '../shell/messages';
import { DeleteResource } from './delete-resource';
import { Input } from '@labos-threejs/ui/components/input';
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
} from '@labos-threejs/ui/components/empty';
import { FolderOpenIcon } from 'lucide-react';
import { DocumentList } from './documents-view';
import { knowledgeBaseQuery } from './knowledge-base-query';
import { KnowledgeBaseGraphic } from './knowledge-base-graphic';

function Failure({ error }: { error: unknown }) {
  const message = useAppMessage('knowledge');
  return (
    <RequestErrorAlert
      title={message('errors.actionIncomplete')}
      text={message('errors.baseUnavailable')}
      error={error}
    />
  );
}

function BaseNameForm({
  initialName = '',
  pending,
  error,
  action,
  onSave,
}: {
  initialName?: string;
  pending: boolean;
  error: unknown;
  action: string;
  onSave: (name: string) => void;
}) {
  const message = useAppMessage('knowledge');
  const [invalid, setInvalid] = useState(false);
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const name = String(
          new FormData(event.currentTarget).get('name'),
        ).trim();
        const invalid = !name || [...name].length > 120 || name.includes('\0');
        setInvalid(invalid);
        if (!invalid && !pending) onSave(name);
      }}
    >
      <FieldGroup>
        <Field data-disabled={pending} data-invalid={invalid}>
          <FieldLabel htmlFor="base-name">
            {message('bases.nameLabel')}
          </FieldLabel>
          <Input
            id="base-name"
            name="name"
            defaultValue={initialName}
            required
            maxLength={120}
            disabled={pending}
            aria-invalid={invalid}
          />
          <FieldDescription>
            {invalid ? message('bases.nameInvalid') : message('bases.nameHint')}
          </FieldDescription>
        </Field>
        {error ? <Failure error={error} /> : null}
        <Button type="submit" disabled={pending}>
          {pending ? message('common.saving') : action}
        </Button>
      </FieldGroup>
    </form>
  );
}

function RenameBase({
  apiClient,
  identity,
  baseId,
  name,
}: {
  apiClient: ApiClient;
  identity: CurrentSession;
  baseId: string;
  name: string;
}) {
  const queryClient = useQueryClient();
  const message = useAppMessage('knowledge');
  const rename = useMutation({
    mutationFn: async (name: string) =>
      (
        await renameKnowledgeBase({
          client: apiClient,
          path: { id: baseId },
          body: { name },
          headers: { 'x-csrf-token': identity.csrf_token },
          throwOnError: true,
        })
      ).data,
    retry: false,
    gcTime: 0,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['knowledge'] });
    },
  });
  return (
    <BaseNameForm
      initialName={name}
      pending={rename.isPending}
      error={rename.error}
      action={message('bases.rename')}
      onSave={(name) => rename.mutate(name)}
    />
  );
}

export function KnowledgeBasesView({
  apiClient,
  onBack,
  onLogin,
  onOpen,
}: {
  apiClient: ApiClient;
  onBack: () => void;
  onLogin: () => void;
  onOpen: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const message = useAppMessage('knowledge');
  const session = useQuery(sessionQuery(apiClient, queryClient));
  return (
    <div className="app-page flex flex-col gap-6">
      <header className="flex items-center justify-between gap-4">
        <h1 className="text-xl font-semibold">{message('bases.title')}</h1>
        <Button variant="outline" onClick={onBack}>
          {message('bases.backHome')}
        </Button>
      </header>
      {session.isPending ? (
        <p role="status">{message('common.readingSession')}</p>
      ) : session.isError ? (
        <Failure error={session.error} />
      ) : session.data ? (
        <BaseList
          key={session.data.user.id}
          apiClient={apiClient}
          identity={session.data}
          onOpen={onOpen}
        />
      ) : (
        <Button onClick={onLogin}>{message('bases.signInToAccess')}</Button>
      )}
    </div>
  );
}

function BaseList({
  apiClient,
  identity,
  onOpen,
}: {
  apiClient: ApiClient;
  identity: CurrentSession;
  onOpen: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const message = useAppMessage('knowledge');
  const attempt = useRef<{ name: string; key: string } | null>(null);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const bases = useInfiniteQuery({
    queryKey: ['knowledge', 'bases', identity.user.id],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) =>
      (
        await listKnowledgeBases({
          client: apiClient,
          query: { cursor: pageParam, limit: 50 },
          signal,
          throwOnError: true,
        })
      ).data,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    maxPages: 10,
    retry: false,
  });
  const creation = useMutation({
    mutationFn: async ({ name, key }: { name: string; key: string }) =>
      (
        await createKnowledgeBase({
          client: apiClient,
          body: { name },
          headers: {
            'x-csrf-token': identity.csrf_token,
            'idempotency-key': key,
          },
          throwOnError: true,
        })
      ).data,
    retry: false,
    gcTime: 0,
    onSuccess: async (base) => {
      await queryClient.invalidateQueries({
        queryKey: ['knowledge', 'bases', identity.user.id],
      });
      if (
        queryClient.getQueryState(sessionKey(apiClient))?.fetchStatus ===
        'fetching'
      ) {
        try {
          await queryClient.fetchQuery(sessionQuery(apiClient, queryClient));
        } catch {
          return;
        }
      }
      if (
        active.current &&
        queryClient.getQueryData<CurrentSession>(sessionKey(apiClient))?.user
          .id === identity.user.id
      )
        onOpen(base.id);
    },
  });
  const items = bases.data?.pages.flatMap((page) => page.data) ?? [];
  return (
    <>
      <Button
        variant="outline"
        disabled={bases.isFetching}
        onClick={() => {
          void bases.refetch();
        }}
      >
        {message('bases.retry')}
      </Button>
      {bases.isPending ? (
        <p role="status">{message('bases.loading')}</p>
      ) : bases.isError ? (
        <Failure error={bases.error} />
      ) : (
        <>
          {bases.data.pages[0]?.can_create ? (
            <BaseNameForm
              pending={creation.isPending}
              error={creation.error}
              action={message('bases.create')}
              onSave={(name) => {
                if (attempt.current?.name !== name)
                  attempt.current = { name, key: crypto.randomUUID() };
                creation.mutate(attempt.current);
              }}
            />
          ) : null}
          {items.length === 0 ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <FolderOpenIcon aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>{message('bases.emptyTitle')}</EmptyTitle>
                <EmptyDescription>
                  {message('bases.emptyHint')}
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <ul className="knowledge-base-list">
              {items.map((base) => (
                <li key={base.id} className="knowledge-base-row">
                  <KnowledgeBaseGraphic
                    userId={identity.user.id}
                    baseId={base.id}
                    name={base.name}
                    editable
                  />
                  <Button variant="link" onClick={() => onOpen(base.id)}>
                    {base.name}
                  </Button>
                  <span className="knowledge-base-summary">
                    {base.personal
                      ? message('bases.personalBadge')
                      : message('bases.sharedBadge')}{' '}
                    ·{' '}
                    {base.can_edit
                      ? message('bases.accessEditor')
                      : message('bases.accessReader')}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {bases.hasNextPage ? (
        <Button
          variant="outline"
          disabled={bases.isFetching}
          onClick={() => {
            void bases.fetchNextPage();
          }}
        >
          {message('bases.loadMore')}
        </Button>
      ) : null}
    </>
  );
}

export function KnowledgeBaseView({
  apiClient,
  baseId,
  onBack,
  onLogin,
  onNew,
  onOpen,
}: {
  apiClient: ApiClient;
  baseId: string;
  onBack: () => void;
  onLogin: () => void;
  onNew: () => void;
  onOpen: (id: string) => void;
}) {
  const queryClient = useQueryClient();
  const message = useAppMessage('knowledge');
  const session = useQuery(sessionQuery(apiClient, queryClient));
  const base = useQuery(
    knowledgeBaseQuery(apiClient, session.data?.user.id, baseId),
  );
  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 px-6 py-10">
      <Button variant="outline" onClick={onBack}>
        {message('bases.backToList')}
      </Button>
      {session.isPending ? (
        <p role="status">{message('common.readingSession')}</p>
      ) : session.isError ? (
        <Failure error={session.error} />
      ) : !session.data ? (
        <Button onClick={onLogin}>{message('bases.signInToAccess')}</Button>
      ) : base.isPending ? (
        <p role="status">{message('bases.loading')}</p>
      ) : base.isError ? (
        <>
          <Failure error={base.error} />
          <Button
            variant="outline"
            onClick={() => {
              void base.refetch();
            }}
          >
            {message('bases.retry')}
          </Button>
        </>
      ) : (
        <>
          <header className="flex items-center justify-between gap-4">
            <h1 className="text-2xl font-semibold">{base.data.name}</h1>
            {base.data.can_edit ? (
              <Button onClick={onNew}>{message('common.newDocument')}</Button>
            ) : (
              <p>{message('bases.readonlyStatus')}</p>
            )}
          </header>
          <DocumentList
            key={`documents:${session.data.user.id}:${baseId}`}
            apiClient={apiClient}
            identity={session.data}
            knowledgeBaseId={baseId}
            canCreate={base.data.can_edit}
            onOpen={onOpen}
          />
          {base.data.can_manage ? (
            <>
              <DeleteResource
                key={`delete:${session.data.user.id}:${baseId}`}
                apiClient={apiClient}
                identity={session.data}
                resource={{
                  kind: 'base',
                  id: baseId,
                  name: base.data.name,
                  personal: base.data.personal,
                }}
                onDeleted={onBack}
              />
              <RenameBase
                key={`name:${session.data.user.id}:${baseId}`}
                apiClient={apiClient}
                identity={session.data}
                baseId={baseId}
                name={base.data.name}
              />
              <Grants
                key={`grants:${session.data.user.id}:${baseId}`}
                apiClient={apiClient}
                identity={session.data}
                baseId={baseId}
              />
            </>
          ) : null}
        </>
      )}
    </div>
  );
}

function Grants({
  apiClient,
  identity,
  baseId,
}: {
  apiClient: ApiClient;
  identity: CurrentSession;
  baseId: string;
}) {
  const message = useAppMessage('knowledge');
  const accessNames = {
    reader: message('bases.accessReader'),
    editor: message('bases.accessEditor'),
  };
  const queryClient = useQueryClient();
  const [userId, setUserId] = useState('');
  const [access, setAccess] = useState<GrantAccess>('reader');
  const members = useInfiniteQuery({
    queryKey: ['organization', 'members', identity.user.id],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) =>
      (
        await listMembers({
          client: apiClient,
          query: { cursor: pageParam, limit: 50 },
          signal,
          throwOnError: true,
        })
      ).data,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    maxPages: 10,
    retry: false,
  });
  const grants = useInfiniteQuery({
    queryKey: ['knowledge', 'grants', identity.user.id, baseId],
    initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) =>
      (
        await listKnowledgeBaseGrants({
          client: apiClient,
          path: { id: baseId },
          query: { cursor: pageParam, limit: 50 },
          signal,
          throwOnError: true,
        })
      ).data,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    maxPages: 10,
    retry: false,
  });
  const mutation = useMutation({
    mutationFn: async ({
      target,
      access,
    }: {
      target: string;
      access?: GrantAccess;
    }) => {
      const options = {
        client: apiClient,
        path: { id: baseId, user_id: target },
        headers: { 'x-csrf-token': identity.csrf_token },
        throwOnError: true as const,
      };
      if (access) await setKnowledgeBaseGrant({ ...options, body: { access } });
      else await revokeKnowledgeBaseGrant(options);
    },
    retry: false,
    gcTime: 0,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['knowledge'] });
    },
  });
  const items = grants.data?.pages.flatMap((page) => page.data) ?? [];
  return (
    <section
      aria-label={message('grants.section')}
      className="flex flex-col gap-4 rounded-lg border p-6"
    >
      <h2 className="text-xl font-semibold">{message('grants.section')}</h2>
      <p>{message('grants.hint')}</p>
      {members.isPending || grants.isPending ? (
        <p role="status">{message('grants.loading')}</p>
      ) : null}
      {members.isError ? (
        <>
          <Failure error={members.error} />
          <Button
            variant="outline"
            onClick={() => {
              void members.refetch();
            }}
          >
            {message('grants.retryMembers')}
          </Button>
        </>
      ) : null}
      {grants.isError ? (
        <>
          <Failure error={grants.error} />
          <Button
            variant="outline"
            onClick={() => {
              void grants.refetch();
            }}
          >
            {message('grants.retryGrants')}
          </Button>
        </>
      ) : null}
      {members.data && !members.isError ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (userId && !mutation.isPending)
              mutation.mutate({ target: userId, access });
          }}
        >
          <FieldGroup>
            <Field data-disabled={mutation.isPending}>
              <FieldLabel htmlFor="grant-user">
                {message('grants.memberLabel')}
              </FieldLabel>
              <NativeSelect
                id="grant-user"
                required
                value={userId}
                disabled={mutation.isPending}
                onChange={(event) => setUserId(event.currentTarget.value)}
              >
                <NativeSelectOption value="" disabled>
                  {message('grants.memberPlaceholder')}
                </NativeSelectOption>
                {members.data.pages
                  .flatMap((page) => page.data)
                  .filter((member) => member.active)
                  .map((member) => (
                    <NativeSelectOption
                      key={member.user_id}
                      value={member.user_id}
                    >
                      {member.email}
                    </NativeSelectOption>
                  ))}
              </NativeSelect>
              <FieldDescription>
                {message('grants.memberHint')}
              </FieldDescription>
            </Field>
            <Field data-disabled={mutation.isPending}>
              <FieldLabel htmlFor="grant-access">
                {message('grants.accessLabel')}
              </FieldLabel>
              <NativeSelect
                id="grant-access"
                value={access}
                disabled={mutation.isPending}
                onChange={(event) =>
                  setAccess(event.currentTarget.value as GrantAccess)
                }
              >
                {(Object.keys(accessNames) as GrantAccess[]).map((value) => (
                  <NativeSelectOption key={value} value={value}>
                    {accessNames[value]}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </Field>
            <Button type="submit" disabled={mutation.isPending || !userId}>
              {mutation.isPending
                ? message('common.saving')
                : message('grants.save')}
            </Button>
          </FieldGroup>
        </form>
      ) : null}
      {members.hasNextPage ? (
        <Button
          variant="outline"
          disabled={members.isFetching}
          onClick={() => {
            void members.fetchNextPage();
          }}
        >
          {message('grants.loadMoreMembers')}
        </Button>
      ) : null}
      {mutation.isError ? <Failure error={mutation.error} /> : null}
      {!grants.isPending && !grants.isError && items.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{message('grants.emptyTitle')}</EmptyTitle>
            <EmptyDescription>{message('grants.emptyHint')}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
      {!grants.isError ? (
        <ul className="flex flex-col gap-3">
          {items.map((grant) => (
            <li
              key={grant.user_id}
              className="flex items-center justify-between gap-3"
            >
              <span>
                {grant.email} · {accessNames[grant.access]}
              </span>
              <Button
                variant="outline"
                disabled={mutation.isPending}
                aria-label={message('grants.revoke', { email: grant.email })}
                onClick={() => mutation.mutate({ target: grant.user_id })}
              >
                {message('grants.revokeAction')}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      {grants.hasNextPage ? (
        <Button
          variant="outline"
          disabled={grants.isFetching}
          onClick={() => {
            void grants.fetchNextPage();
          }}
        >
          {message('grants.loadMore')}
        </Button>
      ) : null}
    </section>
  );
}
