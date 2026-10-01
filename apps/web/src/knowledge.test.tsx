import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import {
  createApiClient,
  type CurrentSession,
  type Document,
} from '@labos-threejs/sdk';
import { act, render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, test } from 'vitest';
import { server } from '../../../tests/frontend/server';
import { createAppRouter, navigateExample } from './router';

// The editor picks its layout from matchMedia; jsdom always reports
// narrow. Wide-layout tests install a controllable stub and get a
// restore function back.
function stubWideEditorLayout() {
  const original = window.matchMedia;
  let matches = false;
  let listener: (() => void) | undefined;
  window.matchMedia = ((query: string) => ({
    matches,
    media: query,
    onchange: null,
    addEventListener: (_: string, next: () => void) => {
      listener = next;
    },
    removeEventListener: () => {
      listener = undefined;
    },
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  return {
    resize(wide: boolean) {
      matches = wide;
      listener?.();
    },
    restore() {
      window.matchMedia = original;
    },
  };
}

test('keyboard preview renders Markdown safely and preserves the draft when returning to editing', async () => {
  const { user } = open('/documents/new');
  await user.click(await screen.findByLabelText('Markdown 正文'));
  await user.paste(
    '# 安全标题\n\n**重点** [文档](https://example.com) [危险](javascript:alert%281%29)\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>',
  );
  await user.click(screen.getByRole('tab', { name: '编辑' }));
  await user.keyboard('{ArrowRight}{Enter}');
  const preview = await screen.findByRole('tabpanel', { name: '预览' });
  expect(
    await within(preview).findByRole('heading', { name: '安全标题' }),
  ).toBeVisible();
  expect(within(preview).getByRole('link', { name: '文档' })).toHaveAttribute(
    'href',
    'https://example.com',
  );
  expect(within(preview).getByText('重点').tagName).toBe('STRONG');
  expect(preview.querySelector('script, img, iframe, [onerror]')).toBeNull();
  expect(within(preview).queryByRole('link', { name: '危险' })).toBeNull();
  await user.keyboard('{ArrowLeft}{Enter}');
  expect(
    (screen.getByLabelText('Markdown 正文') as HTMLTextAreaElement).value,
  ).toContain('# 安全标题');
});

test('the wide layout shows source and preview side by side and live-syncs the preview', async () => {
  const layout = stubWideEditorLayout();
  try {
    const { user } = open('/documents/new');
    // jsdom renders narrow first; the media query flips the layout live.
    act(() => layout.resize(true));
    const editor = await screen.findByLabelText('Markdown 正文');
    const container = editor.closest('[data-editor-layout]');
    expect(container).toHaveAttribute('data-editor-layout', 'wide');
    // No tab switcher on wide screens; both panes carry their names.
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(screen.getByText('编辑')).toBeVisible();
    expect(screen.getByText('预览')).toBeVisible();
    // Typing updates the preview without an explicit switch.
    await user.type(editor, '# 宽屏标题');
    const preview = screen.getByLabelText('预览');
    expect(
      await within(preview).findByRole('heading', { name: '宽屏标题' }),
    ).toBeVisible();
    expect(
      (screen.getByLabelText('Markdown 正文') as HTMLTextAreaElement).value,
    ).toContain('# 宽屏标题');
  } finally {
    layout.restore();
  }
});

test('crossing the layout breakpoint keeps the draft, the mode and the preview mounted', async () => {
  const layout = stubWideEditorLayout();
  try {
    const { user } = open('/documents/new');
    const editor = await screen.findByLabelText('Markdown 正文');
    await user.type(editor, '# 跨断言草稿');
    expect(
      screen.getByLabelText('Markdown 正文').closest('[data-editor-layout]'),
    ).toHaveAttribute('data-editor-layout', 'narrow');
    await user.click(screen.getByRole('tab', { name: '预览' }));
    expect(await screen.findByRole('tabpanel', { name: '预览' })).toBeVisible();

    act(() => layout.resize(true));

    const container = screen
      .getByLabelText('Markdown 正文')
      .closest('[data-editor-layout]');
    expect(container).toHaveAttribute('data-editor-layout', 'wide');
    expect(
      (screen.getByLabelText('Markdown 正文') as HTMLTextAreaElement).value,
    ).toContain('# 跨断言草稿');
    expect(screen.queryByRole('tablist')).toBeNull();
    expect(
      await within(screen.getByLabelText('预览')).findByRole('heading', {
        name: '跨断言草稿',
      }),
    ).toBeVisible();

    act(() => layout.resize(false));

    expect(
      screen.getByLabelText('Markdown 正文').closest('[data-editor-layout]'),
    ).toHaveAttribute('data-editor-layout', 'narrow');
    // The mode survives the round trip: the preview tab is selected again.
    expect(screen.getByRole('tab', { name: '预览' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(
      (screen.getByLabelText('Markdown 正文') as HTMLTextAreaElement).value,
    ).toContain('# 跨断言草稿');
  } finally {
    layout.restore();
  }
});

test('failed saves retain input and retry the same payload with the same idempotency key', async () => {
  const keys: string[] = [];
  server.use(
    http.post('http://api.test/api/v1/knowledge/documents', ({ request }) => {
      keys.push(request.headers.get('idempotency-key') ?? '');
      if (keys.length === 1)
        return HttpResponse.json(
          {
            error: {
              code: 'knowledge.unavailable',
              message: 'Try later',
              details: {},
              request_id: 'save-failed',
            },
          },
          { status: 503 },
        );
      return HttpResponse.json(document, { status: 201 });
    }),
    http.get(`http://api.test/api/v1/knowledge/documents/${document.id}`, () =>
      HttpResponse.json(document),
    ),
  );
  const { user, router } = open('/documents/new');
  await user.type(await screen.findByLabelText('标题'), document.title);
  await user.type(screen.getByLabelText('Markdown 正文'), document.markdown);
  await user.click(screen.getByRole('button', { name: '保存文档' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('save-failed');
  expect(screen.getByLabelText('标题')).toHaveValue(document.title);
  expect(screen.getByLabelText('Markdown 正文')).toHaveValue(document.markdown);
  expect(router.state.location.pathname).toBe('/documents/new');
  await user.click(screen.getByRole('button', { name: '保存文档' }));
  expect(
    await screen.findByRole('heading', { name: document.title }),
  ).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(keys[0]).toBeTruthy();
  expect(keys[1]).toBe(keys[0]);
});

test('search and pagination retain literal filters, reset on a new search, and recover from a page failure', async () => {
  const requests: URL[] = [];
  let failPage = true;
  server.use(
    http.get('http://api.test/api/v1/knowledge/documents', ({ request }) => {
      const url = new URL(request.url);
      requests.push(url);
      const q = url.searchParams.get('q');
      if (!q || q === 'missing')
        return HttpResponse.json({
          data: [],
          next_cursor: null,
          can_create: true,
          has_more: false,
        });
      if (url.searchParams.has('cursor')) {
        if (failPage) {
          failPage = false;
          return HttpResponse.json(
            {
              error: {
                code: 'knowledge.unavailable',
                message: 'Retry',
                details: {},
                request_id: 'page-failed',
              },
            },
            { status: 503 },
          );
        }
        return HttpResponse.json({
          data: [{ ...document, id: 'second', title: '第二页' }],
          next_cursor: null,
          can_create: true,
          has_more: false,
        });
      }
      return HttpResponse.json({
        data: [document],
        next_cursor: 'next-filtered-page',
        can_create: true,
        has_more: true,
      });
    }),
  );
  const { user } = open();
  await screen.findByText('暂无可访问的文档');
  await user.type(screen.getByLabelText('标题关键词'), '100%_notes{Enter}');
  expect(
    await screen.findByRole('button', { name: document.title }),
  ).toBeVisible();
  await user.click(screen.getByRole('button', { name: '加载更多' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('page-failed');
  expect(screen.getByRole('button', { name: document.title })).toBeVisible();
  await user.click(screen.getByRole('button', { name: '重试加载更多' }));
  expect(await screen.findByRole('button', { name: '第二页' })).toBeVisible();
  expect(requests.at(-1)?.searchParams.get('q')).toBe('100%_notes');
  expect(requests.at(-1)?.searchParams.get('cursor')).toBe(
    'next-filtered-page',
  );
  await user.clear(screen.getByLabelText('标题关键词'));
  await user.type(screen.getByLabelText('标题关键词'), 'missing{Enter}');
  expect(await screen.findByText('没有匹配的文档')).toBeVisible();
  expect(
    screen.queryByRole('button', { name: '第二页' }),
  ).not.toBeInTheDocument();
  expect(requests.at(-1)?.searchParams.has('cursor')).toBe(false);
  await user.click(screen.getByRole('button', { name: '清除搜索' }));
  expect(await screen.findByText('暂无可访问的文档')).toBeVisible();
});

test('a denied document displays a safe error without the document body', async () => {
  server.use(
    http.get(`http://api.test/api/v1/knowledge/documents/${document.id}`, () =>
      HttpResponse.json(
        {
          error: {
            code: 'knowledge.not_found',
            message: 'Not found',
            details: {},
            request_id: 'denied-document',
          },
        },
        { status: 404 },
      ),
    ),
  );
  open(`/documents/${document.id}`);
  expect(await screen.findByRole('alert')).toHaveTextContent('文档不存在');
  expect(screen.queryByText(/# 欢迎/)).not.toBeInTheDocument();
});

test('reading saved Markdown filters unsafe URLs and renders images as text without loading them', async () => {
  server.use(
    http.get(`http://api.test/api/v1/knowledge/documents/${document.id}`, () =>
      HttpResponse.json({
        ...document,
        markdown:
          '# 阅读\n\n[安全](https://example.com) [脚本](JaVaScRiPt:alert%281%29) [数据](data:text/html,hello) [实体](jav&#x61;script:alert%281%29)\n\n![私密图](https://tracker.test/pixel)\n\n<iframe src="https://tracker.test"></iframe>',
      }),
    ),
  );
  open(`/documents/${document.id}`);
  expect(await screen.findByRole('heading', { name: '阅读' })).toBeVisible();
  expect(screen.getByRole('link', { name: '安全' })).toHaveAttribute(
    'rel',
    'noopener noreferrer',
  );
  for (const name of ['脚本', '数据', '实体']) {
    expect(screen.queryByRole('link', { name })).not.toBeInTheDocument();
    expect(screen.getByText(name)).toBeVisible();
  }
  expect(screen.getByText('图片：私密图')).toBeVisible();
  expect(
    screen.getByRole('region', { name: '正文' }).querySelector('img, iframe'),
  ).toBeNull();
});

test('a failed initial search can be queried again through the page', async () => {
  let failed = false;
  server.use(
    http.get('http://api.test/api/v1/knowledge/documents', () => {
      if (!failed) {
        failed = true;
        return HttpResponse.json(
          {
            error: {
              code: 'knowledge.unavailable',
              message: 'Try again',
              details: {},
              request_id: 'search-failed',
            },
          },
          { status: 503 },
        );
      }
      return HttpResponse.json({
        data: [],
        next_cursor: null,
        can_create: true,
        has_more: false,
      });
    }),
  );
  const { user } = open();
  expect(await screen.findByRole('alert')).toHaveTextContent('search-failed');
  await user.click(screen.getByRole('button', { name: '重新查询' }));
  expect(await screen.findByText('暂无可访问的文档')).toBeVisible();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('invalid drafts show bounds without discarding text or requesting a save', async () => {
  const { user } = open('/documents/new');
  await user.type(await screen.findByLabelText('标题'), '   ');
  await user.click(screen.getByRole('button', { name: '保存文档' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    '请填写不超过 200 个字符的标题',
  );
  await user.clear(screen.getByLabelText('标题'));
  await user.type(screen.getByLabelText('标题'), '正文边界');
  const oversized = '字'.repeat(350_000);
  await user.click(screen.getByLabelText('Markdown 正文'));
  await user.paste(oversized);
  await user.click(screen.getByRole('tab', { name: '预览' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    '正文超过大小上限',
  );
  await user.click(screen.getByRole('button', { name: '保存文档' }));
  expect(screen.getByRole('alert')).toHaveTextContent('正文超过大小上限');
  await user.click(screen.getByRole('tab', { name: '编辑' }));
  expect(screen.getByLabelText('Markdown 正文')).toHaveValue(oversized);
});

test('a stale edit keeps its draft until the user reads and explicitly reconciles the latest version', async () => {
  let current = document;
  const submitted: unknown[] = [];
  server.use(
    http.get(`http://api.test/api/v1/knowledge/documents/${document.id}`, () =>
      HttpResponse.json(current),
    ),
    http.put(
      `http://api.test/api/v1/knowledge/documents/${document.id}`,
      async ({ request }) => {
        const body = (await request.json()) as {
          version: number;
          title: string;
          markdown: string;
        };
        submitted.push(body);
        if (body.version === 1) {
          current = {
            ...document,
            version: 2,
            title: '同事已保存的标题',
            markdown: '同事的正文',
          };
          return HttpResponse.json(
            {
              error: {
                code: 'document.version_conflict',
                message: 'Changed',
                details: {},
                request_id: 'stale-save',
              },
            },
            { status: 409 },
          );
        }
        current = { ...current, ...body, version: 3 };
        return HttpResponse.json(current);
      },
    ),
  );
  const { user, router } = open(`/documents/${document.id}/edit`);
  await user.clear(await screen.findByLabelText('Markdown 正文'));
  await user.type(screen.getByLabelText('Markdown 正文'), '我的未保存草稿');
  await user.click(screen.getByRole('button', { name: '保存文档' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('stale-save');
  expect(screen.getByLabelText('Markdown 正文')).toHaveValue('我的未保存草稿');
  await user.click(screen.getByRole('button', { name: '读取最新版本' }));
  expect(await screen.findByText('同事的正文')).toBeVisible();
  expect(screen.getByLabelText('Markdown 正文')).toHaveValue('我的未保存草稿');
  expect(screen.getByRole('button', { name: '保存文档' })).toBeDisabled();
  await user.click(
    screen.getByRole('button', { name: '已核对，保留草稿并继续' }),
  );
  await user.type(screen.getByLabelText('Markdown 正文'), '，已合并');
  await user.click(screen.getByRole('button', { name: '保存文档' }));
  expect(await screen.findByText('我的未保存草稿，已合并')).toBeVisible();
  expect(router.state.location.pathname).toBe(`/documents/${document.id}`);
  expect(submitted).toEqual([
    { version: 1, title: document.title, markdown: '我的未保存草稿' },
    { version: 2, title: document.title, markdown: '我的未保存草稿，已合并' },
  ]);
});

test('unsaved edits require an explicit choice before leaving and a cancelled exit retains the draft', async () => {
  server.use(
    http.get(`http://api.test/api/v1/knowledge/documents/${document.id}`, () =>
      HttpResponse.json(document),
    ),
  );
  const { user, router } = open(`/documents/${document.id}/edit`);
  await user.type(
    await screen.findByLabelText('Markdown 正文'),
    '未保存的内容',
  );
  await user.click(screen.getByRole('button', { name: '返回文档' }));
  expect(await screen.findByRole('alertdialog')).toHaveTextContent(
    '内容尚未保存',
  );
  await user.click(screen.getByRole('button', { name: '继续编辑' }));
  expect(router.state.location.pathname).toBe(`/documents/${document.id}/edit`);
  expect(
    (screen.getByLabelText('Markdown 正文') as HTMLTextAreaElement).value,
  ).toContain('未保存的内容');
  await user.click(screen.getByRole('button', { name: '返回文档' }));
  await user.click(await screen.findByRole('button', { name: '确认离开' }));
  expect(
    await screen.findByRole('heading', { name: document.title }),
  ).toBeVisible();
  expect(router.state.location.pathname).toBe(`/documents/${document.id}`);
});

test('background reads and a failed save keep the edit draft and its original version', async () => {
  let current = document;
  let release!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  server.use(
    http.get(`http://api.test/api/v1/knowledge/documents/${document.id}`, () =>
      HttpResponse.json(current),
    ),
    http.put(
      `http://api.test/api/v1/knowledge/documents/${document.id}`,
      async ({ request }) => {
        expect(await request.json()).toMatchObject({
          version: 1,
          markdown: '本地修改',
        });
        return pending;
      },
    ),
  );
  const { user, queryClient } = open(`/documents/${document.id}/edit`);
  await user.clear(await screen.findByLabelText('Markdown 正文'));
  await user.type(screen.getByLabelText('Markdown 正文'), '本地修改');
  current = { ...document, version: 2, markdown: '远端修改' };
  await act(async () => {
    await queryClient.invalidateQueries({
      queryKey: ['knowledge', 'document'],
    });
  });
  expect(screen.getByLabelText('Markdown 正文')).toHaveValue('本地修改');
  expect(screen.getByText('基于版本 1 编辑')).toBeVisible();
  await user.click(screen.getByRole('button', { name: '保存文档' }));
  expect(screen.getByRole('button', { name: '正在保存…' })).toBeDisabled();
  expect(screen.getByLabelText('Markdown 正文')).toBeDisabled();
  await act(async () => {
    release(
      HttpResponse.json(
        {
          error: {
            code: 'knowledge.unavailable',
            message: 'Try later',
            details: {},
            request_id: 'edit-failed',
          },
        },
        { status: 503 },
      ),
    );
  });
  expect(await screen.findByRole('alert')).toHaveTextContent('edit-failed');
  expect(screen.getByLabelText('Markdown 正文')).toHaveValue('本地修改');
  expect(screen.getByRole('button', { name: '保存文档' })).toBeEnabled();
});

const identity = {
  user: {
    id: 'member-one',
    email: 'writer@example.com',
    display_name: '写作者',
    role: 'member',
  },
  csrf_token: 'csrf-proof',
} satisfies CurrentSession;
const document = {
  can_edit: true,
  id: '018f0000-0000-7000-8000-000000000001',
  knowledge_base_id: '018f0000-0000-7000-8000-000000000002',
  title: '团队手册',
  markdown: '# 欢迎\n第一篇正文',
  version: 1,
  created_by: identity.user.id,
  updated_by: identity.user.id,
  created_at: '2026-09-25T00:00:00Z',
  updated_at: '2026-09-25T00:00:00Z',
} satisfies Document;

test('a Reader sees the saved document without an edit action and cannot edit via a direct route', async () => {
  server.use(
    http.get(`http://api.test/api/v1/knowledge/documents/${document.id}`, () =>
      HttpResponse.json({ ...document, can_edit: false }),
    ),
  );
  const { router } = open(`/documents/${document.id}`);
  await screen.findByRole('heading', { name: document.title });
  expect(
    screen.queryByRole('button', { name: '编辑文档' }),
  ).not.toBeInTheDocument();
  await act(async () => {
    await navigateExample(router, {
      path: '/documents/$documentId/edit',
      params: { documentId: document.id },
    });
  });
  expect(
    await screen.findByText('你拥有只读权限，不能保存修改。'),
  ).toBeVisible();
  expect(screen.getByLabelText('Markdown 正文')).toBeDisabled();
  expect(screen.getByRole('button', { name: '保存文档' })).toBeDisabled();
});

test('a rejected save refreshes permissions and blocks further saves without discarding the draft', async () => {
  let canEdit = true;
  server.use(
    http.get(`http://api.test/api/v1/knowledge/documents/${document.id}`, () =>
      HttpResponse.json({ ...document, can_edit: canEdit }),
    ),
    http.put(
      `http://api.test/api/v1/knowledge/documents/${document.id}`,
      () => {
        canEdit = false;
        return HttpResponse.json(
          {
            error: {
              code: 'knowledge.forbidden',
              message: 'Revoked',
              details: {},
              request_id: 'revoked-save',
            },
          },
          { status: 403 },
        );
      },
    ),
  );
  const { user } = open(`/documents/${document.id}/edit`);
  await user.type(
    await screen.findByLabelText('Markdown 正文'),
    '保留这份草稿',
  );
  await user.click(screen.getByRole('button', { name: '保存文档' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('revoked-save');
  expect(screen.getByRole('button', { name: '保存文档' })).toBeDisabled();
  expect(
    (screen.getByLabelText('Markdown 正文') as HTMLTextAreaElement).value,
  ).toContain('保留这份草稿');
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '重新查询权限' })).toBeEnabled(),
  );
  canEdit = true;
  await user.click(screen.getByRole('button', { name: '重新查询权限' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '保存文档' })).toBeEnabled(),
  );
  expect(
    (screen.getByLabelText('Markdown 正文') as HTMLTextAreaElement).value,
  ).toContain('保留这份草稿');
});

test('a new personal draft stays blocked after denied creation until current permission is restored', async () => {
  let allowed = true;
  server.use(
    http.post('http://api.test/api/v1/knowledge/documents', () => {
      allowed = false;
      return HttpResponse.json(
        {
          error: {
            code: 'knowledge.forbidden',
            message: 'Revoked',
            details: {},
            request_id: 'revoked-create',
          },
        },
        { status: 403 },
      );
    }),
  );
  const { user } = open('/documents/new', () => allowed);
  await user.type(await screen.findByLabelText('标题'), '保留新草稿');
  await user.type(screen.getByLabelText('Markdown 正文'), '新正文');
  await user.click(screen.getByRole('button', { name: '保存文档' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('revoked-create');
  expect(screen.getByRole('button', { name: '保存文档' })).toBeDisabled();
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '重新查询权限' })).toBeEnabled(),
  );
  allowed = true;
  await user.click(screen.getByRole('button', { name: '重新查询权限' }));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: '保存文档' })).toBeEnabled(),
  );
  expect(screen.getByLabelText('标题')).toHaveValue('保留新草稿');
  expect(screen.getByLabelText('Markdown 正文')).toHaveValue('新正文');
});

function open(path = '/documents', canCreate = () => true) {
  server.use(
    http.get('http://api.test/api/v1/knowledge/documents/:id/exports', () =>
      HttpResponse.json({ data: [], next_cursor: null, has_more: false }),
    ),
    http.get('http://api.test/api/v1/knowledge/documents/:id/attachments', () =>
      HttpResponse.json({
        data: [],
        can_upload: true,
        can_delete: true,
        max_upload_bytes: 20971520,
        next_cursor: null,
        has_more: false,
      }),
    ),
  );
  if (path === '/documents/new')
    server.use(
      http.get('http://api.test/api/v1/knowledge/documents', ({ request }) => {
        if (new URL(request.url).searchParams.get('limit') === '1')
          return HttpResponse.json({
            data: [],
            next_cursor: null,
            has_more: false,
            can_create: canCreate(),
          });
      }),
    );
  server.use(
    http.get('http://api.test/api/v1/auth/session', () =>
      HttpResponse.json(identity),
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
  return { user: userEvent.setup(), router, queryClient };
}

test('a save completing during an identity refresh cannot repopulate the former identity cache', async () => {
  let releaseSave!: (response: Response) => void;
  let releaseList!: (response: Response) => void;
  let sawRefetch!: () => void;
  const saved = new Promise<Response>((resolve) => {
    releaseSave = resolve;
  });
  const refreshed = new Promise<Response>((resolve) => {
    releaseList = resolve;
  });
  const refetchStarted = new Promise<void>((resolve) => {
    sawRefetch = resolve;
  });
  let listCalls = 0;
  const empty = () =>
    HttpResponse.json({
      data: [],
      next_cursor: null,
      can_create: true,
      has_more: false,
    });
  server.use(
    http.post('http://api.test/api/v1/knowledge/documents', () => saved),
    http.get('http://api.test/api/v1/knowledge/documents', () => {
      if (++listCalls === 2) {
        sawRefetch();
        return refreshed;
      }
      return empty();
    }),
    http.get(`http://api.test/api/v1/knowledge/documents/${document.id}`, () =>
      HttpResponse.json(
        {
          error: {
            code: 'knowledge.not_found',
            message: 'Not found',
            details: {},
            request_id: 'other-identity',
          },
        },
        { status: 404 },
      ),
    ),
  );
  const { user, router, queryClient } = open('/documents/new');
  queryClient.setQueryDefaults(['knowledge', 'document'], { gcTime: Infinity });
  await user.type(await screen.findByLabelText('标题'), document.title);
  await user.click(screen.getByRole('button', { name: '保存文档' }));
  await user.click(screen.getByRole('button', { name: '我的文档' }));
  await user.click(await screen.findByRole('button', { name: '确认离开' }));
  await screen.findByText('暂无可访问的文档');
  try {
    await act(async () => {
      releaseSave(HttpResponse.json(document, { status: 201 }));
      await refetchStarted;
    });
    server.use(
      http.get('http://api.test/api/v1/auth/session', () =>
        HttpResponse.json({
          ...identity,
          user: { ...identity.user, id: 'member-two' },
        }),
      ),
    );
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ['session'] });
    });
    expect(router.state.location.pathname).toBe('/documents');
    expect(
      queryClient.getQueryData([
        'knowledge',
        'document',
        identity.user.id,
        document.id,
      ]),
    ).toBeUndefined();
  } finally {
    releaseList(empty());
  }
});

test('an empty personal space leads to creation and the saved document detail', async () => {
  server.use(
    http.get('http://api.test/api/v1/knowledge/documents', () =>
      HttpResponse.json({
        data: [],
        next_cursor: null,
        can_create: true,
        has_more: false,
      }),
    ),
    http.post(
      'http://api.test/api/v1/knowledge/documents',
      async ({ request }) => {
        expect(request.headers.get('x-csrf-token')).toBe(identity.csrf_token);
        expect(request.headers.get('idempotency-key')).toBeTruthy();
        expect(await request.json()).toEqual({
          title: document.title,
          markdown: document.markdown,
        });
        return HttpResponse.json(document, { status: 201 });
      },
    ),
    http.get(`http://api.test/api/v1/knowledge/documents/${document.id}`, () =>
      HttpResponse.json(document),
    ),
  );
  const { user, router } = open();
  expect(await screen.findByText('暂无可访问的文档')).toBeVisible();
  await user.click(screen.getByRole('button', { name: '新建文档' }));
  await user.type(await screen.findByLabelText('标题'), document.title);
  await user.type(screen.getByLabelText('Markdown 正文'), document.markdown);
  await user.click(screen.getByRole('button', { name: '保存文档' }));
  expect(
    await screen.findByRole('heading', { name: document.title }),
  ).toBeVisible();
  expect(await screen.findByRole('heading', { name: '欢迎' })).toBeVisible();
  expect(screen.getByText('第一篇正文')).toBeVisible();
  expect(router.state.location.pathname).toBe(`/documents/${document.id}`);
});
