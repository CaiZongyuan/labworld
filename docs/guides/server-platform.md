# 使用 Platform Core

本指南面向调用或扩展 Lab Word Server 的开发者。当前 Node 服务实现身份、会话、成员、API key、审计、幂等、限流与文件能力。Lab 资产、世界写入和设备程序仍按后续迁移阶段交付。

## 注册并读取会话

先按[服务基础](server-foundation.md)运行 `pnpm dev`。需要 Node 24 与 pnpm；此路径不需要 Docker。以下 JavaScript 在 `http://127.0.0.1:5173` 的浏览器开发者控制台执行，会写入 `data/`。示例邮箱应属于你的测试数据，密码只用于本机测试。

```js
const registered = await fetch('/api/v1/auth/register', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    email: 'core-reader@example.test',
    password: 'local-example-password-2026',
  }),
});
console.log(registered.status); // 201；邮箱已存在时为 409
const sessionResponse = await fetch('/api/v1/auth/session');
let session = await sessionResponse.json();
console.log(session.user.role); // 新目录中的首位注册者为 owner
```

后续注册者为 Member。已有邮箱返回 409，原密码不变。此时使用 `POST /api/v1/auth/login`，请求体包含 `email` 和 `password`，再读取 session。密码需 12–128 个 Unicode 字符。

服务保存密码哈希和会话秘密的哈希。浏览器保存 HttpOnly 会话 Cookie；HTTPS origin 使用 Secure Cookie。`GET /auth/session` 返回用户和 `csrf_token`。写入需要相同 Cookie、可信 `Origin` 和 `x-csrf-token`。客户端隐藏按钮不能代替服务授权。

验证拒绝与恢复：先执行不带 CSRF 的退出请求。

```js
console.log((await fetch('/api/v1/auth/logout', { method: 'POST' })).status); // 403
console.log((await fetch('/api/v1/auth/session')).status); // 200，会话仍有效
console.log(
  (
    await fetch('/api/v1/auth/logout', {
      method: 'POST',
      headers: { 'x-csrf-token': session.csrf_token },
    })
  ).status,
); // 204
console.log((await fetch('/api/v1/auth/session')).status); // 401
```

重新登录可恢复。会话同时受绝对期限和空闲期限约束；读取配置默认值见[配置参考](site:reference/config.md)。退出撤销该会话，不会撤销所有用户会话。

## 管理企业成员

Owner 或 Admin 使用会话调用 `GET /api/v1/organization/members?limit=50`。使用返回的 `next_cursor` 读取下一页；不要解析或跨账号复用 cursor。Member 返回 403。

| 操作者 | 可管理的当前角色与目标角色 |
| ------ | -------------------------- |
| Owner  | Owner、Admin、Member       |
| Admin  | Admin、Member              |
| Member | 无成员管理权限             |

更新接口为 `PUT /api/v1/organization/members/{user_id}`。请求体示例为 `{"role":"member","active":true,"version":1}`；`version` 必须来自最新读回结果。浏览器写入沿用 Origin 与 CSRF。

过期版本返回 409：刷新成员，再决定是否重试。移除最后一个活跃 Owner 返回 422，原状态不变。停用成员会撤销其会话，API key 也因创建者不活跃而拒绝访问。恢复活跃状态后，用户重新登录；未撤销、未过期的 key 可再次通过创建者检查。成员变更、会话撤销与审计在同一事务提交。

## 创建并撤销 Agent 凭据

重新登录并读取新的 session。任何活跃 Member 都可以创建自己的 key。下面使用同一浏览器控制台；将新 session 保存到 `session` 变量。

```js
session = await (
  await fetch('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'core-reader@example.test',
      password: 'local-example-password-2026',
    }),
  })
).json();
const created = await (
  await fetch('/api/v1/api-keys', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-csrf-token': session.csrf_token,
    },
    body: JSON.stringify({
      name: 'Local Agent',
      scopes: ['profile:read', 'lab:full'],
      expires_in_days: 1,
    }),
  })
).json();
const agentHeaders = { authorization: `Bearer ${created.secret}` };
console.log((await fetch('/api/v1/profile', { headers: agentHeaders })).status); // 200
console.log(
  (
    await fetch(`/api/v1/api-keys/${created.key.id}`, {
      method: 'DELETE',
      headers: { 'x-csrf-token': session.csrf_token },
    })
  ).status,
); // 204
console.log((await fetch('/api/v1/profile', { headers: agentHeaders })).status); // 401
```

创建响应仅此一次返回 `secret`；列表只返回元数据。不要把 secret、Cookie 或完整签名 URL 写入日志。`profile:read` 允许读取创建者资料。`lab:full` 是 Lab 完整能力的 scope；当前 Lab 路由尚未迁移。查看支持的 scope：`GET /api/v1/api-keys/scopes`。

