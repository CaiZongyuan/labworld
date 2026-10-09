# Lab Word vNext PM 暂停交接 — 2026-10-09

本轮按用户要求完成当前修复的审查与发布，记录交接和复盘，然后停止开发。剩余产品工作未完成。本文件供后任 PM 接续；GitHub Issues、PR 和当前 head 的 CI 是事实来源。

## 已批准范围与本次停止

原连续开发授权允许 PM 自行领取、派发、修复、提交、推送、建立 Draft PR，并在简化、独立 Standards + Spec、必需最终 head CI 与实际集成成立后合并、关闭实施票，接续下一张就绪票。目标仍是 #29–#40 全部实际集成及 Product Completion Gate；保留 #23/#24/#25/#45 父规格正文和状态。

用户最新指令是“做完之后，做交接然后停止工作，我会把你的工作交给其他 pm”，并要求复盘。本 PM 到此停止；后任获得接续指令后沿原批准范围推进，不把这次停止或 Draft PR 当作交付完成。

Web 为主，排除 Electron 专属 CI/build/smoke/soak；Node Windows 检查保留。桌面为默认，产品票原已批准的 390 中文浅色 / 320 英文深色及触屏条件保留。已接受空间 v1、operations v1、onboarding v2 和“无 view 的 /lab 默认空间”继续有效，不重新审批预览。

## 实际交付

最后的产品功能基线是 `3b75a1fe29ff5579361080121aec3b9b5c0fcc1c`，tree `2292743c75712aedc724c984e023fbd19574356b`。迁移 #46–#52 / Migration Gate 已完成。产品 12 票已实际集成 4 票：#29 私人进度、#30 同一设备详情/操作、#32 真实趋势、#33 记录/CSV；另外 8 票未完成。

| 票  | 当前完整候选 / PR                                                                                    | 结果与未完成事项                                                                                                                                                                                                                                                                                                                                                    |
| --- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #31 | `18bfaa81be3f85ab72fa148a88f66f28bb1427d4` / [PR65](https://github.com/CaiZongyuan/labworld/pull/65) | Draft。源码/简化/独立审查与本机关键验收有效。CI [37937739099](https://github.com/CaiZongyuan/labworld/actions/runs/37937739099) verify/Windows 成功、Web 失败；26 profiles 中 17 失败。不可合并或关闭。                                                                                                                                                             |
| #36 | `cf15edfe385f8bb77f738188b376d871ed26ee29` / [PR60](https://github.com/CaiZongyuan/labworld/pull/60) | Draft。完整 35 路径，tree `813cb93779f500750daa666b65676eaaa3367a7a`。最新一文件 oracle 修复独立双轴通过；真实 owning case 15.290s 通过。最终 CI [37946870625](https://github.com/CaiZongyuan/labworld/actions/runs/37946870625) verify/Windows 成功、Web 失败：Foundation busy=true/false，lifecycle geometries15>14。修复后的趋势测试通过，两个旧失败原因仍未知。 |
| #37 | `b957dd48e7b7d5b83db1e74e344a04929c4de041` / [PR66](https://github.com/CaiZongyuan/labworld/pull/66) | Draft。完整 23 路径，tree `f1b9c203421946cbb767f48cf2f7a6bbb25b9e3b`。简化/独立双轴/28 定向 Views 与真实业务、桌面和窄屏验收通过。CI [37941878977](https://github.com/CaiZongyuan/labworld/actions/runs/37941878977) verify/Windows 成功、Web 两项失败，未集成。                                                                                                    |

三条分支均基于上述实际 main，已推送且源码干净。所有原 writer 已停止；名称不是下一任的活跃租约。旧 Rust #27/#29/#30 未提交改动已提交为 archive/2026-10-09/wip-* 标签，不能合入新的 TypeScript 主线。

## 后任先做的动作

1. 读取 AGENTS、CONTEXT、相关 ADR、docs/agents/issue-tracker.md、development-flow.md、testing/strategy.md，以及 GitHub #45 / #23 / #24 / #25 和对应实施票全文、评论、原生 blockers。回读 main、PR head/assignee 与资源，重新建立 owner。
2. #36 的 cf15 最终 CI 已失败，先用已有安全证据排查 Foundation readiness 和 lifecycle 15>14，保留原5000ms和资源上界。修复已证明错误的静态标签测试前提不代表这两个失败修复。全部必需检查成功后才能实际合入/关闭。主线移动时其他候选需检查语义影响，不能只复用旧 head 的绿色。
3. #31 的最佳下一问题是：一个栅格 callback 的五秒消耗在哪个公开 await——canvas screenshot，还是 decode/pixel evaluate。保持原条件/阈值，先按阶段保留安全证据；不要再用相同输入的本机绿色或盲目全 CI 重跑来解释远端失败。
4. #37 当前两项 Web 失败是 Foundation `.world-page` busy=true 对 false/5000ms；以及 records 窄屏历史面板 `lab-records.spec.ts:383` 预期 20 项，解析到 2 项。前者原因未知；后者需要检查实际页面、查询截止范围和 reader 刷新，不能直接改为接受 2。已完成三项功能审查修复和 44px 触屏修复，复用未变证据。
5. 实际 #31 CLOSED 后才能领取 #34；随后 #35 正式模板。#38 依赖 #29/#35/#36，#39 依赖 #38，#40 依赖 #37/#39。#34/#35 只有只读准备，没有实施或交付；#38–#40 未启动。

