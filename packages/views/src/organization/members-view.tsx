import { RateLimitHint } from '../system/rate-limit';
import { useState } from 'react';
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import {
  listMembers,
  updateMember,
  type ApiClient,
  type CurrentSession,
  type Member,
  type MemberRole,
} from '@labos-threejs/sdk';
import { errorCodeOf, requestIdFromError } from '@labos-threejs/core';
import { Alert, AlertTitle, AlertDescription } from '@labos-threejs/ui/components/alert';
import { Badge } from '@labos-threejs/ui/components/badge';
import { Button } from '@labos-threejs/ui/components/button';
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from '@labos-threejs/ui/components/card';
import { Field, FieldGroup, FieldLabel } from '@labos-threejs/ui/components/field';
import {
  NativeSelect,
  NativeSelectOption,
} from '@labos-threejs/ui/components/native-select';
import { Switch } from '@labos-threejs/ui/components/switch';
import { sessionQuery } from '../identity';
import { roleMessageKeys, useAppMessage } from '../shell/messages';
import { usePageTitle } from '../shell/page-title';

// Member administration inside the universal shell (docs/ui/design.md
// §5 Q4): the view resolves its own session — once for the shell's
// role-aware navigation, once for the roster — and speaks the active
// language through the Core catalog. The versioned save contract and the
// server-decided error codes are unchanged.

function Failure({ error }: { error: unknown }) {
  const message = useAppMessage();
  const codes: Record<string, string> = {
    'organization.last_owner': message('members.error.lastOwner'),
    'organization.forbidden': message('members.error.forbidden'),
    'organization.version_conflict': message('members.error.versionConflict'),
    'auth.unauthorized': message('members.error.unauthorized'),
  };
  const requestId = requestIdFromError(error);
  return (
    <Alert variant="destructive">
      <AlertTitle>{message('members.error.title')}</AlertTitle>
      <AlertDescription>
        {codes[errorCodeOf(error) ?? ''] ?? message('members.error.generic')}
        <RateLimitHint error={error} />
        {requestId ? (
          <p>{message('common.requestId', { id: requestId })}</p>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

export function MembersView({
  apiClient,
  onLogin,
}: {
  apiClient: ApiClient;
  onLogin: () => void;
}) {
  const message = useAppMessage();
  usePageTitle('members.title');
  const queryClient = useQueryClient();
  const session = useQuery(sessionQuery(apiClient, queryClient));
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 px-6 py-10">
      <h1 className="text-2xl font-semibold">{message('members.title')}</h1>
      {session.isPending ? (
        <p role="status">{message('common.loadingSession')}</p>
      ) : session.isError ? (
        <Failure error={session.error} />
      ) : session.data ? (
        <MembersList
          key={session.data.user.id}
          apiClient={apiClient}
          identity={session.data}
        />
      ) : (
        <p>
          {message('members.sessionExpired')}{' '}
          <Button variant="link" onClick={onLogin}>
            {message('members.loginLink')}
          </Button>
        </p>
      )}
    </div>
  );
}

function MembersList({
  apiClient,
  identity,
}: {
  apiClient: ApiClient;
  identity: CurrentSession;
}) {
  const message = useAppMessage();
  const queryClient = useQueryClient();
  const [reload, setReload] = useState(0);
  const queryKey = ['organization', 'members', identity.user.id];
  const members = useInfiniteQuery({
    queryKey,
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
  return (
    <>
      <p>{message('members.hint')}</p>
      <Button
        variant="outline"
        disabled={members.isFetching}
        onClick={async () => {
          await queryClient.resetQueries({ queryKey, exact: true });
          setReload((previous) => previous + 1);
        }}
      >
        {message('members.reload')}
      </Button>
      {members.isPending ? (
        <p role="status">{message('members.loading')}</p>
      ) : null}
      {members.isError ? <Failure error={members.error} /> : null}
      {!members.isError || members.isFetchNextPageError
        ? members.data?.pages.flatMap((page) =>
            page.data.map((member) => (
              <MemberCard
                key={`${reload}:${member.user_id}`}
                apiClient={apiClient}
                identity={identity}
                member={member}
                assignableRoles={page.assignable_roles}
              />
            )),
          )
        : null}
      {members.hasNextPage ? (
        <Button
          variant="outline"
          disabled={members.isFetching}
          onClick={() => {
            void members.fetchNextPage();
          }}
        >
          {members.isFetchingNextPage
            ? message('common.loadingMore')
            : message('members.loadMore')}
        </Button>
      ) : null}
    </>
  );
}

function MemberCard({
  apiClient,
  identity,
  member,
  assignableRoles,
}: {
  apiClient: ApiClient;
  identity: CurrentSession;
  member: Member;
  assignableRoles: MemberRole[];
}) {
  const message = useAppMessage();
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState(() => ({
    role: member.role,
    active: member.active,
    version: member.version,
  }));
  const mutation = useMutation({
    mutationFn: async () =>
      (
        await updateMember({
          client: apiClient,
          path: { user_id: member.user_id },
          body: draft,
          headers: { 'x-csrf-token': identity.csrf_token },
          throwOnError: true,
        })
      ).data,
    retry: false,
    gcTime: 0,
    onSuccess: async (saved) => {
      setDraft({
        role: saved.role,
        active: saved.active,
        version: saved.version,
      });
      await queryClient.invalidateQueries({
        queryKey: ['organization', 'members', identity.user.id],
      });
      await queryClient.fetchQuery(sessionQuery(apiClient, queryClient));
    },
  });
  return (
    <article aria-label={member.email}>
      <Card>
        <CardHeader>
          <CardTitle>{member.display_name || member.email}</CardTitle>
          <CardDescription>
            {member.email} · {message(roleMessageKeys[member.role])}
          </CardDescription>
          <Badge variant="secondary">
            {member.active
              ? message('members.badge.active')
              : message('members.badge.inactive')}
          </Badge>
        </CardHeader>
        <CardContent>
          {member.can_edit ? (
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (!mutation.isPending) mutation.mutate();
              }}
            >
              <FieldGroup>
                <Field data-disabled={mutation.isPending}>
                  <FieldLabel htmlFor={`role-${member.user_id}`}>
                    {message('members.form.role')}
                  </FieldLabel>
                  <NativeSelect
                    id={`role-${member.user_id}`}
                    value={draft.role}
                    disabled={mutation.isPending}
                    onChange={(event) =>
                      setDraft({
                        ...draft,
                        role: event.currentTarget.value as MemberRole,
                      })
                    }
                  >
                    {assignableRoles.map((role) => (
                      <NativeSelectOption key={role} value={role}>
                        {message(roleMessageKeys[role])}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </Field>
                <Field
                  orientation="horizontal"
                  data-disabled={mutation.isPending}
                >
                  <Switch
                    id={`active-${member.user_id}`}
                    checked={draft.active}
                    disabled={mutation.isPending}
                    onCheckedChange={(active) => setDraft({ ...draft, active })}
                  />
                  <FieldLabel htmlFor={`active-${member.user_id}`}>
                    {message('members.form.active')}
                  </FieldLabel>
                </Field>
                {mutation.isError ? <Failure error={mutation.error} /> : null}
                {mutation.isSuccess ? (
                  <p role="status">{message('members.form.saved')}</p>
                ) : null}
                <Button type="submit" disabled={mutation.isPending}>
                  {mutation.isPending
                    ? message('members.form.saving')
                    : message('members.form.save')}
                </Button>
              </FieldGroup>
            </form>
          ) : (
            <p>{message('members.form.readonly')}</p>
          )}
        </CardContent>
      </Card>
    </article>
  );
}
