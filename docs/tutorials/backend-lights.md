# 控制后端照明程序

目标：启动两台独立照明，从普通 Member 与 Agent 发出同一命令，比较命令结果与来源明确的实际观测。

## 起始版本与本章变更

起点是 `a4354a6`，完成[持久 Lab 与对象](persistent-world.md)后已有 Lab、Entity、独立节点、固定定义快照和 `lab:full` 凭据。本章对应 [Issue #4](https://github.com/CaiZongyuan/labworld/issues/4)，使用包含本章实现的工作副本。命令在仓库根目录运行，浏览器和脚本会写入开发数据库。

实现入口是 [设备 HTTP](../../crates/app/src/modules/lab/devices.rs)、[公开设备运行与观测入口](../../crates/app/src/modules/lab/runtime.rs)、[持久迁移](../../migrations/0020_lab_devices.sql)、[来源排序迁移](../../migrations/0021_lab_observation_order.sql)、[Inspector](../../packages/views/src/lab/device-panel.tsx)、[三维外观](../../packages/views/src/lab/world-viewport.tsx)及[生成 SDK](../../packages/sdk/src/generated/sdk.gen.ts)。[Lab ownership](../../crates/app/src/modules/lab/module.json)包含新增表、合同、测试和教程。

## 从浏览器得到第一条观测

```bash
pnpm install --frozen-lockfile
just dev
```

打开 <http://127.0.0.1:5173/lab>，登录普通 Member，创建 `Lighting lab`。以 `智能照明 · 1.0`、内置外观、模拟对象分别登记 `Light A` 和 `Light B`。

1. 选择 `Light A`。没有观测时显示 **未知 · 无观测**；Binding 已实现照明能力，但程序未启动，当前不可执行。
2. 点击 **启动程序**，记录 Run UUID。启动本身不伪造观测。切换 **电源**，先看到提交、等待设备执行，再看到执行完成及实际观测。灯罩根据服务器报告发光。
3. 在 **目标亮度 (%)** 填写 `35` 并点击 **设置**。目标输入与 **观测亮度** 分开，后者仅在设备报告后变为 `35 %`。
4. 启动 `Light B` 并打开电源。其 Run、Binding、来源和观测独立，A 的调光不会改变 B。
5. 关闭页面再打开，程序仍在后端运行，最后观测仍可读取。点击 A 的 **停止程序**，最后观测的值和来源时间保留，新鲜度变为 **来源已停止**；停止不等于关闭灯。

只使用内置后端 `light.v1` 程序，不执行用户代码。实例配置在启动时保存到 Run；后续配置修改作用于下一次启动。迁移为以前登记的模拟照明补建 Binding，启动不重写已固定的定义快照。Entity 的能力返回由 Binding 提供执行元数据，并分别表达定义支持、实现与当前可执行性。真实对象仍没有执行 Binding。

## 独立 Agent 操作与同键重试

从设置取得有效 `lab:full` API 密钥。脚本创建一个 Lab 和两盏灯；已有 Lab 时设置 `LAB_ID`。

```bash
export LAB_API_BASE=http://127.0.0.1:3000
read -rs LAB_API_KEY
export LAB_API_KEY
# 可选：export LAB_ID=<lab-uuid>
node examples/lab/control-lights.mjs
```

输出包含两个不同 Entity/Run UUID、命令 UUID和两组报告值：A 为 `on=true, brightness=35`，B 为 `on=true, brightness=20`。A 来源停止后保留该值，B 继续运行。浏览器打开脚本输出的 Lab，可查看同一状态与实际像素。

完整可执行请求：

<<< ../../examples/lab/control-lights.mjs

`POST /api/v1/lab/labs/{lab_id}/entities/{entity_id}/actions` 使用 `Idempotency-Key`，请求 `{ "capability": "light.set_power", "parameters": { "on": true } }`，返回 202 和命令记录。`light.set_brightness` 接受 number 型 `brightness`，范围 0–100、单位 percent。能力版本为 `1.0`；成功结果 `applied_by_device_program` 表示程序已应用动作，不把命令接受当作测量。

`GET .../commands/{command_id}` 查询 `accepted`、`executing`、`succeeded`、`failed` 或 `unknown`、操作者、参数和结果。同一操作者、Entity、键与等价 JSON 参数返回同一命令；不同参数返回 409。记录由用户与 Agent 共用。同一个账号的会话和 Agent 使用相同键空间。

`GET .../entities/{entity_id}` 与 World 快照返回 Binding、当前 Run、观测及三层能力状态。观测包含 `source`、`run_id`、`sequence`、`observed_at`、`received_at`、`updated_at`、`quality` 与 `freshness`。缺少来源时间时 `observed_at=null`、新鲜度为 `source_time_unknown`，不会借用接收时间。照明变化时才报告，`current` 表示该报告来自仍运行的来源；连续采样的过期判定将在后续章节交付。页面通过[可靠订阅](reliable-sync.md)接收世界快照和属性变化，命令短期读取仍有 30 秒上限。实际操作须同时满足持久能力许可与 `X-Lab-Runtime` / `runtime_status` 表达的即时服务就绪条件。

## 失败与恢复

脚本实际验证 `brightness=101` 返回 `422 lab.invalid_parameters`、停止后新动作返回 `422 lab.program_not_running`；两者不会改变观测。Robot 等未实现动作返回 `422 lab.capability_not_implemented`，Member 与 Agent 的拒绝一致。会话写入需要 CSRF；坏、过期或撤销的 Agent 凭据不能写入。

响应丢失后，页面显示 **提交结果不确定**，保留原参数和键，选择其他对象后再回来仍保留反馈。点击 **重试同一命令** 使用原键；已有命令时可 **刷新命令**。不要生成新键来自动重复未知执行。后台重启把原运行标为 `interrupted`，未结束命令标为 `unknown`，保留最后观测并要求显式启动新 Run；旧 Run 与旧运行端报告均被拒绝。开发时 Rust 热重载也遵循这项重启规则。

数据库尚未迁移时，readiness 返回 503，API 不自动执行迁移。运行器尚未初始化时，已认证的程序启动和动作返回 `503 lab.runtime_unavailable`，不会接受无执行者的新命令。后台只对尚未建立的运行器重试初始化；成功后处理队列不会反复中断 Run。依赖恢复后可显式重试原键。

## 验证与下一阶段

```bash
node scripts/test-backend.mjs --test lab_devices --test lab_world
pnpm test:frontend apps/web/src/lab-devices.test.tsx
node scripts/e2e.mjs tests/e2e/lab-devices.spec.ts
```

HTTP 用真实 Router 与隔离 PostgreSQL；公开运行入口覆盖报告顺序和重启；组件仅用 MSW 替代 HTTP；浏览器使用真实应用、独立 Agent 和 WebGL。接下来按[编辑布局与登记位置](edit-layout.md)操作布局和人工关系；[Issue #6](https://github.com/CaiZongyuan/labworld/issues/6) 添加连续传感器与过期判定。本章保持布局版本与运行观测分离。
