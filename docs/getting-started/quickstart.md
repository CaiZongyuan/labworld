# 快速开始

目标：从源码启动 Lab Word 现有应用，并用 HTTP 和 Web 页面确认开发环境可用。已验证的 Viewer 体验目前来自[独立预览](../guides/lab-viewer.md)，正式 Lab 集成验收另行记录。

## 1. 安装并启动

安装 Docker 和 Compose。使用以下工具版本：

| 工具 | 版本    | 来源                                |
| ---- | ------- | ----------------------------------- |
| Rust | 1.96.0  | [工具链](../../rust-toolchain.toml) |
| Node | 24.18.0 | [Node 版本](../../.node-version)    |
| pnpm | 11.17.0 | [包配置](../../package.json)        |
| just | 1.58.0  | [工具版本](../../.tool-versions)    |

执行以下命令克隆仓库并启动开发环境：

```bash
git clone https://github.com/CaiZongyuan/labworld.git
cd labworld
pnpm install --frozen-lockfile
just dev
```

项目命令在仓库根目录执行。首次启动下载依赖并编译 Rust。开发脚本启动 PostgreSQL、Redis、RustFS 和 Mailpit。随后执行迁移并初始化存储，再运行 API、Worker 和 Web。脚本会在本地开发卷写入数据。

默认设置来自 [.env.example](../../.env.example)；需要调整时建立未跟踪的 `.env`。API 配置见[生成参考](site:reference/config.md)。

## 2. 观察结果

保持开发入口运行，在另一个终端执行：

```bash
curl -i http://127.0.0.1:3000/health/live
curl -i http://127.0.0.1:3000/health/ready
curl -i http://127.0.0.1:3000/api/v1/system/status
```

预期每个响应均为 HTTP 200，并含 `x-request-id`。

| 接口                    | 预期信息           |
| ----------------------- | ------------------ |
| `/health/live`          | API 进程正在运行。 |
| `/health/ready`         | 依赖与迁移已就绪。 |
| `/api/v1/system/status` | 当前系统状态。     |

密码长度须为 12–128 字符。

1. 打开 <http://127.0.0.1:5173/register>。
2. 创建开发账号。

首个账号为 Owner，后续账号为 Member。开发邮件在 <http://127.0.0.1:8025> 查看。

已有平台可以验证登录与业务操作。Lab 体验以相应版本的集成验收为准。

## 3. 检查依赖失败与恢复

只在自己的开发环境执行本节失败检查。

1. 停止 PostgreSQL：

```bash
just db-down
```

2. 检查就绪状态：

```bash
curl -i http://127.0.0.1:3000/health/ready
```

`/health/ready` 应返回 503，`/health/live` 仍返回 200。

3. 启动 PostgreSQL：

```bash
docker compose up -d --wait postgres
```

4. 再次检查就绪状态：

```bash
curl -i http://127.0.0.1:3000/health/ready
```

`/health/ready` 应恢复 200。

迁移不匹配时，先核对源码版本，再执行 `just migrate`。API 启动不自动迁移。

新增 SQL 迁移后：

1. 执行 `just migrate`。
2. 重启开发入口。

重启会更新二进制中的迁移集合。

## 停止与下一步

按 `Ctrl+C` 停止 API、Worker 和 Web。执行 `just services-down` 停止容器；此命令保留开发卷。

API 端口变更时，调整 `APP_BIND`，并将 `VITE_API_PROXY` 指向该 API 的可访问地址。Web 地址变更时，将 `APP_ORIGIN` 设为浏览器访问 Web 时的来源地址，包含协议、主机和端口。数据库端口变更时，同时调整 `POSTGRES_PORT` 和 `DATABASE_URL`。

接下来[运行 Lab Viewer 预览](../guides/lab-viewer.md)，或阅读[项目结构](../architecture/project-structure.md)。

查看在线文档：

1. 在仓库根目录执行 `just docs`。
2. 打开 <http://127.0.0.1:5174/labworld/docs/>。
