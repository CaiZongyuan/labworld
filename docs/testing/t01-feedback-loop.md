# 开发与验证

目标：为自己的 Lab World 变更选择能观察结果的公开检查。命令从仓库根目录执行，完整职责见[测试策略](strategy.md)。

服务与开发环境使用 Linux/WSL，Windows 用户从 WSL 终端运行下列命令。CI 在 Ubuntu 上执行完整 Node、合同与浏览器 Web 检查；不再运行原生 Windows job。

## 选择入口

| 变更              | 命令                                      | 观察结果与前提                                                       |
| ----------------- | ----------------------------------------- | -------------------------------------------------------------------- |
| Web 行为          | `pnpm test:frontend`                      | 真实组件操作；HTTP 使用 MSW；motion golden 需 Python 3               |
| TypeScript 与边界 | `pnpm typecheck`、`pnpm boundaries:check` | 类型、包依赖、Node 模块、限定表与 SDK 归属                           |
| 后端行为          | `pnpm test:server`                        | 真实 Node HTTP/CLI 与隔离嵌入数据                                    |
| 合同              | `pnpm generate`、`pnpm contracts:check`   | Node OpenAPI、正式生成类型与 SDK 一致                                |
| 文档              | `pnpm docs:check`、`pnpm docs:build`      | 来源、双语、Node 生成参考与构建链接                                  |
| 文档浏览器旅程    | `pnpm test:e2e:docs`                      | 语言、主题、搜索、约定视口与自定义 base；需 Chromium                 |
| 应用关键旅程      | `pnpm test:e2e`                           | 所属 Node/Web 与真实 Chromium/WebGL；motion smoke 需固定 Python 环境 |

首次浏览器验证执行 `pnpm exec playwright install chromium`。默认 `pnpm test:e2e` 还需要独立 Python 环境，按[合成运动教程](../tutorials/synthetic-motion.md#启动-python-publisher)安装 tracked requirements 的固定版本。运行器默认读取 `.scratch/motion-python/bin/python`，也可用 `MOTION_E2E_PYTHON` 指定解释器路径。

默认 suite 执行 motion smoke，不执行至少 600 秒的完整运动验收。完整命令与两者覆盖范围见[验证源码](../tutorials/synthetic-motion.md#验证源码)。`pnpm check` 包含当前 Node、格式、静态、行为、性能预算与构建检查，不含浏览器 E2E；其中 TS/Python golden 检查需要 Python 3，可用 `PYTHON` 指定解释器。正常 Node/Web 启动与构建不需要 Python。

命令能力不扩大任务范围。默认验证 desktop web；移动适配、窄屏、触屏或真机只按明确批准的范围加入。heavy browser 前先核对 discovery 与前提；已有关键旅程复用，CSS/布局变更选择受影响的 focused case。

`docs:check` 与 `docs:build` 读取正式 Node OpenAPI 和当前配置解析器。`pnpm test:e2e` 使用所属 Linux Node/Web 浏览器监督入口。当前 CI 执行 `pnpm check`，先检查静态、完整前端和工具，再运行长服务与合同套件。明确实际浏览器前提与任务范围。

## Lab Viewer 的实际边界

正式 Viewer 与持久 World 沿用已接受的 [Lab 体验](../guides/lab-viewer.md)。保留浏览器旅程验证真实 GLB/HDR/WebGL、选择、草稿、设备和恢复。

正式接入时，组件测试观察导入控件、选择、loading/error 与恢复，浏览器观察真实 GLB/HDR、画布像素、相机和资源释放。DOM 成功不能证明三维模型可见；一次内存采样不能证明泄漏。

首次进入含模型的 World 或资产查看器时，浏览器检查通过 `expectInitialSceneReady` 最多等待 15 秒，并继续检查实际模型、像素与错误状态。[实际 GitHub Ubuntu/SwiftShader 诊断](https://github.com/CaiZongyuan/labworld/actions/runs/38074047499) 在 9.269 秒观察到正确的 20 模型场景；原 5 秒失败仍保留。这个测试环境等待只用于初始场景，不改变产品性能承诺、后续操作或恢复等待、600 秒运动验收及计数预算。

## 失败与证据

motion smoke 的原始三角形轮询失败、trusted WSS 首旅程的旧 Recording 完成轮询失败，以及该 WSS 旅程失败时在清理前采集的 250ms UI／公开 Session 快照，会将脱敏事实写入 `original-*-facts.jsonl`，由正式 CI 的小型 `gate-facts-web-journeys-<shard>` 产物保留。

需要 GitHub Ubuntu 上的单个原始 Web profile 时，将 `your-branch` 替换为已推送的分支：

```bash
gh workflow run perf-nightly.yml --ref your-branch -f diagnose_web=history
```

`history` 运行完整历史用例文件；`motion` 运行原始 motion smoke；`resources` 运行完整 `lab.spec.ts`（四个用例及原有同进程历史）。它们沿用正式 CI 的 Node/Web 监督入口、Chromium 和默认桌面 Web 范围，只有 motion 安装固定 Python 依赖。省略输入或选择 `none` 仍运行原合成报告，`soak_duration_secs` 用法不变。诊断按分支与 profile 隔离并发，不取消 nightly。

查看 `diagnose-web (not CI)` 的 collected/executed/skipped 数量；零执行或全部跳过会失败。下载 `diagnose-web-<profile>` 产物中的安全事实、summary 和 ownership/closure 回执，并核对实际 head。它不保留原始 trace、请求头或服务日志。该入口仅缩短已选失败的反馈；成功不替代正式 verify 或浏览器分片/汇总检查，也不重置诊断预算。

如果 Docker、Chromium 或依赖缺失，记录命令、失败条件和未验证范围，不把跳过视为通过。后端检查使用隔离资源，不清理开发或生产数据。

在固定的源码版本、环境和任务范围上记录验证。真实 TDD red/green可复用为同一断言的 VDD 证据。稳定最终候选由本地定向检查与负责环境的一次完整门禁覆盖；已包含的 affected 检查不重复运行。修复和 main 前进按语义影响刷新，具体顺序与独立审查见[开发流程](../agents/development-flow.md)。

多阶段协作使用 [development-timeline](../../.agents/skills/development-timeline/SKILL.md)轻量记录阶段、等待和返工。报告说明已记录的进展与未知部分，不追加产品验证或合并门禁。
