import { queryOptions, type QueryClient } from '@tanstack/react-query';
import {
  getCurrentSession,
  type ApiClient,
  type CurrentSession,
} from '@labos-threejs/sdk';

export const sessionKey = (api: ApiClient) =>
  ['session', api.getConfig().baseUrl] as const;

export async function replaceSession(
  queryClient: QueryClient,
  api: ApiClient,
  session: CurrentSession | null,
) {
  await queryClient.cancelQueries();
  queryClient.removeQueries();
  queryClient.setQueryData(sessionKey(api), session);
}

export function sessionQuery(api: ApiClient, queryClient: QueryClient) {
  return queryOptions({
    queryKey: sessionKey(api),
    queryFn: async ({ signal }) => {
      const result = await getCurrentSession({ client: api, signal });
      const next = result.response?.status === 401 ? null : result.data;
      if (next === undefined)
        throw result.error ?? new Error('Missing session response');
      const previous = queryClient.getQueryData<CurrentSession | null>(
        sessionKey(api),
      );
      if (
        next === null ||
        previous?.user.id !== next.user.id ||
        previous?.user.role !== next.user.role
      ) {
        // Never cancel this in-flight session refresh itself.
        const otherQueries = {
          predicate: (query: { queryKey: readonly unknown[] }) =>
            query.queryKey[0] !== 'session' ||
            query.queryKey[1] !== api.getConfig().baseUrl,
        };
        await queryClient.cancelQueries(otherQueries);
        queryClient.removeQueries(otherQueries);
      }
      return next;
    },
    retry: false,
    staleTime: 0,
  });
}