Agent 不通过 key 管理成员、key 或审计。显式无效 Bearer 返回 401，即使请求另带有效会话 Cookie。缺少所需 scope 返回 403。撤销、过期或创建者不活跃都使凭据失效。文件等分阶段操作在最终事务重新检查同一个凭据；新的会话或 key 不会让旧凭据重新有效。

## 读取审计与请求预算

Owner 或 Admin 使用会话读取 `GET /api/v1/audit-events?limit=50`。支持 `actor_id`、`action`、`resource_type` 和 `resource_id` 过滤。cursor 绑定操作者与过滤条件。审计记录原操作者与请求关联，元数据不保存密码、key secret 或会话值。

`GET /api/v1/system/rate-limits` 向 Owner 或 Admin 返回本进程指标。限流按 TCP peer 计量，忽略转发头；默认窗口为 60 秒，最多 4096 个本地 bucket。额度耗尽返回 429 和 `Retry-After`。等待返回的秒数后再发请求。当前没有 Redis 限流消费者。

[幂等能力](../../packages/server/src/core/idempotency/use-cases.ts)由业务在已有 `DbSession` 中调用。先授权，再查询 replay；claim、业务写入、审计和保存的结果使用同一事务。它保留结果 24 小时，每次 claim 最多回收 25 条过期记录。调用方将相同 key 的参数冲突映射为 409。后续 Lab handler 负责挂接真实业务路径。

## 停止服务并重置密码

此操作修改持久数据。先停止使用同一数据目录的 Server；目录独占会拒绝第二个持有者。保留该目录，不删除数据库来解除独占。

从仓库根目录运行以下 Bash 命令。输入不会回显；密码经标准输入进入命令，不出现在参数中。

```bash
read -r -s -p 'New password: ' core_password
printf '\n'
printf '%s\n' "$core_password" | pnpm reset-password --email core-reader@example.test
unset core_password
```

默认读取 `data/`。使用其他目录时，在命令前设置相同的 `LAB_WORD_DATA_DIR`。成功输出 `status: reset` 与用户标识，不输出密码。命令原子更新密码、撤销旧会话并记录 `identity.password_reset`；审计 `actor_type` 为 `system`，`actor_id` 为 null，`metadata.subject_user_id` 指向被重置用户。

重新运行 `pnpm dev`，用新密码登录。旧会话和旧密码返回 401。输入无效、用户不存在、数据库或审计失败时，命令非零退出；先修复报告的问题，再重试。不要自动替换未知的数据库或密钥文件。

## 源码与验证责任

| 能力                           | 当前 Node 源码所有者                                                                                                                                                                                  |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 组合、配置、生命周期与密码命令 | [apps/server](../../apps/server/src/main.ts)、[config](../../apps/server/src/config.ts)、[runtime](../../apps/server/src/runtime.ts)、[reset-password](../../apps/server/src/reset-password.ts)       |
| 身份与会话                     | [Core Identity](../../packages/server/src/core/identity/use-cases.ts)                                                                                                                                 |
| 成员角色与 CAS                 | [Core Organization](../../packages/server/src/core/organization/use-cases.ts)                                                                                                                         |
| API key 与精确凭据重查         | [Core API Keys](../../packages/server/src/core/api-keys/authentication.ts)                                                                                                                            |
| 审计、幂等与限流               | [Audit](../../packages/server/src/core/audit/use-cases.ts)、[Idempotency](../../packages/server/src/core/idempotency/use-cases.ts)、[Rate Limit](../../packages/server/src/core/rate-limit/domain.ts) |
| DB 队列、迁移、文件 I/O        | [Platform DB](../../packages/server/src/platform/db/index.ts)、[BlobStore](../../packages/server/src/platform/blob-store.ts)                                                                          |

Core 不引用 Lab。应用组合注册 scope 与真实消费者。当前 JSON 合同来自 Zod/OpenAPI；正式完整 SDK 仍保留冻结合同，迁移候选单独生成。当前字段、错误、状态和限额见[生成参考](site:reference/api.md)。

从仓库根目录运行定向验证：

```bash
node --test --experimental-strip-types tests/server/core-identity.test.ts tests/server/core-members.test.ts tests/server/core-keys.test.ts tests/server/core-password-command.test.ts
pnpm contracts:m1:check
```

这些检查通过实际 HTTP 或密码命令观察拒绝、读回和恢复。更细的事务、并发与阶段归属见[逐断言映射](../testing/vnext-core-assertions.md)。继续[文件指南](server-files.md)，学习如何在同一事务发布文件与业务引用。
