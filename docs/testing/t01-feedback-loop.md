# 开发与验证

目标：为自己的 Lab Word 变更选择能观察结果的公开检查。命令从仓库根目录执行，完整职责见[测试策略](strategy.md)。

## 选择入口

| 变更              | 命令                                                | 观察结果与前提                                        |
| ----------------- | --------------------------------------------------- | ----------------------------------------------------- |
| Web 行为          | `pnpm test:frontend`                                | 真实组件操作；HTTP 使用 MSW                           |
| TypeScript 与边界 | `pnpm typecheck`、`pnpm boundaries:check`           | 类型、包依赖、Rust 表归属                             |
| 后端行为          | `node scripts/test-backend.mjs --test registration` | 真实 Router 与隔离服务；需要 Docker                   |
| 合同              | `pnpm generate`、`pnpm contracts:check`             | Rust/OpenAPI、生成类型与 SDK 一致                     |
| 文档              | `pnpm docs:check`、`pnpm docs:build`                | 来源、双语、生成参考与实际构建链接                    |
| 文档浏览器旅程    | `just e2e-docs`                                     | 语言、主题、搜索、窄屏与自定义 base；需 Chromium      |
| 应用关键旅程      | `just e2e`                                          | 真实 Web/API/Worker/数据库与存储；需 Docker、Chromium |

首次浏览器验证执行 `pnpm exec playwright install chromium`。`just check` 包含主要格式、静态、行为、性能预算与构建检查；它不含浏览器 E2E。`just check-full` 额外运行应用 E2E。

## Lab Viewer 的实际边界

已接受的 Viewer 体验由[独立预览](../guides/lab-viewer.md)保存渲染与资源生命周期证据。本次文档基线的应用测试未覆盖正式 Lab，产品集成需要单独验证。

正式接入时，组件测试观察导入控件、选择、loading/error 与恢复，浏览器观察真实 GLB/HDR、画布像素、相机和资源释放。DOM 成功不能证明三维模型可见；一次内存采样不能证明泄漏。

## 失败与证据

如果 Docker、Chromium 或依赖缺失，记录命令、失败条件和未验证范围，不把跳过视为通过。后端检查使用隔离资源，不清理开发或生产数据。

在已固定的源码版本和任务范围上记录验证。按照[开发流程](../agents/development-flow.md)先做仓库简化，再完成受影响检查与 Standards + Spec review。
