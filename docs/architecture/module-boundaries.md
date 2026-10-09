# 模块边界

Lab Word 复用现有 Core 与 Platform，并为实验室业务保留独立职责。相关目标来自 [ADR 0003](../adr/0003-static-example-composition.md)与 [ADR 0005](../adr/0005-lab-digital-twin-on-saas-foundation.md)。

## 依赖关系

```text
应用入口 ──组合──> 通用壳 + 业务贡献
业务 Views ─────> SDK / Core / UI
SDK ────────────> Contracts
业务 Application ──> Core 公共能力 / Platform
Platform ───────> 基础设施
```

应用入口决定实际装配，Core 和通用壳保持不导入具体业务。Platform 不依赖 Application。当前知识库为参考业务；Lab 的三维资产与设备概念留在 Lab 自身。

## 当前公开接口

[组装合同](../../packages/views/src/shell/app-contract.ts)定义业务的页面、导航、文案和默认入口。[组装实现](../../packages/views/src/shell/app-contract.ts)拒绝重复 id、冲突路由、保留路由与缺失翻译。TanStack Router 留在 Web 适配层。

后端由 [API 入口](../../apps/api/src/lib.rs)组合 Router 与 OpenAPI。Rust 模块的 `module.json` 声明表归属，模块通过公共能力协作，不直接读写其他模块的表。业务用例拥有事务边界；审计与任务在需要原子提交时使用同一个连接。

## 验证和限制

```bash
pnpm boundaries:check
pnpm typecheck
```

静态检查可以拒绝已知依赖与表归属越界，不能证明动态 SQL、真实授权或事务恢复正确。这些行为从 HTTP 和公开能力检查；阅读[测试策略](../testing/strategy.md)。

“独立业务”表示源码和职责边界，不表示新的企业或租户。当前沿用[单企业部署](../adr/0001-single-organization-deployment.md)。历史模板的完整所有权清单与删例工具在此副本中并不存在，不把目标架构视为已完成的命令。

Lab 的 [ownership](../../crates/app/src/modules/lab/module.json) 以 `sdkPaths` 精确登记订阅 helper，以 `assemblyPoints` 登记 SDK facade 接入位置，`contractSymbols` 包含相应导出。移除 Lab 时一并移除这些 helper、测试、教程及 facade 的 Lab 导出，随后重新生成合同和 SDK；共享 HTTP/SSE 生命周期仍属于 SDK。边界检查仅允许已登记的业务 SDK 文件导入该业务合同，未登记 SDK 文件与 Core 仍受原规则约束。

后续 Lab 的导入失败、资源释放、快速切换与懒加载在正式应用验收，见[产品范围](lab-word.md)。
