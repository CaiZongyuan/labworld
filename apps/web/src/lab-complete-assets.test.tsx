import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { createApiClient, type CurrentSession } from '@labos-threejs/sdk';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, test } from 'vitest';
import { server } from '../../../tests/frontend/server';
import { createAppRouter } from './router';

const identity = {
  user: {
    id: 'asset-user',
    email: 'asset@example.test',
    display_name: 'Asset reader',
    role: 'member',
  },
  csrf_token: 'asset-csrf',
} satisfies CurrentSession;
const version = {
  id: '11111111-1111-4111-8111-111111111111',
  asset_id: 'example/centrifuge-c',
  namespace: 'example',
  version: '1.0.0',
  content_sha256: 'a'.repeat(64),
  definition: {
    schema_version: 1,
    asset_id: 'example/centrifuge-c',
    version: '1.0.0',
    name: '离心机 C',
    name_en: 'Centrifuge C',
    category: 'instrument',
    manufacturer: 'Example Instruments',
    model: 'C-15',
    source: 'Manufacturer manual',
    license: 'CC0',
    specifications: { maximum_speed: { value: 15000, unit: 'rpm' } },
    configuration_schema: {
      type: 'object',
      properties: { rotor: { type: 'string' } },
    },
    state_schema: {
      type: 'object',
      properties: {
        speed: { type: 'number', unit: 'rpm' },
        temperature: { type: 'number', unit: 'degC' },
      },
    },
    capabilities: [
      {
        id: 'centrifuge.start',
        version: '1.0',
        parameters: {
          type: 'object',
          properties: { rpm: { type: 'integer', maximum: 15000 } },
        },
        result: { type: 'boolean' },
      },
    ],
  },
  resources: [
    {
      key: 'manual',
      format: 'pdf',
      file_id: '22222222-2222-4222-8222-222222222222',
      file_name: 'manual.pdf',
      content_type: 'application/pdf',
      sha256: 'b'.repeat(64),
      size: 1024,
      representation_id: null,
      verification: 'pdf-header',
    },
  ],
  representations: [
    {
      key: 'manual',
      purpose: 'documentation',
      resource_keys: ['manual'],
      components: [],
    },
  ],
  created_by: identity.user.id,
  created_at: '2026-10-14T00:00:00Z',
};
function openAssets() {
  server.use(
    http.get('http://api.test/api/v1/auth/session', () =>
      HttpResponse.json(identity),
    ),
    http.get('http://api.test/api/v1/lab/assets', () =>
      HttpResponse.json({
        data: [],
        has_more: false,
        next_cursor: null,
        max_upload_bytes: 20 * 1024 * 1024,
      }),
    ),
    http.get('http://api.test/api/v1/lab/asset-definitions', () =>
      HttpResponse.json({ data: [] }),
    ),
    http.get('http://api.test/api/v1/lab/asset-versions', () =>
      HttpResponse.json({
        data: [version],
        has_more: false,
        next_cursor: null,
      }),
    ),
  );
  const router = createAppRouter(
    {
      apiClient: createApiClient('http://api.test'),
      docsUrl: 'https://docs.test',
    },
    createMemoryHistory({ initialEntries: ['/assets'] }),
  );
  render(
    <QueryClientProvider
      client={
        new QueryClient({
          defaultOptions: { queries: { retry: false, gcTime: 0 } },
        })
      }
    >
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return userEvent.setup();
}
test('the asset library shows complete fixed-version information without instance measurements or editing controls', async () => {
  const user = openAssets();
  await user.click(
    await screen.findByRole('button', { name: '查看资产信息 离心机 C v1.0.0' }),
  );
  const dialog = await screen.findByRole('dialog', { name: '离心机 C' });
  expect(within(dialog).getByText('Example Instruments')).toBeInTheDocument();
  expect(within(dialog).getByText('C-15')).toBeInTheDocument();
  expect(within(dialog).getByText('配置字段')).toBeInTheDocument();
  expect(within(dialog).getByText('状态字段')).toBeInTheDocument();
  expect(dialog).toHaveTextContent('rpm');
  expect(dialog).toHaveTextContent('degC');
  expect(dialog).toHaveTextContent('centrifuge.start');
  expect(dialog).toHaveTextContent('文档');
  expect(
    within(dialog).getByRole('button', { name: '下载 manual.pdf' }),
  ).toBeInTheDocument();
  expect(
    within(dialog).queryByRole('button', { name: /启动|保存|编辑/ }),
  ).not.toBeInTheDocument();
});
