# Lab Word

带有 Three.js 工作台与后端设备程序的实验室数字孪生。

[English](README.md) | 简体中文

应用提供持久 Lab、资产、Entity、Scene Node、已保存布局、观测、Command、Task、记录和趋势。用户与 Agent 共用保留的 HTTP/SSE 合同。一个 Node 服务持有嵌入数据库、本地字节与运行状态，React Web 消费生成 SDK。

迁移按 [#45](https://github.com/CaiZongyuan/labworld/issues/45)推进。冻结 Rust 与容器源码保留到最终清理阶段，普通开发与正式合同生成已使用 Node。参见[产品架构](docs/architecture/lab-word.md)和[领域词汇](CONTEXT.md)。

## 运行应用

使用 Linux 或 Windows，以及仓库锁定的 [Node](.node-version) 和 [pnpm](package.json)。

```bash
git clone https://github.com/CaiZongyuan/labworld.git
cd labworld
pnpm install --frozen-lockfile
pnpm dev
```

打开 <http://127.0.0.1:5173/register>。首个账户为 Owner，后续为 Member，登录后进入 Lab。Node 服务监听 `127.0.0.1:3000`，用 `curl -i http://127.0.0.1:3000/health/ready` 检查就绪。Ctrl+C 排空并关闭两个开发进程，保留 `data/`。

将 [.env.example](.env.example)复制为未跟踪的 `.env`，配置 Node 与 Web。启动输出提供所属开发记录路径；监督进程异常退出后，`pnpm dev:recover <ledger>` 只停止记录中的使用者，并保留持久数据。

## 文档与检查

```bash
pnpm docs:dev
pnpm typecheck
pnpm test
pnpm contracts:check
```

打开 <http://127.0.0.1:5174/labworld/docs/> 阅读双语指南。

- [快速开始](docs/getting-started/quickstart.md)与 [Lab](docs/guides/lab-viewer.md)
- [Node 服务基础](docs/guides/server-foundation.md)、[World](docs/guides/server-world.md) 和 [Devices](docs/guides/server-devices.md)
- [备份、恢复与密码恢复](docs/guides/server-operations.md)
- [Web 与同源托管](docs/guides/server-web.md)
- [项目结构](docs/architecture/project-structure.md)与[验证入口](docs/testing/t01-feedback-loop.md)

API 和配置参考来自正式 Node 合同与运行解析器。独立的站点发布流程见[发布指南](docs/getting-started/publish-docs.md)。

```text
apps/          Node 服务、Web、共享 Desktop 源码与文档
packages/      服务领域/平台、合同、SDK、客户端 Core、UI 和 Views
scripts/       开发、验证与运维
docs/          指南、领域词汇、决策与计划
```

Lab Word 基于 [axum-saas-template](https://github.com/CaiZongyuan/axum-saas-template)。内部标识保留 `labos-threejs` 以保持兼容；产品为 **Lab Word**，仓库 slug 为 `labworld`。

[MIT](LICENSE)，保留原模板版权署名。
