# 开发与验证

目标：为自己的 Lab Word 变更选择能观察结果的公开检查。命令从仓库根目录执行，完整职责见[测试策略](strategy.md)。

## 选择入口

| 变更              | 命令                                      | 观察结果与前提                                       |
| ----------------- | ----------------------------------------- | ---------------------------------------------------- |
| Web 行为          | `pnpm test:frontend`                      | 真实组件操作；HTTP 使用 MSW                          |
| TypeScript 与边界 | `pnpm typecheck`、`pnpm boundaries:check` | 类型、包依赖、Node 模块边界与冻结 Rust 归属          |
| 后端行为          | `pnpm test:server`                        | 真实 Node HTTP/CLI 与隔离嵌入数据                    |
| 合同              | `pnpm generate`、`pnpm contracts:check`   | Node OpenAPI、正式生成类型与 SDK 一致                |
| 文档              | `pnpm docs:check`、`pnpm docs:build`      | 来源、双语、Node 生成参考与构建链接                  |
| 文档浏览器旅程    | `just e2e-docs`                           | 语言、主题、搜索、约定视口与自定义 base；需 Chromium |
| 应用关键旅程      | `pnpm test:e2e`                           | 所属 Node/Web 与真实 Chromium/WebGL                  |

首次浏览器验证执行 `pnpm exec playwright install chromium`。`just check` 包含主要格式、静态、行为、性能预算与构建检查；它不含浏览器 E2E。`just check-full` 额外运行应用 E2E。

命令能力不扩大任务范围。默认验证 desktop web；移动适配、窄屏、触屏或真机只按明确批准的范围加入。heavy browser 前先核对 discovery 与前提；已有关键旅程复用，CSS/布局变更选择受影响的 focused case。

`docs:check` 与 `docs:build` 读取正式 Node OpenAPI 和当前配置解析器。`pnpm test:e2e` 使用所属 Linux Node/Web 浏览器监督入口。当前 CI 执行 `pnpm check:m1`，最终清理阶段会更新冻结的 `just check` 别名。明确实际浏览器前提与任务范围。

## Lab Viewer 的实际边界

正式 Viewer 与持久 World 沿用已接受的 [Lab 体验](../guides/lab-viewer.md)。保留浏览器旅程验证真实 GLB/HDR/WebGL、选择、草稿、设备和恢复。

正式接入时，组件测试观察导入控件、选择、loading/error 与恢复，浏览器观察真实 GLB/HDR、画布像素、相机和资源释放。DOM 成功不能证明三维模型可见；一次内存采样不能证明泄漏。

## 失败与证据

如果 Docker、Chromium 或依赖缺失，记录命令、失败条件和未验证范围，不把跳过视为通过。后端检查使用隔离资源，不清理开发或生产数据。

在固定的源码版本、环境和任务范围上记录验证。真实 TDD red/green可复用为同一断言的 VDD 证据。稳定最终候选由本地定向检查与负责环境的一次完整门禁覆盖；已包含的 affected 检查不重复运行。修复和 main 前进按语义影响刷新，具体顺序与独立审查见[开发流程](../agents/development-flow.md)。

多阶段协作使用 [development-timeline](../../.agents/skills/development-timeline/SKILL.md)轻量记录阶段、等待和返工。报告说明已记录的进展与未知部分，不追加产品验证或合并门禁。
