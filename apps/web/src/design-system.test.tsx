import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createMemoryHistory, RouterProvider } from '@tanstack/react-router';
import { createApiClient, type CurrentSession } from '@labos-threejs/sdk';
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, test } from 'vitest';
import { server } from '../../../tests/frontend/server';
import { createAppRouter } from './router';
import { app } from './app';

// The design-system page (UI05): reachable from the sidebar and from
// settings for
// signed-in users, reading production tokens and components, rendering
// example-registered scenes from the real assembly, with search, copy
// feedback, stateful demos and an overlay. Scene assertions are written
// combo-agnostically so the example-removal job exercises the same file.

const signedIn = {
  user: {
    id: 'design-system-user',
    email: 'design-system@example.com',
    display_name: '展厅用户',
    role: 'member',
  },
  csrf_token: 'design-system-csrf',
} satisfies CurrentSession;

async function open(path = '/design-system') {
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
  const user = userEvent.setup();
  if (path === '/design-system')
    await screen.findByRole(
      'tab',
      {
        name:
          window.localStorage.getItem('labos-threejs.locale') === 'en'
            ? 'Foundation'
            : '基础',
      },
      { timeout: 5000 },
    );
  return { user, router };
}

test('the sidebar entry opens the showroom; the page renames the document', async () => {
  const { user } = await open('/');
  await screen.findByText('你好，展厅用户');
  await user.click(screen.getByRole('link', { name: '设置' }));
  await user.click(
    await within(
      screen.getByRole('navigation', { name: '设置目录' }),
    ).findByRole('link', { name: '设计系统' }),
  );
  expect(
    await screen.findByRole('heading', { name: '设计系统' }),
  ).toBeVisible();
  expect(document.title).toBe('设计系统 · Lab Word');
  await screen.findByRole('tab', { name: '基础' }, { timeout: 5000 });
  for (const tab of ['基础', '组件', '场景', '图标'])
    expect(
      screen.getByRole('tab', { name: tab }),
      `tab ${tab} should exist`,
    ).toBeVisible();
  // The tutorial link deep-links into this chapter's zh docs page.
  expect(
    screen.getByRole('link', {
      name: '查看「选用生产组件与注册演示场景」教程',
    }),
  ).toHaveAttribute('href', 'https://docs.test/tutorials/design-system');
});

test('foundation lists production tokens with search and copy of the live value', async () => {
  const { user } = await open();
  await screen.findByRole('heading', { name: '设计系统' });
  // The foundation tab is the landing tab; tokens render from the live
  // computed styles, not a second color table.
  expect(screen.getByText('--primary')).toBeVisible();
  expect(screen.getByText('--radius')).toBeVisible();

  await user.type(
    screen.getByRole('searchbox', { name: '按名称查找' }),
    'ring',
  );
  expect(screen.getByText('--ring')).toBeVisible();
  expect(screen.queryByText('--primary')).toBeNull();
  await user.clear(screen.getByRole('searchbox', { name: '按名称查找' }));

  await user.click(
    screen.getByRole('button', { name: '复制 --primary 的当前值' }),
  );
  // The copied bytes are the live theme's computed value; jsdom computes
  // no custom properties, so the mechanism (not the bytes) is what this
  // suite can prove here — the icon catalog covers real clipboard bytes.
  expect(await screen.findByText('已复制：--primary')).toBeVisible();
});

test('component states operate: loading, validation error, disabled', async () => {
  const { user } = await open();
  await screen.findByRole('heading', { name: '设计系统' });
  await user.click(screen.getByRole('tab', { name: '组件' }));

  const loadingButton = screen.getByRole('button', {
    name: '演示加载状态',
  });
  await user.click(loadingButton);
  expect(screen.getByRole('button', { name: '加载中…' })).toHaveAttribute(
    'aria-busy',
    'true',
  );
  await user.click(screen.getByRole('button', { name: '加载中…' }));
  expect(screen.getByRole('button', { name: '演示加载状态' })).toHaveAttribute(
    'aria-busy',
    'false',
  );

  expect(screen.getByRole('button', { name: '禁用' })).toBeDisabled();

  // The error toggle flips a real error state: an alert region plus an
  // aria-invalid input — never color alone. (The feedback card's
  // informational Alert also carries role=alert, so assert through the
  // error text, then confirm the region semantics.)
  expect(screen.queryByText('校验未通过')).toBeNull();
  await user.click(screen.getByRole('switch', { name: '模拟校验错误' }));
  const failed = screen.getByText('校验未通过');
  expect(failed).toBeVisible();
  expect(failed.closest('[role="alert"]')).not.toBeNull();
  expect(screen.getByLabelText('姓名')).toHaveAttribute('aria-invalid', 'true');
  await user.click(screen.getByRole('switch', { name: '模拟校验错误' }));
  expect(screen.queryByText('校验未通过')).toBeNull();
});

