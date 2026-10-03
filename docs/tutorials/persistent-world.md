# 创建 Lab 与独立对象

目标：用同一定义登记两个独立 Entity，从浏览器与 World API 找到同一身份，并区分 Robot 的声明能力和当前可执行状态。

## 起始版本与本章变更

起点是 `e6f80f5`，完成[持久数字资产](persistent-assets.md)后已有服务器资产、内置定义目录和 `lab:full` Agent 凭据。本章对应 [Issue #3](https://github.com/CaiZongyuan/labworld/issues/3)，使用包含本章实现的工作副本。所有命令从仓库根目录运行，浏览器登记和下面的脚本会写入开发数据库。

实现位于 [World HTTP](../../crates/app/src/modules/lab/world.rs)、[持久模型迁移](../../migrations/0019_lab_world.sql)、[工作台](../../packages/views/src/lab/world-view.tsx)、[多对象场景](../../packages/views/src/lab/world-viewport.tsx)与[生成 SDK](../../packages/sdk/src/generated/sdk.gen.ts)。[Lab ownership](../../crates/app/src/modules/lab/module.json)登记表、合同、测试和教程；身份、CSRF、文件与审计继续通过 Core 公开能力提供。

## 在浏览器登记两个对象

```bash
pnpm install --frozen-lockfile
just dev
```

打开 <http://127.0.0.1:5173/lab>，登录普通 Member，点击 **创建 Lab**，输入 `Identity lab` 并创建。

1. 点击 **登记对象**，选择 `协作机械臂 · 1.0`、内置外观、模拟对象，名称填写 `Robot A`，点击 **登记**。
2. 再用相同定义版本登记 `Robot B`。对象目录出现两个条目，场景出现两个独立外观。
3. 分别点击目录条目或画布中的机械臂。Inspector 的 Entity UUID 应不同，定义版本同为 `robot · 1.0`。目录复选框可同时选择多个对象，画布 Shift 点击也会扩展选择。
4. 点击 **配置对象**，修改名称和标识并保存。它们是实例配置，不改写定义、Placement 或观测。
5. 点击 **新增同一对象表示**。节点 UUID 增加，Entity UUID 保持不变。注册另一对象则生成新 Entity。
6. 刷新，或在另一浏览器登录企业内另一 Member，从 **打开 Lab** 选择 `Identity lab`。对象、定义快照、节点与基本摆放恢复。

Robot 显示 `move/pick/place` 声明，但绑定实现和当前可执行均为“否”；没有观测时显示 **未知 · 无观测**。选择“真实对象 · 未接入”会创建另一个独立身份，当前不会连接真实协议。对象关系由后续阶段提供，照明程序见[下一章](backend-lights.md)。

已有 GLB 可从资产库上传，然后在登记弹窗的 **外观表示** 中选择它。同一资产可用于两个独立对象；表示、文件、节点和 Entity UUID 分开。对象引用的资产删除返回 409，原文件仍可用。资产库的 **在 Lab 中打开** 使用 `/lab/asset` 预览文件；它本身不会登记 Entity。

## 用 Agent 查询同一世界

在设置的 API 密钥页面取得有效 `lab:full` 凭据。以下脚本创建新 Lab 并登记两个 Robot；已有 Lab 时设置 `LAB_ID` 为 Inspector 中的 Lab UUID。

```bash
export LAB_API_BASE=http://127.0.0.1:3000
read -rs LAB_API_KEY
export LAB_API_KEY
# 可选：export LAB_ID=<existing-lab-uuid>
node examples/lab/register-world.mjs
```

预期输出一个 Lab UUID、两个不同 Entity UUID、独立节点 UUID、三个声明能力与空的可执行能力集合。在浏览器重新打开这个 Lab，应看到脚本登记的对象。脚本已查询并比较 World，且实际调用 `robot.pick` 验证 422 拒绝后世界未变。

完整可执行请求：

<<< ../../examples/lab/register-world.mjs

World 查询 `GET /api/v1/lab/labs/{lab_id}/world` 返回 Lab 布局版本、Entity、节点和节点引用的资产；可按 `kind`、`capability`、`state=unknown` 组合筛选。本章的 Robot 无运行 Binding 或观测；照明开始报告后还可用 `state=true/false` 筛选报告电源。`kind` 使用定义目录中的 category。配置 JSON 是实例对象，最大 8192 字节；名称最多 120 字符；单 Lab 最多 1000 Entity 和 1000 节点。Lab 列表默认每页 50 项，`limit` 为 1–100，使用 `next_cursor` 继续；浏览器提供“加载更多”。Placement 使用米、弧度和正尺度；基本注册摆放自动持久化，交互编辑将由后续阶段提供。

## 失败与恢复

登记时指定不存在的 `definition_version` 或 `representation_id`，HTTP 返回 `400 lab.invalid_reference`，World 中不会出现对象或节点，布局版本也不增长。换回目录返回的版本和表示再提交应成功。浏览器服务暂时不可用时，登记弹窗保留名称、定义版本和外观，重试不会丢失草稿；成功登记的重复请求会创建新的对象，避免在响应不确定时盲目重发。

被引用资产删除返回 `409 lab.asset_in_use`；换用未被引用资产验证删除。Robot 调用返回 `422 lab.capability_not_implemented`；无需重试以期待执行。会话缺 CSRF、坏 Bearer、撤销密钥均拒绝写入，重新取得有效凭据后继续。

## 验证与下一阶段

```bash
node scripts/test-backend.mjs --test lab_world --test lab_assets
pnpm exec vitest run apps/web/src/lab-world.test.tsx apps/web/src/lab.test.tsx
node scripts/e2e.mjs tests/e2e/lab.spec.ts
```

HTTP 使用真实 Router、隔离 PostgreSQL，文件用真实对象存储；组件只用 MSW 替代 HTTP；浏览器用真实 GLB/WebGL 验证目录与画布身份、跨上下文恢复、压缩加载及资源隔离。继续[后端照明控制](backend-lights.md)，为照明对象加入独立设备程序、命令和观测；本章布局与实例配置不会假装成运行测量。
