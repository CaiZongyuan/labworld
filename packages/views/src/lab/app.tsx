import { lazy, Suspense } from 'react';
import { Box, LibraryBig } from 'lucide-react';
import { Skeleton } from '@labos-threejs/ui/components/skeleton';
import type { AppDefinition } from '../shell/app-contract';
import { LabAccess } from './lab-access';
import { labMessages } from './messages';
import { coreMessages } from '../shell/core-messages';
import { coreModuleIcons } from '../shell/module-registry';

function catalog(locale: 'zh' | 'en') {
  return {
    ...coreMessages[locale],
    ...Object.fromEntries(
      Object.entries(labMessages[locale]).map(([key, text]) => [
        'lab.' + key,
        text,
      ]),
    ),
    'app.name': 'Lab Word',
  };
}

const AssetLibrary = lazy(() => import('./asset-library'));
const LabView = lazy(() => import('./lab-view'));
const Workbench = lazy(() => import('./workbench'));

export const labApp: AppDefinition = {
  defaultEntry: '/lab',
  routes: [
    {
      path: '/lab',
      component: ({ apiClient, navigate, search }) => (
        <LabAccess
          apiClient={apiClient}
          title="world.title"
          onLogin={() => navigate({ path: '/login' })}
        >
          {(identity) => (
            <Suspense fallback={<Skeleton className="m-6 h-40" />}>
              <Workbench
                key={`${apiClient.getConfig().baseUrl}:${identity.user.id}`}
                identity={identity}
                apiClient={apiClient}
                search={search ?? {}}
                navigate={navigate}
              />
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
      id: 'lab:lab',
      labelKey: 'lab.nav.group',
      items: [
        { id: 'lab:viewer', labelKey: 'lab.nav.viewer', path: '/lab' },
        { id: 'lab:assets', labelKey: 'lab.nav.assets', path: '/assets' },
      ],
    },
  ],
  messages: { zh: catalog('zh'), en: catalog('en') },
  scenes: [],
  moduleIcons: {
    ...coreModuleIcons,
    '/lab': { icon: Box, variant: 'teal' },
    '/assets': { icon: LibraryBig, variant: 'blue' },
  },
};
