# 外观与语言

目标：在 Lab Word 切换语言和外观，并确认本机偏好被保留。前提是已按[快速开始](../getting-started/quickstart.md)启动应用。

## 操作与结果

1. 使用页面顶部的语言入口切换简体中文或英文，当前界面与页面标题应同时更新。
2. 在外观入口选择跟随系统、浅色或深色；跟随系统时，操作系统外观变化会更新页面。
3. 从左下角账户入口进入设置，也可在外观与语言区修改同样的偏好。
4. 刷新页面，显式选择应继续保留。窄屏通过导航抽屉访问相应入口。

偏好保存于当前设备，不修改后端权限或业务数据。不同浏览器不会自动同步；禁用存储或清除站点数据后会回到设备默认值。

## 开发与验证

[Preferences](../../packages/views/src/shell/preferences.tsx)负责状态与存储，[Settings](../../packages/views/src/shell/settings-view.tsx)提供界面；双语文案在 [core-messages.ts](../../packages/views/src/shell/core-messages.ts)。共享 token 来自 `packages/ui/src/styles.css`。

从仓库根目录验证语言、外观和设置行为：

```bash
pnpm exec vitest run apps/web/src/settings.test.tsx apps/web/src/desktop-preferences.test.tsx
```

组件检查验证可观察选择与保存。Electron 桥与真实浏览器的系统外观另在各自旅程核对。文档站的主题和语言由自己的站点控制，切换语言仍停留在同一章节。
