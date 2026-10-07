# Web 与同源托管

使用完整 Node SDK 和真实 Lab 应用。先完成[快速开始](../getting-started/quickstart.md)与[服务运维](server-operations.md)。命令从仓库根目录运行。

## 开发入口

```bash
pnpm dev
```

Vite 在 `http://127.0.0.1:5173` 提供 Web，将 `/api/v1`、`/api/openapi.json`、`/objects` 和 `/health` 代理到 Node。`/api-keys` 和 `/settings` 保持 Web 文档路由。用户使用 Session Cookie 和 CSRF，Agent 使用 API key 访问相同的保留业务操作。

## 托管构建应用

停止自己的开发监督进程，再构建 Web 并选择独立数据目录：

```bash
pnpm build
LAB_WORD_DATA_DIR=.scratch/hosted-lab SERVER_PORT=3100 APP_ORIGIN=http://127.0.0.1:3100 FILE_PUBLIC_ORIGIN=http://127.0.0.1:3100 LAB_WORD_WEB_DIR=apps/web/dist pnpm server
```

PowerShell：

```powershell
pnpm build
$env:LAB_WORD_DATA_DIR = '.scratch/hosted-lab'
$env:SERVER_PORT = '3100'
$env:APP_ORIGIN = 'http://127.0.0.1:3100'
$env:FILE_PUBLIC_ORIGIN = 'http://127.0.0.1:3100'
$env:LAB_WORD_WEB_DIR = 'apps/web/dist'
pnpm server
```

打开 <http://127.0.0.1:3100/register>，创建账户与 Lab。上传 GLB，从资产库打开，刷新含有所选 Entity 的 Lab。直接进入 `/api-keys` 与 `/settings` 会加载应用。签名 PUT/GET capability 使用同一 origin，保留校验后的资产字节。

`LAB_WORD_WEB_DIR` 必须包含已构建的 `index.html`；配置留空时启动 API 服务。服务提供构建文件，并为应用路由及已移除模块的旧书签提供 Web 文档。不存在的 API、健康检查与对象请求保留 JSON 状态和错误，不存在的构建文件也返回错误。静态回退不会将这些失败变成 HTML 文档。

默认监听仍为 `127.0.0.1`。团队访问由部署方提供 HTTPS 反向代理，将 `APP_ORIGIN` 与 `FILE_PUBLIC_ORIGIN` 设置为该公开 origin。Ctrl+C 排空所属服务工作，所选数据目录保留。执行[备份与恢复](server-operations.md)前先停服。

## 生成与验证

```bash
pnpm generate
pnpm contracts:check
pnpm contracts:baseline:check
pnpm typecheck
```

[生成器](../../scripts/generate-contracts.mjs)读取 [Node OpenAPI](../../apps/server/src/openapi.ts)，写入正式合同与 SDK。保留路由、DTO、operationId、状态/错误和认证语义与迁移基准一致。浏览器消费这一 SDK，JSON DTO 只有一份生成来源。[Lab 应用](../../packages/views/src/lab/app.tsx)直接声明路由、导航与消息，大型页面仍按需加载。

归属：[生产托管](../../apps/server/src/web.ts)、[配置](../../apps/server/src/config.ts)、[Vite 代理](../../apps/web/vite.config.ts)、[路由](../../apps/web/src/router.tsx)、[生成 SDK](../../packages/sdk/src/index.ts)和[所属 Node 浏览器监督入口](../../scripts/e2e-server.mjs)。
