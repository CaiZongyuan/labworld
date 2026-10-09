---
status: accepted
---

# V1 的普通用户与 Agent 共享完整 Lab 操作能力

Digital Twin Foundation V1 优先验证人与 Agent 对同一实验室世界的完整读写和设备交互。用户在 2026-10-02 的审阅中明确选择 full access：通过认证的普通用户和 Agent 均可访问本部署企业内的全部 Lab 业务能力，包括资产、对象、布局、关系、设备命令和记录；Lab 操作不按 Owner/Admin/Member 分级，也不增加逐 Lab 授权管理。

这使浏览器与 Agent 能复用同一业务操作和验收合同，减少首版的授权管理成本。相较管理员控制、成员及 Agent 只读的方案，所有已认证参与者都能修改共享实验室，这是本版明确接受的协作方式；后续若要限制操作范围，需要显式修订该访问合同。

两类入口沿用相应身份凭据并记录操作者。会话写入沿用 CSRF 校验，Agent 使用有效 API 凭据；身份失效或撤销后拒绝访问。参数、设备忙碌、任务生命周期及资产引用约束对所有调用者一致。本决定作用于 Lab 业务，企业成员管理与其他 Core 能力继续使用各自的既有合同。完整范围见 [Foundation V1 计划](../plans/Labworld-Digital-Twin-Foundation-V1-plan.md)。
