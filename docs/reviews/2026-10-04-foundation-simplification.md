# Foundation V1 整体简化调查

范围：规格 [#1](https://github.com/CaiZongyuan/labworld/issues/1)，实施 #2–#11。前 Foundation 基线为 `e080eb3aca90c0e62358b3c5ecd6f779b2b1104e`。已集成前驱为 `c6c3063719c76d24cbdb1b03dd9bb4a724e445a9`，本次调查还包含 #11 的全部源码、测试、文档和当前消费者。最终审查 tree 与集成 SHA 由本票 PR 记录，提交或 squash 不改变源码时可复用。

## 集成库存

| 票           | PR      | 集成提交             |
| ------------ | ------- | -------------------- |
| #2 资产      | #12     | `e6f80f5`            |
| #3 世界      | #13     | `a4354a6`            |
| #4 照明      | #14     | `b707bc9`            |
| #5 布局      | #15     | `240294a`            |
| #8 同步      | #16     | `cbf2883`            |
| #6 传感器    | #18     | `ddaf175`            |
| #7 离心      | #19     | `5fe3468`            |
| #9 历史      | #20     | `c79e355`            |
| #10 生命周期 | #21     | `c6c3063`            |
| #11 综合验收 | 本票 PR | 最终 tree 由 PR 记录 |

PR #17 / `fece778` 只维护 Core 缓存测试，并非 Foundation 业务切片。本次保留其修复，未把它当作 Lab 简化对象。

## 检查过的完整路径

使用完整 `git diff e080eb3...c6c3063` 库存及 #11 的 tracked/new 文件。未以最后一票的 diff 替代整体调查。

- 资产生产、验证和文件生命周期：[assets.rs](https://github.com/CaiZongyuan/labworld/blob/legacy-rust-final/crates/app/src/modules/lab/assets.rs)、[glb.rs](https://github.com/CaiZongyuan/labworld/blob/legacy-rust-final/crates/app/src/modules/lab/glb.rs)、`glb/payloads.rs`、`files/mod.rs`；消费端是资产目录、发布弹窗、模型 loader 和 Worker 文件清理。
- 世界、布局、关系及生命周期：[world.rs](https://github.com/CaiZongyuan/labworld/blob/legacy-rust-final/crates/app/src/modules/lab/world.rs)、`layout.rs`、`relationships.rs`、`lifecycle.rs`，以及迁移 `0018–0028`。消费者包括 WorldView、WorldViewport、Inspector、布局编辑器和生命周期面板。
- 程序、命令、观测、Task/Result：[devices.rs](https://github.com/CaiZongyuan/labworld/blob/legacy-rust-final/crates/app/src/modules/lab/devices.rs)、[runtime.rs](https://github.com/CaiZongyuan/labworld/blob/legacy-rust-final/crates/app/src/modules/lab/runtime.rs)、`runtime/centrifuge.rs`、`tasks.rs`、历史和 retention。API 启动显式组装 runtime/maintenance，浏览器使用状态和记录，不拥有运行时钟。
- 同步完整路径：[sync.rs](https://github.com/CaiZongyuan/labworld/blob/legacy-rust-final/crates/app/src/modules/lab/sync.rs) → OpenAPI/生成 SDK → [lab-world.ts](../../packages/sdk/src/lab-world.ts) → [world-subscription.ts](../../packages/views/src/lab/world-subscription.ts) → WorldView/Inspector/3D。持久版本与 runtime availability 分开。
- 生成合同、SDK facade、所有权、配置和门禁：Lab `module.json`、Core API-key 认证改动、`apps/api/src/{lib,main}.rs`、`config-reference.rs`、`scripts/{generate-contracts,check-boundaries,e2e}.mjs`、`.env.example`、锁文件、package 接入、`justfile` 和性能基线。
- 当前回归消费者：全部 Lab HTTP 测试、组件/MSW、SDK 测试、真实 E2E、GLB fixtures、Core 缓存维护差异，以及 10 章双语教程、9 份请求示例、公开文档入口/导航和站点浏览器测试。声明、动态显式组装和生成消费者均纳入检查。

## 候选与取舍

| 分类与 owner               | 具体证据及生产/消费路径                                                                                                                                                                                                                          | 可减少的维护                                                                                                                                     | 保留义务、验证与建议                                                                                                                                                                               |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 行为保持候选；Lab renderer | `WorldViewport.Scene` 为每节点创建 `NodeModel`；`useLoadedModel` 为同一远端 Asset 重复获取下载能力、下载字节并创建 GLTF/Draco/KTX loader。参考 77 个导入节点只对应 2 份 Asset，每浏览器有 208 geometry / 43 texture，并出现 KTX 多 loader 告警。 | 按 immutable file/representation 身份复用下载字节和 renderer 级 decoder 池，可减少重复请求、解码器和 worker。无需先共享可变材质。                | 节点选择材质、appearance key、失败后旧模型保留、独立 Scene、abort、最终 dispose 和带权限下载必须保留。需要真实多节点/双浏览器、重复替换/移除、纹理解码和资源计数验证。可选优化，本票不实现大缓存。 |
| 行为保持候选；Lab 测试     | `lab_world.rs`、`lab_devices.rs`、`lab_sensors.rs`、`lab_history.rs` 和 `lab_lifecycle.rs` 各维护相似 Browser/session/CSRF、HTTP request、register entity 代码。生产入口是同一真实 Router。                                                      | 共享纯公开 HTTP fixture 可集中 Cookie/CSRF 和 DTO 漂移；保留不同旅程断言。#11 已把两个浏览器验收的共用公开操作放入 `lab-foundation-support.ts`。 | 不统一真实/受控时钟、Worker、身份失效和不同文件服务前提，不增加私有 Repository 测试。后续可小步抽取已有重复；本票只简化自己两个入口。                                                              |
| 架构决策；Lab runtime/sync | `sync::lock_world`、迁移 `0023` 和每个写事务共享 deployment clock。订阅先读 clock，只在变更时 `load_world`；20 sensors 每秒分别提交事实。其他 Lab 变化仍推进同一 deployment 版本。                                                               | 每 Lab revision/锁可能减少不相关 Lab 的版本更新和写竞争；需要维护的全局通知范围会改变。现有实现已经跳过未变化快照，不提出重复的“先查版本”改动。  | 认证锁次序、consistent snapshot、清理/幂等竞争、运行恢复与旧数据库升级都依赖当前顺序。公开比较语义需要保持或显式修订。延后到更大、多 Lab 实测证据，不改变 ADR/产品合同。                           |
| 延后；Lab 定义与参数规则   | `definitions.json` 提供声明型参数 bounds/defaults；`devices.rs`、`runtime.rs` 和 `runtime/centrifuge.rs` 独立验证控制参数、配置和真实报告。                                                                                                      | 把纯数值界限集中在 closed built-in program 合同中，可能降低声明与执行漂移。                                                                      | 请求目标和实际测量不同；准备容差、单位、quality、时钟及 Stop 规则不能变成泛型 schema 校验。只有三种内置程序，通用 schema 引擎会增加依赖和适配成本。暂不引入引擎，也不删除 trust boundary 校验。    |
| 保留；Lab 状态与持久化     | `ObservationProperty` 保存独立属性时间/质量；envelope `values` 被世界过滤、灯控和离心读数使用。Run、Task、Result、Command、Binding 和 receipt 分别被历史、重启、幂等和 Inspector 消费。                                                          | 不删除这些状态或身份；投影看似重复，但消费者有不同的时间、来源、保留和重试责任。                                                                 | 合并会丢失迟到/部分属性、准备计时、减速结果、旧 Run 含义或 TTL 后 410。保留当前独立状态与 regression evidence。                                                                                    |
| 保留；Core/业务组装        | `module.json`、显式 API/Views assembly、SDK 注册、OpenAPI 和 generated consumers 使 Lab 拥有专有能力，Core 拥有身份、文件和 Worker。                                                                                                             | 不用隐式扫描、全局 registry 或把 Lab 合并入 Core 来减少文件。                                                                                    | ADR 0002/0003/0005 的可移除业务和 ownership 是真实义务。生成文件不得手工精简；删除 Lab 时还需移除 `justfile` 的 Lab recipe、`budgets.lab` 和对应文档投影。                                         |

## 本票简化

已执行 repository-owned reduce-complexity。两个真实浏览器检查共用公开身份、HTTP 查询、章节执行、像素与脱敏失败辅助。综合旅程与参考负载分别拥有入口和临时栈，避免前者消耗后者的限流窗口。基线保持已有 Core 限流和 bundle 上限。完整教程通过一个共同起点消除多份旧 checkout 指令。

未执行可选 renderer 缓存、跨票 fixture 抽取、clock 变更或 schema 引擎。本票修复两项必要行为缺陷：布局示例忽略 `LAB_ID`，以及历史组合后窄屏固定高度工作区裁切 3D/Inspector。两者均有真实公开行为 red → green。窄屏复用接受的纵向工作区，解除嵌套固定高度和滚动约束，不增加控制状态。没有新增产品决定或后续票。

源码与消费者覆盖到本票最后修改。独立双轴审查和受影响检查覆盖简化后的 tree；最终命令、结果和不可变 tree 记录在本票 PR。Epic 合并后可比较最终源码树；树相同即可复用，新增集成变化需要补查。
