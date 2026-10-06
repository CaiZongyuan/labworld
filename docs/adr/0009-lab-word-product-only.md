---
status: accepted
---

# Lab Word 只保留实验室产品及其所需平台能力

2026-10-05 规划 vNext 时，用户决定仓库不再作为可移除示例的 SaaS 模板维护：只保留 Lab 业务及其依赖的 Platform Core（身份与会话、企业与成员、API key、文件、审计、幂等与限流），移除知识库参考业务、示例组装与删例机制、通知、通用任务队列及邮件密码重置。迁移这些能力不会推进实验室产品，而知识库在资产库替换主导航后已不再是产品入口。

本决定取代 [ADR 0002](0002-executable-removable-reference.md)、[ADR 0003](0003-static-example-composition.md)，以及 [ADR 0005](0005-lab-digital-twin-on-saas-foundation.md) 中保留知识库兼容和依赖 0003 显式组装的部分。Lab 建立在 Platform Core 之上、Core 不引用 Lab 的边界不变，[单企业部署](0001-single-organization-deployment.md)与 [full access](0008-full-lab-access-for-users-and-agents.md) 继续有效。密码改由服务端命令重置；界面重置或邮件能力需要时另行决定。被移除模块的既有开发数据不迁移。
