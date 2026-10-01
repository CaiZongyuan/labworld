# Lab Word

实验室数字孪生，从 Three.js 设备模型查看器开始。

[English](README.md) | 简体中文

## 当前阶段

首阶段包含预置设备、浏览器本地 GLB 导入、相机操作、点击选择与渲染指标。[Lab Viewer v1 交互预览](docs/guides/lab-viewer.md)已在隔离环境运行这些交互，画面已接受，正式应用接入与验证仍待完成。

当前应用保留 Rust/Axum API、React Web、Electron 壳，以及身份、成员、权限、文件、后台任务与知识库等基础能力。Lab 正式接入正在进行，仍待验收；真实设备数据与场景摆放编辑属于后续范围。

进一步阅读[呈现层方案](docs/plans/lab-viewer-m0.md)、[产品架构](docs/architecture/lab-word.md)和[词汇表](CONTEXT.md)。

## 运行应用

准备 Docker/Compose，并按 [rust-toolchain.toml](rust-toolchain.toml)、[.node-version](.node-version)、[package.json](package.json)和 [.tool-versions](.tool-versions)安装固定工具版本。

```bash
git clone https://github.com/CaiZongyuan/labworld.git
cd labworld
pnpm install --frozen-lockfile
just dev
```

打开 <http://127.0.0.1:5173/register>。`just dev` 启动 PostgreSQL、Redis、RustFS、Mailpit，执行迁移、初始化存储，再启动 API、Worker 与 Web。使用 `curl -i http://127.0.0.1:3000/health/ready` 验证就绪。

首个成功注册账号为 Owner，后续为 Member。上述命令运行现有应用；查看独立的三维预览请按 [Lab Viewer 指南](docs/guides/lab-viewer.md)操作。

## 项目文档

执行 `just docs`，打开 <http://127.0.0.1:5174/labworld/docs/>。中英文文档围绕当前源码、可运行任务、观察结果和失败边界编写。

- [快速开始](docs/getting-started/quickstart.md)
- [项目结构](docs/architecture/project-structure.md)与[模块边界](docs/architecture/module-boundaries.md)
- [Lab Viewer 预览](docs/guides/lab-viewer.md)
- [现有平台能力](docs/guides/platform.md)
- [测试](docs/testing/t01-feedback-loop.md)与[文档维护](docs/guides/maintain-docs.md)

API 与配置参考由实现生成。站点按 `labworld` 仓库配置；发布流程见[发布文档](docs/getting-started/publish-docs.md)。本地验证与线上发布分别进行。

## 仓库结构

```text
apps/          API、Worker、Web、Desktop 与文档入口
crates/        应用模块与基础设施
packages/      合同、SDK、客户端 Core、UI 与共享 Views
migrations/    PostgreSQL 迁移历史
scripts/       开发、验证与运维工具
docs/          产品文档、决策与计划
```

Lab Word 基于 [axum-saas-template](https://github.com/CaiZongyuan/axum-saas-template)。内部包名、数据库与存储标识保留 `labos-threejs` 以保持兼容；产品名为 **Lab Word**，仓库 slug 为 `labworld`。

## 许可证

[MIT](LICENSE)，保留原模板的版权署名。
