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
import { assembledApp } from './app-examples';

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
  if (assembledApp.scenes.length === 0) {
    expect(screen.getByText('当前组合没有示例场景。')).toBeVisible();
  } else {
    for (const scene of assembledApp.scenes) {
      // The example badge is scoped to its own scene card: several scenes
      // can belong to one example, so the badge text legitimately repeats
      // across cards but each card still carries exactly its own badge.
      // The lookup stays inside the main landmark because a scene title
      // may equally be a sidebar navigation label.
      const card = within(screen.getByRole('main'))
        .getByText(assembledApp.messages.zh[scene.titleKey])
        .closest('div.rounded-lg');
      expect(card).not.toBeNull();
      expect(
        within(card as HTMLElement).getByText(scene.exampleId),
      ).toBeVisible();
    }
  }
});

test('the knowledge save-conflict scene demos success, failure, conflict and disabled feedback', async () => {
  const knowledge = assembledApp.scenes.find(
    (scene) => scene.exampleId === 'knowledge' && scene.id === 'save-conflict',
  );
  if (!knowledge) return; // combo without the knowledge example
  const { user } = await open();
  await screen.findByRole('heading', { name: '设计系统' });
  await user.click(screen.getByRole('tab', { name: '场景' }));

  const pick = async (name: string) => {
    await user.click(screen.getByRole('radio', { name }));
  };

  // Success: the save action completes with local feedback only. The
  // button reuses the production 保存文档 label, distinct from the
  // generic form scene's 保存 on the same tab.
  await pick('保存成功');
  await user.click(screen.getByRole('button', { name: '保存文档' }));
  expect(
    await screen.findByText('文档已保存（演示数据，仅局部状态）。'),
  ).toBeVisible();

  // Failure: the production failure alert with the fallback text and a
  // reportable request id.
  await pick('保存失败');
  const alert = await screen.findByRole('alert');
  expect(within(alert).getByText('服务暂时不可用，请稍后重试。')).toBeVisible();
  expect(within(alert).getByText('请求编号：scene-demo-request')).toBeVisible();

  // Conflict: the production reconcile flow. Taking the latest replaces the
  // draft body with the latest content (as production reconcile(true) does);
  // keeping the draft returns to the success state with the draft intact.
  await pick('版本冲突');
  expect(screen.getByText('我正在编辑这一段，尚未保存。')).toBeVisible();
  await user.click(screen.getByRole('button', { name: '读取最新版本' }));
  expect(await screen.findByText('最新版本 2：演示文档')).toBeVisible();
  await user.click(
    screen.getByRole('button', { name: '放弃草稿，采用最新内容' }),
  );
  expect(screen.getByText('另一位用户已更新这一段。')).toBeVisible();
  expect(screen.getByRole('radio', { name: '保存成功' })).toBeChecked();

  await pick('版本冲突');
  await user.click(screen.getByRole('button', { name: '读取最新版本' }));
  expect(await screen.findByText('最新版本 2：演示文档')).toBeVisible();
  await user.click(
    screen.getByRole('button', { name: '已核对，保留草稿并继续' }),
  );
  expect(screen.getByText('我正在编辑这一段，尚未保存。')).toBeVisible();
  expect(screen.getByRole('radio', { name: '保存成功' })).toBeChecked();

  // Disabled: the lost-permission status with disabled write controls.
  await pick('权限失效');
  expect(await screen.findByText('保存权限已失效，草稿已保留。')).toBeVisible();
  expect(screen.getByRole('button', { name: '保存文档' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: '重新查询权限' }));
  expect(screen.getByRole('radio', { name: '保存成功' })).toBeChecked();
});

