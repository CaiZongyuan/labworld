# Digital Twin Foundation V1 开发交接

交接日期：2026-10-03。用户已批准产品范围、v1 交互预览和 10 张实施票的粒度/依赖，随后要求交给其他开发者实施。**Foundation 正式业务代码尚未开始编写；接手从 Issue #2 开始。**

## 先读什么

1. [GitHub 规格 #1](https://github.com/CaiZongyuan/labworld/issues/1)：已确认的用户故事、行为、测试入口和范围。GitHub Issues 是实施任务与依赖的唯一来源。
2. [已接受的体验](../ui/lab-foundation-experience.md)：界面结构、真实与模拟边界、运行预览和验证证据。用户反馈“效果很好，你可以去实现了”；继续沿用此次批准。
3. [CONTEXT](../../CONTEXT.md)及 [ADR 0006](../adr/0006-server-owned-virtual-device-programs.md)、[0007](../adr/0007-separate-simulated-and-physical-entity-identities.md)、[0008](../adr/0008-full-lab-access-for-users-and-agents.md)：术语、后端运行、模拟/真实身份和 full access 决定。
4. [开发流程](../agents/development-flow.md)、[测试策略](../testing/strategy.md)与所领取 Issue 的完整正文、评论和当前 blockers。

[产品计划](../plans/Labworld-Digital-Twin-Foundation-V1-plan.md)保留设计意图，[审阅记录](../reviews/2026-10-02-digital-twin-foundation-v1-plan.md)保留决策理由。`docs/draft/` 的原始材料用于理解远景，`docs/research/` 的组件调查是候选资料；具体实施以规格和 ADR 为准。ractor/jsonschema 尚未安装或选定，不把调查结论当作强制技术栈。

## 任务顺序

下表只记录已发布的编号和依赖，领取与完成状态实时查询 GitHub。交接时 #2–#11 均未完成；此前为 #2 做的领取已释放，未产生实现 PR。

| 顺序 | 实施票                                                                            | 直接阻塞            |
| ---- | --------------------------------------------------------------------------------- | ------------------- |
| 1    | [#2 持久资产库](https://github.com/CaiZongyuan/labworld/issues/2)                 | 无                  |
| 2    | [#3 持久 Lab 与独立对象](https://github.com/CaiZongyuan/labworld/issues/3)        | #2                  |
| 3    | [#4 两台照明的后端控制闭环](https://github.com/CaiZongyuan/labworld/issues/4)     | #3                  |
| 4    | [#5 布局、位置关系与保存冲突](https://github.com/CaiZongyuan/labworld/issues/5)   | #3                  |
| 5    | [#6 连续传感器与新鲜度](https://github.com/CaiZongyuan/labworld/issues/6)         | #4                  |
| 6    | [#7 离心任务及重启恢复](https://github.com/CaiZongyuan/labworld/issues/7)         | #4                  |
| 7    | [#8 实时同步与断线恢复](https://github.com/CaiZongyuan/labworld/issues/8)         | #4                  |
| 8    | [#9 历史查询与保留清理](https://github.com/CaiZongyuan/labworld/issues/9)         | #7                  |
| 9    | [#10 归档、定义与外观替换](https://github.com/CaiZongyuan/labworld/issues/10)     | #7                  |
| 10   | [#11 综合旅程、负载与体验验收](https://github.com/CaiZongyuan/labworld/issues/11) | #5、#6、#8、#9、#10 |

原生 `blocked_by` 关系已建立并回读核对。#1 是规格参考，不领取为编码任务。先完成持久资产、世界登记和照明闭环，再按真实依赖扩展；#5 只依赖 #3，可与照明切片独立推进。每票包含公开测试和双语教程要求。

```bash
gh issue view 2 --repo CaiZongyuan/labworld --comments
gh api repos/CaiZongyuan/labworld/issues/2/dependencies/blocked_by
git fetch origin
git worktree add -b feat/2-persistent-assets .worktrees/2-persistent-assets origin/main
cd .worktrees/2-persistent-assets
pnpm install --frozen-lockfile
```

领取前核对 assignee 与 blockers；使用一票一分支、一 worktree、一 PR。此前只准备过包含文档副本的空实现 worktree，已经清理，没有需要 cherry-pick 的 Foundation 实现提交。

## 当前代码边界

最后一个应用代码基线为 `55a27be3bc717ebedda94f81a2c6d9e6d4dd7012`；交接整理在其上补充文档与开发端口工具。接手以最新 `origin/main` 建立工作树。

| 已有能力                  | 入口与接手注意事项                                                                                                                                                                              |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 正式 Lab 页面与会话资产库 | [Lab 组装](../../packages/views/src/lab/app-example.tsx)已注册 `/lab`、`/assets`；[catalog](../../packages/views/src/lab/catalog.ts)仍是按用户划分的浏览器内存，没有资产后端                    |
| 正式三维加载              | [model-loader](../../packages/views/src/lab/model-loader.ts)支持 Draco/KTX2/Meshopt、取消与资源释放；多节点扩展需明确共享几何/纹理和实例可变材质的所有权                                        |
| 文件基础设施              | [FileService](../../crates/app/src/modules/files/mod.rs)与[附件先例](../../crates/app/src/modules/knowledge/attachments.rs)可复用生命周期；Lab 自己拥有资源关联，沿用 Core 接口而非借用文档端点 |
| 身份                      | [API key 认证](../../crates/app/src/modules/api_keys/authentication.rs)当前只有读取入口；会话写入需 CSRF，Agent 写入须显式接入有效 key 校验，再调用同一 Lab 业务操作                            |
| 后端组装                  | [API 组装](../../apps/api/src/lib.rs)当前没有 Lab 模块/路由；新增迁移需登记模块 ownership，通过边界检查                                                                                         |
| 合同与 SDK                | [生成脚本](../../scripts/generate-contracts.mjs)从 Rust OpenAPI 生成 TypeScript；前端消费生成合同                                                                                               |
| 实时                      | 当前没有 World 实时服务；[SDK](../../packages/sdk/src/index.ts)默认请求超时为 5 秒，长连接不能直接套用这个生命周期                                                                              |

第一票特别注意：FileService 默认文件上限是 20 MiB，最终以部署配置为准；通用字节校验不等于 GLB 格式校验。数据库保存稳定 `file_id`，按请求获取短期签名下载；GLB 使用普通下载 GET，不套图片 inline 限制。发布文件与业务引用要保持一致，删除 ready 对象需检查引用后显式进入清理流程。

## 取得已接受的预览

主来源是独立分支 `preview/lab-foundation-v1`，固定提交 `10c4c22f875b958c7adc30cf84c7a41d56a4589c`。[源码与操作说明](https://github.com/CaiZongyuan/labworld/blob/10c4c22f875b958c7adc30cf84c7a41d56a4589c/.scratch/lab-foundation/v1/README.md)包含证据清单；版本在独立分支保存，主分支不包含 `.scratch` 原型源码。

本次交接补充远程预览资源；规格中“仅在本地”的可用性说明记录的是发布当时的状态。

在已克隆仓库的根目录执行：

```bash
git fetch origin preview/lab-foundation-v1
git worktree add --detach .worktrees/foundation-preview 10c4c22f875b958c7adc30cf84c7a41d56a4589c
cd .worktrees/foundation-preview
pnpm install --frozen-lockfile
cd .scratch/lab-foundation/v1
pnpm install --ignore-workspace --frozen-lockfile
pnpm dev
```

打开 <http://127.0.0.1:5191/prototype/lab-foundation>。若本机该预览已在运行，可直接使用现有地址。默认 30× 时间加速和异常场景/Agent 客户端位于预览工具条。

预览真实执行渲染、点选、拖动、GLB 导入和浏览器存储；设备、身份、API 和网络故障由浏览器模拟。它只持久保存布局与模型资源，刷新会重置运行记录，关闭页面停止本地程序。正式产品应按规格改用服务器持久化、后端设备程序和真实接口。

重建时保留已接受的视觉与操作，单独实现 Entity、Scene Node、Relationship、Observation、Command、Device Program Run 和 Device Task。预览将部分概念简化在同一个对象中，适合作为体验输入；其全局 store、IndexedDB 和故障注入不构成正式架构。

## 验证与首片完成标准

- **现有先例**：[附件 HTTP 测试](../../apps/api/tests/attachments.rs)、[API key 测试](../../apps/api/tests/key_documents.rs)、[Lab 页面测试](../../apps/web/src/lab.test.tsx)、[真实三维 E2E](../../tests/e2e/lab.spec.ts)。
- **隔离后端检查**：`node scripts/test-backend.mjs --test <测试目标>` 自动创建本次 Docker 依赖和测试库，不使用已有开发数据。具体命令见[测试说明](../testing/t01-feedback-loop.md)。
- **正式开发**：`just dev` 启动依赖、迁移、存储初始化和应用。开发进程占用端口时，按 `just dev` 提示核对；`just dev-stop` 只管理本工作树的 API/Worker/Web，数据服务由 `just services-down` 管理。
- **既有预算**：[性能基线](../../scripts/perf/baselines.json)保持初始 gzip 400 KiB、单异步 chunk 500 KiB；Foundation 的规模与查询预算按各票建立，保留实际测量环境。

预览的 19 项浏览器检查与 3 项定向检查通过，且类型检查/独立构建通过；这些是体验证据。正式票按 TDD、双语教程、reduce-complexity、受影响检查、`just check`、Standards + Spec review、提交/PR 交付，并按关键旅程比较真实应用。

首片完成时，普通 Member 和真实 Agent key 应能持久导入并读取同一资产，新浏览器能够加载保存的字节；格式/存储/凭据失败有正确结果，生成合同、ownership 和教程齐备。之后再推进 #3。

## 建议使用的技能

每张票使用 `implement` 与 `tdd`；模块接口需要判断时参考 `codebase-design`，前端使用 `shadcn` 与 `vercel-react-best-practices`。交付前按仓库流程运行 `reduce-complexity` 和 `code-review`。只有出现新产品问题才回到 `grill-with-docs`；当前范围和 v1 体验已经批准。

## 本次交接检查

2026-10-03 的整理通过完整 `just check`：63 项工具测试、166 项既有 Rust 测试、251 项前端测试通过，4 项既有跳过；格式、静态、合同、边界、性能预算和应用/文档构建通过。初始包体为 222.1 KiB gzip，沿用原预算。

开发端口工具的 9 项定向检查包含真实受控子进程，验证 TERM、超时升级、当前工作树归属及其他监听保留。Linux 已实测，macOS 路径仅做静态审查；`dev-stop` 当前支持 Linux/macOS。Foundation 的正式行为测试仍随实施票建立。
