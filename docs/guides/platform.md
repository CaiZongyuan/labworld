# 现有平台能力

目标：选择 Lab Word 当前 Platform Core 的真实入口。先按[服务基础](server-foundation.md)运行 Node 服务；开发不需要 Docker、Rust 或外部数据库。

```bash
curl -i http://127.0.0.1:3000/api/v1/auth/session
curl -i http://127.0.0.1:3000/api/openapi.json
```

匿名 session 返回 401。OpenAPI 返回当前已迁移端点的 JSON，标题为 `Lab Word Server`。当前身份、成员、API key、审计、幂等、限流与文件能力见[平台指南](server-platform.md)。文件字节与业务引用见[文件指南](server-files.md)。Lab 资产、世界写入与设备程序仍在迁移。

Core 不引用 Lab。角色管理属于 Core；用户和有效 `lab:full` Agent 的完整 Lab 访问合同见 [ADR 0008](../adr/0008-full-lab-access-for-users-and-agents.md)。Lab 保留业务 validator、引用与提交回调的职责。

[生成 API](site:reference/api.md)与[配置参考](site:reference/config.md)分别列出当前 Node 内容和冻结旧栈内容。旧 Rust 模块、Docker 配置与完整 SDK 暂时保留，不是 `pnpm dev` 的运行依赖。它们在完整迁移门禁后移除；当前页面不宣称最终切换完成。

从仓库根目录运行 `pnpm test:server` 检查真实 Node HTTP、能力与事务恢复。前端测试在 HTTP 边界使用 MSW，不能证明真实存储集成。选择受影响入口见[测试指南](../testing/t01-feedback-loop.md)。当前 Node 备份与完整发布流程仍属后续阶段。
