import { lazy, Suspense } from 'react';
import { Box, LibraryBig } from 'lucide-react';
import { Skeleton } from '@labos-threejs/ui/components/skeleton';
import type { ExampleContribution } from '../shell/app-contract';
import { LabAccess } from './lab-access';
import { labMessages } from './messages';

const AssetLibrary = lazy(() => import('./asset-library'));
const LabView = lazy(() => import('./lab-view'));
const WorldView = lazy(() => import('./world-view'));

export function createLabExample(): ExampleContribution {
  return {
    id: 'lab',
    defaultEntry: '/lab',
    routes: [
      {
        path: '/lab',
        component: ({ apiClient, navigate }) => (
          <LabAccess
            apiClient={apiClient}
            title="world.title"
            onLogin={() => navigate({ path: '/login' })}
          >
            {(identity) => (
              <Suspense fallback={<Skeleton className="m-6 h-40" />}>
                <WorldView identity={identity} apiClient={apiClient} />
              </Suspense>
            )}
          </LabAccess>
        ),
      },
      {
        path: '/lab/asset',
        component: ({ apiClient, navigate }) => (
          <LabAccess
            apiClient={apiClient}
            title="viewer.title"
            onLogin={() => navigate({ path: '/login' })}
          >
            {(identity) => (
              <Suspense fallback={<Skeleton className="m-6 h-40" />}>
                <LabView identity={identity} apiClient={apiClient} />
              </Suspense>
            )}
          </LabAccess>
        ),
      },
      {
        path: '/assets',
        component: ({ apiClient, navigate }) => (
          <LabAccess
            apiClient={apiClient}
            title="assets.title"
            onLogin={() => navigate({ path: '/login' })}
          >
            {(identity) => (
              <Suspense fallback={<Skeleton className="m-6 h-40" />}>
                <AssetLibrary
                  identity={identity}
                  apiClient={apiClient}
                  onOpen={() => navigate({ path: '/lab/asset' })}
                />
              </Suspense>
            )}
          </LabAccess>
        ),
      },
    ],
    navigation: [
      {
        id: 'lab',
        labelKey: 'nav.group',
        items: [
          { id: 'viewer', labelKey: 'nav.viewer', path: '/lab' },
          { id: 'assets', labelKey: 'nav.assets', path: '/assets' },
        ],
      },
    ],
    messages: labMessages,
    moduleIcons: {
      '/lab': { icon: Box, variant: 'teal' },
      '/assets': { icon: LibraryBig, variant: 'blue' },
    },
  };
}
