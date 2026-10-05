# 重放迁移合同基准

本指南面向迁移 Lab Word 服务的开发者。M0 使用真实 Rust HTTP/SSE 服务，重放已交付的 Core、Foundation #2–#11 和 #26–#28。新 TypeScript 服务尚未实现。#29–#40 的产品行为不属于此基准。

## 得到第一个结果

在仓库根目录执行。需要仓库指定的 Node、pnpm、Rust、Docker。Docker daemon 必须可用。

```bash
pnpm install --frozen-lockfile
pnpm test:contract core.test.ts
```

runner 编译独立 Rust target，创建隔离 PostgreSQL、Redis、RustFS 和 Mailpit，执行迁移，再启动 API 和文件清理 Worker。它通过 HTTP 创建首个 Owner。用例中的其他注册用户是 Member。

终端显示实际收集和执行的测试数量。`CORE-02` 验证缺少 CSRF 的写入被拒绝，Lab 列表保持不变，正确写入随后成功。`CORE-03` 验证有效 Agent、无效 Bearer 不回退 Cookie，以及撤销后的拒绝。

未选择文件时，`test:contract` 运行 Core/API 小片段。完整合同使用下节的 `test:contract:all`。

测试只通过 HTTP 准备业务，通过 HTTP/SSE 观察结果。ID 和游标原样传回服务。进程控制用于真实启动、停止和重启。

## 运行全部必需合同

```bash
pnpm test:contract:all
```

六个 profile 各有独立数据和 owned ledger。任何 profile 失败都会使命令失败。

| Profile       | 验证                                                           | 显式测试配置               |
| ------------- | -------------------------------------------------------------- | -------------------------- |
| `baseline`    | 身份、权限、资产、世界、设备、SSE、历史、记录、趋势和 API 合同 | 生产默认额度与保留期       |
| `file-ttl`    | 签名上传/下载过期及重新授权恢复                                | 下载 2 秒、上传会话 5 秒   |
| `session-ttl` | 会话 idle/absolute 过期、SSE 结束与新登录恢复                  | idle 60 秒、absolute 65 秒 |
| `retention`   | 公开清理、真实缺口、在途任务、最后值及过期命令 receipt         | 观测 2 秒、结束记录 3 秒   |
| `rate`        | 主额度 20/60/600、429、`Retry-After` 与窗口恢复                | 窗口 5 秒；主额度保持默认  |
| `capacity`    | 1000 Entity/1000 Scene Node 和超限拒绝                         | 关闭限流，独立验证容量     |

baseline 按 Core/API、资产世界、设备、历史和 SSE 分五批，各批使用新进程和独立数据。这样不会让多个测试文件的轮询耗尽同一 TCP 客户端的正常额度。总共六种 profile、十批真实运行。

正常限流仍是注册 20、认证 60、资源 600，每 60 秒。`fallback_limit` 的 5/20/120 和 4096 桶容量是兼容配置。它们不能代替正常额度。旧 Redis 故障模式不进入新服务的共同 oracle。

开发中可定向运行已编译目标：

```bash
pnpm test:contract --no-build sse.test.ts
pnpm test:contract --no-build --profile retention
```

`--no-build` 只适用于已编译当前 Rust 源码的 target。它不证明旧二进制与当前候选一致。

## 阅读覆盖和失败

[行为矩阵](../../tests/contract/behavior-matrix.json) 为每条行为登记来源、正常结果、拒绝后状态、恢复、用例和预算。`public` 是公开 HTTP/SSE；`configuration` 使用现有配置。`internal-supplement` 明确由后续票承担内部规则或用例验证。`gap` 表示必需覆盖仍缺失，不能宣告 M0 完成。

24 小时尖峰造样、坏质量、旧来源、重复 sequence、精确 SQL 计量及 SSE 恰好 8 条待发不能由当前公开入口可靠诱发。矩阵将它们映射到 #48/#50。现有 SQL/Runtime 先例不是纯 HTTP 证据。真实事件大小、断线和凭据撤销仍由共同合同验证。

运行证据在 `.scratch/vnext-m0/runs/<run-id>/`。`results.json` 保存实际发现、通过与失败数量；`owned-resources.json` 保存资源意图、身份、消费者和前后盘点。`.scratch/vnext-m0/current.json` 指向最近一次 run。完整命令还写入 suite manifest。

先辨别失败类型：编译、零收集和夹具错误不算业务 red。业务失败需保留原断言和预算。修复夹具不能改变生产默认值。旧趋势容量夹具 `now - 86370` 与默认保留期的时效风险另行记录。

## 比较保留 API

```bash
pnpm contracts:baseline:check
```

[比较工具](../../scripts/lib/contract-openapi.ts) 只过滤明确移除的知识库、通知、邮件密码重置、通用 jobs 和 system cache 路由。它按引用保留 DTO 和安全声明。对象声明顺序不影响结果；DTO、operationId、响应状态、错误和安全变化会报告 JSON 路径。

使用 `node scripts/contract-api-baseline.mjs --input <候选-openapi.json>` 比较另一份 OpenAPI。`--write` 会重写基准，只在已批准合同变更时使用。M0 不固定 schema 版本 28。Rust 版本期望从当前构建和迁移源导出；其他目标报告自己的实际版本。

## 切换目标与恢复资源

Rust 是当前唯一内置 adapter。其他可执行目标可通过 descriptor 接入；这不表示新服务已经存在：

```json
{ "command": "/absolute/path/to/server", "args": [] }
```

```bash
pnpm test:contract --target candidate --descriptor /absolute/path/to/target.json
```

目标获得 `APP_BIND`、`APP_ORIGIN` 和独立 `CONTRACT_DATA_DIRECTORY`。它需自行初始化该目录，并提供相同 HTTP 合同。非 Rust 目标不会创建 Docker 服务。可选 `version`、`schemaVersion` 用于核对实际目标 metadata。

正常结束、失败、超时和 SIGINT/SIGTERM 都会停止本次消费者并清理资源。异常终止后，在原 supervisor 已停止时执行：

```bash
pnpm test:contract --recover .scratch/vnext-m0/runs/<run-id>/owned-resources.json
```

恢复先核对进程组的 PID、启动 token、PGID/session 及子进程 proof，再核对容器 labels 和不可变 ID。身份不明或被替换的资源会保留。工具只删除 owned ledger 内已证明归属的资源，使用 `docker rm -f -v` 回收匿名卷。它不会执行全局 prune，也不会删除既有根服务或持久卷。

M0 Rust/Docker 与进程组恢复验证范围是 Linux。Windows 的新目标 adapter 和子进程验证由后续基础票完成，当前不宣称 Windows 通过。

用 `pnpm test:contract:lifecycle` 检查真实中断和 wrapper 子进程恢复。该命令创建自己的隔离旧栈。CI 在最终候选运行完整合同；本地绿色和 Draft PR 不能代替最终 CI。
