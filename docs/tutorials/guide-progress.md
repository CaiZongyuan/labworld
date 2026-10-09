# 保存个人 Lab 引导进度

目标：用真实 Member 会话与同一用户的 Agent 凭据读写个人引导记录，检查错误后的恢复及共享 World 不变。

## 起始版本与本章变更

使用[完整旅程](complete-foundation.md)指定的共同版本。先完成[持久 Lab 与对象](persistent-world.md)，了解 User、Entity 与 Scene Node 的独立身份。没有 Lab 也可以运行本章。命令在仓库根目录运行。

实现入口是[进度 HTTP](../../crates/app/src/modules/lab/progress.rs)、[迁移](../../migrations/0029_lab_guide_progress.sql)、[生成 SDK](../../packages/sdk/src/generated/sdk.gen.ts)和 [Lab ownership](../../crates/app/src/modules/lab/module.json)。Lab 页面尚未接入视觉引导；本章使用正式 HTTP/SDK 接口。

```bash
pnpm install --frozen-lockfile
just dev
```

使用普通 Member 创建有效的 `lab:full` API 密钥。读取不会建立学习记录。显式写入会修改开发数据库中当前用户的个人进度，不创建 Lab、对象或设备操作。

## 得到个人记录

```bash
export LAB_API_BASE=http://127.0.0.1:3000
read -rs LAB_API_KEY
export LAB_API_KEY
node examples/lab/guide-progress.mjs
```

脚本通过生成 SDK 调用 `GET /api/v1/lab/guides/lab-onboarding/1.0/progress`。没有记录时，`progress` 为 `status=not_started`、`revision=0`；步骤、引导尝试、Lab/Entity/Node 引用和更新时间为空。读取不插入记录，也不把其他成员的完成状态当作自己的首次状态。

响应包含 `current_guide_version`、`compatibility`、`progress` 与 `previous_progress`。个人记录以当前认证用户、guide id 和版本区分。两个 Member 可以引用同一共享对象，但各自保存独立进度。同一用户的会话与有效 Agent 凭据访问相同记录。

## 显式保存并恢复

```bash
LAB_GUIDE_WRITE=1 node examples/lab/guide-progress.mjs
```

第一次运行会保存 `paused/create_lab`、一个 UUID 引导尝试和无 Lab 的初始上下文。`business_attempt` 保存客户端的 `create_lab` 尝试键。这个键尚未提交创建请求，保存进度不会创建业务对象。已有记录时，脚本保留原尝试、步骤及上下文；已完成记录保持 `completed/complete`。

完整示例：

<<< ../../examples/lab/guide-progress.mjs

`PUT` 使用相同路径。请求包含 `expected_revision`、`status`、`step`、`guide_attempt_id` 和 `context`。缺记录使用 revision 0；每次成功保存返回新的 revision。并发使用同一个 revision 时，仅一个请求成功，另一个返回 `409 lab.guide_progress_conflict`。

| 状态                    | 有效输入                                         |
| ----------------------- | ------------------------------------------------ |
| `not_started`           | step 与 guide attempt 为空，context 所有字段为空 |
| `in_progress`、`paused` | UUID guide attempt，除 `complete` 外的稳定 step  |
| `completed`             | UUID guide attempt，step 为 `complete`           |

稳定步骤为 `create_lab`、`register_light`、`select_entity`、`edit_placement`、`save_layout`、`return_run`、`start_program`、`light_action`、`verify_observation`、`asset_library`、`complete`。Driver.js 数组位置、翻译和对象名称不属于保存合同。

`context` 包含可空的 `lab_id`、`entity_id`、`node_id` 和 `business_attempt`。新建或改变对象引用时，服务器检查 Lab 归属；同时提供 Entity 与 Node 时，Node 必须引用该 Entity。对象不必由当前用户创建。对象改名后引用不变；目标后来归档或 Node 移出布局时，GET 保留原身份，同一上下文仍可保存暂停状态。使用公开 World 查询核对实际可用性。

业务尝试包含 `operation=create_lab|register_entity`、可空 `target_lab_id` 和 `request_key`。创建 Lab 的目标为空，登记对象的目标等于 context Lab。键为 1–128 个可见 ASCII 字符。它仅表达客户端尝试，不证明业务已提交，也不会创建或改写业务收据。服务器根据凭据确定 owner；请求中的 owner、receipt 或 committed context 字段返回 400。

会话调用使用 `LAB_SESSION_COOKIE` 与 `LAB_SESSION_CSRF`，写入时携带正常 Origin 和 CSRF。可用 `LAB_WEB_ORIGIN` 指定已配置的前端 Origin。不要把 Cookie、API key 或 CSRF 写入源码、截图或日志。

## 错误与版本恢复

脚本验证伪造 committed context 返回 400、陈旧 revision 返回 409，再通过 GET 确认成功保存的记录仍在。响应丢失或保存失败时，先 GET 当前记录，再决定是否使用最新 revision 重试。个人进度不是重复创建、保存布局、启动程序或发送命令的依据。

未知 guide 返回 `404 lab.guide_not_found`。不支持版本的 PUT 返回 `400 lab.guide_version_unsupported`。GET 仍可读取旧版本的原状态、步骤与身份，并返回 `compatibility=unsupported`。旧步骤不自动转换。

请求当前版本且尚未开始、但已有其他版本记录时，响应为 `restart_required`，`previous_progress` 为最近更新的其他版本记录。应先让用户选择续查旧记录或开始当前版本，不自动重播。明确开始当前版本时使用新的 guide attempt 与当前版本 revision；旧版本记录保留，可按原版本路径读取。

无 CSRF、错误 Bearer、失效或撤销凭据、登出及停用成员均按现有认证规则拒绝访问。错误 Bearer 优先于 Cookie，不退回有效会话。重新认证后读取相同个人记录。事务内持久化或审计失败返回 503，原记录、World、布局版本及 Run/Task/Command 保持不变。

## 验证与下一阶段

```bash
node scripts/test-backend.mjs --test lab_progress
pnpm contracts:check
pnpm boundaries:check
pnpm docs:check
```

Router 检查使用隔离 PostgreSQL，包含两个真实 Member、同用户 Agent、并发冲突、旧版本、失效目标、认证拒绝和审计故障回滚。SDK 检查运行本章示例，通过真实 Axum listener 完成 GET/PUT、拒绝与恢复。进度表不更新共享 World clock，不产生 SSE 世界变更，也不保存布局草稿。继续使用[布局编辑](edit-layout.md)和[后端照明](backend-lights.md)的普通业务入口；恢复进度不会自动执行它们。
