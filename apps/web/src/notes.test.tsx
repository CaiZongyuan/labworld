import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { createApiClient, type CurrentSession } from '@labos-threejs/sdk';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, test } from 'vitest';
import { server } from '../../../tests/frontend/server';
import { createAppRouter } from './router';
import { assembledApp, exampleEntries } from './app-examples';

// Notes ships unregistered by default (UI-R5): the app assembles only the
// knowledge example, so these tests follow the assembled state and run
// where notes is registered — the CI scenario that adds it back proves
// the composition interface these tests pin.
const notesRegistered = exampleEntries.some((entry) => entry.id === 'notes');

const signedIn = {
  user: {
    id: 'notes-reader',
    email: 'notes@example.com',
    display_name: '便签用户',
    role: 'member',
  },
  csrf_token: 'notes-csrf',
} satisfies CurrentSession;

function open(path = '/') {
  server.use(
    http.get('http://api.test/api/v1/auth/session', () =>
      HttpResponse.json(signedIn),
    ),
  );
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const router = createAppRouter(
    {
      apiClient: createApiClient('http://api.test'),
      docsUrl: 'https://docs.test',
    },
    createMemoryHistory({ initialEntries: [path] }),
  );
  render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { user: userEvent.setup(), router };
}

test.skipIf(!notesRegistered)(
  'the notes page opens from the home business navigation and renders its own messages',
  async () => {
    const { user, router } = open('/');
    // Business groups mount with the session; await the link, not the nav.
    await user.click(await screen.findByRole('link', { name: '便签示例' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/notes'));
    expect(
      await screen.findByRole('heading', { name: '便签示例页' }),
    ).toBeVisible();
  },
);

test.skipIf(!notesRegistered)(
  'switching language in settings instantly re-renders the notes example',
  async () => {
    // The second test example proves that example-owned messages follow the
    // preference switch at runtime — no reload, no per-example wiring.
    const { user } = open('/settings');
    const english = await screen.findByRole('radio', { name: 'English' });
    await user.click(english);
    expect(document.documentElement.lang).toBe('en');
    // The locale switch re-renders the whole shell; the example link lives
    // in the assembled navigation on the home route.
    await user.click(
      within(
        await screen.findByRole('navigation', { name: 'Main menu' }),
      ).getByRole('link', { name: 'Home' }),
    );
    await user.click(
      await screen.findByRole('link', { name: 'Notes example' }),
    );
    expect(
      await screen.findByRole('heading', { name: 'Notes example page' }),
    ).toBeVisible();
  },
);

test.skipIf(!notesRegistered)(
  'a direct /notes deep link renders without any backend call',
  async () => {
    const { router } = open('/notes');
    expect(
      await screen.findByRole('heading', { name: '便签示例页' }),
    ).toBeVisible();
    expect(router.state.location.pathname).toBe('/notes');
  },
);

test.skipIf(!notesRegistered)(
  'assembly carries the notes messages and scene in both locales',
  () => {
    expect(assembledApp.messages.zh['notes.nav.notes']).toBe('便签示例');
    expect(assembledApp.messages.en['notes.nav.notes']).toBe('Notes example');
    // Assembled scenes carry their example id alongside namespaced message
    // keys (the notes example contributes the nav scene as notes:notes-demo).
    expect(
      assembledApp.scenes.map(({ exampleId, id }) => `${exampleId}:${id}`),
    ).toContain('notes:notes-demo');
  },
);
