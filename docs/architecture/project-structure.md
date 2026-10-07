# 项目结构

Lab Word 使用一个 TypeScript 服务与 Web 应用。持久 Lab、资产、布局、设备程序、观测、记录与趋势通过用户/Agent 共用 HTTP 合同访问。

```text
apps/
  server/src/              Node 服务、CLI 与生命周期组合
  web/src/app.ts           直接接入 Lab 的应用配置
  web/src/router.tsx       Web 路由适配
  desktop/src/             保留的共享 Electron 壳源码
  docs/.vitepress/         双语文档站
packages/
  server/src/platform/     嵌入数据库、本地字节与 HTTP 适配
  server/src/core/         身份、成员、密钥、文件、审计与限流
  server/src/lab/          Assets、World、Devices、History 与 Records
  views/src/lab/           工作台、资产与三维界面
  views/src/shell/         共享导航、偏好与消息
  ui/src/                  共享组件与样式
  contracts/               Node 生成的 OpenAPI 与 TypeScript DTO
  sdk/                     生成 HTTP 客户端与 Lab SSE 传输
scripts/                   开发、检查、构建与运维
docs/                      指南、领域词汇与决策
```

[应用入口](../../apps/web/src/app.ts)直接接入 [Lab 应用](../../packages/views/src/lab/app.tsx)，[路由适配](../../apps/web/src/router.tsx)提供导航与 API client 端口。[壳接口](../../packages/views/src/shell/app-contract.ts)描述页面、导航和双语消息。登录后进入 Lab，`/` 保持共享首页。大型页面与三维代码按需加载。

[runtime](../../apps/server/src/runtime.ts)负责服务启动与关闭。驱动与迁移只由 [platform/db](../../packages/server/src/platform/db/index.ts)持有，Platform Core 不导入 Lab。Web 使用生成 SDK，数据库源码不进入 Web 产物。已移除源码和基础设施仅在 `legacy-rust-final` 保留；当前命令使用 Node。

```bash
pnpm boundaries:check
pnpm typecheck
```

从仓库根目录运行。边界检查覆盖包依赖与 TypeScript 服务，表与 SDK 归属来自 Node 声明。继续阅读[开发与验证](../testing/t01-feedback-loop.md)、[模块边界](module-boundaries.md)和 [Lab 指南](../guides/lab-viewer.md)。
