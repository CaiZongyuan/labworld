# 使用空间工作台

目标：打开同一个持久 Lab，用目录和场景选择 Entity，并从链接恢复对象。收放面板不会保存布局或重置相机。

## 起始状态与本章变更

先完成[持久 Lab 与对象](persistent-world.md)。使用本章配套源码，保留已创建的 Lab 和两个独立对象。命令在仓库根目录运行。以下查看、选择和收放操作不写入持久世界。

本章将世界查询、唯一订阅、选择、布局草稿和命令尝试交给 [Lab 工作台上下文](../../packages/views/src/lab/workbench-context.tsx)。[空间页面](../../packages/views/src/lab/world-view.tsx)消费这个上下文。[Lab 组装](../../packages/views/src/lab/app.tsx)保留身份入口和按需加载；[路由适配层](../../apps/web/src/router.tsx)只传递通用查询参数。通用壳提供紧凑导航，不解释 Lab 身份。

```bash
pnpm install --frozen-lockfile
pnpm dev
```

打开 <http://127.0.0.1:5173/lab>，登录已登记对象的 Member。页面先显示三维空间、真实 Lab 名称和连接状态。

## 查看与选择

1. 点击 **打开 Lab**，选择上一章创建的 Lab。
2. 点击 **收起导航**。窄栏保留业务入口和左下的唯一账户入口。悬停图标可读到名称。点击 **展开导航** 可恢复导航宽度。
3. 点击 **打开对象目录**。用名称、类别、未放置或已归档筛选找到对象。目录复选框保留多选入口。
4. 点击目录中的对象，或点击场景中的表示。对象信息显示同一 Entity 的身份。多个节点仍可以属于同一个 Entity。
5. 点击 **关闭对象目录** 和 **关闭对象信息**。相机保留当前角度，空间恢复可用面积。可用 **打开对象信息** 再显示当前选择。
6. 用旋转和缩放检查场景。点击 **聚焦模型** 可重新取景；**网格** 和 **性能** 分别控制辅助显示。

目录或详情关闭后，焦点返回打开它的控件或选择来源。Escape 关闭当前面板；正在输入或使用弹窗时，Escape 不放弃布局草稿。手机上的主要触控命令保留至少 44px 命中区。语言与主题使用应用顶部控件。

## 恢复链接

选择对象后，浏览器地址包含 Lab 和主要 Entity。刷新这个地址会从服务器世界重新确认它们。多选中的其他对象和 Scene Node 选择仅在当前工作台会话保留。

| 参数                   | 当前行为                                    |
| ---------------------- | ------------------------------------------- |
| `lab=<Lab UUID>`       | 打开指定 Lab；省略时选择 Lab 列表中的默认项 |
| `entity=<Entity UUID>` | 在该 Lab 中恢复主要对象；省略时不选择对象   |
| `view=space`           | 打开三维空间；省略时也打开空间              |

例如：

```text
/lab?lab=<Lab UUID>&entity=<Entity UUID>&view=space
```

将占位值换成地址中的真实 UUID。目前只交付空间视图。其他 `view` 值显示明确的不可用状态，通过 **打开三维空间** 返回同一个 Lab。`/`、`/assets` 和 `/lab/asset` 保留各自入口。

## 草稿与失败恢复

切换 **运行查看** 和 **编辑布局**，或收放面板，同一 Lab 的未保存草稿保持。切换 Lab 后，该 Lab 的草稿与选择不会应用到另一 Lab。返回原 Lab 可继续内存草稿。身份或部署改变后，旧上下文不再提供受保护数据和操作尝试。刷新后的私人草稿恢复尚不属于本章；离开页面前先保存或明确放弃。

将链接中的 `entity` 改为不存在的 UUID。页面显示 **找不到此对象。**，不会选择另一对象。点击 **清除对象链接**，再从目录选择有效对象。将 `lab` 改为不存在的 UUID时，页面显示 **找不到此 Lab。**；使用 **打开 Lab** 明确选择有效 Lab。

断线保留来源明确的最后快照。连接状态不再表示实时同步，需要连接的命令禁用。点击 **重新连接** 恢复订阅。保存失败或 409 保留草稿；后续恢复见[布局章节](edit-layout.md)。迟到的保存或登记只影响它原来的 Lab，不替换刚切换的 Lab 选择或草稿。

## 验证与下一章

工作台入口和共享上下文的完整接入：

<<< ../../packages/views/src/lab/workbench.tsx

```bash
pnpm typecheck
pnpm exec vitest run apps/web/src/lab-workbench.test.tsx apps/web/src/lab-world.test.tsx apps/web/src/lab-sync.test.tsx
node --experimental-strip-types scripts/e2e-server.mjs tests/e2e/lab-workbench.spec.ts
```

Views 测试只用 MSW 替代 HTTP。浏览器使用真实身份、API、数据库、订阅、HDR 和 WebGL。迁移验证使用 desktop web，核对画布外部可见面积、相机像素、深链、面板与焦点。已有产品窄屏与触屏职责保留到 Migration Gate 后继续验证。继续[后端照明控制](backend-lights.md)，在同一对象详情中区分命令与实际观测。
