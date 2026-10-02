# 项目结构

修改 Lab Word 前，先区分实际应用、共享能力和隔离预览。Lab Viewer 与会话资产库已接入；Foundation V1 的持久世界和后端设备程序按已发布实施票继续开发。

## 源码地图

```text
apps/
  web/src/app-examples.tsx  业务贡献的显式组装点
  web/src/router.tsx        Web 路由适配
  api/src/lib.rs            HTTP Router 与 OpenAPI 组合
  worker/src/main.rs        后台 Handler 与维护任务
  desktop/src/              Electron 宿主与 IPC
  docs/.vitepress/           双语文档站
crates/
  app/src/modules/          身份、成员、任务、文件、知识库等
  platform/src/             数据库、存储、邮件、缓存与观测
packages/
  views/src/lab/             正式查看器、会话资产库与 Lab 业务贡献
  views/src/shell/           通用应用壳与组装合同
  views/src/knowledge/       知识库界面
  ui/src/                   共享组件与样式
  contracts/                Rust 生成的 API 合同
  sdk/                      生成客户端
migrations/                 显式 SQL 迁移
scripts/                    开发、检查、构建与运维
docs/                       正文、领域词汇入口、ADR 与计划
```

正式查看器的用法见[指南](../guides/lab-viewer.md)。下一阶段已接受的 Foundation v1 预览保存在独立的 `preview/lab-foundation-v1` 分支中，取得和运行方式见[开发交接](../handoffs/digital-twin-foundation-v1.md)；它不属于正式应用构建。

## Lab 接入点

[显式组装点](../../apps/web/src/app-examples.tsx)消费业务贡献，[路由适配](../../apps/web/src/router.tsx)将页面接入宿主。贡献合同定义在 [app-contract.ts](../../packages/views/src/shell/app-contract.ts)，组装检查由 [app-contract.ts](../../packages/views/src/shell/app-contract.ts)负责。

Lab 的模型导入、三维视口与资产信息属于自己的业务界面。通用壳不认识设备。Lab 贡献已注册 `/lab` 和 `/assets`，登录后默认进入 Lab；直接访问 `/` 保持通用首页。既有页面与三维代码按需加载，Foundation 扩展应保持这些接入职责。

## 检查边界

```bash
pnpm boundaries:check
pnpm typecheck
```

从仓库根目录运行。边界检查核对包依赖、Rust 模块表所有权与纯 Domain 的基础设施导入；它没有提供完整的示例增删工具。源码、行为和权限的检查职责见[开发与验证](../testing/t01-feedback-loop.md)。

下一步阅读[模块边界](module-boundaries.md)，再按已验收的 Lab 体验实施。
