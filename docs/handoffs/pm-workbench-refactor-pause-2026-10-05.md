# PM 工作台开发暂停与重构交接

暂停决定：用户于 2026-10-05 明确要求先暂停开发，整理全部在途和待做内容，优先重构已有代码，再决定接续开发。

现场核对开始于 **2026-10-05 04:03 UTC / 北京时间 12:03**。备份捕获开始于 04:13:19 UTC。本文件是维护者交接，不是新的产品规格，也不表示未交付功能已经完成。

## 先读这几条

- **当前开发已暂停，不自动恢复。** 所有三个实施 Agent 已结束活跃任务；没有 Cargo、测试、浏览器验证或重型锁正在执行。后续先完成用户安排的重构。
- 原批准工作有 15 张实施票，目前只集成 **#26、#27、#28，共 3/15**。其余 12 张未完成。
- 最重要的未交付代码是 **PR #44 的本地修复、#30 设备详情、#29 个人进度**。#30/#29 尚无功能提交或 PR，单看分支 HEAD 会遗漏它们的 staged 新文件。
- 根目录还有 **18 个未提交的 skills/规范改动**，已通过工具测试和独立审查；它们也需要保留。
- 已保存补丁、完整的变更源码、历史证据和固定 Git tree 引用。**重构后先迁移行为与合同，不把旧补丁直接套进新主线。**

## 基线、权威来源与备份

