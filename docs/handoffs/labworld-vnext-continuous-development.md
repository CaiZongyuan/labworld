# Lab Word vNext 连续开发交接

交接日期：2026-10-06。接手 PM 从 [#47](https://github.com/CaiZongyuan/labworld/issues/47) 开始，连续完成迁移 #47–#52，再自动恢复产品 #29–#40，直到两个 Gate 的结果实际集成。本次只整理交接；M0 已交付，其余开发尚未完成。

## 执行授权与终点

用户最新指令：

> 形成一个交接文档给下一个pm，他就接着开发，这回需要连续做完，而不是做完一个票就停下来等用户确认

此前用户已批准规格、7 张迁移票的粒度、依赖和测试入口，并要求“发布并开始 M0”。最新指令扩展执行授权至已批准总纲的迁移与产品恢复阶段，取代只启动 M0、逐票等待确认的执行方式。

**PM 可自行领取、派发、实现、修复、提交、推送、创建 PR，在项目门禁满足后合并并关闭实施票，随后立即接续下一张可实施票。** 每票完成只需记录交付和更新依赖；Migration Gate 通过后直接进入产品恢复。沿用已批准的规格、票粒度和体验，迁移仍为原 7 票，不拆出更多迁移票，也不重复发布已有产品票。

终点是 Migration Gate 通过，#29–#40 全部实际集成，且 #40 的 Product Completion Gate 验收通过。数字孪生、Isaac、实机、Browser Standalone、Electron 内嵌服务仍按总纲另行 grill → spec → tickets。代码移除的授权不包含删除旧持久数据。

只有明确暂停指令、必须由用户决定的范围/合同改变、无法自行解决的外部权限或环境阻塞才需要停下对应工作。说明具体阻塞、所需决定及规则来源，保留检查点，并继续不受影响的已授权工作。普通实现选择、例行修复、下一票领取、已有验收的执行均由 PM 推进。

## 接手先做这些

1. 读 [规格 #45](https://github.com/CaiZongyuan/labworld/issues/45)、[#47 全文与评论](https://github.com/CaiZongyuan/labworld/issues/47)、[总纲 v2.0](../plans/labworld-vnext-development-plan.md)、[CONTEXT](../../CONTEXT.md) 和 ADR [0009](../adr/0009-lab-word-product-only.md)、[0010](../adr/0010-single-typescript-lab-word-server.md)、[0011](../adr/0011-pglite-embedded-database.md)。验收以 GitHub 正文、评论中的明确决定和最新用户范围为准；本文件提供执行授权与接续入口。
2. 按 [issue tracker](../agents/issue-tracker.md)、[开发流程](../agents/development-flow.md)、[测试策略](../testing/strategy.md) 核对最新 main、完整候选、assignee、原生 blockers、实际写入者和资源。下表是交接快照，不代替领取前回读。
3. 使用 [pm-development](../../.agents/skills/pm-development/SKILL.md) 安排独立 Developer；保留非作者审查容量，重执行与轻量准备分开排程。一票一 owner、分支、worktree；共享生成入口由单一集成人负责。新 PM 重新建立角色，不把历史 agent 名称当活跃租约。
4. #47 无未完成依赖、未分配。核对后领取，以最新 `origin/main` 建立新的 #47 工作树。先稳定组合根、数据库平台和上下文，再进入业务模块；迁移期 #29–#40 保持冻结。
5. 每票通过简化、独立 Standards + Spec、适用最终 head CI 和实际集成后，回读 merge/issue，更新轻量检查点与 [阶段记录](../../.agents/skills/development-timeline/SKILL.md)，接续新的可实施票。上下文压缩、换人或交接保留本授权与下一步，不构成新的用户审批点。
6. #52 集成并证明 Migration Gate 后，确认 #29/#30 旧 writer 停止、记录 owner 转交，在新架构实现产品票。优先 #30/#29；#36 同时依赖就绪，按真实代码重叠安排。波次是优先级，不是额外的整波阻塞。

仓库根目录的读取与新工作树入口：

```bash
gh issue view 47 --repo CaiZongyuan/labworld --json title,body,comments,assignees,labels,state
gh api repos/CaiZongyuan/labworld/issues/47/dependencies/blocked_by
git status --short
git worktree list --porcelain
git fetch origin
git worktree add -b feat/47-vnext-server-foundation .worktrees/47-vnext-server-foundation origin/main
```

分支或目录已存在时，先核对 owner 与完整工作状态，再恢复原工作；实施评论应记录 owner、分支/worktree、base 和证据位置。所有 GitHub 操作显式指定 `CaiZongyuan/labworld`。

## 当前基线与迁移队列

2026-10-06 07:34 UTC 回读：本地 main 与 GitHub main 均为 `cd28bb03c60ad05d01be83288bc24e2f0a90cdb1`，根工作树在本次交接编辑前干净。该提交已纳入总纲、ADR 0009–0011 和 M1 官方研究；`cf27165` 已纳入 skills/tooling 更新。旧 M0 检查点所称“8 份 staged 文档及 untracked research”已成为历史，不再是待保全改动。

M0 [#46](https://github.com/CaiZongyuan/labworld/issues/46) 经 [PR #53](https://github.com/CaiZongyuan/labworld/pull/53) 合并，merge 为 `d3878fce37705052c5cb5eef09ce25a958395af7`。独立审查与最终 CI 候选为 `a8d9b9663845d1de7a33c00b52daa840fdaf7c13`，集成 tree 与候选一致。[CI 37341110044](https://github.com/CaiZongyuan/labworld/actions/runs/37341110044) 的 `verify`（完整 `just check` 和合同套件）与 `desktop-smoke` 成功。新 TypeScript 业务服务尚未实现；M0 绿色不代表迁移完成。

| 票                                                       | 交付                                      | 原生前置 | 交接状态                 |
| -------------------------------------------------------- | ----------------------------------------- | -------- | ------------------------ |
| [#46](https://github.com/CaiZongyuan/labworld/issues/46) | M0 旧栈 HTTP/SSE 基准                     | 无       | CLOSED，已集成           |
| [#47](https://github.com/CaiZongyuan/labworld/issues/47) | M1 TypeScript 基础与数据库 spike          | #46      | OPEN，依赖已完成，未分配 |
| [#48](https://github.com/CaiZongyuan/labworld/issues/48) | M2 Platform Core、身份、凭据、文件        | #47      | OPEN，blocked，未分配    |
| [#49](https://github.com/CaiZongyuan/labworld/issues/49) | M3a 资产、世界、关系与布局                | #48      | OPEN，blocked，未分配    |
| [#50](https://github.com/CaiZongyuan/labworld/issues/50) | M3b 设备、SSE、历史、记录、趋势、生命周期 | #49      | OPEN，blocked，未分配    |
| [#51](https://github.com/CaiZongyuan/labworld/issues/51) | M4–5 运维恢复、Web/Electron 切换          | #50      | OPEN，blocked，未分配    |
| [#52](https://github.com/CaiZongyuan/labworld/issues/52) | M6 一次删除旧栈与 Migration Gate          | #51      | OPEN，blocked，未分配    |

这些票均有 `ready-for-agent` 标签；标签表示规格充分，领取仍需 blockers 完成和单 owner。#45 是规格参考，保留正文与状态；实施进度记录在子票和 PR。

## #47 的关键验证

按 [#47](https://github.com/CaiZongyuan/labworld/issues/47) 实现 Node 24/Hono/Zod/Drizzle、新服务健康与错误合同、默认回环监听、Web 代理、真实进程 harness、串行数据库执行器和可校准语句计量。Core 不引用 Lab，纯领域规则不依赖 Node/Hono/Drizzle/PGlite；读取、写入、后台操作都经执行器，事务内不等待外部 I/O。

正式 spike 必须保留以下证据：

- 保留的最终 schema、限定名、jsonb、约束、索引、CTE、RETURNING、UUID 和迁移重开行为；不载入移除模块。
- 20 台 1Hz 设备形态写入、两个 SSE 订阅与代表性并发请求持续至少 30 分钟；满足已有预算，采样漂移不超过一个周期。合成负载不冒充完整设备验收。
- 写入中至少 20 次真实 force-kill；每次重开并核对所有已向外部确认提交的数据。证明两个进程不能同时打开同一目录。
- Linux 与 Windows 各实际执行启动、迁移、适用 HTTP 合同子集。冷启动、目录体积、内存仅报告；缺少平台证据保持 pending。

[官方研究笔记](../research/2026-10-05-pglite-drizzle-foundation.md) 已提交，可作为集成输入。PGlite 0.5.8 的 NodeFS `syncToFs` 为空、默认含 `-F`；这些源码事实既不证明本项目强杀耐久性成功，也不证明必败。锁定实际版本和有效配置后实测。保留微秒时间字符串，验证同一毫秒内 `.123456Z` / `.123457Z` 在驱动、Drizzle、公开输出、排序和游标中的保真；单一 `Date` 路径会丢微秒。

ADR 0011 仍 proposed。全部判据通过后定案；任一实测失败按已批准方案切换 npm 分发原生 PostgreSQL、重证适用合同并更新 ADR，无需重新审批既定 fallback。尚未执行的证据不算失败。Linux/Windows 证据与决策完成才可关闭 #47。

M1 先在隔离产物接通 Zod → OpenAPI → 现有生成链路，保留尚未迁移的客户端合同；完整 SDK 来源到 #51 才切换。阶段 CI 明示已完成与 pending 覆盖，从 M1 起新栈日常验证无 Docker，不重复启动冻结旧服务。

## 验证与合并循环

公共入口见 [合同指南](../testing/contracts.md)及其 [英文版](../testing/contracts.en.md)，详细责任见 [behavior matrix](../../tests/contract/behavior-matrix.json)。M0 有 42 项唯一真实 HTTP/SSE 合同、6 个逻辑 profile、10 个隔离运行批次，必需 public gaps 为空；内部规则、事务、SQL 预算和浏览器补证仍由 #48/#50/#51 完成。

当前已存在的入口如下；默认 `test:contract` 只跑 Core/API 小片段，不能当作全量通过：

```bash
pnpm test:contract:all
pnpm contracts:baseline:check
node scripts/contract-api-baseline.mjs --input <candidate-openapi.json>
pnpm test:contract --target candidate --descriptor /absolute/path/to/target.json
```

当前内置 Rust adapter 需要 Docker且只验证过 Linux；descriptor 的非 Rust 目标不会创建 Docker，正式新服务和 Windows adapter 属于 #47。`--no-build` 需匹配当前源码的二进制。保留 M0 oracle 与 API 基准，只因明确批准的合同改变才重写基准。总纲的 `pnpm check` 等目标命令须随对应票实现，不能提前声称可用。

每票从真实公共行为完成 red/green、失败后状态与恢复；随后运行 [reduce-complexity](../../.agents/skills/reduce-complexity/SKILL.md)，固定完整候选，取得非作者 Standards + Spec 审查及适用最终 head CI。权限、事务、恢复和广泛共享合同优先两位独立审查者；按项目规则记录实际容量与覆盖。更新 main 后检查语义影响，复用有效证据并刷新受影响部分。CI/审查通过后自行合并，回读真实 merge 和 issue，再进入下一票。

使用 [CI observer](../../.agents/skills/pm-development/references/ci-observer.md) 有界观察并记录状态变化。observer 的 exit 0 可能只是失败结果已经终止；PM 仍要核对 required checks、head、结论与完整覆盖。旧 head 的绿色、Draft PR、零收集和预览均不能替代交付。

Migration Gate 的完整清单在 [总纲 §6](../plans/labworld-vnext-development-plan.md#migration-gate) 和 #52：新克隆无旧栈安装/启动、全部共同合同、保留 OpenAPI 零语义差异、确定性预算、真实 Web/Electron、备份恢复/密码命令、数据库定案、旧栈单 PR 移除、可运行文档、简化/审查/最终 CI。最后含 Rust 的 main 打 `legacy-rust-final`；旧持久数据继续保留。门禁通过就接续产品恢复。

## 产品恢复队列与行为输入

原规格 [#23](https://github.com/CaiZongyuan/labworld/issues/23)、[#24](https://github.com/CaiZongyuan/labworld/issues/24)、[#25](https://github.com/CaiZongyuan/labworld/issues/25) 及 #29–#40 均 OPEN。#26/#27/#28 已集成，PR #44 亦已合并；暂停交接中“PR #44 待合并”的状态已过时。依赖快照如下，产品领取还需 Migration Gate 已通过。

| 票                                                       | 内容                           | 原生前置           |
| -------------------------------------------------------- | ------------------------------ | ------------------ |
| [#29](https://github.com/CaiZongyuan/labworld/issues/29) | 私人引导进度                   | 无                 |
| [#30](https://github.com/CaiZongyuan/labworld/issues/30) | 同一设备详情、操作与任务结果   | #26（CLOSED）      |
| [#31](https://github.com/CaiZongyuan/labworld/issues/31) | 三维表示、相机、标签、几何合同 | #30                |
| [#32](https://github.com/CaiZongyuan/labworld/issues/32) | 真实 TanStack 趋势 UI          | #27（CLOSED）、#30 |
| [#33](https://github.com/CaiZongyuan/labworld/issues/33) | 记录、活动与当前页 CSV         | #28（CLOSED）、#30 |
| [#34](https://github.com/CaiZongyuan/labworld/issues/34) | 创建/登记安全重试与初始摆放    | #31                |
| [#35](https://github.com/CaiZongyuan/labworld/issues/35) | 基础、完整、空白模板           | #34                |
| [#36](https://github.com/CaiZongyuan/labworld/issues/36) | 本浏览器布局草稿恢复           | #26（CLOSED）      |
| [#37](https://github.com/CaiZongyuan/labworld/issues/37) | 显式运行总览与筛选             | #32、#33           |
| [#38](https://github.com/CaiZongyuan/labworld/issues/38) | 首次真实旅程与动态引导         | #29、#35、#36      |
| [#39](https://github.com/CaiZongyuan/labworld/issues/39) | 跨上下文续接与位置回顾         | #38                |
| [#40](https://github.com/CaiZongyuan/labworld/issues/40) | 完整里程碑验收与连续学习路径   | #37、#39           |

#29/#30 当前 GitHub assignee 为 `CaiZongyuan`，评论保留旧 implementer 身份；其余未分配。原 writer 已在暂停阶段停止，本次 agent 列表仅 PM/root。恢复时仍需核对实际进程与写入者，明确转交，保留一票一 owner。

[暂停交接](pm-workbench-refactor-pause-2026-10-05.md)保留完整旧候选、备份 manifest、行为及已知缺陷；其暂停授权与当时版本/资源数字属于历史，接续授权以本文件为准。旧 #29/#30 worktree 仍有 staged 源码，保留 `refs/handoffs/20261005T040315Z-pm-pause/*`。提取纯规则、行为测试和教程语义，在新模块重实现；不 cherry-pick/apply 旧补丁，#29 不沿用旧 `0029` 迁移号。新入口记录在子票评论，父规格与票正文保持批准版本。

复用已接受的空间 v1 `7a7007d7`、operations v1 `a1486c78`、onboarding v2 `037fa8ee`；取得方式见暂停交接与 [体验规范](../agents/experience-design.md)，[operations 体验](../ui/lab-operations-experience.md)是其中一个入口。历史预览端口和模拟结果不证明当前正式应用可用。迁移默认 desktop web；产品原有窄屏/触屏验收仍有效，#30 的 320×640、320×844 长名称裁剪缺陷需要修复与新栈验证，按当前范围执行无需另问是否保留。

跨票语义按暂停交接的八条合同和 GitHub 规格验证，特别保留当前/最后 Observation、Command/Run/Task/result 独立身份、私人进度 CAS、业务 receipt/association 原子性、过期已提交尝试只读恢复、版本化几何、真实模板对象及初始不启动 Run。趋势仍由服务端数据库做有界且保来源/缺口的压缩；浏览器负责渲染和必要的追加呈现简化，按 #45 的澄清理解总纲中的浏览器降采样。

#40 验收整个集成范围：默认空间 → 设备详情 → 趋势/任务/记录 → 模板 → 登记与布局保存 → 引导 → 续接。需 100 Entity、20 台 1Hz 设备、两个真实浏览器、确定性 24h 趋势、包体与 SQL 预算、真实 WebGL/图表、连续双语学习路径、独立审查和最终 CI。Epic 简化 survey 覆盖整个里程碑与消费者，不能只检查 #40 diff；可选清理作为建议。全部实施票真实集成后才算 Product Completion Gate 完成。

## 工作树、资源与证据

同机保留工作树如下。接手以最新 main 建新树，保留旧成果；这些路径与 scratch 证据只在本机可用。

| 路径（仓库根下）                        | HEAD                   | 用途                                                         |
| --------------------------------------- | ---------------------- | ------------------------------------------------------------ |
| `.worktrees/46-vnext-contract-baseline` | `a8d9b966`             | M0 审查候选、隔离 Rust cache 与证据；原 owner `developer_m0` |
| `.worktrees/29-guide-progress`          | `d028d602`             | #29 staged 旧实现，行为参考，未交付                          |
| `.worktrees/30-device-details`          | `d028d602`             | #30 staged 旧实现与未收尾验证，未交付                        |
| `.worktrees/27-bounded-trends`          | `5014ff44`             | 已合并 PR #44 的历史维护现场                                 |
| `.worktrees/foundation-preview`         | `10c4c22f`（detached） | 已接受 Foundation 预览                                       |

本次只读 Docker 盘点（2026-10-06 07:33 UTC）：15 containers、19 volumes、8 networks；仅 `clinmesh` 两个容器运行，根四服务和 `agentic-axum-saas-demo` 九容器均 exited。images 7.944GB、containers 1.171MB、volumes 711.9MB、build cache 32.02GB。本次未创建/删除 Docker 资源；进程名盘点未发现 Node/Cargo/产品测试消费者，当前没有已验证的正式 Lab 验收地址。接续时重新建立真实应用并记录地址。

根 `labos-threejs` 的 postgres/rustfs/redis/mailpit 容器、`labos-threejs_postgres-data`、`labos-threejs_rustfs-data`、`labos-threejs_rustfs-logs` 卷及网络保留，归属既有开发数据；其他项目资源归其 owner。退出或无引用不构成删除授权。M0 原清理回执确认本票临时 container 为 0；本次 inventory 未见 M0 临时容器。M1 起新服务用独立临时目录；创建者负责结束消费者、清理与中断恢复。

需要恢复 M0 异常运行时，先确认原 supervisor、creator CLI 和所有消费者停止，再使用现有 owned runner：`pnpm test:contract --recover <owned-resources.json>`。按 ledger 核对不可变 container ID、labels、进程身份/创建标记；活跃 owner、无效 ledger 或身份不明时拒绝清理。规则见 [AGENTS.md](../../AGENTS.md#docker-resources)。不要为交接重新执行旧 Docker 验证。

本机补充证据（缺失时从已发布 PR、CI 和源码读取，不把本地附件当接手前置）：

- [当前 checkpoint](../../.scratch/labword-vnext-20261005/current.md)、[M0 历史交付](../../.scratch/labword-vnext-20261005/delivery.md)、[发布编号](../../.scratch/labword-vnext-20261005/publication.md)。
- [本次 tracker 快照](../../.scratch/labword-vnext-20261005/evidence/handoff-tracker-20261006.json)、[本次资源快照](../../.scratch/labword-vnext-20261005/evidence/handoff-resources-20261006.json)。
- M0 [集成回执](../../.scratch/labword-vnext-20261005/evidence/m0-integration.json)、[最终 CI](../../.scratch/labword-vnext-20261005/evidence/m0-final-ci-success.json)、[覆盖复核](../../.scratch/labword-vnext-20261005/evidence/m0-pm-coverage-check.json)、[清理与保留归属](../../.scratch/labword-vnext-20261005/evidence/m0-delivery-resources.json)。
- [M0 历史时间线](../../.scratch/labword-vnext-20261005/timeline.html)；新的接续记录追加独立 journal，交接不等于余下开发完成。

M0 的有效经验已写入合同指南：隔离 TCP 配额批次；趋势对照公开原始历史及停止缺口；拒绝检查 before/after 状态；OpenAPI example/default 数组保留业务顺序；离心 running 门槛为 ±50 RPM/±0.5°C；24h Rust fixture 单独用 172800 秒保留，默认 86400 秒裁剪仍独立验证。旧知识库 optional 100ms cache 计数曾 CI 失败，同 head 重试通过，根因未证，不宣称已修复；该模块按 #52 移除。复用有效证据，保持生产默认和预算。
