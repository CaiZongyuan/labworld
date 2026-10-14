import { useMemo } from 'react';
import type { ApiClient, CurrentSession } from '@labos-threejs/sdk';

/** Private equality scope for the authenticated model composition. */
export function useModelAuthority(
  apiClient: ApiClient,
  identity: CurrentSession,
) {
  const baseUrl = apiClient.getConfig().baseUrl;
  return useMemo(
    () => ({}),
    [
      apiClient,
      baseUrl,
      identity.user.id,
      identity.user.role,
      identity.csrf_token,
    ],
  );
}
