# 现有平台能力

目标：在 Lab Word 开发中复用已有平台入口，并理解它们与实验室业务的边界。先完成[快速开始](../getting-started/quickstart.md)。

## 从真实接口开始

```bash
curl -i http://127.0.0.1:3000/api/v1/auth/session
curl -i http://127.0.0.1:3000/api/openapi.json
```

匿名 session 请求应返回 401；OpenAPI 应返回 JSON，并标识 `Lab Word API`。已登录页面通过 SDK 使用 Session；业务写请求沿用可信 Origin 与 CSRF，不能用客户端按钮可见性代替后端授权。

## 源码与职责

| 能力                 | 公开源码入口                                                                                                                                                             | Lab 的责任                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| 注册、会话、密码重置 | [Identity](../../crates/app/src/modules/identity/mod.rs)                                                                                                                 | 复用当前 User 与 Session                  |
| 企业成员与角色       | [Organization](../../crates/app/src/modules/organization/mod.rs)                                                                                                         | 定义设备资源的具体访问资格                |
| 文件与清理           | [Files](../../crates/app/src/modules/files/mod.rs)                                                                                                                       | 未来明确资产所有权；M0 本地导入不调用上传 |
| 后台任务、审计、通知 | [Jobs](../../crates/app/src/modules/jobs/mod.rs)、[Audit](../../crates/app/src/modules/audit/mod.rs)、[Notifications](../../crates/app/src/modules/notifications/mod.rs) | 定义业务 Handler、审计语义和通知目标      |
| 知识库               | [Knowledge](../../crates/app/src/modules/knowledge/mod.rs)                                                                                                               | 保留现有功能，与设备模型区分              |

当前 HTTP 请求、操作名与响应以[生成 API](site:reference/api.md)为准，设置以[配置参考](site:reference/config.md)为准。平台能力不代表设备遥测、IoT 接入或控制已经存在。

## 验证失败边界

从仓库根目录运行：

```bash
node scripts/test-backend.mjs --test registration --test sessions
pnpm test:frontend
```

后端检查启动隔离服务，真实验证注册、会话、拒绝与失效；需要 Docker。前端测试在 HTTP 边界使用 MSW，不证明真实数据库与存储集成。按[测试指南](../testing/t01-feedback-loop.md)选择变更涉及的入口。

## 运维入口

现有部署定义为 [compose.production.yaml](../../compose.production.yaml)，配置示例为 [env.production.example](../../deploy/production/env.production.example)。[justfile](../../justfile)提供显式迁移、部署、备份及独立恢复入口。先检查当前脚本和环境配置；此页不声明 Lab 生产发布已完成。
