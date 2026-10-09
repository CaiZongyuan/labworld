import { lazy, Suspense } from 'react';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@labos-threejs/ui/components/tabs';
import type { AssembledApp } from '../shell/app-contract';
import { docsChapterUrl } from '../shell/docs-links';
import { useAppMessage } from '../shell/messages';
import { usePreferences } from '../shell/preferences';
import { usePageTitle } from '../shell/page-title';
import { ComponentsSection } from './components-section';
import { FoundationSection } from './foundation-section';
import { ScenesSection } from './scenes-section';

// The design-system showroom (docs/ui/design.md §6 Q3, Q9). It reads
// production tokens and components directly — no second color table or
// design-system copy of the library — and renders scenes registered by
// examples from the assembled result. The view is content-only: the
// shell mounts once on the router's layout route around it (§4.2). It
// ships as its own async chunk, and the icon catalog lazy-loads inside
// it, so neither reaches the initial bundle.

const IconCatalog = lazy(() => import('./icon-catalog'));

export default function DesignSystemView({
  docsUrl,
  scenes,
  copyText,
  embedded = false,
}: {
  docsUrl: string;
  /** Scenes registered by assembled examples; empty in Core-only apps. */
  scenes: AssembledApp['scenes'];
  /** Port for copying token values and icon names. */
  copyText: (text: string) => Promise<void>;
  /** Inside settings: render the tabs only — the host page owns the
      section heading (§3 codexloom pattern). */
  embedded?: boolean;
}) {
  const message = useAppMessage();
  const { locale } = usePreferences();
  usePageTitle(embedded ? undefined : 'design.title');

  const showroom = (
    <Tabs defaultValue="foundation">
      <TabsList aria-label={message('design.title')}>
        <TabsTrigger value="foundation">
          {message('design.tab.foundation')}
        </TabsTrigger>
        <TabsTrigger value="components">
          {message('design.tab.components')}
        </TabsTrigger>
        <TabsTrigger value="scenes">{message('design.tab.scenes')}</TabsTrigger>
        <TabsTrigger value="icons">{message('design.tab.icons')}</TabsTrigger>
      </TabsList>
      <TabsContent value="foundation">
        <FoundationSection copyText={copyText} />
      </TabsContent>
      <TabsContent value="components">
        <ComponentsSection />
      </TabsContent>
      <TabsContent value="scenes">
        <ScenesSection scenes={scenes} />
      </TabsContent>
      <TabsContent value="icons">
        <Suspense
          fallback={
            <p role="status" className="text-sm text-muted-foreground">
              {message('design.icons.loading')}
            </p>
          }
        >
          <IconCatalog copyText={copyText} />
        </Suspense>
      </TabsContent>
    </Tabs>
  );
  if (embedded) return showroom;

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-12">
      <h1 className="text-xl font-semibold">{message('design.title')}</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        {message('design.description')}
      </p>
      <div className="mt-6">{showroom}</div>
      <a
        href={docsChapterUrl(docsUrl, locale, 'tutorials/design-system.md')}
        target="_blank"
        rel="noreferrer"
        className="mt-6 inline-block text-sm text-link hover:underline"
      >
        {message('design.tutorial')}
      </a>
    </div>
  );
}
