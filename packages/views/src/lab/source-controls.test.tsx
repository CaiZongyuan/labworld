import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, test, vi } from 'vitest';
import { createApiClient } from '@labos-threejs/sdk';
import { server } from '../../../../tests/frontend/server';
import { PreferencesProvider, LOCALE_STORAGE_KEY } from '../shell/preferences';
import { AppMessagesProvider } from '../shell/messages';
import { labApp } from './app';
import { SourceControls } from './source-controls';

test('source configuration can be generated and copied once without a scene; closing removes the displayed credential', async () => {
  localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
  const user = userEvent.setup();
  const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
  const data: unknown[] = [];
  const base = 'http://api.test/api/v1/lab/labs/lab/sources';
  const configuration = {
    format: 'lab-world-source-v1',
    source_id: 'source',
    lab_id: 'lab',
    server_url: 'http://127.0.0.1:3000',
    machine_id: 'machine',
    credential: 'private-once',
    expires_at: '2026-11-13T12:00:00Z',
  };
  server.use(
    http.get(base, () => HttpResponse.json({ data })),
    http.post(base, async ({ request }) => {
      expect(request.headers.get('x-csrf-token')).toBe('csrf-source');
      expect(await request.json()).toEqual({ name: 'Original world' });
      const source = {
        id: 'source',
        lab_id: 'lab',
        name: 'Original world',
        authorization: 'unconfigured',
        connection_state: 'offline',
        phase: null,
        epoch: '0',
        last_seen_at: null,
        source_run_id: null,
        connection_id: null,
        credential_expires_at: null,
      };
      data.push(source);
      return HttpResponse.json(source, { status: 201 });
    }),
    http.post(base + '/source/configuration', () =>
      HttpResponse.json(configuration, { status: 201 }),
    ),
  );
  const query = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={query}>
      <PreferencesProvider>
        <AppMessagesProvider app={labApp}>
          <SourceControls
            apiClient={createApiClient('http://api.test')}
            userId="operator"
            labId="lab"
            csrfToken="csrf-source"
          />
        </AppMessagesProvider>
      </PreferencesProvider>
    </QueryClientProvider>,
  );
  try {
    await user.click(screen.getByRole('button', { name: /Sources/ }));
    await user.type(screen.getByLabelText('Source name'), 'Original world');
    await user.click(
      screen.getByRole('button', { name: 'Create source configuration' }),
    );
    expect(await screen.findByLabelText('Source configuration')).toHaveValue(
      JSON.stringify(configuration, null, 2),
    );
    await user.click(
      screen.getByRole('button', { name: 'Copy configuration' }),
    );
    await waitFor(() =>
      expect(copy).toHaveBeenCalledWith(JSON.stringify(configuration, null, 2)),
    );
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(
      screen.queryByLabelText('Source configuration'),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Sources/ }));
    expect(
      screen.queryByLabelText('Source configuration'),
    ).not.toBeInTheDocument();
    expect(
      JSON.stringify(
        query
          .getQueryCache()
          .getAll()
          .map((q) => q.state.data),
      ),
    ).not.toContain('private-once');
  } finally {
    view.unmount();
    query.clear();
  }
});

test('source initialization, loss and revoked authorization are distinct and a denied action keeps the source visible', async () => {
  localStorage.setItem(LOCALE_STORAGE_KEY, 'en');
  const user = userEvent.setup();
  const source = {
    id: 'source',
    lab_id: 'lab',
    name: 'Original world',
    authorization: 'authorized',
    connection_state: 'connected',
    phase: 'initializing',
    epoch: '1',
    last_seen_at: '2026-10-14T12:00:00Z',
    source_run_id: 'run',
    connection_id: 'connection',
    credential_expires_at: '2026-11-13T12:00:00Z',
  };
  const base = 'http://api.test/api/v1/lab/labs/lab/sources';
  server.use(
    http.get(base, () => HttpResponse.json({ data: [source] })),
    http.post(base + '/source/revoke', () =>
      HttpResponse.json(
        {
          error: {
            code: 'auth.csrf',
            message: 'Denied',
            request_id: 'source-denied',
          },
        },
        { status: 403 },
      ),
    ),
  );
  const query = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={query}>
      <PreferencesProvider>
        <AppMessagesProvider app={labApp}>
          <SourceControls
            apiClient={createApiClient('http://api.test')}
            userId="operator"
            labId="lab"
            csrfToken="csrf-source"
          />
        </AppMessagesProvider>
      </PreferencesProvider>
    </QueryClientProvider>,
  );
  try {
    await user.click(screen.getByRole('button', { name: /Sources/ }));
    expect(await screen.findByText('Adapter initializing')).toBeInTheDocument();
    expect(screen.getByText('Source connected')).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: 'Revoke source access' }),
    );
    expect(
      await screen.findByText(/Source access was denied/),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('region', { name: 'Original world' }),
    ).toBeInTheDocument();
    source.connection_state = 'offline';
    source.authorization = 'revoked';
    await user.click(screen.getByRole('button', { name: 'Retry source list' }));
    expect(await screen.findByText('Access revoked')).toBeInTheDocument();
    expect(screen.getByText('Source offline')).toBeInTheDocument();
    expect(screen.queryByText('Adapter initializing')).not.toBeInTheDocument();
    expect(screen.getByText('2026-10-14T12:00:00Z')).toBeInTheDocument();
  } finally {
    view.unmount();
    query.clear();
  }
});