test('the knowledge attachment scene demos file icons and upload lifecycle feedback', async () => {
  const knowledge = assembledApp.scenes.find(
    (scene) =>
      scene.exampleId === 'knowledge' && scene.id === 'attachment-states',
  );
  if (!knowledge) return; // combo without the knowledge example
  const { user } = await open();
  await screen.findByRole('heading', { name: '设计系统' });
  await user.click(screen.getByRole('tab', { name: '场景' }));

  // The gallery shows the vendored Material file icons; the icons are
  // decorative there because each row's text names the type.
  expect(
    await screen.findByText('文件图标（Material Symbols 子集）'),
  ).toBeVisible();
  expect(screen.getByText('图片 · image')).toBeVisible();
  expect(screen.getByText('文档 · description')).toBeVisible();

  const pick = async (name: string) => {
    await user.click(screen.getByRole('radio', { name }));
  };

  // Uploading: the production progress block on demo data.
  await pick('上传中');
  expect(
    await screen.findByRole('progressbar', { name: '附件上传进度' }),
  ).toBeVisible();
  expect(screen.getByText('正在上传 60%')).toBeVisible();

  // Done: the production uploaded status with the generic file icon.
  await pick('上传完成');
  expect(await screen.findByText('报告.pdf · 文件 · 1.2 MiB')).toBeVisible();

  // Failed: a mapped production failure (expired session) with a
  // reportable request id; retry returns to the uploading demo.
  await pick('上传失败');
  const alert = await screen.findByRole('alert');
  expect(within(alert).getByText('上传已过期，请重新上传。')).toBeVisible();
  expect(within(alert).getByText('请求编号：scene-demo-request')).toBeVisible();
  await user.click(screen.getByRole('button', { name: '重试上传' }));
  expect(
    await screen.findByRole('progressbar', { name: '附件上传进度' }),
  ).toBeVisible();
});

test('the knowledge export scene demos export statuses and the notification display contract', async () => {
  const knowledge = assembledApp.scenes.find(
    (scene) => scene.exampleId === 'knowledge' && scene.id === 'export-states',
  );
  if (!knowledge) return; // combo without the knowledge example
  const { user } = await open();
  await screen.findByRole('heading', { name: '设计系统' });
  await user.click(screen.getByRole('tab', { name: '场景' }));

  const pick = async (name: string) => {
    await user.click(screen.getByRole('radio', { name }));
  };

  // Export statuses reuse the production catalog labels; only a
  // succeeded export offers the download action, and its transient
  // downloading label is the production one.
  expect(await screen.findByText('等待处理')).toBeVisible();
  await pick('running');
  expect(screen.getByText('正在生成')).toBeVisible();
  await pick('retry_wait');
  expect(screen.getByText('等待重试')).toBeVisible();
  await pick('failed');
  expect(screen.getByText('导出失败')).toBeVisible();
  expect(screen.getByText('本次导出未完成，可重新申请。')).toBeVisible();
  expect(
    screen.queryByRole('button', { name: '下载 ZIP' }),
  ).not.toBeInTheDocument();
  await pick('expired');
  expect(screen.getByText('已过期')).toBeVisible();
  await pick('succeeded');
  expect(screen.getByText('导出完成')).toBeVisible();
  await user.click(screen.getByRole('button', { name: '下载 ZIP' }));
  expect(screen.getByRole('button', { name: '正在下载…' })).toBeVisible();

  // The registered type resolves its heading from the structured type
  // and outcome; opening the result marks the notice read on demo state.
  const registered = screen.getByLabelText('已注册类型的通知（演示）');
  expect(within(registered).getByText('文档导出完成')).toBeVisible();
  await user.click(
    within(registered).getByRole('button', { name: '查看结果' }),
  );
  expect(within(registered).getByText('已读')).toBeVisible();
  expect(
    within(registered).getByRole('button', { name: '查看结果' }),
  ).toBeDisabled();
  expect(
    within(registered).queryByRole('button', { name: '标记已读' }),
  ).not.toBeInTheDocument();

  // An unknown type keeps the original subject and shows the
  // unavailable-target feedback instead of a navigation button.
  const unknown = screen.getByLabelText('未知类型的通知（演示）');
  expect(within(unknown).getByText('笔记共享失败')).toBeVisible();
  expect(within(unknown).getByText('此通知的功能当前不可用。')).toBeVisible();
  expect(
    within(unknown).queryByRole('button', { name: '查看结果' }),
  ).not.toBeInTheDocument();

  // The same scene reads in English too: the badges and notification
  // headings come from the shared catalog, so the demo follows the
  // interface language without its own strings (UI09).
  cleanup();
  window.localStorage.setItem('labos-threejs.locale', 'en');
  const english = await open();
  await screen.findByRole('heading', { name: 'Design system' });
  await english.user.click(screen.getByRole('tab', { name: 'Scenes' }));
  expect(await screen.findByText('Document export completed')).toBeVisible();
  expect(screen.getByRole('group', { name: 'Export status' })).toBeVisible();
  await english.user.click(screen.getByRole('radio', { name: 'failed' }));
  expect(screen.getByText('Export failed')).toBeVisible();
  const unknownEn = screen.getByLabelText('A notice of an unknown type (demo)');
  expect(within(unknownEn).getByText('笔记共享 (failed)')).toBeVisible();
  expect(
    within(unknownEn).getByText(
      'The feature behind this notification is currently unavailable.',
    ),
  ).toBeVisible();
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
