# 用 Node 服务保存数字资产

目标：Member 发布 GLB，Agent 读取同一份原始字节，再验证失败后的恢复。需要 Node 24、pnpm 和 Linux 或 Windows。命令在仓库根目录运行，会写入你选择的开发数据目录。

先按[服务基础](server-foundation.md)启动 `pnpm dev`。当前 Node 服务提供持久资产、Lab、Entity、Scene Node 与布局。设备执行、业务订阅和历史仍在迁移；完整生成 SDK 的来源切换尚未完成。

## 保存第一个模型

打开 <http://127.0.0.1:5173/assets>。新目录先注册 Owner，再注册第二个账号作为 Member。选择 **导入 GLB**，使用 `tests/fixtures/lab/cube.glb`，填写名称、来源、许可与版本，然后点击 **发布资产**。

目录出现资产后，点击 **在 Lab 中打开**。`/lab/asset` 深链接可直接打开查看器；刷新后从资产库重新打开已保存的模型。当前资产选择保留在页面内。此入口只预览资产；登记 Entity 见[Node 世界与布局](server-world.md)。文件、表示和资产各有独立 UUID，下载 URL 是短期能力。

## 用 Agent 保存并读回

在 **API 密钥** 页面创建带 `lab:full` 的密钥。在 Bash 终端运行以下命令，在隐藏输入处输入密钥：

```bash
export LAB_API_BASE=http://127.0.0.1:3000
read -rs LAB_API_KEY
export LAB_API_KEY
export LAB_UPLOAD_KEY=node-first-cube
LAB_ASSET_NAME='Node cube' LAB_ASSET_LICENSE=CC0 \
  node examples/lab/import-asset.mjs tests/fixtures/lab/cube.glb
```

脚本返回资产、表示和文件 UUID，并下载原始字节核对 SHA-256。不要把密钥或签名 URL 写入日志。相同 `LAB_UPLOAD_KEY` 和相同输入返回同一上传与资产；改变输入需使用新 key，否则为 409。

<<< ../../examples/lab/import-asset.mjs

Member 与 Agent 共用这些 HTTP 接口。会话写入需要 Cookie、可信 Origin 和 CSRF；Agent 使用有效 Bearer 与 `lab:full`。完成上传在验证后重查原凭据，期间撤销或失效的凭据不能发布。

## 验证失败并恢复

上传缺少场景或含坏像素流的 GLB，完成请求返回 `422 files.upload_rejected`，资产目录保持原样。永久拒绝的同一上传继续返回 422；用修好的文件与新 key 重试。没有 PUT 的上传到期返回 `410 files.upload_expired`。到期下载 URL 拒绝读取，重新通过授权接口取得 URL 后恢复。

编解码器加载或存储暂时不可用时返回 503，同一上传可在服务恢复后重试。ready 文件按持久大小和摘要读取。降低当前 `FILE_MAX_BYTES` 会拒绝新的超限 start 输入，也会拒绝使用原超限输入重放 start；已经 ready 的完成与下载仍读取原文件。

资产可改名或删除。被 Entity 或节点引用时，删除返回 `409 lab.asset_in_use`。先移除你拥有的实际引用，再重试。后台维护每轮最多检查 50 个逻辑文件和 100 个目录项；拒绝与到期上传的字节会回收，终态元数据和原拒绝原因保留。表示、pin 与未知外键继续保护字节。

## 来源、限制与验证

[Lab 上传用例](../../packages/server/src/lab/assets/use-cases.ts)负责授权、幂等、GLB 验证、表示与业务审计。[Core FileService](../../packages/server/src/core/files/use-cases.ts)负责签名、不可变字节与逻辑引用。[Lab composition](../../packages/server/src/lab/assets/composition.ts)只把上传回执声明为 provisional 元数据，不能豁免逻辑删除检查。Core 不依赖 Lab。

服务使用随 npm 工作区提交的 WASM、Basis 和 Meshopt 编解码器，安装和启动不需要 Rust。服务器解码 Draco、Meshopt、Basis、嵌入图像与 data URI。默认上传为 20 MiB；展开资源和图像分配分别受 256 MiB 规则约束。这些规则不构成整个 WASM heap、scratch 或进程 RSS 的上限。具体来源和可选重建见[codec 说明](../../packages/server/codecs/README.md)。

```bash
node --test --experimental-strip-types tests/server/lab-assets.test.ts tests/server/lab-assets-recovery.test.ts tests/server/lab-asset-gc.test.ts
pnpm contracts:m1:check
```

检查使用真实 Node HTTP、嵌入数据库与所属临时目录，验证拒绝、重试、字节读回和清理，不打开你的开发数据。递归 API 检查从 [Zod 路由](../../packages/server/src/lab/assets/routes.ts)生成隔离合同，并确认正式 SDK 未被改写。继续[Node 世界与布局](server-world.md)。