#34 准备：Lab 不可变业务 receipt 与同 DbSession 写入、Core fingerprint 的作用保持独立；不复用过期 Core claim 执行，过期已提交尝试只读恢复；当前 caller 与 guide/version/attempt 有界恢复。已有预算建议不是已发布新合同。

#35 准备：基础四对象（room/bench/beaker/sensor），完整九对象（room/两 bench/两 centrifuge/sensor/light/静态 robot/beaker），空白为空；初始不启动 Run。正式静态 room 不等于 Environment marker。使用 #31 元数据的实际尺寸和受支持位置，不能直接复制会重叠的 fixture 摆放。#31 metadata 在 `@labos-threejs/contracts/lab-representations`，尚未 main；bench `[2.8,.96,1.25]`，worktop `.96`，lamp 最大高度 `2.157275`，米/弧度/正 scale。

## 当前失败证据的边界

#31 当前 17 个失败包含此前 15 个，加 centrifuge Details 点击超时和趋势初始检查。七个栅格/handle/pose poll 明确 predicate timeout，numeric=null；不是实测 0 或实测运动。Records 点击报告 detached。Native warm reference 为 28 后卡在 busy；旧 run 是 13，未证明泄漏。GLB 真 503 保留像素仍通过，稳定资源 16 geometries/6 textures 后才外层超时。Foundation 四类请求有完成事实，但 Network/Tracing 时钟关系与活动文档归属未证；1733 ProfileChunks 不等于目标线程已归因。所有 26 profile、52 service ledgers 清理记录成立。

#36 上一 head 的唯一失败是初始未遮罩 canvas 稳定检查，expected0/received56；不是打开趋势后的相机检查。真实 1Hz counterexample 保存了 22.4→22.5、sequence5→7、同 Node/Placement/Run 和同 692×755 canvas：56 全在实际单传感器标签内、外部0，原未遮罩0保留为 red，orbit 外部50734>30。最小修复仅让初始检查复用已有实际标签 mask，保留全画布、0、RGB30、5s/90s 和后续 orbit>30。历史 CI 原图对没保存，因此不唯一归因历史 case。此证明不能套到 #31 未返回数字的 callback。

#37 的真实修复：Task 不确定结果 wire 值是 `unknown`；runtime availability 与 transport live 分开；所有可见趋势共享 controller 的 refreshRevision，重连且 World 未变也按原 5000ms cadence 刷新，共享请求不会互相取消；四个窄屏 tab 恢复 44px。

## 演示与本地证据的当前状态

此前正式 main32 演示确实通过：16 Entities /18 Nodes/7详细GLBs/6模拟来源，1376×755暴露canvas、真实TanStack曲线/非空读数、记录/CSV、pageerrors0。这些是历史验证结果，不是当前持久资源声明。

仓库整理期间确认 `.scratch/vnext-continuation-20261006/` 和 `.scratch/demo-scene-20261008/` 从磁盘消失，包含原372MiB演示数据、私有会话、原始review pins/图像/资源报告。该删除不是本PM执行；没有可确认的备份。用户明确回复“演示数据可以丢弃，只保留代码”。因此停止旧Root演示服务，放弃该演示数据；新环境重新初始化数据/会话/演示，不能沿用旧URL的Lab UUID或假称已恢复。

正式代码、三条未完成PR、已保存的审查文字与CI结果保留在GitHub。完整旧的本机验证材料已不可用；复制到本仓库的七份审查报告是删除前已捕获并校验的记录，当前不能重新对照消失的原文件。最新CI失败证据可从GitHub下载，过期则由后任重新验证受影响部分。

测试/构建目录与旧工作树按用户要求清理，仅保留源码及Git存档。Docker属于其他项目，最新已核对2containers/0volumes/6networks；本PM未创建/删除/prune Docker资源。旧owned Node/Web只按已确认的creator/server/web出生标记停止，不按名称或年龄清理其他服务。

## 新环境接手与仓库清理

- 代码：拉取main和三个未完成PR分支，核对完整SHA。交接/授权/审查记录/复盘合入main；文档站所需`gh-pages`保留。
- 存档：`git fetch origin --tags`。旧27/29/30独有WIP在`archive/2026-10-09/wip-27-bounded-trends`、`wip-29-guide-progress`、`wip-30-device-details`。其他未被main包含的旧commit/preview也在归档标签中，按Issue清理manifest读取；不要将旧Rust补丁混入TS主线。
- 工作树：旧附属工作树和本地临时分支清理后，新PM从必要远端分支新建独立工作树、重新建立owner和测试资源。原连续开发授权文档已原样提交。
- 数据：用户选择不迁移旧演示数据。按[快速开始](../getting-started/quickstart.md)重新初始化；后续备份/恢复遵循[运维指南](../guides/server-operations.md)。没有Root旧私有cookie可供新环境使用。

最终GitHub交接Issue包含交接和复盘全文、清理结果与新环境入口，可单独作为接手依据。暂停不等于Product Gate完成。可携带审查摘要见[证据索引](pm-pause-2026-10-09-evidence.md)；具体原因和改进见[复盘](../reviews/2026-10-09-vnext-development-retrospective.md)。