仓库：[CaiZongyuan/labworld](https://github.com/CaiZongyuan/labworld)。根工作目录：`/home/caii/robots/labos-threejs`。

`main` 与本地 `origin/main` 均为：

```text
d028d60262fbe2576164ce5c833b4caa2fc6c01d
```

该提交包含三个已集成切片；根工作目录当前并非干净，skills/规范修改尚未提交。GitHub Issues/PRs 是状态权威，暂停现场的 API 快照与原生 blocker 关系保存于 [manifest.json](../../.scratch/handoffs/20261005-pm-pause/manifest.json)。父规格 #23/#24/#25 未改写。

备份目录：

```text
仓库内：.scratch/handoffs/20261005-pm-pause/
仓库外：/home/caii/.codex/handoffs/labos-threejs/20261005T040315Z-pm-pause/
```

仓库外副本用于防止仓库目录或 ignored 文件被重构清理。保留两份中的至少一份；三个在途 worktree、`.scratch/pm-parallel-20261004` 与 `.scratch/pm-workflow-upgrade` 也保留。已完成的历史 worktree 后续按用户授权归档清理，见下一节。备份含本地维护证据，未经脱敏与授权不要上传公开站点。

| 快照 | worktree / 分支 | HEAD | 完整未提交 tree | 变更文件 |
| --- | --- | --- | --- | --- |
| skills/规范 | 根目录 / `main` | `d028d602` | `2fc9684c20ee555421873bbcb9491bbce9064960` | 18 |
| 趋势维护 | `.worktrees/27-bounded-trends` / `fix/main-sql-count-scope` | `5014ff44` | `6260ab02cbed3302e5e11e7645c8d56ba579e3e3` | 2，相对主线 |
| 个人进度 | `.worktrees/29-guide-progress` / `feat/29-guide-progress` | `d028d602` | `e63647666ee9c7c58db3b8c252c7b39172599fb7` | 9 |
| 设备详情 | `.worktrees/30-device-details` / `feat/30-device-details` | `d028d602` | `5419fb8ec0e28f5fb417ca5031346669e839d2e7` | 30 |

固定引用前缀为 `refs/handoffs/20261005T040315Z-pm-pause/`，后缀分别为 `root-workflow`、`27-maintenance`、`29-progress`、`30-details`。这些引用指向 tree，用于保留对象；没有创建业务提交、移动分支 HEAD 或改动原索引。

每份快照有 `<名称>.patch` 和 `<名称>-sources.tar.gz`。补丁基线统一为 `d028d602`，已经在临时索引中重放并核对 tree 完全一致；SHA-256 在 manifest 中。源码包保存整个变更文件，便于新架构按语义迁移。`baseline.bundle` 保存已提交基线和 PR44 已发布头；`evidence.tar.gz` 保存两份历史记录目录。数据库和 RustFS 持久数据不在源码备份中，本次未触碰；若重构涉及数据迁移，应另做一致数据备份。

## 后续本地清理：2026-10-05

用户明确授权“按你建议清理”后，已执行 [原清理清单](../../.scratch/handoffs/20261005-pm-pause/cleanup-plan.md)：移除 13 个已完成 worktree 及其分支，再删除两个没有 worktree 的已完成本地分支。worktree 从 **18 减为 5**，本地分支从 **26 减为 11**；业务开发继续暂停。

当前保留：根目录 main、27-bounded-trends、29-guide-progress、30-device-details、foundation-preview。七个 preview 分支、全部恢复引用、stash 和远程引用均保留。删除前后比对了五个保留目录的 HEAD、索引 tree、Git 状态和源码内容，以及全部剩余 Git refs；一致。之后仅补写本交接及本地清理记录。

本轮新增私有备份：

```text
/home/caii/.codex/handoffs/labos-threejs/20261005T091159Z-git-cleanup/
```

目录权限 0700，文件权限 0600。`completed-branches.bundle` 保存全部 15 个删除分支，bundle 验证通过且引用与原头逐一一致。13 份 `*-local-files.tar.gz` 保存旧目录的 `.scratch`、`.secrets`、测试结果等非缓存 ignored 资料；154 个普通文件已逐个核对 SHA-256，符号链接已核对目标。manifest 保存完整清单、PR 合并证据、checksum 和保护对象核对结果。备份约 20.1 MiB，含密钥，继续只在本机私有保存。

6/7/9 的 target 仅 unlink 链接；根 target 保留。每个 worktree 使用正常 `git worktree remove`，未强制移除目录。`.worktrees` 的 `du -sh` 从约 **2.3G 降到 998M**；共享硬链接使该目录变化不能直接等同于整块磁盘释放量。未操作根缓存、服务、Docker、GitHub 状态或远程分支。

恢复方法及完成回执：[cleanup-receipt.md](../../.scratch/handoffs/20261005-pm-pause/cleanup-receipt.md)。历史工作可从 bundle 建立新的恢复分支与隔离 worktree；不要覆盖 main 或三个在途目录。本节覆盖暂停时“历史 worktree 仍保留”的现场描述。

## 已集成的三项成果

| Issue / PR | 实际交付 | 重构时保留的行为 |
| --- | --- | --- |
| [#26](https://github.com/CaiZongyuan/labworld/issues/26) / [#41](https://github.com/CaiZongyuan/labworld/pull/41) | 空间优先工作台、共享 Lab 上下文、深链、选择/面板/草稿状态与相机修复 | `/lab` 无显式 view 时先显示真实三维空间；同一 Lab 单世界订阅；结构和观测更新不擅自重置相机 |
| [#28](https://github.com/CaiZongyuan/labworld/issues/28) / [#42](https://github.com/CaiZongyuan/labworld/pull/42) | Lab 混合记录 HTTP/生成 SDK、筛选/游标/来源/保留与预算 | 原身份和可证操作者、不猜停止者；固定查询上界；全序分页；已归档 Entity 历史可读 |
| [#27](https://github.com/CaiZongyuan/labworld/issues/27) / [#43](https://github.com/CaiZongyuan/labworld/pull/43) | 温度/RPM 有界趋势 HTTP/SDK、数据库分段压缩、缺口与来源 | 真实样本、半开区间、原时间与单位/质量/Binding/Run；不跨缺口连线、不伪造聚合值 |

趋势图界面、运行记录页面和总览尚未交付。API 完成不能算这些 UI 已完成。已合并历史 worktree #26/#28 及 Foundation #2–#11 后续已按用户授权归档清理；原分支源码及本地记录可从上述新增私有备份恢复。

## 未交付成果一：PR44 趋势测试维护

原实施者：`/root/developer_bounded_trends`。公开 [PR #44](https://github.com/CaiZongyuan/labworld/pull/44) **仍开放、未合并**，远程头为 `5014ff4467e7eae5f82db1bd2d1a7ccab8f11e23`。本地后续修复仅 staged，未推送。

问题与修复：

- 主线 CI 的 tracing SQL 计量出现 1/7，而 PostgreSQL 实际执行均为 8 条，原健康计量还漏 BEGIN。修复用目标数据库 OID 的实际 top-level SQL 计量，包含认证与事务控制，隔离其他数据库噪声。
- PR44 新 CI 又出现 `86379 != 86380`：容量样本起点只有约 30 秒保留余量，HTTP 使用真实 wall clock，旧前缀在慢运行中自然过期。
- 最新本地 tree `6260ab02` 仅为容量测试 Router 配置 172800 秒观测保留期，并独立验证生产默认 86400 秒裁剪；生产默认、查询时钟、数据、24h 范围和 SQL 上限未改变。
- 原 `86380` 断言实际 red；修复后 1/100 Entity 都恢复完整样本，物理 SQL 8/8、认证各 2 条。临时第二真实 GET 测到 16 并击中原十 SQL 限制，证明计量能抓超预算。

最新本地完整门禁通过：17 项趋势测试、263 Rust、64 tooling、289 frontend，另 4 项既有 skip；独立 R2 Standards/Spec 均无确认发现。所有临时诊断已移除。远程 [CI 37240238414](https://github.com/CaiZongyuan/labworld/actions/runs/37240238414) 仍是旧头的 verify 失败，desktop 通过，**不能当作最新候选通过 CI**。

来源：[R2 回执](../../.scratch/pm-parallel-20261004/evidence/pr44-rawcount-37240238414/run-1/r2-final-candidate.md)、[诊断裁决](../../.scratch/pm-parallel-20261004/evidence/pr44-rawcount-37240238414/run-1/advisor-decision.md)。

重构后处理：保留可辨别的真实 SQL 预算与默认保留行为测试；原 tracing 内部 cache/drop 机制未证明，不必为仪器修复查尽上游内部。World/records 现有事件计量尚未独立物理校准，不能声称已修复。决定保留旧 PR 还是在新基线重做维护后，再更新头、确认最终 CI 和集成；当前不操作该 PR。

## 未交付成果二：#30 设备详情

原实施者：`/root/developer_device_details_30`。没有 feature commit 或 PR。

已实现：统一 Operations/Records/Details；当前有效与最后报告值判定；实际值与目标值分离；每设备独立输入/尝试/结果；Source Stop/Start 恢复；Task/Run 停止区分；认证失效/断线保护；完整当前执行身份与旧属性来源独立；双语教程与 ownership。

主要迁移入口：`packages/views/src/lab/observation-state.ts`、`entity-detail.tsx`、`device-panel.tsx`、`centrifuge-panel.tsx`、`command-feedback.tsx`、`workbench-context.tsx`，以及 `apps/web/src/lab-device-details.test.tsx` 与 `tests/e2e/lab-device-details.spec.ts`。完整路径清单在 manifest。

版本与已知缺陷：

- 已验证生产候选为 `f491e02104e5f3edf45df3e5a414e75f1bc2fed0`。R1 两项缺陷已修复：所选设备场景可见；当前 Binding/Run/Task/result 可查询，不从旧属性来源猜测。
- R2 Standards 无确认问题，Spec 仍有一项短高/长 Lab 名称裁剪问题：移动布局 scene 至少 180px、inspector 至少 260px，超过可用高度，hidden 父层会裁掉内容。
- 当前 tree `5419fb8e` 比生产候选只新增测试准备：320×640 短名与 320×844 合法 120 字名称。**未执行 R3 浏览器红测，未修复该布局缺陷。**
- 历史验证：两次 `just check`、52 个定向 Views；真实双灯/双离心设备、完成/取消、退出浏览器后后台继续运行和重启后保留结果；代表 390/320×844 的像素、九点遮挡、orbit、质量/新鲜度、44px 操作与焦点。

来源：[R2 候选](../../.scratch/pm-parallel-20261004/evidence/30/run-1/r2-final-candidate.md)、[R2 审查](../../.scratch/pm-parallel-20261004/evidence/30/run-1/review-r2.md)、[R3 准备](../../.scratch/pm-parallel-20261004/evidence/30/run-1/r3-preparation.md)。旧 browser13 的整体结果失败，只复用它已完成的业务部分，不能宣称完整浏览器通过。

重构后处理：先迁移观测/恢复/身份语义，再按新工作台和组件边界接入。重新确认活跃范围：新默认桌面规则不自动抹掉已明确批准的要求；若用户明确缩小旧票范围，记录覆盖关系后按新范围交付。旧预览批准、旧 CSS 和这些截图不证明重构后界面仍正确。

## 未交付成果三：#29 个人进度 API

原实施者：`/root/developer_progress_29`。没有 feature commit 或 PR。完整 tree `e6364766` 有九个变更路径。

实现入口：`crates/app/src/modules/lab/progress.rs`、路由/ownership、`apps/api/tests/lab_progress.rs`、`examples/lab/guide-progress.mjs`、双语教程、`migrations/0029_lab_guide_progress.sql`。

公开合同草案：`GET/PUT /api/v1/lab/guides/{guide_id}/{guide_version}/progress`，guide `lab-onboarding`、version `1.0`。missing progress 读为 revision 0 / not_started；写入有 expected_revision 冲突保护。数据属于当前真实用户，同用户 Member/有效 Agent 共享，两用户各自私有，进度写入没有 World/设备副作用。

已验证：旧基线 `f2b03d9e`、当时 tree `2e2597bc` 上八个真实 Router 测试，包括身份隔离、引用验证、CAS409后恢复、版本兼容、伪造字段拒绝、审计写入故障回滚及既有对象不可用后的原身份保留。后续仅完成到 `d028d602` 的安全基线迁移与轻量准备。

尚未完成：新基线 HTTP 刷新、实际生成 SDK red/green、Member/Agent 真实 SQL/字节预算、受影响验证、简化、最终门禁、独立审查、最终 DTO 发布。准备的 `getLabGuideProgress/saveLabGuideProgress` 还不在主线生成 SDK 中。

**0029 只为这张未合并票保留，未进入主线。** 重构若先用了该编号，恢复时重新分配并核对数据库 schema，不直接应用旧迁移。既有恢复引用 `refs/labword/29/run1/phase1-backup` 保留；不要使用共享 stash 默认栈。

来源：[phase1 与准备回执](../../.scratch/pm-parallel-20261004/evidence/29/run-1/phase1-and-prep.md)。重构后优先重新确认存储与用户身份边界，不把旧八项测试的绿色当作新基线绿色。

## 未提交的 skills 与项目规范

根快照 `root-workflow` 保存了新 `development-timeline`、PM skill 及参考文件、AGENTS、工程/体验/issue tracker/测试策略和双语验证页，共 18 文件。

新规则已在当前工作目录生效：桌面 Web 默认、明确需求才加移动端；WIP/Draft PR 提前记录进展；按风险独立双轴审查；设计预审前移；稳定候选完整覆盖可由最终 CI 负责；修复与基线变化按影响复用；同因果诊断与有效退出；轻量事件记录与 HTML 报告。正式合并的最终 CI、权限/恢复、资源归属等保证仍保留。

工具验证：13 Node 测试、两个 skill validator、独立完整审查和两处工具修复后的 delta 审查通过。该工具不依赖 npm 包或服务。

个人入口 `/home/caii/.codex/skills/development-timeline` 是指向本仓库 skill 目录的 symlink。重构移动仓库或 `.agents/skills` 时更新入口；只维护一个源，不产生两份分叉规则。导入的 implement/tdd/code-review/diagnosing-bugs 未改，项目覆盖明确写在新工程流与 PM 参考中。

来源：[规范升级回执](../../.scratch/pm-workflow-upgrade/current.md)、[新 skill 生成的历史报告](../../.scratch/pm-workflow-upgrade/historical-timeline.html)、[详细审计](../../.scratch/pm-parallel-20261004/audit/REPORT.md)。这些是本地资料，未提交/推送/合并，也未发布到 GitHub。

## 全部实施票与重构后待办

下面的依赖已重新读取 GitHub 原生关系；“可启动”仅描述暂停时的依赖，**不构成恢复授权**。

| Issue | 内容 | 暂停状态 | 原生前置 |
| --- | --- | --- | --- |
| #26 | 空间优先工作台 | 已集成 | 无 |
| #27 | 有界趋势 API | 已集成；另有 PR44 维护待合并 | 无 |
| #28 | Lab 混合记录 API | 已集成 | 无 |
| #29 | 私人引导进度 | phase1 完成，未交付 | 无 |
| #30 | 普通设备详情/操作 | 在途，缺陷与验证未收尾 | #26 已关闭 |
| #31 | 三维表示/相机/标签 | 只读预检，未实施 | #30 |
| #32 | 真实 TanStack 趋势 UI | 未实施 | #27、#30 |
| #33 | 记录界面/活动/CSV | 未实施 | #28、#30 |
| #34 | 创建/登记安全重试与初始摆放 | 未实施 | #31 |
| #35 | 基础/完整/空白模板 | 未实施 | #34 |
| #36 | 浏览器布局草稿恢复 | 只读预检，未实施；前置已完成 | #26 |
| #37 | 运行总览/设备筛选 | 未实施 | #32、#33 |
| #38 | 首次真实旅程/动态指引 | 未实施 | #29、#35、#36 |
| #39 | 跨上下文续接/位置回顾 | 未实施 | #38 |
| #40 | 整体验收/容量/连续学习路径 | 未实施 | #37、#39 |

待做内容的关键输入：

- **#31**：真实 GLB/HDR、原尺度、相机主动定位/全景/减少动态、重点标签避让、材质实例隔离/释放，以及 #30 的当前观测语义。必须交付可供 #34/#35 消费的正式版本化几何边界/原点/实验台支撑面；预检中的实验台尺寸不是最终合同。见 [预检](../../.scratch/pm-parallel-20261004/evidence/31/preflight.md)。
- **#32**：真实 `@tanstack/charts@1.0.0`、UTC 时间尺度、1/6/24h 与一分钟入口、断点/孤立点/尖峰、来源 tooltip/表格、仅可见时节流刷新和晚响应隔离。曾有依赖只读研究，库没有因此成为已验证实现；新架构重新核对兼容与包体。
- **#33**：有界混合记录筛选/分页、失败保留页、最近活动固定上界、真实原身份跳转、当前页 CSV 的 UTF-8/ISO/引号换行/公式前缀处理；原 Observation 历史继续可达。
- **#34/#35**：普通表单一套入口；业务 receipt、对象与 guide association 同事务；同键同参恢复、异参409、过期不能再执行；模板保留独立身份/槽位映射/静态房间、原子回滚与初始无 Run。房间必须是真实 Entity/Scene Node，不是装饰背景。
- **#36**：浏览器草稿按部署/API base、用户、Lab、格式版本隔离；保留原 baseline/未保存输入；只在确认保存或明确丢弃后清除；冲突显式恢复，数值有限性/范围有效。旧共享 context/view/CSS 交叠是排期原因，不是新的原生 blocker。
- **#37–#40**：复用同一普通详情、真实状态、活动与个人进度；引导只定位普通业务控件、观察真实结果；跨浏览器缺失本地草稿不能假称保存；最终验收覆盖完整集成范围和跨票消费者。

完整 76 项验收与 17 条 blocker 边见 GitHub 各票及 [发布记录](../../.scratch/pm-parallel-20261004/publication.md)。重构可调整实现划分；需要改变需求或原生依赖时以明确决定和 tracker 为准，不用本表偷偷替换规格。

## 重构时要保留的跨票合同

1. `/lab` 默认真实三维空间，其他视图显式进入；有效深链、当前 Lab、Entity/Scene Node 身份与单世界订阅保持一致。切换身份/Lab 隔离受保护数据、选择、草稿和操作尝试。
2. Entity、Scene Node、资产定义/表示、Placement、Command、Observation、Run、Task/result 各自有独立含义。Core 与 Lab 保持领域边界；Member 与有效 lab:full Agent 依 ADR0008 共用完整访问，不新增角色分级。
3. 当前观测需要真实值、有效时效/source time、good 质量、当前 Binding 与正在运行 Run。零/false 有效；心跳/别的属性不刷新旧属性。停止/重启未报告时保留原最后值和时间，但不能渲染成可信实时状态。
4. 趋势保留真实 received_at 排序、observed_at、原来源与分段，半开范围最多24h，默认600/最多1000绘图项，响应256KiB，含认证最多10SQL。记录最多100项/256KiB、31天、绑定筛选/固定上界的全序游标；不为 Run 新增清理规则，不猜操作者。
5. 既有容量、CSRF/身份撤销、单 SSE 1MiB/8待发、1000 Entity/1000 Scene Node、布局限制，以及初始400KiB/单异步500KiB gzip预算不因重构自动放宽。
6. 私人进度与共享 World 独立；客户端 business_attempt 只是尝试上下文，不可自称已提交 receipt。已成功业务与 receipt/guide association 同事务保存，进度写失败不能导致再次创建。
7. Guide 使用稳定语义步骤和原对象身份，不能靠翻译、名字、DOM层级或 Driver.js 位置定位。核心11步为 create_lab、register_light、select_entity、edit_placement、save_layout、return_run、start_program、light_action、verify_observation、asset_library、complete。
8. Core 24h 幂等缓存回收不代表 Lab 已提交尝试可以重执行；过期须明确拒绝并只读恢复。最终 DTO/错误码在实施后发布，不把尚未实现的提案当现有 SDK。见 [尝试/进度合同](../../.scratch/pm-parallel-20261004/attempt-progress-contract.md)。

以上是当前批准行为输入，不是要求保留旧类名、文件路径、内部 hooks 或特定组件结构。重构中的领域/架构变更先读 [CONTEXT](../../CONTEXT.md) 与相关 ADR，记录真实取舍。

## 运行资源与残余风险

暂停现场：24 个容器，其中4个根项目持久服务运行；19 volumes、9 networks。images8.091GB、containers2.236MB、volumes702.2MB、build cache33.74GB。没有本任务验证容器、Cargo/浏览器测试进程或 heavy-validation 锁。完整清单在 manifest；本轮只盘点，未删除资源。

保留的根项目服务归属既有 `labos-threejs` Compose：`labos-threejs-postgres-1`、`labos-threejs-rustfs-1`、`labos-threejs-redis-1`、`labos-threejs-mailpit-1`。持久卷 `labos-threejs_postgres-data`、`labos-threejs_rustfs-data`、`labos-threejs_rustfs-logs` 保留。其他20个容器及其他项目卷/网络不属于本次清理授权。

既有预览继续保留给重构参考：docs5174（PID2159876），operations v1 5196（PID2805221），onboarding v1 5192（PID2818504），onboarding v2 5194（PID2864063）。归属本仓库既有预览用途，不是正式 Lab API/Web 服务。11581、15400、18000/18001及其他 IDE/项目监听者保持不动；不要以端口或年龄推定所有权。

没有常驻的正式 Lab 应用验收地址。接受体验引用为 spatial v1 `7a7007d7`、operations v1 `a1486c78`、onboarding v2 `037fa8ee`；它们包含模拟行为，只是体验输入。

残余：主线/旧PR的验证仍有上述测试仪器/夹具问题；World/records 事件 SQL 计量待物理校准；早先 unmodified Core notifications/deletion 偶发失败重试通过但根因未证明；PG reset/eviction/强制终止的部分拒绝分支未独立诱发。没有把这些问题标成已修复。

## 重构完成后如何接续

1. 用户明确恢复后，先读本交接，重新核对 GitHub、实际新主线、工作目录、迁移号、个人 skill 入口与资源 owner；旧阶段的租约、fixed writer 上限和微观待执行命令不恢复。
2. 先确认重构的模块/API/存储/前端边界，逐项判断旧合同仍适用、已替换或需要用户决定。别为了适配旧补丁反向破坏新架构。
3. 从备份取行为测试、纯规则和教程语义；选择按新接口重实现、分段迁移或在隔离恢复树比较。旧完整验证只证明其记录版本；按照新语义 delta 刷新证据。
4. 判断 PR44 是否仍需要及如何重做可靠预算/保留期测试；决定保留原 PR 或另建维护，不直接合并失败旧头。
5. 优先重评估 #30/#29 的剩余工作以及 #31/#36 的边界；接口与几何合同稳定后再安排 #32/#33/#34。这是恢复时的候选顺序，不是当前派发。
6. 按新的 PM 流程持续记录阶段与交付；该图不能替代真实业务验收。实际集成后才完成 issue，当前所有未完成票保持开放。

只查看快照文件可使用：

```bash
git show refs/handoffs/20261005T040315Z-pm-pause/30-details:packages/views/src/lab/observation-state.ts
tar -tzf .scratch/handoffs/20261005-pm-pause/29-progress-sources.tar.gz
```

需要完整恢复时，先在独立目录从 `baseline.bundle` 或已保存的原提交建立旧基线，再检查/apply对应补丁；不得对正在重构的新主线执行覆盖恢复。备份的 checksum 和逐份重放结果见 manifest。

**本次只完成交接与保全，没有恢复开发、合并 PR、关闭 issue、运行产品测试或改变旧业务源码。**
