# 用 Node 服务登记世界与布局

目标：建立持久 Lab，登记独立 Entity，共用一个表示，再保存布局并从 409 恢复。先完成[Node 数字资产](server-assets.md)，准备普通 Member 与有效的 `lab:full` Agent 密钥。Node 24、pnpm、Linux 或 Windows 足够；`pnpm dev` 不需要 Docker。命令在仓库根目录运行，会写入开发数据。

## 登记并找到同一身份

打开 <http://127.0.0.1:5173/lab>，选择 **创建 Lab**，填写 `Identity lab`。登记两个 `robot · 1.0` 对象，命名为 `Robot A` 与 `Robot B`。目录和 Inspector 显示两个不同 Entity UUID；节点 UUID 和 Lab UUID 也独立。

选择目录中的 Robot，或在画布中点击其外观，Inspector 应显示该对象。刷新后使用 **打开 Lab** 重新读取持久世界。登记弹窗也可选择前章上传的 GLB；两个 Entity 可共用一个表示，同一 Entity 可有多个独立摆放的 Scene Node。

静态 bench、model 与 Robot 没有 Binding、Run 或 Observation。Robot 能力是声明，当前不可执行。模拟照明、传感器和离心机保存原绑定元数据，但 Node 设备运行尚未迁移；World 响应头为 `X-Lab-Runtime: unavailable`。这里的 Placement 和实例配置不能代替设备观测。

用 Agent 运行同一登记业务：

```bash
export LAB_API_BASE=http://127.0.0.1:3000
read -rs LAB_API_KEY
export LAB_API_KEY
# 可选：export LAB_ID=<existing-lab-uuid>
# 可选：export LAB_REPRESENTATION_ID=<representation-uuid-from-asset-import>
node examples/lab/register-static-world.mjs
```

脚本先提交错误定义版本并确认世界未变，然后登记两个 Robot，查询 `kind=robot&capability=robot.pick&state=unknown`。它返回不同 Entity UUID、节点 UUID 和声明能力；Run 与 Observation 为 null，可执行集合为空。已有 Lab 会保留原对象，重复登记会创建新 Entity。

<<< ../../examples/lab/register-static-world.mjs

## 编辑、登记关系并处理冲突

用 `bench · 1.0` 和 `labware · 1.0` 登记工作台与烧杯。选中烧杯后进入 **编辑布局**，输入位置、旋转或缩放，点击 **保存布局**。位置使用米，旋转使用弧度。登记 **位于** 工作台后再保存，关系带人工来源、操作者和登记时间；仅改变坐标不会证明真实物料已移动。

在第二个独立浏览器登录另一 Member，打开同一 Lab，两页进入编辑布局。第二页先保存，第一页再保存会返回 `409 lab.layout_conflict`，输入草稿保留。选择 **重新载入并保留草稿**，比较新布局，然后 **重试保存**。也可明确放弃草稿。页面内草稿不会因服务器冲突丢失；刷新前应保存。

Agent 脚本验证保存、冲突、非法环回滚、复制、多表示和移除/放回：

```bash
node examples/lab/edit-layout.mjs
```

<<< ../../examples/lab/edit-layout.mjs

`PUT /api/v1/lab/labs/{lab_id}/layout` 接受 `expected_version`、完整 `nodes` 和可选的完整 `relationships`。省略关系或设为 null 保留原关系；`[]` 清空。服务器产生人工 provenance，重复保存同一关系事实保留原操作者和时间。包含与位于共用无环、单容纳对象规则；模拟对应要求模拟对象指向同一定义的真实对象。跨 Lab 引用和非法图返回 400，全部回滚。

移除节点保留未放置 Entity。**复制为独立实例** 创建新 Entity 与节点，复制定义快照、配置和外观，保留空的 Run 与 Observation。它接受同一布局版本检查；不会复制历史或执行设备程序。

## 限制、来源与验证

单 Lab 最多 1000 Entity、1000 Scene Node 和 1000 关系。布局请求最大 512 KiB；普通 JSON 仍为 16 KiB。配置 JSON 最大 8192 字节。位置和旋转绝对值最多 10000；缩放为 0.001–1000。World 的 `kind/capability/state` 筛选同时约束 Entity、节点、引用资产与关系，未知观测使用 `state=unknown`。

[World 用例](../../packages/server/src/lab/world/use-cases.ts)、[布局事务](../../packages/server/src/lab/world/layout.ts)、[关系规则](../../packages/server/src/lab/relationships/domain.ts)和[定义目录](../../packages/server/src/lab/world/catalog.json)拥有这些业务事实。World 用一次实际 SQL JSON 聚合读取，整个请求预算为 10 条 SQL，包含身份和 BEGIN/COMMIT；它不随实体数量逐条查询。

```bash
node --test --experimental-strip-types tests/server/lab-world.test.ts tests/server/lab-capacity.test.ts tests/server/lab-budgets.test.ts
pnpm contracts:m1:check
```

Linux 的独立 desktop browser 补证入口：

```bash
pnpm exec playwright install chromium
node --experimental-strip-types scripts/e2e-server.mjs tests/e2e/lab-node-assets-world.spec.ts
```

该入口使用真实 Node 服务、Vite、现有 Web/SDK 与 WebGL，检查资产深链接、场景可见像素、选择和两个浏览器的冲突草稿。它登记并清理所属进程和临时数据，证据保存在输出给出的目录；不启动旧服务。正式 SDK 来源切换和设备/SSE/历史旅程仍由后续迁移负责。HTTP 类型与错误来自[生成 API](site:reference/api.md)，Lab 归属记录在 [module.json](../../crates/app/src/modules/lab/module.json) 的 `vnext` 项。
