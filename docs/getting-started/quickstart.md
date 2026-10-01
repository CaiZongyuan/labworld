# 快速开始

目标：从源码启动 Lab Word 现有应用，并用 HTTP 和 Web 页面确认开发环境可用。已验证的 Viewer 体验目前来自[独立预览](../guides/lab-viewer.md)，正式 Lab 集成验收另行记录。

## 1. 安装并启动

准备 Docker/Compose，以及仓库固定版本：Rust 1.96.0、Node 24.18.0、pnpm 11.17.0、just 1.58.0。版本以[工具链](../../rust-toolchain.toml)、[Node](../../.node-version)、[包配置](../../package.json)和[工具版本](../../.tool-versions)为准。

```bash
git clone https://github.com/CaiZongyuan/labworld.git
cd labworld
pnpm install --frozen-lockfile
just dev
```

命令在仓库根目录执行。首次启动下载依赖并编译 Rust。开发脚本启动 PostgreSQL、Redis、RustFS、Mailpit，执行迁移、初始化存储，再运行 API、Worker 和 Web。它会在本地开发卷写入数据。

默认设置来自 [.env.example](../../.env.example)；需要调整时建立未跟踪的 `.env`。API 配置见[生成参考](site:reference/config.md)。

## 2. 观察结果

保持开发入口运行，在另一个终端执行：

```bash
curl -i http://127.0.0.1:3000/health/live
curl -i http://127.0.0.1:3000/health/ready
curl -i http://127.0.0.1:3000/api/v1/system/status
```

预期均为 HTTP 200，响应含 `x-request-id`。live 表示进程运行；ready 核对依赖与迁移；status 返回实际系统状态。

打开 <http://127.0.0.1:5173/register> 创建开发账号。首个账号为 Owner，后续为 Member；密码长度 12–128 字符。开发邮件在 <http://127.0.0.1:8025> 查看。已有平台可以验证登录与业务操作，Lab 体验以相应版本的集成验收为准。

## 3. 检查依赖失败与恢复

只在自己的开发环境停止 PostgreSQL：

```bash
just db-down
curl -i http://127.0.0.1:3000/health/ready
```

ready 应为 503，live 仍为 200。恢复数据库：

```bash
docker compose up -d --wait postgres
curl -i http://127.0.0.1:3000/health/ready
```

ready 应恢复 200。迁移不匹配时核对源码版本并执行 `just migrate`。API 启动不自动迁移；新增 SQL 后执行迁移并重启开发入口，使二进制中的迁移集合刷新。

## 停止与下一步

`Ctrl+C` 停止 API、Worker 和 Web；`just services-down` 停止容器并保留卷。端口冲突时同步核对 APP_BIND、VITE_API_PROXY 与 APP_ORIGIN；数据库端口变更同时调整 POSTGRES_PORT 和 DATABASE_URL。

接下来[运行 Lab Viewer 预览](../guides/lab-viewer.md)，或阅读[项目结构](../architecture/project-structure.md)。文档本身通过 `just docs` 启动，地址为 <http://127.0.0.1:5174/labworld/docs/>。
