# 产品范围与架构

Lab Word 的产品目标是实验室数字孪生。当前正式应用提供单模型查看、服务器持久资产库与版本化内置定义；持久世界和后端虚拟设备是已批准的下一阶段。术语见 [CONTEXT](../../CONTEXT.md)。

## 模型与设备的关系

```text
Lab ──登记──> Entity（设备等对象）<──定义── Asset
                 │
                 └──由 Scene Node 呈现 <──外观── Asset Representation
```

这是 Foundation V1 的目标关系：Equipment Model 是三维资产表示，Equipment Instance 是设备类 Entity；Scene Node 的身份与摆放独立于设备身份。同一模型可表示多台设备，同一设备也可有多个节点。当前单模型查看器尚不建立这些持久对象和布局。

## 已有实现与目标接入

| 范围                           | 当前状态                        | 后续责任                       |
| ------------------------------ | ------------------------------- | ------------------------------ |
| 通用应用壳、身份、成员、知识库 | 现有应用代码                    | 为 Lab 提供宿主与共享能力      |
| Lab Viewer 与持久资产库        | Member/Agent 共用真实文件与 API | 扩展持久世界及多对象表示       |
| Lab 导航与登录后默认入口       | 已由显式组装接入                | 保持宿主和 Lab 职责分离        |
| Foundation V1                  | 体验已接受，规格/实施票已发布   | 建立持久世界与后端虚拟设备运行 |
| 真实设备与协议接入             | 后续范围                        | 按实际来源增加适配与执行合同   |

[ADR 0005](../adr/0005-lab-digital-twin-on-saas-foundation.md)选择复用现有 SaaS 底座：Lab 拥有设备与布局业务，Core 保持身份、成员等公共职责。接入点见[项目结构](project-structure.md)。

## 当前呈现层边界

当前查看一份资源内嵌的 GLB，支持文件选择与拖入、自动居中与取景、旋转/缩放/平移、点击选择、回到示例和渲染指标。导入文件按 Core 文件生命周期保存，Lab 拥有资产、表示和稳定文件关联；目录在其他浏览器及 Agent 中可查询。操作与恢复见[持久资产教程](../tutorials/persistent-assets.md)。

当前实现保持模型原始尺度，并在外部资源依赖、无几何或解码失败时反馈错误、保留前一个可用模型。替换与离开页面释放独占 GPU 资源，快速切换防止旧结果覆盖新模型；后续多实例改造需保持这些合同。

Three.js 相关代码已随 Lab 页面按需加载，并纳入正式包体预算。预览的构建与软件渲染指标不代表目标硬件性能。

## 继续开发

先按[查看器指南](../guides/lab-viewer.md)观察现有功能。Foundation V1 从[规格 #1](https://github.com/CaiZongyuan/labworld/issues/1)及其实施票继续，接手入口为[开发交接](../handoffs/digital-twin-foundation-v1.md)；职责规则见[模块边界](module-boundaries.md)。
