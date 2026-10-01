import { queryOptions } from '@tanstack/react-query';
import { getKnowledgeBase, type ApiClient } from '@labos-threejs/sdk';

export function knowledgeBaseQuery(
  apiClient: ApiClient,
  userId: string | undefined,
  baseId: string | undefined,
) {
  return queryOptions({
    queryKey: ['knowledge', 'base', userId, baseId],
    enabled: !!userId && !!baseId,
    queryFn: async ({ signal }) =>
      (
        await getKnowledgeBase({
          client: apiClient,
          path: { id: baseId! },
          signal,
          throwOnError: true,
        })
      ).data,
    retry: false,
  });
}
