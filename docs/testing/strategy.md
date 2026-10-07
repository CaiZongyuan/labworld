# Lab Word 测试策略

测试从可观察的公开行为进入。已有平台和正式查看器测试保留其职责；Foundation V1 按已发布实施票建立新行为验收，预览证据不代替产品验证。

默认范围是 desktop web。只有用户或已批准任务明确要求移动端时，才增加移动适配、窄屏、触屏或真机验证。最新明确范围更改优先，记录对旧验收项的影响；既有测试保留原职责，不因默认范围主动扩展新场景或擅改历史 issues。

| 接口 | 工具与依赖 | 验证责任 |
| --- | --- | --- |
| 后端 HTTP | Node/Hono、真实 HTTP、隔离 PGlite 目录 | 身份、成员、权限、CRUD、错误与持久化 |
| 公开任务/存储 | Node 服务、目录租约与本地校验字节 | 租约、重试、对象清理、缓存与事务恢复 |
| React Views | Vitest、Testing Library、user-event；MSW 仅替代 HTTP | 表单、选择、导入反馈、拒绝、冲突与恢复 |
| 真实应用浏览器 | Playwright 与真实应用栈 | Cookie/CSRF、SDK、权限、文件、任务及关键旅程 |
| Lab 三维浏览器 | Playwright、真实 GLB/HDR 和 WebGL | 实际像素、取景、相机、点选、快速切换与资源释放 |
| 文档浏览器 | Playwright 与静态 dist | 导航、搜索、同页语言、主题、约定视口和自定义 base |
| 工程合同 | 合同生成、边界检查、文档构建与性能预算 | 协议漂移、依赖、来源链接和确定性计量 |

## 公开接口与风险

优先从 HTTP、可操作组件和浏览器验证。只有不能从这些入口可靠区分的事务适配、纯规则或任务恢复，才增加相应公开能力测试；新增接口先说明必要性。低风险文案与样式变更使用已有检查，不新增镜像测试。

保留失败与随后可观察结果，例如无权限写入后内容不变、409 后草稿仍在、无效 GLB 后前一个模型仍可用。测试不固定 hooks 内部状态、私有 Repository 调用或大型 DOM 快照。

同一验收断言的真实 TDD red 与恢复 green 可直接作为 VDD 辨别证据。仅当缺少有效 red、检查对象变化或存在具体假绿风险时补最小反证；编译、零收集和错误定位器失败不算业务 red。性能预算可用独立计量 observer，但业务结果仍从公开接口断言，并记录目标隔离和计量有效性。

## Lab 当前与后续

正式 Lab Viewer 与会话资产库已有渲染、导入、相机、选择、失败恢复、响应式和重复导入资源计数证据，记录在[体验文件](../ui/lab-viewer-experience.md)与[实现验证](../reviews/2026-10-02-lab-viewer-implementation.md)。主导航为 Lab 与资产库，登录后的默认业务入口为 Lab。

持久资产、对象、布局、后端程序、用户/Agent 共用接口和恢复已在 Node 实现。既有登录入口、导航、按需加载、包体与资源释放合同继续保留。历史 Foundation 体验见[开发交接](../handoffs/digital-twin-foundation-v1.md)，当前命令见[快速开始](../getting-started/quickstart.md)。

FPS 和内存趋势附场景、资产、浏览器与硬件；软件渲染及单次采样不构成跨机器性能门槛或泄漏结论。

## 隔离与节奏

数据库、缓存、对象存储和浏览器状态按测试隔离，清理只作用于本次资源。并发使用 barrier/显式条件，不依赖任意 sleep。失败证据脱敏，认证旅程不默认保存凭据、token 或完整签名 URL。

编辑循环跑定向检查。稳定最终候选的完整门禁 `pnpm check` 在负责环境运行一次；本地定向检查与最终 head 的 CI 完整门禁可以共同覆盖交付。本地也跑完整门禁时注明需要它的原因。它已经包含的受影响检查按覆盖矩阵引用，不先重复执行。失败、修复或 main 前进后，按语义、依赖和环境变化刷新受影响检查与审查；影响无法界定时再完整重跑。记录 base、candidate commit/tree、实际环境、覆盖入口、结果和可复用证据，简化与独立双轴评审按[开发流程](../agents/development-flow.md)完成。

新的关键旅程、浏览器回归或里程碑验收需要真实 E2E；已有旅程按有效输入复用。CSS/布局修复跑受影响状态和约定视口的 focused case。heavy browser 前先核对 discovery、测试数量与场景前提，再通过显式 ready 条件观察稳定的外部几何。三维可见性同时核对外部遮挡、可见像素或真实操作，不能用 canvas 存在替代场景曝光证据。

资源记录、重试与清理按 [AGENTS.md 的 Docker run 规则](../../AGENTS.md#docker-resources)，由 fixture/supervisor 自动留下 owned ledger。阶段、等待和返工只做轻量记录；需要时用 [development-timeline](../../.agents/skills/development-timeline/SKILL.md)分析，报告不是交付门禁。

命令与前提见[开发与验证](t01-feedback-loop.md)。
