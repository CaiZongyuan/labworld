import { webcrypto } from 'node:crypto';
// MSW builds Node Requests; use the matching File implementation for byte bodies.
import { File as NativeFile } from 'node:buffer';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import {
  createApiClient,
  type CurrentSession,
  type Document,
  type FileInfo,
} from '@labos-threejs/sdk';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { server } from '../../../tests/frontend/server';
import { createAppRouter } from './router';

beforeEach(() => vi.stubGlobal('crypto', webcrypto));
afterEach(() => vi.unstubAllGlobals());
const identity = {
  user: {
    id: 'writer',
    email: 'writer@example.com',
    display_name: null,
    role: 'member',
  },
  csrf_token: 'csrf-proof',
} satisfies CurrentSession;
const document = {
  id: 'doc-one',
  knowledge_base_id: 'base-one',
  title: '附件页面',
  markdown: '正文',
  can_edit: true,
  version: 1,
  created_by: 'writer',
  updated_by: 'writer',
  created_at: '2026-09-26T00:00:00Z',
  updated_at: '2026-09-26T00:00:00Z',
} satisfies Document;
const attachment = {
  id: 'upload-one',
  file_name: 'hello.txt',
  content_type: 'text/plain',
  size: 5,
  sha256: '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
  created_at: '2026-09-26T00:00:00Z',
  previewable: false,
} satisfies FileInfo;
const imageAttachment = {
  ...attachment,
  id: 'upload-image',
  file_name: '图.png',
  content_type: 'image/png',
  size: 2048,
  previewable: true,
} satisfies FileInfo;