test('the overlay demo moves focus into the dialog and closes without writes', async () => {
  const { user } = await open();
  await screen.findByRole('heading', { name: '设计系统' });
  await user.click(screen.getByRole('tab', { name: '组件' }));

  await user.click(screen.getByRole('button', { name: '删除演示数据' }));
  const dialog = await screen.findByRole('alertdialog');
  expect(dialog).toHaveTextContent('删除这条演示数据？');
  // Focus moved into the dialog when it opened.
  expect(dialog.contains(document.activeElement)).toBe(true);

  await user.keyboard('{Escape}');
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());

  await user.click(screen.getByRole('button', { name: '删除演示数据' }));
  await user.click(
    within(await screen.findByRole('alertdialog')).getByRole('button', {
      name: '确认删除',
    }),
  );
  expect(
    await screen.findByText('已确认删除（演示，无真实写入）'),
  ).toBeVisible();
});

test('scenes run on isolated local state; example scenes come from the real assembly', async () => {
  const { user } = await open();
  await screen.findByRole('heading', { name: '设计系统' });
  await user.click(screen.getByRole('tab', { name: '场景' }));

  // Generic form scene: saving is local, nothing hits the API.
  await user.type(screen.getByLabelText('名称'), '演示条目');
  await user.click(screen.getByRole('button', { name: '保存' }));
  expect(
    await screen.findByText('已保存（演示数据，仅局部状态）'),
  ).toBeVisible();

  // List scene: selecting a fixture only changes this page.
  await user.click(screen.getByRole('radio', { name: '演示条目 B' }));
  expect(screen.getByText('当前选中：演示条目 B')).toBeVisible();

  // Empty-state scene: toggles between the Empty component and a list.
  // The item text legitimately repeats (radio label in the list scene and
  // the filled list), so presence is asserted with getAllBy*.
  expect(screen.getByText('还没有数据')).toBeVisible();
  await user.click(screen.getByRole('button', { name: '填充示例数据' }));
  expect(screen.getAllByText('演示条目 A').length).toBeGreaterThan(0);
  await user.click(screen.getByRole('button', { name: '清空为空态' }));
  expect(screen.getByText('还没有数据')).toBeVisible();

  // Example-registered scenes render from the assembled result: present
  // in combinations with examples, gone after example removal. Assembled
  // keys are already namespaced (the rule lives in app-contract), so the
  // test resolves them directly against the message catalog.
  if (app.scenes.length === 0) {
    expect(screen.getByText('当前没有业务演示场景。')).toBeVisible();
  } else {
    for (const scene of app.scenes) {
      // The example badge is scoped to its own scene card: several scenes
      // can belong to one example, so the badge text legitimately repeats
      // across cards but each card still carries exactly its own badge.
      // The lookup stays inside the main landmark because a scene title
      // may equally be a sidebar navigation label.
      const card = within(screen.getByRole('main'))
        .getByText(app.messages.zh[scene.titleKey])
        .closest('div.rounded-lg');
      expect(card).not.toBeNull();
      expect(
        within(card as HTMLElement).getByText(scene.moduleId),
      ).toBeVisible();
    }
  }
});

test('the icon catalog lazy-loads, filters by name, and copies names', async () => {
  const { user } = await open();
  await screen.findByRole('heading', { name: '设计系统' });
  await user.click(screen.getByRole('tab', { name: '图标' }));

  const search = await screen.findByRole('searchbox', {
    name: '按名称查找图标',
  });
  expect(screen.getByText(/个图标/)).toBeVisible();
  for (const category of ['操作', '导航', '状态', '对象'])
    expect(screen.getByRole('heading', { name: category })).toBeVisible();

  await user.type(search, 'arrow');
  const copyArrow = screen.getByRole('button', {
    name: '复制图标名称 ArrowRight',
  });
  expect(copyArrow).toBeVisible();
  expect(
    screen.queryByRole('button', { name: '复制图标名称 Plus' }),
  ).toBeNull();

  await user.click(copyArrow);
  expect(await screen.findByText('已复制：ArrowRight')).toBeVisible();
  await waitFor(async () => {
    expect(await navigator.clipboard.readText()).toBe('ArrowRight');
  });

  await user.clear(search);
  await user.type(search, '不存在的图标');
  expect(screen.getByText('没有匹配的图标')).toBeVisible();
});

test('all four locale/theme combinations render the showroom', async () => {
  for (const [locale, theme] of [
    ['zh', 'light'],
    ['zh', 'dark'],
    ['en', 'light'],
    ['en', 'dark'],
  ] as const) {
    window.localStorage.setItem('labos-threejs.locale', locale);
    window.localStorage.setItem('labos-threejs.theme', theme);
    const { user } = await open();
    const heading = locale === 'zh' ? '设计系统' : 'Design system';
    expect(await screen.findByRole('heading', { name: heading })).toBeVisible();
    expect(document.documentElement.classList.contains('dark')).toBe(
      theme === 'dark',
    );
    const iconsTab = locale === 'zh' ? '图标' : 'Icons';
    await user.click(screen.getByRole('tab', { name: iconsTab }));
    expect(
      await screen.findByRole('searchbox', {
        name: locale === 'zh' ? '按名称查找图标' : 'Search icons by name',
      }),
    ).toBeVisible();
    // Each combination gets its own mounted tree.
    cleanup();
  }
});
