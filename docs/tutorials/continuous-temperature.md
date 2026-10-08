# 查看连续温度与来源新鲜度

当前服务使用 Node 24 与 TypeScript，默认验证 desktop web。命令在仓库根目录运行；Linux/Windows 不需要 Docker。实现入口见[Node 设备](../guides/server-devices.md)、[同步](../guides/server-sync.md)和[追溯](../guides/server-traceability.md)。

目标：查看两个后端温度来源。停止一个来源，保留最后值并观察过期。恢复来源后，核对新的运行身份与时间。

## 起始版本

使用包含本章 Node 实现的当前 checkout。先完成[可靠同步与恢复](reliable-sync.md)，取得持久世界和 SSE 订阅。

在仓库根目录运行命令。操作会写入开发数据库。普通 Member 需要有效会话。Agent 需要有效的 `lab:full` API 密钥。

实现入口：[后端程序与观测入口](../../packages/server/src/lab/devices/runtime.ts)、[属性观测合同](../../packages/server/src/lab/devices/use-cases.ts)、[新增迁移](../../packages/server/migrations/0000_baseline.sql)、[观测面板](../../packages/views/src/lab/observation-reading.tsx)。Node 使用共享保留 schema。

## 查看两个来源

1. 安装依赖。

   ```bash
   pnpm install --frozen-lockfile
   ```

2. 启动开发栈。

   ```bash
   pnpm dev
   ```

   Node 服务初始化设备运行端。每个 Entity 的程序仍需要显式启动。文件与历史清理由各自的服务调度器处理。

3. 打开 <http://127.0.0.1:5173/lab>。

4. 创建或打开一个 Lab。

5. 点击 **登记对象**。

6. 选择 `sensor@1.0`。

7. 在名称字段输入 `Sensor A`。

8. 点击 **登记**。

   新 Entity（实验室对象）具有独立身份。Inspector 显示 **未知 · 无观测**。

9. 点击 **启动程序**。

   后端开始每秒采样一次。Inspector 和三维读数显示温度、单位与新鲜度。

10. 对 `Sensor B` 重复步骤 5–9。

两个对象有不同的 Binding、Run 和来源。关闭所有浏览器不会停止采样。

11. 选择 `Sensor A`。

12. 点击 **停止程序**。

    最后值保留。最后一次接收后的 5 秒期限到达时，页面显示 **观测已过期 · 保留最后值**。

13. 点击 **启动程序**。

    新观测使用新的 Run。接收时间更新，质量仍由来源报告。`Sensor B` 的运行不变。

## 用 Agent 验证相同事实

先在设置中创建 `lab:full` 密钥。下面的 `<lab-uuid>` 来自 Inspector。密钥输入不显示在终端。

1. 设置 API 地址。

   ```bash
   export LAB_API_BASE=http://127.0.0.1:3000
   ```

2. 设置 Lab 身份。

   ```bash
   export LAB_ID='<lab-uuid>'
   ```

3. 读取密钥。

   ```bash
   read -rs LAB_API_KEY
   ```

4. 导出密钥。

   ```bash
   export LAB_API_KEY
   ```

5. 运行示例。

   ```bash
   node examples/lab/observe-temperature.mjs
   ```

   示例创建两个独立传感器。它停止第一个来源，并等待过期。它验证第二个来源继续采样，然后恢复第一个来源。

完整请求与结果检查：

<<< ../../examples/lab/observe-temperature.mjs

示例使用 `configuration.baseline_temperature` 设置模拟温度基线。默认值为 `22 degC`。允许范围是 `-50` 到 `100 degC`。程序启动时冻结配置。配置不是实际测量。

## 读取属性合同

`GET /api/v1/lab/labs/{lab_id}/entities/{entity_id}` 和 World 查询返回相同的观测。`observation.values.temperature` 保留最后值。`observation.properties.temperature` 提供该属性的完整来源信息。

| 字段                                         | 含义                                        |
| -------------------------------------------- | ------------------------------------------- |
| `value`、`unit`                              | 温度值与 `degC` 单位                        |
| `binding_id`、`run_id`、`source`、`sequence` | 来源绑定、运行、身份与报告顺序              |
| `observed_at`                                | 来源提供的观测时间；未提供时为 `null`       |
| `received_at`                                | API 的独立接收时间                          |
| `updated_at`                                 | 属性最后一次接受报告的时间                  |
| `expires_at`                                 | 接收时间后 5 秒的报告期限                   |
| `quality`                                    | 来源报告的 `good`、`uncertain` 或 `bad`     |
| `freshness`                                  | `current`、`source_time_unknown` 或 `stale` |

来源时间缺失时，API 不用接收时间代替它。新鲜度按属性判断。5 秒期限描述最近报告的接收情况；判断测量实际年龄时，还必须检查 `observed_at`。三维读数的悬停信息保留来源、来源时间、接收时间与质量。

心跳只更新运行的报告顺序。它不改变旧测量的接收时间或期限。同一 Run 的重复或较小顺序号不会刷新测量。较旧的属性来源时间也会被拒绝。缺失来源时间不会清除该属性的最后已知时间高水位。部分报告保留未报告的属性。退休 Binding、停止 Run 和旧后端代次不能覆写新运行。

API 把过期转换持久化，并推进 `world.version`。相同版本不会因查询时间不同而返回不同新鲜度。SSE 传播这个新版本。布局版本与布局草稿保持独立。

`DeviceRuntime.report` 是后端设备程序的可信入口。Member 和 Agent 没有对应的 HTTP 写入入口。内置温度程序始终提供来源时间；未知时间的行为由受控运行入口补充与页面测试验证。

## 验证拒绝与恢复

示例向 Entity PATCH 请求加入 `observation`，并要求 HTTP 400。API 拒绝直接覆写测量，最后值保持不变。普通 Member 得到相同约束。删除这个字段后，使用程序启动/停止操作继续工作。

```bash
pnpm test:contract:server
pnpm test:frontend apps/web/src/lab-sensors.test.tsx
node --experimental-strip-types scripts/e2e-server.mjs tests/e2e/lab-node-assets-world.spec.ts
```

HTTP 合同验证真实 Hono Router 与隔离 PGlite 嵌入式数据库中的传感器行为，页面测试验证操作与显示。受控运行入口补充验证精确时间规则。上述 Node 浏览器入口验证 Asset、World、布局与 WebGL；完整传感器客户端旅程将在后续客户端迁移中验证。[旧 Foundation 旅程](complete-foundation.md)保留历史版本与负载参考，不是本章的启动版本。下一章[离心任务与重启恢复](centrifuge-tasks.md)提供固定任务参数、减速取消和显式重启恢复。