function open(
  path = '/documents/doc-one',
  canEdit = true,
  markdown = document.markdown,
) {
  server.use(
    http.get('http://api.test/api/v1/knowledge/documents/:id/exports', () =>
      HttpResponse.json({ data: [], next_cursor: null, has_more: false }),
    ),
    http.get('http://api.test/api/v1/auth/session', () =>
      HttpResponse.json(identity),
    ),
    http.get('http://api.test/api/v1/knowledge/documents/doc-one', () =>
      HttpResponse.json({ ...document, can_edit: canEdit, markdown }),
    ),
  );
  const router = createAppRouter(
    {
      apiClient: createApiClient('http://api.test'),
      docsUrl: 'https://docs.test',
    },
    createMemoryHistory({ initialEntries: [path] }),
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

test('upload progress, failure and retry preserve the upload identity until publication', async () => {
  let published = false;
  let attempts = 0;
  const keys: string[] = [];
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.use(
    http.get(
      'http://api.test/api/v1/knowledge/documents/doc-one/attachments',
      () =>
        HttpResponse.json({
          data: published ? [attachment, imageAttachment] : [],
          can_upload: true,
          can_delete: true,
          max_upload_bytes: 20971520,
          next_cursor: null,
          has_more: false,
        }),
    ),
    http.post(
      'http://api.test/api/v1/knowledge/documents/doc-one/uploads',
      async ({ request }) => {
        keys.push(request.headers.get('idempotency-key') ?? '');
        expect(await request.json()).toEqual({
          file_name: 'hello.txt',
          content_type: 'text/plain',
          size: 5,
          sha256: attachment.sha256,
        });
        return HttpResponse.json(
          {
            upload_id: attachment.id,
            state: 'pending_upload',
            upload: {
              url: 'http://storage.test/upload',
              method: 'PUT',
              headers: { 'content-type': 'text/plain' },
              expires_at: new Date(Date.now() + 60_000).toISOString(),
            },
          },
          { status: 201 },
        );
      },
    ),
    http.put('http://storage.test/upload', async ({ request }) => {
      expect(await request.text()).toBe('hello');
      if (++attempts === 1) {
        await pending;
        return new HttpResponse(null, { status: 503 });
      }
      return new HttpResponse(null, { status: 200 });
    }),
    http.post(
      'http://api.test/api/v1/knowledge/documents/doc-one/uploads/upload-one/complete',
      () => {
        published = true;
        return HttpResponse.json(attachment);
      },
    ),
  );
  const user = open();
  const picker = await screen.findByLabelText('选择附件');
  await waitFor(() => expect(picker).toBeEnabled());
  await user.upload(
    picker,
    new NativeFile(['hello'], 'hello.txt', {
      type: 'text/plain',
    }) as unknown as File,
  );
  await user.click(screen.getByRole('button', { name: '上传附件' }));
  expect(
    await screen.findByRole('progressbar', { name: '附件上传进度' }),
  ).toBeVisible();
  await act(async () => {
    release();
  });
  expect(await screen.findByRole('alert')).toHaveTextContent('上传失败');
  await user.click(screen.getByRole('button', { name: '重试上传' }));
  expect(
    await screen.findByRole('button', { name: '下载 hello.txt' }),
  ).toBeVisible();
  // Each published row resolves its file-type icon from the name and
  // MIME (hello.txt → document, 图.png → image); the type is never
  // icon-only — the row shows the file name and the download button
  // carries a localized accessible name. Each row is reachable through
  // its uniquely labeled download button.
  expect(
    screen
      .getByRole('button', { name: '下载 hello.txt' })
      .closest('li')
      ?.querySelector('img[data-material-file-icon]'),
  ).toHaveAttribute('data-material-file-icon', 'document');
  expect(
    screen
      .getByRole('button', { name: '下载 图.png' })
      .closest('li')
      ?.querySelector('img[data-material-file-icon]'),
  ).toHaveAttribute('data-material-file-icon', 'image');
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBeTruthy();
  expect(keys[1]).toBe(keys[0]);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('a file above the returned limit is rejected before hashing or sending bytes', async () => {
  server.use(
    http.get(
      'http://api.test/api/v1/knowledge/documents/doc-one/attachments',
      () =>
        HttpResponse.json({
          data: [],
          can_upload: true,
          can_delete: true,
          max_upload_bytes: 4,
          next_cursor: null,
          has_more: false,
        }),
    ),
  );
  const user = open();
  const picker = await screen.findByLabelText('选择附件');
  await waitFor(() => expect(picker).toBeEnabled());
  await user.upload(
    picker,
    new NativeFile(['too large'], 'large.txt', {
      type: 'text/plain',
    }) as unknown as File,
  );
  await user.click(screen.getByRole('button', { name: '上传附件' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('超过上传上限');
  expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
});

test('a Reader can see the attachment download action without upload controls', async () => {
  server.use(
    http.get(
      'http://api.test/api/v1/knowledge/documents/doc-one/attachments',
      () =>
        HttpResponse.json({
          data: [attachment],
          can_upload: false,
          can_delete: false,
          max_upload_bytes: 20971520,
          next_cursor: null,
          has_more: false,
        }),
    ),
  );
  open('/documents/doc-one', false);
  expect(
    await screen.findByRole('button', { name: '下载 hello.txt' }),
  ).toBeVisible();
  expect(screen.queryByLabelText('选择附件')).not.toBeInTheDocument();
});

test('a revoked Reader sees a recoverable download denial and refreshed attachment access', async () => {
  let revoked = false;
  server.use(
    http.get(
      'http://api.test/api/v1/knowledge/documents/doc-one/attachments',
      () =>
        revoked
          ? HttpResponse.json(
              {
                error: {
                  code: 'knowledge.not_found',
                  message: 'Not found',
                  request_id: 'denial-id',
                },
              },
              { status: 404 },
            )
          : HttpResponse.json({
              data: [attachment],
              can_upload: false,
              can_delete: false,
              max_upload_bytes: 20971520,
              next_cursor: null,
              has_more: false,
            }),
    ),
    http.get(
      'http://api.test/api/v1/knowledge/documents/doc-one/attachments/upload-one/download',
      () => {
        revoked = true;
        return HttpResponse.json(
          {
            error: {
              code: 'knowledge.not_found',
              message: 'Not found',
              request_id: 'denial-id',
            },
          },
          { status: 404 },
        );
      },
    ),
  );
  const user = open('/documents/doc-one', false);
  await user.click(
    await screen.findByRole('button', { name: '下载 hello.txt' }),
  );
  await waitFor(() =>
    expect(
      screen.queryByRole('button', { name: '下载 hello.txt' }),
    ).not.toBeInTheDocument(),
  );
  expect(
    screen
      .getAllByRole('alert')
      .some((alert) => alert.textContent?.includes('访问权限已失效')),
  ).toBe(true);
  expect(screen.getByRole('button', { name: '重新查询附件' })).toBeEnabled();
});

test('an uploaded attachment can be inserted into the unsaved Markdown draft', async () => {
  server.use(
    http.get(
      'http://api.test/api/v1/knowledge/documents/doc-one/attachments',
      () =>
        HttpResponse.json({
          data: [attachment],
          can_upload: true,
          can_delete: true,
          max_upload_bytes: 20971520,
          next_cursor: null,
          has_more: false,
        }),
    ),
  );
  const user = open('/documents/doc-one/edit');
  await user.click(await screen.findByRole('button', { name: '插入引用' }));
  expect(
    (screen.getByLabelText('Markdown 正文') as HTMLTextAreaElement).value,
  ).toContain('[hello.txt](attachment:upload-one)');
  expect(screen.getByRole('button', { name: '保存文档' })).toBeEnabled();
});

test('Markdown attachment images obtain an authorized URL while arbitrary images stay text', async () => {
  const id = '018f0000-0000-7000-8000-000000000004';
  server.use(
    http.get(
      'http://api.test/api/v1/knowledge/documents/doc-one/attachments',
      () =>
        HttpResponse.json({
          data: [],
          can_upload: false,
          can_delete: false,
          max_upload_bytes: 20971520,
          next_cursor: null,
          has_more: false,
        }),
    ),
    http.get(
      `http://api.test/api/v1/knowledge/documents/doc-one/attachments/${id}/download`,
      ({ request }) => {
        expect(new URL(request.url).searchParams.get('inline')).toBe('true');
        return HttpResponse.json({
          url: 'http://storage.test/protected-image',
          method: 'GET',
          headers: {},
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          file: {
            ...attachment,
            id,
            file_name: 'picture.png',
            content_type: 'image/png',
            previewable: true,
          },
        });
      },
    ),
  );
  open(
    '/documents/doc-one',
    false,
    `![图示](attachment:${id})\n\n![外部图片](https://tracker.test/pixel)\n\n![坏引用](attachment:../../secret)`,
  );
  expect(await screen.findByRole('img', { name: '图示' })).toHaveAttribute(
    'src',
    'http://storage.test/protected-image',
  );
  expect(
    screen.queryByRole('img', { name: '外部图片' }),
  ).not.toBeInTheDocument();
  expect(screen.queryByRole('img', { name: '坏引用' })).not.toBeInTheDocument();
});

test('a failed image waits for a fresh authorized URL before retrying the browser load', async () => {
  const id = '018f0000-0000-7000-8000-000000000004';
  let requests = 0;
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.use(
    http.get(
      'http://api.test/api/v1/knowledge/documents/doc-one/attachments',
      () =>
        HttpResponse.json({
          data: [],
          can_upload: false,
          can_delete: false,
          max_upload_bytes: 20971520,
          next_cursor: null,
          has_more: false,
        }),
    ),
    http.get(
      `http://api.test/api/v1/knowledge/documents/doc-one/attachments/${id}/download`,
      async () => {
        const generation = ++requests;
        if (generation === 2) await pending;
        return HttpResponse.json({
          url: `http://storage.test/image-${generation}`,
          method: 'GET',
          headers: {},
          expires_at: new Date(Date.now() + 60_000).toISOString(),
          file: { ...attachment, id, previewable: true },
        });
      },
    ),
  );
  const user = open('/documents/doc-one', false, `![图示](attachment:${id})`);
  fireEvent.error(await screen.findByRole('img', { name: '图示' }));
  await user.click(screen.getByRole('button', { name: '重新读取图片：图示' }));
  expect(screen.queryByRole('img', { name: '图示' })).not.toBeInTheDocument();
  await act(async () => {
    release();
  });
  expect(await screen.findByRole('img', { name: '图示' })).toHaveAttribute(
    'src',
    'http://storage.test/image-2',
  );
});

test('a stalled upload times out and permits retrying the same upload resource', async () => {
  let requests = 0;
  const keys: string[] = [];
  let release!: () => void;
  let reached!: () => void;
  const stalled = new Promise<void>((resolve) => {
    release = resolve;
  });
  const entered = new Promise<void>((resolve) => {
    reached = resolve;
  });
  server.use(
    http.get(
      'http://api.test/api/v1/knowledge/documents/doc-one/attachments',
      () =>
        HttpResponse.json({
          data: [],
          can_upload: true,
          can_delete: true,
          max_upload_bytes: 20971520,
          next_cursor: null,
          has_more: false,
        }),
    ),
    http.post(
      'http://api.test/api/v1/knowledge/documents/doc-one/uploads',
      ({ request }) => {
        keys.push(request.headers.get('idempotency-key')!);
        return HttpResponse.json(
          {
            upload_id: attachment.id,
            state: 'pending_upload',
            upload: {
              url: 'http://storage.test/stalled-upload',
              method: 'PUT',
              headers: {},
              expires_at: new Date(Date.now() + 900_000).toISOString(),
            },
          },
          { status: 201 },
        );
      },
    ),
    http.put('http://storage.test/stalled-upload', async () => {
      if (++requests === 1) {
        reached();
        await stalled;
      }
      return new HttpResponse(null, { status: 503 });
    }),
  );
  const user = open();
  const picker = await screen.findByLabelText('选择附件');
  await waitFor(() => expect(picker).toBeEnabled());
  await user.upload(
    picker,
    new NativeFile(['hello'], 'hello.txt', {
      type: 'text/plain',
    }) as unknown as File,
  );
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    fireEvent.click(screen.getByRole('button', { name: '上传附件' }));
    await act(async () => {
      await vi.waitFor(() => expect(requests).toBe(1));
      await entered;
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_001);
    });
    expect(screen.getByRole('button', { name: '重试上传' })).toBeEnabled();
    expect(screen.getByRole('alert')).toHaveTextContent('上传失败');
  } finally {
    vi.useRealTimers();
    await act(async () => {
      release();
    });
  }
  await user.click(screen.getByRole('button', { name: '重试上传' }));
  await waitFor(() => expect(keys).toHaveLength(2));
  expect(keys[1]).toBe(keys[0]);
});

test('a stalled download releases its controls after the transfer deadline', async () => {
  let requested = false;
  let release!: () => void;
  const stalled = new Promise<void>((resolve) => {
    release = resolve;
  });
  server.use(
    http.get(
      'http://api.test/api/v1/knowledge/documents/doc-one/attachments',
      () =>
        HttpResponse.json({
          data: [attachment],
          can_upload: false,
          can_delete: false,
          max_upload_bytes: 20971520,
          next_cursor: null,
          has_more: false,
        }),
    ),
    http.get(
      'http://api.test/api/v1/knowledge/documents/doc-one/attachments/upload-one/download',
      () =>
        HttpResponse.json({
          url: 'http://storage.test/stalled-download',
          method: 'GET',
          headers: {},
          file: attachment,
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        }),
    ),
    http.get('http://storage.test/stalled-download', async () => {
      requested = true;
      await stalled;
      return HttpResponse.text('hello');
    }),
  );
  open('/documents/doc-one', false);
  const button = await screen.findByRole('button', { name: '下载 hello.txt' });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    fireEvent.click(button);
    await act(async () => {
      await vi.waitFor(() => expect(requested).toBe(true));
    });
    expect(button).toBeDisabled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_001);
    });
    expect(button).toBeEnabled();
    expect(screen.getByRole('alert')).toHaveTextContent('下载暂时不可用');
  } finally {
    vi.useRealTimers();
    await act(async () => {
      release();
    });
  }
});

test('inline images and attachment links preserve rate-limit hints and wait before retrying', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
  try {
    const imageId = '0195c9a0-0000-7000-8000-000000000010';
    const fileId = '0195c9a0-0000-7000-8000-000000000011';
    let calls = 0;
    server.use(
      http.get(
        'http://api.test/api/v1/knowledge/documents/doc-one/attachments',
        () =>
          HttpResponse.json({
            data: [],
            can_upload: false,
            can_delete: false,
            max_upload_bytes: 20971520,
            next_cursor: null,
            has_more: false,
          }),
      ),
      http.get(
        'http://api.test/api/v1/knowledge/documents/doc-one/attachments/:file/download',
        () => {
          calls++;
          return HttpResponse.json(
            {
              error: {
                code: 'rate_limit.exceeded',
                message: 'Wait',
                request_id: 'inline-wait',
                details: { retry_after_seconds: '2' },
              },
            },
            { status: 429, headers: { 'Retry-After': '2' } },
          );
        },
      ),
    );
    const user = open(
      '/documents/doc-one',
      false,
      `![图示](attachment:${imageId})\n\n[原始资料](attachment:${fileId})`,
    );
    expect(
      await screen.findByText('请求过于频繁，请 2 秒后重试。'),
    ).toBeVisible();
    expect(screen.getByRole('button', { name: /图示/ })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: '原始资料' }));
    await waitFor(() =>
      expect(screen.getAllByText('请求过于频繁，请 2 秒后重试。')).toHaveLength(
        2,
      ),
    );
    expect(screen.getByRole('button', { name: /原始资料/ })).toBeDisabled();
    expect(calls).toBe(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });
    expect(
      screen.getByRole('button', { name: '重新读取图片：图示' }),
    ).toBeEnabled();
    expect(screen.getByRole('button', { name: '原始资料' })).toBeEnabled();
    expect(calls).toBe(2);
  } finally {
    vi.useRealTimers();
  }
});
