# 快速开始

启动 Node 服务与 Web，创建账户并打开持久 Lab。使用 Linux 或 Windows，以及仓库锁定的 [Node 24.18.0](../../.node-version) 和 [pnpm 11.17.0](../../package.json)。

```bash
git clone https://github.com/CaiZongyuan/labworld.git
cd labworld
pnpm install --frozen-lockfile
pnpm dev
```

命令从仓库根目录执行。服务先初始化嵌入数据库并恢复状态，再接入 HTTP。服务地址为 `http://127.0.0.1:3000`，Web 为 `http://127.0.0.1:5173`。重启后保留 `data/` 数据。启动输出提供开发进程所有权记录路径。

## 打开应用

1. 打开 <http://127.0.0.1:5173/register>，使用 12–128 字符的密码注册。首个账户为 Owner，后续为 Member。
2. 登录与注册后进入 Lab。新建 Lab，再打开其空间。
3. 打开资产库，上传 GLB 并填写来源、许可与版本，等待校验。导入被拒绝后，前一个有效模型仍可使用。
4. 注册 Entity，在 Lab 放置 Scene Node，保存布局后刷新。可以通过地址重新打开同一 Lab 与所选 Entity。
5. 继续阅读 [Lab 指南](../guides/lab-viewer.md)、[World](../guides/server-world.md) 和 [Devices](../guides/server-devices.md)。用户与 Agent 共用保留的 API 和后端设备程序。

共享首页保留在 `/`，设置与 API key 地址为 `/settings` 和 `/api-keys`。移除模块的旧书签显示不可用页面，并提供返回入口。

## 验证与停服

保持开发运行，在另一个终端执行：

```bash
curl -i http://127.0.0.1:3000/health/live
curl -i http://127.0.0.1:3000/health/ready
curl -i http://127.0.0.1:3000/api/v1/system/status
```

就绪后返回 HTTP 200 和 `x-request-id`，系统状态报告实际 schema。开发终端按 Ctrl+C，等待两个进程排空并关闭。持久数据保留。监督进程异常退出后，先用输出记录执行 `pnpm dev:recover <ledger>`，再重启。保留活跃服务与未知数据。

需要修改 Node 和 Web 设置时，将 [.env.example](../../.env.example)复制为未跟踪的 `.env`。Node 入口命令加载此文件，Vite 从仓库根目录读取。参见[生成配置](site:reference/config.md)和[独立目录与端口](../guides/server-foundation.md)。

停服备份、恢复到新目录或空目录，以及密码恢复，见[服务运维](../guides/server-operations.md)。忘记密码时使用运维 CLI。

```bash
pnpm typecheck
pnpm test:server
pnpm test:frontend
pnpm contracts:check
```

浏览器检查与完整验证职责见[开发与验证](../testing/t01-feedback-loop.md)。
