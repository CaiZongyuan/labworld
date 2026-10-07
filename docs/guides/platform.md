# 现有平台能力

目标：选择 Lab Word 当前 Platform Core 的真实入口。先按[服务基础](server-foundation.md)运行 Node 服务；开发不需要 Docker、Rust 或外部数据库。

```bash
curl -i http://127.0.0.1:3000/api/v1/auth/session
curl -i http://127.0.0.1:3000/api/openapi.json
```

匿名 session 返回 401。OpenAPI 返回当前完整保留 Node 合同的 JSON，标题为 `Lab Word API`。当前身份、成员、API key、审计、幂等、限流与文件能力见[平台指南](server-platform.md)。文件字节与业务引用见[文件指南](server-files.md)。Lab 资产、世界写入与设备程序已使用该服务。

Core 不引用 Lab。角色管理属于 Core；用户和有效 `lab:full` Agent 的完整 Lab 访问合同见 [ADR 0008](../adr/0008-full-lab-access-for-users-and-agents.md)。Lab 保留业务 validator、引用与提交回调的职责。

[生成 API](site:reference/api.md)与[配置参考](site:reference/config.md)来自正式 Node 来源。已移除 Rust 和部署源码保存在 `legacy-rust-final`；当前源码、命令与正式 SDK 使用 Node。Migration Gate 由最终 CI 与实际集成判定。

从仓库根目录运行 `pnpm test:server` 检查真实 Node HTTP、能力与事务恢复。前端测试在 HTTP 边界使用 MSW，不能证明真实存储集成。选择受影响入口见[测试指南](../testing/t01-feedback-loop.md)。备份、恢复与密码恢复见[服务运维](server-operations.md)，生产同源访问见 [Web 托管](server-web.md)。
