# 发布文档

目标：将已验证的双语 Lab Word 文档发布到自己的 GitHub Pages。需要源码仓库的推送权限，首次 Pages 配置需要仓库管理权限。以下步骤会推送静态产物；本地构建本身不会发布。

## 1. 核对仓库与构建

当前 [site.json](../site.json)声明 `CaiZongyuan/labworld`，默认 base 为 `/labworld/`。先提交并推送源码，页脚链接才有对应线上版本。源码 Markdown 与 `apps/docs/public/` 是输入，`.generated` 和 VitePress dist 是派生产物。

```bash
pnpm docs:check
pnpm docs:build
```

成功时构建检查报告双语页面与内部目标均在该 base 下解析。源码未发布时，本地页面仍可运行，但其 GitHub 版本链接不能证明线上可用性。

## 2. 首次启用 Pages

```bash
node scripts/publish-docs.mjs
```

脚本将 dist 提交到 `gh-pages`，不切换源码分支。到 GitHub **Settings → Pages → Build and deployment** 选择 **Deploy from a branch**、`gh-pages`、`/ (root)`。

GitHub CLI 登录后可执行：

```bash
node scripts/publish-docs.mjs --request-build
```

命令核对 Pages 配置、请求构建、匹配产物提交并读取线上源码版本。推送成功不等于站点可访问；构建未就绪时按脚本失败原因检查 Pages 状态。

## 3. 后续发布

[CI](../../.github/workflows/ci.yml)在 `main` 检查成功后推送验证过的文档产物并请求 Pages 构建；第一次仓库设置仍需完成。GitHub Actions token 推送不会自动触发 Pages 构建，因此脚本保留显式请求。

默认目标地址为 `https://caizongyuan.github.io/labworld/`；当前是否已上线需实际核对。自定义路径使用 `DOCS_BASE`，例如 `DOCS_BASE=/manual/ pnpm docs:build`。验证语言切换、搜索与章节导航后再发布。
