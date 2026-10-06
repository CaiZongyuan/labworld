# 持久导入第一个数字资产

当前 Node 开发入口使用 TypeScript 服务；可直接运行的资产路径见[Node 资产指南](../guides/server-assets.md)。本章完整 Foundation V1 版本中的设备与历史后续内容仍按迁移阶段交付。

目标：普通 Member 保存一份 GLB 与元数据，在新浏览器和真实 Agent 请求中读取同一资产，再观察一次失败与恢复。

## 起始版本与本章变更

使用[完整旅程](complete-foundation.md)指定的 Foundation V1 工作副本。全部章节保持同一版本。资产、表示和文件身份独立，并使用现有文件生命周期。以下命令在仓库根目录运行；上传会写入开发数据。

主要源码为 [Lab 资产业务](../../crates/app/src/modules/lab/assets.rs)、[迁移](../../migrations/0018_lab_assets.sql)、[内置定义](../../crates/app/src/modules/lab/definitions.json)、[资产库](../../packages/views/src/lab/asset-library.tsx)与[生成 SDK](../../packages/sdk/src/generated/sdk.gen.ts)。Lab 的 [module.json](../../crates/app/src/modules/lab/module.json)登记业务归属；Core 文件与身份职责沿用公共接口。

## 在浏览器保存模型

```bash
pnpm install --frozen-lockfile
just dev
```

打开 <http://127.0.0.1:5173/assets>，登录一个普通 Member；新部署可先注册 Owner，再注册第二个账号。选择 **导入 GLB**，使用 `tests/fixtures/lab/cube.glb`，填写名称、来源、许可与版本，点击 **发布资产**。页面显示部署提供的实际 GLB 大小上限；默认值与设置见[生成配置参考](site:reference/config.md)。没有可信来源或许可时可留空，界面显示“未注明”。

发布成功后目录出现文件，打开到 Lab 可观察一米立方体。刷新、关闭页面，或在另一个浏览器登录企业内另一 Member，再从资产库打开同一条目；原始尺度和文件内容应保留。名称、版本和稳定 `file_id` 存在服务器，短期签名 URL 只在请求下载时取得。

服务器在发布前解码 Draco、Meshopt、Basis、嵌入图像和 data URI，并验证几何数据。页面同时显示展开资源上限；超过该上限的模型也会被拒绝，不占用无界解码内存。原始压缩字节保持不变。

按类别查询内置定义。打开详情可查看规格、能力参数、状态结构和接口实现状态。照明、传感器和离心机已有虚拟程序；后续章节介绍如何启动。Robot 动作仍仅声明，尚未实现。声明存在不代表动作当前可执行。

## 用 Agent 导入并读取

在应用设置的 **API 密钥** 页面创建带 `lab:full` 范围的有效密钥。普通 Member 和 Agent 使用同一资产业务；会话写入要求 CSRF，Bearer 写入按密钥范围与有效期检查。

在仓库根目录设置开发 API 地址，然后在隐藏输入处输入自己的密钥：

```bash
export LAB_API_BASE=http://127.0.0.1:3000
read -rs LAB_API_KEY
export LAB_API_KEY
export LAB_UPLOAD_KEY=first-cube-import
LAB_ASSET_NAME='Agent cube' LAB_ASSET_SOURCE='Generated test geometry' \
  LAB_ASSET_LICENSE=CC0 node examples/lab/import-asset.mjs tests/fixtures/lab/cube.glb
```

脚本打印资产 id、表示 id、稳定文件 id、实际大小与 SHA-256，并已通过 GET 重新读取元数据和下载字节、核对哈希。浏览器重新加载资产库后应出现 **Agent cube**。使用相同 `LAB_UPLOAD_KEY` 和相同元数据重试返回同一资产；更改请求内容时使用新 key，否则返回 409。

完整请求流程来自以下可执行源码：

<<< ../../examples/lab/import-asset.mjs

## 失败与恢复

1. 创建任意文本文件并命名为 `broken.glb`，在资产库选择它。应出现无效 GLB 提示，前一个可用模型和已发布目录保持可用。
2. 再选择有效 `cube.glb` 并发布，应成功。服务器也验证格式、引用、数据范围和场景图；通过 Agent 上传外部资源依赖或无效 GLB 会返回 422，不发布资产。
3. 若上传或发布暂时失败，导入对话框保留元数据，重试继续同一请求。已失效或撤销的凭据拒绝发布；重新取得有效凭据后重试。中止的上传与已删除文件由既有对象清理机制回收。
4. 资产可重命名或确认删除；被业务引用的资产返回 409。短期下载能力在对象实际回收前可能仍有效，不把删除目录与已经发送的下载能力混为一谈。

## 验证与下一阶段

```bash
node scripts/test-backend.mjs --test lab_assets
pnpm exec vitest run apps/web/src/lab.test.tsx
node scripts/e2e.mjs tests/e2e/lab.spec.ts
```

HTTP 检查使用隔离 PostgreSQL 与真实对象存储；页面检查仅由 MSW 替代 HTTP；浏览器检查覆盖另一上下文、真实 Agent、GLB/WebGL 与 Draco、Meshopt、Basis 压缩加载。

继续[持久 Lab 与对象教程](persistent-world.md)，用这些稳定资产建立 Lab 与独立 Entity、Scene Node。本章的 `/lab/asset` 单模型预览不生成实验室对象或摆放关系。
