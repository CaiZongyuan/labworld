# 模块边界

Lab 拥有实验室业务。Platform Core 拥有身份、成员、凭据、文件、审计、幂等与限流，Core 不导入 Lab。Node 应用通过公开能力组合两者，决定见 [ADR 0010](../adr/0010-single-typescript-lab-word-server.md)与 [ADR 0011](../adr/0011-pglite-embedded-database.md)。

[应用入口](../../apps/web/src/app.ts)把 Lab 路由、导航与消息交给共享壳。[路由适配](../../apps/web/src/router.tsx)拥有 TanStack 类型和浏览器导航；大型页面按需加载。Web 使用生成 SDK/DTO，数据库源码不进入 Web 产物。

[runtime](../../apps/server/src/runtime.ts)组合服务资源。数据库驱动与迁移执行只属于 platform/db，纯领域不导入基础设施。业务用例拥有事务；Core 审计和幂等与同一业务操作一起提交。

[Node schema 声明](../../packages/server/src/lab/world/schema.ts)拥有限定表。[Lab ownership](../../packages/server/src/lab/ownership.json)记录 Views 路径、准确 SDK helper 路径与合同符号。[边界检查](../../scripts/check-boundaries.mjs)检查包依赖、Node 表声明/迁移和 SDK/Core 限制；[服务检查](../../scripts/lib/server-boundaries.mjs)追踪 Core/纯领域的间接依赖。静态检查不能证明授权、动态 SQL 或恢复。

运行总览的[汇总与登记区域](../../packages/views/src/lab/operations-state.ts)和[设备视图](../../packages/views/src/lab/operations-view.tsx)由 Lab Views 拥有。它们读取现有 World、逐属性观测、趋势和运行记录，不引入第二套身份或服务。共享工作台持有一个世界订阅、布局草稿和设备操作尝试；Core 与通用壳不计算这些业务事实。

```bash
pnpm boundaries:check
pnpm typecheck
```

命令从仓库根目录执行。行为通过 HTTP、浏览器和受控资源检查验证，见[测试策略](../testing/strategy.md)与[产品范围](lab-word.md)。旧静态示例架构保存在历史 ADR 中，不是活动删例或组装框架。
