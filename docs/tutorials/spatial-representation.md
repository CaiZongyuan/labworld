# 查看表示并定位对象

<script setup>
import { withBase } from 'vitepress';
</script>

目标：检查已登记空间，在选择时保留相机，再主动定位对象。

## 起始状态与源码

先完成[空间工作台](spatial-workbench.md)。保留同一个持久 Lab 和两个对象。使用包含本章实现的当前 checkout。普通 Member 需要有效会话。Agent 写入使用相同公开接口和有效 `lab:full` key。

在仓库根目录运行：

```bash
pnpm install --frozen-lockfile
pnpm dev
```

打开 <http://127.0.0.1:5173/lab>，选择你的 Lab。查看和取景不会保存 Placement。登记对象、启动程序和更换外观会写入开发数据。

[查看器](../../packages/views/src/lab/world-viewport.tsx)渲染实际 World。[内置几何](../../packages/views/src/lab/builtin-models.ts)、[相机取景](../../packages/views/src/lab/camera-framing.ts)和[重点标签](../../packages/views/src/lab/world-labels.tsx)承接本章变更。[Lab ownership](../../packages/server/src/lab/ownership.json)将共享表示元数据保留给 Lab 消费者。

## 保留视角，再主动定位

1. 旋转或缩放画布。
2. 通过模型、标签或目录选择任一对象。

   选择保留相机位置和目标。收放面板和调整窗口大小也保留这个姿态。可用面积变化会改变投影。

3. 选择**聚焦模型**。

   相机框入活动 Scene Node。没有活动节点时，该命令框入整个布局。

4. 选择**恢复全景**，框入全部可见表示。
5. 选择**俯视布局**，从上方检查 Placement。
6. 双击对象模型或标签名称。

   这个动作会再次主动定位该节点。旋转输入可中断取景过渡。操作系统的减少动态效果偏好使取景立即完成，并关闭旋转阻尼。

要检查实时设备，登记一个内置传感器，在**操作**中选择**启动程序**。等待实际观测。标签更新时，相机保留姿态。[设备详情](device-details.md)继续说明目标、Command 和 Task 结果。

## 阅读标签与内置模型

<img :src="withBase('/lab-spatial-representations-v1.png')" alt="1600×1000 下的已登记内置对象与实际虚拟程序观测" />

图中八个对象来自隔离的正式 Node/Web 验证。身份和观测由服务器生成；设备来源是虚拟程序。实验台、设备和器皿使用本章表示，画面没有房间身份或测得的房间尺寸。

标签依次优先显示选中对象、活动 Task 和关键读数。它们避让彼此，以及实际不透明面板和工具。选中对象位于画面外时，标签提供**定位**。趋势章节可用时，传感器的**最近 1 分钟**操作打开其历史视图。

当前读数复用操作页的连接、Binding、Run、类型、来源时间、质量和新鲜度判定。最后报告值保持独立。停止来源会保留照明最后的外观。转子读数无效或离线时，当前运动停止。Robot 的静态关节姿态不能证明现实运动或控制。

内置实验台、设备和烧杯的几何与材质按实例独立。既有 Environment 仍是位置标记。网格和空 Lab 都不能证明房间身份或测得的房间尺寸。

## 使用共享尺寸

生成的[表示 profiles](../../packages/contracts/src/lab-representations.ts)冻结内置边界和支撑高度。渲染模块拥有其[生成器](../../scripts/generate-lab-representations.mjs)。

在 `packages/views/src/lab` 或 `packages/server/src/lab` 的 Lab 代码中使用下列数据导入。这两个 workspace 包已声明 contracts 依赖。

```ts
import { labRepresentationProfiles } from '@labos-threejs/contracts/lab-representations';

const bench = labRepresentationProfiles.profiles.bench;
// bounds.size 依次表示宽、高、深，单位为米。
// bench.bounds.size 为 [2.8, 0.96, 1.25]。
// bench.worktopHeight 为节点支撑平面上方 0.96 米。
```

Placement 的位置使用米，旋转使用弧度，尺度是正数乘数。内置原点使用 Y=0 的底部支撑平面。GLB 保留原始单位与尺度。其摆放锚点是边界框的 X/Z 中心和最低 Y。导入尺寸以实际文件边界为准。

这些尺寸描述表示，不是厂商测量值。改变视角或外观不会改变 Entity 身份或 Registered Location。模板必须使用这些 profiles，或实际选中文件的边界。

## 恢复外观失败

1. 在**资产库**发布有效 GLB，并填写名称、来源、许可和版本。
2. 通过对象既有的**更换外观**操作选择该表示。
3. 替换 GLB 加载失败时，检查错误。上一个可用 GLB 仍然可见。
4. 恢复访问或发布修正文件，再选择有效表示。

恢复后的外观保留同一个 Entity、Task 和 Run。等待替换和取消加载都不会用部分文件替换可用模型。[外观替换](entity-lifecycle.md)说明资产引用和归档。

## 验证与下一章

```bash
pnpm representations:check
LAB_WORD_MIGRATION_DESKTOP=false node scripts/e2e-suite.mjs tests/e2e/lab-spatial-representation.spec.ts
LAB_WORD_MIGRATION_DESKTOP=false node scripts/e2e-suite.mjs tests/e2e/lab-spatial-models.spec.ts
```

第一条命令按内置顶点检查生成尺寸。浏览器命令使用隔离的 Node/Web 服务、账号和数据。它检查公开相机像素、标签、主动取景和约定视口，不使用正在开发的 Lab。功能与视觉验收仍然分开记录。

继续[从同一对象详情操作设备](device-details.md)。
