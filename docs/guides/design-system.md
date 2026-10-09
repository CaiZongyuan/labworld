# 共享界面组件

目标：开发 Lab Word 界面时复用现有组件与 token，并在组件展厅观察状态。先按[快速开始](../getting-started/quickstart.md)启动并登录应用。

## 查看一个真实组件

从左下角账户入口进入设置，再打开设计系统。选择按钮、输入或其他现有场景，对照亮色、暗色、禁用与错误状态。展厅使用演示数据，不更改设备或知识库资料。

[设计系统 View](../../packages/views/src/design-system/design-system-view.tsx)组合场景；共享实现来自 [Button](../../packages/ui/src/components/button.tsx)、[Input](../../packages/ui/src/components/input.tsx)等 `packages/ui/src/components/`。颜色和尺寸 token 以 [styles.css](../../packages/ui/src/styles.css)为准。

## 用于 Lab 业务

在业务中从 `@labos-threejs/ui/components/...` 导入已有组件。设备选择、GLB 导入和资产信息留在 Lab 的业务界面；通用 UI 不 import 设备规则。新组件先确认现有组件不能表达所需状态，再将业务状态通过明确参数传入。

无权限时业务入口应提示拒绝，禁用按钮不能替代后端授权。加载与错误状态保持控件尺寸和键盘焦点稳定；在窄屏和两种语言下核对文字不遮挡其他控件。

## 验证

```bash
pnpm exec vitest run apps/web/src/design-system.test.tsx
pnpm typecheck
```

从仓库根目录执行。View 检查验证展厅与可操作场景，类型检查验证组件合同。真实布局、主题与焦点另在浏览器观察；Lab 的实际三维渲染见[Viewer 验证边界](lab-viewer.md)。
