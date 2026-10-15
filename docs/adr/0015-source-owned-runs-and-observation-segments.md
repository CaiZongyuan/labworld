---
status: accepted
---

# 来源自主运行，Lab World 以独立观察段记录真实过程

决定日期：2026-10-13。用户在 [Issue #85](https://github.com/CaiZongyuan/labworld/issues/85) 的 Q17–Q22 访谈中确认：场景和映射就绪后自动从 Newton 当前实际状态开始观察，新浏览器先取得完整状态；来源不回初态、不重新执行。持久 Lab Source、一次 Source Run 与固定场景和字典的 Observation Segment 分别记录，一观察段一录制。

Lab World 断开只中断自己的观察与录制，Newton 继续自身程序。恢复从最新状态自动开始新段，复用对象和资产，明确缺口，不回放动作或补造历史。来源明确暂停/等待时保留连接并冻结实际样本，心跳不刷新测量；连接健康与运行进度分别表达。

每次实验/episode reset 保留旧末态和来源结果，结束旧观察段与录制，再以新初态建立新段，浏览器不跨 reset 插值。同一实验因重接被分为多段时保留关联及不完整范围。实际结构变化结束旧观察，新版本确认后从来源当前状态恢复；空闲判断针对 Lab World 的观察，而不是要求源程序停机。

首版记录来源明确上报的阶段和成功/失败/未知结果，不从静止、回初态或进程退出推断成功，不伪造 Lab World Command 或既有受控 Device Task。记录的完整性与实验成败分别表达。

相比让源程序随观察服务暂停、重连续写无缺口历史或跨 reset 平滑运动，该选择保留单向来源权威和可追溯事实；代价是新增观察起点、双时间锚点、来源生命周期、可靠事件和不完整范围。只读 Binding 与现有受控程序合同需明确区分。

本决定沿用 [ADR 0013](0013-source-presence-before-scene-synchronization.md) 的来源接入及 [ADR 0014](0014-versioned-assets-and-external-authoring.md) 的固定资产版本。它补充 [ADR 0012](0012-newton-scene-templates-and-independent-replay.md) 的外部观察模式，不改变其既有受监管启动行为。协议衔接、代码事实和所需验证见[实时观察合同](../plans/newton-live-observation-contract.md)。
