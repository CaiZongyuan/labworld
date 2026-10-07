# Foundation V1 综合验收

任务：[Issue #11](https://github.com/CaiZongyuan/labworld/issues/11)，参考规格 #1。基线 `c6c3063719c76d24cbdb1b03dd9bb4a724e445a9`；独立工作树 `.worktrees/11-foundation-acceptance`，分支 `issue/11-foundation-acceptance`。原 `main` 的五份用户文档改动未导入或覆盖。

## 综合旅程与必要修复

[完整旅程 E2E](../../tests/e2e/lab-foundation.spec.ts)使用真实注册 Member、CSRF、API key、PostgreSQL、Redis、RustFS、Worker、SDK、GLB 和 WebGL。Member 创建空 Lab、导入 Basis 外观、登记静态模型/Environment；Agent 执行此前九章原有请求代码。Member 继续控制照明、编辑、断线恢复、移除/放回节点；Agent 查询、替换定义/外观并归档。15 Entity 的布局、Inspector、两个浏览器和 API 保持同一世界。

首次有效 red 表明 `examples/lab/edit-layout.mjs` 始终另建 Lab，忽略 `LAB_ID`。修复后整条教程共享同一个 Lab。Node 移除/放回保留 Binding、Task 和 Result，布局重连保留 `X=2.25 m` 草稿，关系保持人工来源。归档后历史可查，新启动被拒绝。Member/Agent 无效亮度都返回 422，缺 CSRF 写入拒绝后原观测不变。

实际 320px 整页截图还暴露了组合布局缺陷：历史面板与固定 `100dvh` 页面压缩 `world-body` 到 320px。目录占去约 250px，380px 3D 视口只露出约 70px。画布内部像素检查不能区分这种外部裁切。新增浏览器检查同时读取公开 DOM rectangles，要求 body 包含整个 viewport，Inspector 位于其后，history 位于 Inspector 后。CSS 让窄屏页面按内容展开，并解除内部滚动约束。首个 red 截图与 rect 证据独立保留为 `mobile-first-red.png` / `mobile-first-red-rects.json`，分别来自完整旅程和静态 Robot 最小场景。

| 接受的 Demo                | 实际覆盖                                                                                             |
| -------------------------- | ---------------------------------------------------------------------------------------------------- |
| 1 Asset Library            | 内置八类筛选、Member Basis 和 Agent Draco 持久导入，完整 metadata/file 身份请求                      |
| 2 Build a Lab              | 空 Lab、Environment、Bench、Labware、Robot、灯、传感器、两离心机、用户模型；保存和第二浏览器真实加载 |
| 3 Inspect Entity           | Entity/定义/Binding/Run/Task/Result 身份可查，目录、Inspector 与实际 WebGL 场景一致                  |
| 4 Live Interaction         | 两台离心机独立；准备达标后计时、completed 与 cancelled、忙碌和同键重试；旧实栈 restart 回归保持      |
| 5 Simple World Interaction | 两照明独立、Member 控制后 Agent 读到实际观测；连续 sensors 单位、过期与显式恢复                      |
| 6 Agent-ready World        | 普通 Member 与 Agent 共用创建/登记/布局/动作/记录/生命周期；业务错误一致，真实双浏览器收敛           |

新的应用截图和原始 JSON 放在 `.scratch/foundation-v1/application/`，不会被文档 Playwright 清空。公共首页截图 `apps/docs/public/lab-foundation-v1.png` 来自本次真实应用，不使用隔离预览。新旅程覆盖桌面中文/浅色、320px 英文/深色、离线/恢复和实际 Draco/Basis 像素。无页面错误或横向页面溢出。

固定比较基准是 `preview/lab-foundation-v1@10c4c22f875b958c7adc30cf84c7a41d56a4589c`。正式 UI 延续对象目录、3D、Inspector、运行/布局模式及底部历史。正式流程没有 30x/120x 或场景故障工具条。后端 Run、Task、属性观测和 persistent World 替代预览模拟器。长 UUID 和真实来源留在 Inspector，不复制到目录标题。

GLB loading/error/replacement 和 archived viewport 原证据保存在 `.worktrees/10-entity-lifecycle/.scratch/lifecycle-evidence/application/lab-foundation/`。本票窄屏 CSS 改动后重新验证受影响的实际生命周期桌面/窄屏场景及完整旅程。空/加载/WebGL 不可用、选择/指针、认证撤销、运行重启和保留/幂等语义继续由已有 HTTP、组件、SDK 与浏览器检查承担。输入未变的 pass 可复用；综合恢复 pass 不宣称修复 #8 曾出现的冷启动 timeout。

## 受控参考负载

入口：`just perf-lab-reference`，调用 [reference-load E2E](../../tests/e2e/lab-reference-load.spec.ts)。临时服务随机端口、独立资源及测试数据；不使用现有开发/生产数据。20 个 sensors 各以 1 Hz 为目标，两真实 Chromium 浏览器；100 Entity、100 个已放置且未归档节点，77 个导入模型节点复用两份独立 Asset。两视口取景包含完整节点布局；不声称每个像素均无遮挡。

环境：Chromium `153.0.8010.12`；ANGLE Vulkan SwiftShader 软件渲染；WSL2 Linux `6.18.33.2` x64；Intel Core i7-12700H，20 logical CPU，16,624,828,416 B RAM。两页 1440×1000，第一 WebGL canvas 692×531。开发 API/Worker debug build；PostgreSQL 与对象存储来自 repository 测试服务配置。

| 计量               | 本次独立负载结果                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------- |
| 模型 / 纹理        | Draco 960 B，1 mesh、无 texture；Basis 4664 B，1 mesh、1 texture，嵌入 image 2560 B；独立对象文件总 5624 B |
| 每设备报告         | 每台 12 条 / 12.513 s；240 条总增量，独立来源与 `degC`                                                     |
| HTTP world payload | 每次 185121 B，100 Entities/100 Nodes/2 Assets                                                             |
| SSE                | 119 事件；最大 185108 B，含 snapshot/runtime_status/update/heartbeat                                       |
| history            | 每设备查询区间 12 条、约 11.5 KB，无下一 cursor，始终低于 100 items/256 KiB                                |
| 存储               | 100 Entity、100 Node、580 observation rows；Lab 表与索引 1957888 B；全测试库 11925171 B                    |
| 实际渲染           | 每页 198 draw calls、2934 triangles、208 geometry、43 texture；两 canvas 均 204 种量化颜色                 |
| FPS 趋势           | 页一 25–41；页二 31–39                                                                                     |
| HTTP 查询时间趋势  | 31.4–54.1 ms，含客户端响应读取；不是广播延迟 SLA                                                           |
| JS heap 趋势       | 页一约 168.8 MiB，页二约 149.7 MiB，短窗口没有变化；非泄漏结论                                             |

原始 12 次采样、实际版本与 dirty scope 在 `reference-load.json`。这些结果只描述本环境和小文件，不能推断大型模型/纹理或其他 GPU、浏览器、硬件的表现。KTX 多 loader 告警是已记录的维护机会，未出现未加载资源或页面错误。

诊断保留两个验收脚本问题：英文环境中错误点击 `English` 导致等待；组合旅程和负载同栈时先前请求消耗默认每 IP 600/60 s 窗口，触发真实 429。现分离 opt-in 负载入口与独立栈，没有放宽限流、bundle 或载荷预算。这些原因不用于解释 #8 历史 timeout。

## 确定性合同、文档与审查

[perf_lab.rs](https://github.com/CaiZongyuan/labworld/blob/legacy-rust-final/apps/api/tests/perf_lab.rs)从真实 HTTP Router 捕获 sqlx statement 事件。1 Entity 和 100 Entity 都是 10 次 statement；字节数分别 2376 和 137577。Lab 列表 cursor 无重复，超出 100 的 limit 返回 400。不同模型/设备状态会改变字节数，SQL 数保持不随 Entity 数增长。

已有 sync Router 检查继续验证 1 MiB 初始事件、8 条待发队列、慢客户端 discard/resync、可靠交接与撤权。历史检查验证 100 项、256 KiB、31 天区间和同时间 cursor，无静默放宽。布局保持 512 KiB，Entity/Node/关系各有 1000 项边界。bundle 保持首屏 400 KiB、异步 500 KiB gzip。相应 Lab 基线新增到 `scripts/perf/baselines.json`，原门槛未改变。

10 章中英文教程已共用当前 checkout，布局脚本继承 `LAB_ID`，生命周期下一章和站点 pager 指向完整旅程。最后一章可从空 Lab 连续跟做全部旧请求，提供独立容量入口和失败恢复。公共首页、文档入口、指南与产品架构区分已实现虚拟程序和未来真实设备。字段、SDK 和配置未改动，生成合同仍以源码为准。

手工 language review 按根工作树最新作者规则检查：短主动句、编号步骤每步一行动、相关条件/持久写入提示在操作前、明确单位/限制/权限、稳定术语及中英相同含义。`docs:check` 只提供结构检查，不替代该审查，也不声明完整 STE 合规。

Lab ownership 登记性能 HTTP 测试、共用公开浏览器辅助、两个独立旅程、双语最终章节、真实截图和共享 performance 接入。Core/SDK 边界仍保持。整体与本票简化结果见[完整调查](2026-10-04-foundation-simplification.md)。

最终 `just check`、应用/负载 pass、文档浏览器、Standards/Spec 的结果和 immutable tree 由本票 PR 记录。合并前必需 CI 必须覆盖最终 head；仅 PR 创建不代表已集成。Epic 结束后对最终 integrated source tree 回读，相同树可复用调查。
