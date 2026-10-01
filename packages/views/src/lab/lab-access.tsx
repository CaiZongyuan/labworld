import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { ApiClient } from '@labos-threejs/sdk';
import { Fragment, type ReactNode } from 'react';
import { Button } from '@labos-threejs/ui/components/button';
import { Skeleton } from '@labos-threejs/ui/components/skeleton';
import { sessionQuery } from '../identity/session';
import { ErrorAlert } from '../shell/error-alert';
import { useAppMessage } from '../shell/messages';
import { usePageTitle } from '../shell/page-title';

export function LabAccess({
  apiClient,
  title,
  onLogin,
  children,
}: {
  apiClient: ApiClient;
  title: string;
  onLogin: () => void;
  children: (userId: string) => ReactNode;
}) {
  const client = useQueryClient();
  const identity = useQuery(sessionQuery(apiClient, client));
  const message = useAppMessage();
  usePageTitle(`lab.${title}`);
  if (identity.data?.user)
    return (
      <Fragment key={identity.data.user.id}>
        {children(identity.data.user.id)}
      </Fragment>
    );
  return (
    <section className="flex flex-col gap-4 p-6">
      <h1 className="text-lg font-semibold">{message(`lab.${title}`)}</h1>
      {identity.isPending ? (
        <Skeleton className="h-10 w-64" />
      ) : identity.isError ? (
        <ErrorAlert
          error={identity.error}
          title={message('common.sessionUnavailable')}
        />
      ) : (
        <Button className="w-fit" onClick={onLogin}>
          {message('login.submit')}
        </Button>
      )}
    </section>
  );
}
