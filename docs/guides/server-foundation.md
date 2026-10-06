# 启动 TypeScript 服务基础

本指南面向开发 Lab Word Server 的开发者。当前服务基础提供健康、系统状态、错误信封、持久数据库与合同生成。身份、成员、API key、审计、限流与文件能力已经实现。Web 可以使用 Core 身份；完整 Lab 旅程仍在迁移。继续阅读[平台指南](server-platform.md)。

## 得到第一个结果

需要 Linux 或 Windows，以及仓库指定的 Node 24 和 pnpm。以下命令在仓库根目录执行，不需要 Docker、Rust 或外部数据库。

```bash
pnpm install --frozen-lockfile
pnpm dev
```

服务默认监听 `127.0.0.1:3000`，Web 使用 `http://127.0.0.1:5173`。Vite 将 `/api/v1`、`/api/openapi.json`、`/objects` 与 `/health` 代理到新服务。打开第二个终端：

```bash
curl http://127.0.0.1:3000/health/live
curl http://127.0.0.1:3000/health/ready
curl http://127.0.0.1:3000/api/v1/system/status
```

两个健康响应都为 `{"status":"ok"}`。系统状态保留兼容标识 `labos-threejs-api`；`version` 来自服务包，`schema_version` 只报告实际已应用的迁移。数据库或迁移元数据不可用时，就绪与系统状态返回 503，错误代码为 `database.unavailable`。

按 Ctrl+C 停止两个开发进程。开发数据保留在 `data/`。启动输出会给出开发归属回执的位置。创建者异常终止后，可运行 `pnpm dev:recover <development-owned-resources.json>`，核对并停止它登记或标记的消费者；此命令保留开发数据。服务代码变更后重新运行 `pnpm dev`；Web 继续使用 Vite 的热更新。

## 使用独立目录和端口

配置的实现位于 [config.ts](../../apps/server/src/config.ts)。完整默认值和校验来自此文件：

<<< ../../apps/server/src/config.ts

Linux shell 的示例：

```bash
LAB_WORD_DATA_DIR=.scratch/my-foundation-data SERVER_PORT=3100 WEB_PORT=5180 APP_ORIGIN=http://127.0.0.1:5180 pnpm dev
```

PowerShell 的同一示例：

```powershell
$env:LAB_WORD_DATA_DIR = '.scratch/my-foundation-data'
$env:SERVER_PORT = '3100'
$env:WEB_PORT = '5180'
$env:APP_ORIGIN = 'http://127.0.0.1:5180'
pnpm dev
```

同一规范化数据目录只允许一个进程打开。第二个启动失败时，保留原进程和目录；不要删除目录来解除独占。默认回环监听适合本机开发。团队访问需要部署方提供 HTTPS 反向代理。

## 验证失败和恢复

```bash
pnpm typecheck
pnpm test:server
pnpm contracts:m1:check
pnpm check:m1
```

服务测试启动真实子进程。它们验证健康、错误、持久化、重开、微秒时间、事务回滚、SQL 计量与目录独占。错误测试请求不存在的资源：响应为 404，包含 `code`、`details`、`message`、`request_id`，并与 `x-request-id` 响应头对应。响应使用 `cache-control: no-store`。

`contracts:m1:check` 从 Zod 路由生成 OpenAPI，并通过现有 SDK 生成器写入 `.scratch/vnext-m1/generated/`。它比较15 个已迁移路径与 28 个递归引用 schema，包含五个文件 DTO，编译生成的调用，并检查正式合同与 SDK 未被改变。部分服务不会覆盖完整客户端合同。

`check:m1` 运行服务、Web、保留工具、边界、包体和文档检查。当前 CI 以 Web 为主，不构建或运行 Electron。旧服务、完整业务合同和浏览器旅程仍待对应迁移阶段；本命令不宣称 Migration Gate 已通过。

## 重放持久化试验

```bash
pnpm spike:server --duration-seconds 1800 --output .scratch/my-foundation-spike
```

此命令使用独立测试进程和临时数据库。它写入 20 个合成设备形态的 1 Hz 样本，保持两个真实 SSE 订阅，并同时读写。它不是完整 Device Program 或业务 SSE 验收。

报告保留每个采样周期的提交时间、确认数据、实际 SQL 语句数、订阅计数和资源清理回执。漂移以进程单调时钟和固定采样起点计算，不能通过延迟下一周期来隐藏。名义 UTC 排程是起点的投影；实际样本时间逐次读取墙钟，二者的差异不是数据库排队时间。现有 SQL 与载荷预算继续有效。冷启动、目录体积和内存只作为报告。

进程与数据目录的归属记录在 `.scratch/vnext-m1/<run>/owned-resources.json`。正常结束、失败和中断都清理所属临时数据。异常终止后，确认原创建者已停止，再按回执恢复：

```bash
pnpm server:recover .scratch/vnext-m1/<run>/owned-resources.json
```

恢复核对进程创建身份、运行标记与目录归属。活跃创建者、被替换的 PID、未知消费者或不匹配的目录标记会使恢复安全失败。不要用全局清理或删除既有数据替代此检查。

## 数据库选择与代码边界

数据库使用锁定的 PGlite 0.5.8 和 Drizzle 0.45.3。有效配置与 Linux/Windows 证据记录在 [ADR 0011](../adr/0011-pglite-embedded-database.md)。强杀测试证明的是本次进程终止后的已确认提交，不是操作系统崩溃或断电保证。

[数据库平台](../../packages/server/src/platform/db/index.ts) 独占驱动、迁移和执行队列。读取、写入与后台操作都进入同一队列；事务内不等待网络、文件或定时器。时间列保留精度为六位的字符串，不通过 JavaScript Date 丢弃微秒。

[用例上下文](../../packages/server/src/platform/context.ts) 定义数据库、时钟、BlobStore、审计和事件接口。当前组合使用数据库、时钟、本地字节存储与 Core 审计。[FileService](server-files.md) 提供文件能力；领域规则不依赖 Node、Hono 或数据库驱动，Platform Core 不引用 Lab。
