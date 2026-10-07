# 同步世界并从断线恢复

当前服务使用 Node 24 与 TypeScript，默认验证 desktop web。命令在仓库根目录运行；Linux/Windows 不需要 Docker。实现入口见[Node 设备](../guides/server-devices.md)、[同步](../guides/server-sync.md)和[追溯](../guides/server-traceability.md)。

目标：让两个浏览器和一个 Agent 观察同一后端设备，保留断线前的最后观测，并验证撤销凭据终止现有订阅。

## 起始版本与本章变更

使用包含本章 Node 实现的当前 checkout。先完成[Node 设备程序](../guides/server-devices.md)，建立持久世界和设备程序。命令在仓库根目录运行。浏览器操作会写入开发数据库。

实现入口：[持久世界版本](../../packages/server/migrations/0000_baseline.sql)、[公开 SSE 接口](../../packages/server/src/lab/world/subscriptions.ts)、[SDK 订阅和版本应用](../../packages/sdk/src/lab-world.ts)、[页面订阅](../../packages/views/src/lab/world-subscription.ts)、[Lab ownership](../../packages/server/src/lab/ownership.json)。Node 使用共享保留 schema。

## 两个浏览器观察同一设备

```bash
pnpm install --frozen-lockfile
pnpm dev
```

打开 <http://127.0.0.1:5173/lab>，使用普通 Member，沿用[后端照明控制](backend-lights.md)中的 Lab 和 `Light A`。启动程序并打开电源。在另一浏览器登录同一企业，打开相同 Lab、选择同一对象。两端显示 **实时同步**，Inspector 和灯罩来自相同设备观测，页脚的 `W` 数字为世界版本，标题的 `v` 数字仍是独立布局版本。

在浏览器 A 调整亮度。浏览器 B 无需刷新即看到更新。开发工具把 B 切到 Offline，页面显示 **连接中断**，最后观测和场景继续可见，设备继续在后端运行。A 再调光；B 恢复 Online 后自动连接，并从最新快照恢复。也可点击 **重新连接**。布局草稿仍由布局编辑器单独持有；重连不会把观测写进草稿或覆盖未保存的摆放。

## Agent 订阅和撤权

在设置创建有效 `lab:full` API 密钥，从 Inspector 取得 Lab UUID。在单独终端运行：

```bash
export LAB_API_BASE=http://127.0.0.1:3000
export LAB_ID=<lab-uuid>
read -rs LAB_API_KEY
export LAB_API_KEY
node examples/lab/observe-world.mjs --reconnect
```

脚本先输出 `snapshot`、版本、Entity/Run 身份及最后报告值。浏览器修改亮度后输出 `update`，主动断开一次并重新取得最新 `snapshot`。浏览器和 Agent 在相同世界版本下拥有相同事实；显示动画无需接收逐帧网络消息。

保持终端运行，在设置撤销刚创建的密钥。原订阅输出 `access_ended` 并结束；再次运行返回 HTTP 401。Member 登出、会话过期或企业成员失效同样终止现有访问。Ctrl+C 会取消请求并释放流。

完整请求和取消处理：

<<< ../../examples/lab/observe-world.mjs

## 公开协议和边界

`GET /api/v1/lab/labs/{lab_id}/world/subscribe` 接受会话 Cookie 或 `Authorization: Bearer …`，返回 `text/event-stream`。第一条 `snapshot` 带完整 `LabWorld`。后续 `update` 带 `version`、`base_version`、可选的 `lab` 和 `changes`：按 `entities`、`nodes`、`assets`、`relationships` 的独立 id 更新；`patch` 是改变的顶层属性，`null` 删除该项。新增项携带完整属性。设备观测仅更新相关 Entity，不传播渲染帧。

世界版本是部署内事务提交有序的十进制字符串。使用 `BigInt` 比较同一个 Lab 和查询范围。版本覆盖 Entity、Run、观测、结构和引用资产变化。它独立于 `layout_version`。某台设备的 `sequence` 不能代替世界版本。同一版本代表相同持久事实。中间状态可以合并为最新状态，不能作为完整历史事件流。查询已实现的[运行历史](run-history.md)可获取保留范围内记录。

SDK 的 `subscribeLabWorld({client,labId,signal,headers,onWorld,onEvent})` 使用独立流生命周期，保留 `createApiClient` 的普通 HTTP 5 秒超时，订阅以 10 秒无消息检测连接中断。`onWorld` 只在完整快照或有效更新后调用；重复和旧版本被忽略，缺少匹配 `base_version` 时抛出 `WorldSyncError`，调用者重新订阅以获得快照。页面支持自动与手动重连，离开页面、切换 Lab 或身份时取消旧流。

World 和单 Entity 读取的 `X-Lab-Runtime: ready | unavailable`，以及订阅的 `runtime_status.available`，表达独立的即时执行服务状态。`capabilities.executable`/`reason` 表达持久 Binding 与 Run 的约束；实际可操作需同时满足能力许可和服务就绪。Inspector 合并判断并显示运行端未就绪。服务状态变化不会暗中改写同版本设备事实，动作入口仍在未就绪时返回 `503 lab.runtime_unavailable`。

每条事件 JSON 上限 1 MiB，服务器待发队列最多 8 条，客户端未完成帧也有上限。慢客户端溢出时丢弃待发队列，优先发送 `resync`（`slow_client`）并关闭；更新过大用 `payload_limit`，来源不可用用 `source_unavailable`。重新订阅恢复快照，不无限缓存。初始快照超过限额返回 `413 lab.snapshot_too_large`；减少该 Lab 的对象/配置体量后重试。身份在每次目标间隔为 250ms 的轮询和待发帧发送前重查，失效终止流；数据库延迟会影响轮询间隔，检查或来源超时会关闭连接。

## 验证与下一阶段

```bash
pnpm test:contract:server
pnpm test:frontend apps/web/src/lab-sync.test.tsx packages/sdk/src/lab-world.test.ts
node --experimental-strip-types scripts/e2e-server.mjs tests/e2e/lab-node-assets-world.spec.ts
```

HTTP 合同使用真实 Hono Router 与隔离 PGlite 嵌入式数据库，验证版本、撤权和重连。受控运行补充验证交接与有界 Body 队列。页面只用 MSW 替代 HTTP。上述 Node 浏览器入口验证 Asset、World、布局冲突与 WebGL；两浏览器和 Agent 的完整设备旅程将在后续客户端迁移中验证。[下一章](continuous-temperature.md)读取连续温度与过期状态。[旧 Foundation 旅程](complete-foundation.md)保留历史版本、布局草稿与网络恢复参考，不是本章的启动版本。
