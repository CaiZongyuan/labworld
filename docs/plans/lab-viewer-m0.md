# Lab Viewer M0 呈现层方案

> 状态：M0 呈现层范围已收敛，2026-10-01。用户确认 Lab 默认入口、本地 GLB 导入，以及先查看与点选的交互范围。v1 交互预览已接受，用户要求直接实施，并将主业务导航中的知识库改为资产库；正式集成验收另行记录。本文尚未成为 GitHub 实施票。

## 已明确的方向

产品目标是实验室数字孪生。现有 SaaS 模板提供工程底座，Lab 作为独立业务接入当前应用并按需加载。用户明确当前先解决 Three.js 呈现层，包括三维资产的导入与显示；现实数据相关问题移出本轮。相关边界已记录在 [ADR 0005](../adr/0005-lab-digital-twin-on-saas-foundation.md)。

Lab 成为左侧边栏首要业务导航及登录后的默认业务入口，资产库替换主导航中的知识库，既有知识库路由与数据保留兼容。用户在 Lab 页面选择或拖入本地 GLB，页面同时提供一个预置示例。首个版本完成自动居中、相机适配、旋转/缩放/平移查看与点击选择；设备摆放编辑留到下一步。

先验证外部资产进入浏览器的完整链路：取得 GLB、加载、环境光照、旋转/缩放/平移、点击设备、观察渲染性能。技术方向为 React 19、TypeScript、React Three Fiber v9、Three.js 和 Drei，性能面板优先评估 r3f-perf。

第一阶段使用别人已经制作的 glTF/GLB，不要求自己建模。统一运行场景的长度尺度为米，保留源资产与运行资产的区别。UE5、TwinState、IoT、MQTT、Agent 均不进入本阶段。

用户已确认先一台设备闭环，再扩展至五类资产；接受 CC0 / CC BY 并保留必要署名；第一版优先桌面 Chrome。

后续学习路径为多实例性能实验，再评估实验室空间与 Blender/IFC。优化技术须由测量出的瓶颈驱动，避免预先承诺 Instancing、LOD 或纹理压缩都要进入 M0。

## M0-A 用户流程与页面体验

```text
左侧 Lab / 登录后的默认业务入口
  -> 查看预置模型
  -> 选择或拖入本地 GLB
  -> 校验、解析与加载反馈
  -> 模型自动居中，相机适配模型包围盒
  -> 旋转 / 缩放 / 平移 / 重置视角
  -> 点击选择，查看资产名称和静态模型信息
  -> 查看实时渲染指标
```

推荐页面使用现有应用壳：左侧保留应用导航，中间为充分占用内容区的三维画布，右侧为紧凑的所选资产信息；画布工具包含导入、聚焦模型、重置视角、网格开关和性能面板开关。沿用仓库组件、图标、主题与双语模式，具体布局通过交互预览验收。

第一次进入即显示预置示例。M0-A 每次查看一个模型，本地导入替换当前模型；M0-B 再扩展到多设备实例的静态场景。首次光照使用项目托管的 HDR，搭配中性背景与网格。相机按照实际模型范围取景，不依赖某个模型恰好匹配的固定位置。

本地导入在浏览器当前页面会话中处理，不增加服务器上传、云资产库或持久化流程。重新进入可恢复预置示例；刷新后不要求恢复用户导入的本地文件。材质、动画、尺寸与层级的观察结果用于后续资产整理。

## 导入边界与加载行为

- 首版输入为 glTF 2.0 的 `.glb`，优先支持资源完整内嵌的单文件资产。`.glb` 本身也可能引用外部资源；缺失外部贴图或二进制文件时明确提示，不能静默显示残缺模型。
- 选择文件和拖拽文件使用相同的加载流程。Three.js `GLTFLoader.parseAsync` 可以解析 `File.arrayBuffer()`，完成本地导入无需先上传服务器；具体 R3F 接线在实现时选择。
- 格式无效、没有可显示几何、引用缺失资源、压缩扩展无法解码等情况提供明确失败反馈，并保留重新选择文件或回到示例的路径。
- 保留原始模型尺度；自动取景与显示居中不等于将所有模型强行缩放为相同高度。五类资产组合时以显式的资产尺度修正统一到米。
- 加载成功后更新当前模型与所选对象的信息；新文件加载失败时保留上一个可用模型。重复导入与快速切换需避免旧加载结果覆盖新的模型。
- 替换模型和离开页面时释放当前导入独占的 GPU 资源。使用 Blob URL 时，撤销 URL 与释放几何体、材质、纹理分别处理；共享或缓存资源按其所有权管理。
- 首版材料检查以静态外观为主；动画控制、节点编辑、分件操作和场景摆放工具作为后续范围。

## 呈现层的组织方式

Lab 页面组合三维视口、导入反馈、静态资产信息和性能显示。三维视口负责 GLB 场景树、环境光照、相机、网格与点选；导入流程负责文件解析、加载/失败状态和资源生命周期。模型数据与设备实例的身份分开，重复模型使用独立场景树。

这是 Lab 自身的前端能力，通用 UI、SaaS Core 和知识库不需要认识三维设备。优先沿用现有 React 状态与组件模式，在实际复杂度出现前保持少量明确模块。Three.js、R3F 和 Drei 按页面加载，性能面板兼容性单独验证。

## 方案调查基线

以下记录制定方案时的源码，不代表后续工作区接入状态。

- 当前仓库是已有 SaaS 模板，不是空白 Vite 项目。Web 已使用 React 19.3.0、TypeScript 5.9.3、Vite 8.3.1 和 TanStack Router；当前未发现 Three.js、R3F、Drei、r3f-perf 依赖或 GLB Viewer。
- 已有通用壳与业务贡献的组合接口。[显式组装点](../../apps/web/src/app-examples.tsx)和[路由适配](../../apps/web/src/router.tsx)是实际代码；[ADR 0002](../adr/0002-executable-removable-reference.md)与[ADR 0003](../adr/0003-static-example-composition.md)约束业务所有权及 Core 独立性。
- `assembleApp` 保留示例与业务导航声明次序，并支持显式默认入口；登录/注册已消费该结果。当前适配器不自动懒加载业务页面，3D 页面需通过动态导入接入。默认业务入口沿用 [Default Entry](../../CONTEXT.md) 合同。
- Vite 使用默认静态资源目录，可以托管本地 GLB、HDR 与所需解码器；当前未发现这些三维资源。
- 已有[前端包体预算](../../scripts/perf/baselines.json)：首屏 gzip 400 KiB，每个异步块 gzip 500 KiB。若接入现有应用，3D 页面需按需加载，并实际验证包体；不能直接修改预算掩盖超限。GLB/HDR 文件不在这个 JS 门禁的计量范围内，资产预算需另行约定。
- 模板架构文档描述的是 SaaS 基线，文件名中的 `threejs` 不代表已经实现 3D 能力。文档提到的工具也需要核对实际文件与行为后才能复用。

## 原始建议需要澄清的地方

1. “一天先跑通一个模型”与完整 M0 的“五类实验室资产”是不同交付范围。资产寻找、许可核对、尺寸与材质整理也要计入工作量；一天暂不作为已承诺排期。
2. `scene.json` 同时出现在 M0 清单和 M0 之后的计划。建议放在五类资产阶段；单模型阶段可以先用一个明确配置，完整 Asset Registry 和自动优化流水线另行评估。
3. 同一 GLB 重复使用时，模型定义与场景中的设备实例必须区分。同一个模型可以对应多个独立 id；点击需要识别实例，不能只返回模型类型。`useGLTF` 按 URL 缓存加载结果，重复 `<primitive object={scene}>` 会复用只能有一个父节点的对象。每个实例需要独立的场景树，可使用 Drei 的 `Clone` / `Gltf`；不必因此复制几何体和材质。
4. Drei 的 `Environment preset="studio"` 会从远程获取 HDR。建议正式可复现的演示使用本地、许可明确的 HDR；压缩模型的解码器等附加资源也要核对是否依赖远程服务。
5. GLB 文件字节数、JS 堆内存、渲染器的 geometry/texture 数量和 GPU 显存是不同指标。Three.js `renderer.info.memory` 提供 geometry/texture 数量；r3f-perf 的 memory 来自 `performance.memory` 的 JS 堆占用，不是准确显存。相关 API 不可用时不能将面板返回的 0 解读成零占用。GPU 时间依赖浏览器的 timer-query 扩展，无法测量时应显示不可用。
6. 60 FPS、100-300 draw calls 和三角形数量只能作为学习参考。正式验收必须指定设备、浏览器、视口、DPR、资产版本、实例数量和采样方式。
7. `gltf-transform optimize` 的产物需要验证材质、外观、层级、选取行为和运行时解码支持。例如 v4.5.1 默认启用 simplify、flatten、join 与 Meshopt，可能改变几何和节点组织。保留原件、工具版本、命令与检查结果，不能仅凭体积下降宣称优化成功；KTX2 需要另行配置纹理解码支持。
8. 顶层技术方向匹配不代表依赖树已经兼容。查询到的 `r3f-perf@7.2.3` 自身 peer 范围允许 React 19 / R3F 9，但依赖的 Drei 9 系列声明 React 18 / R3F 8。实施时检查安装后的实际依赖树并验证运行，再固定版本；必要时评估替代性能面板，当前不声称已完成兼容验证。

## 阶段划分

M0-A 与 M0-B 的逐步交付已获用户确认；后续阶段的细化仍用于讨论，不是已发布的实施票。

| 阶段 | 可观察结果 | 边界 |
| --- | --- | --- |
| M0-A：单设备闭环 | 一台真实实验室设备 GLB，有环境光照、网格和相机操作；点击后可见设备身份；显示基础渲染指标 | 验证资产与渲染链路，含加载/失败反馈 |
| M0-B：完整 Lab Viewer | 五类设备/家具资产按场景清单摆放；相同模型的不同实例能独立选择；显示名称与静态信息 | 明确清单格式、尺度与落点；不伪造实时在线状态或温度 |
| M1：性能实验 | 同一资产以 1、10、100 个实例运行，生成可复现的指标对比 | 先记录基线，再针对瓶颈验证一种优化；区别首次加载与稳定运行 |
| M2：实验室空间 | 根据实际资产与空间需求选择独立资产组合、Blender 整场景或 IFC | 作为后续决策，不由 M0 预先绑定 |

模型文件、HDR、许可与署名记录是交付物的一部分。Khronos 样例适合诊断材质和加载器；它能证明渲染路径可用，但不能替代实验室设备的最终验收。

## 设计树与已确认选择

```text
实验室数字孪生 [用户明确的产品目标]
├─ React 19 + R3F v9 + Three.js + Drei [用户指定的技术方向]
├─ 当前应用中的 Lab 业务、按需加载 [Q1 已确认]
│  └─ 左侧 Lab 首要业务导航和默认业务入口；知识库为模板附带功能 [Q5 已确认]
├─ M0: 一台设备 -> 五类资产场景 [Q2 已确认]
│  ├─ GLB -> 浏览器 -> 光照/相机 -> 选择 -> 性能观察
│  ├─ 页面选择或拖入本地 GLB，并附带预置示例 [Q8 已确认]
│  └─ 自动居中与相机适配，先查看与点选 [Q9 已确认]
├─ CC0 / CC BY，保留许可与署名 [Q3 已确认]
└─ 桌面 Chrome 优先 [Q4 已确认]

现实现场对应、设备数据、状态监测及控制 [Q6 / Q7 移出本轮]
```

| 问题 | 需要用户决定 | 推荐答案 | 状态 |
| --- | --- | --- | --- |
| Q1 产品归属 | 接入当前 SaaS 应用成为 Lab 参考业务，还是独立学习 Demo？ | 当前应用中的新参考业务；遵循显式组装和按需加载 | 已接受；用户进一步明确 Lab 是数字孪生产品业务 |
| Q2 首轮范围 | 先验收一台设备再扩展到五类资产，还是首轮就要求完整 M0？ | 分为 M0-A 和 M0-B；第一步只完成一台设备闭环 | 已接受 |
| Q3 资产许可 | 可以使用 CC0 / CC BY 并保留必要署名，还是仅接受 CC0？ | 接受 CC0 / CC BY，逐项记录来源、作者和准确许可 | 已接受 |
| Q4 验收平台 | 先验收桌面 Chrome，还是首轮也要求手机与 Electron？ | 桌面 Chrome 优先；后续根据设备明确性能条件 | 已接受 |

已将 Digital Twin、Lab Viewer、Lab Layout、Equipment Model 与 Equipment Instance 的定义写入 [CONTEXT.md](../../CONTEXT.md)。例如两个显微镜实例可以共用同一模型，但选择和后续设备数据关联针对不同实例。

## 后续澄清结果

| 问题 | 需要用户决定 | 推荐答案 | 状态 |
| --- | --- | --- | --- |
| Q5 产品入口 | Lab 是否成为登录后的默认业务入口，现有知识库如何安排？ | Lab 成为默认业务入口，知识库保留为模板附带功能 | 已确认；左侧边栏默认进入 Lab |
| Q6 场景对应 | 是否先约定与真实实验室的对应关系？ | 先专注三维资产呈现 | 用户明确当前先不考虑数据，移出本轮 |
| Q7 孪生优先级 | 是否当前约定设备数据接入、监测与控制？ | 当前聚焦 Three.js 呈现层 | 用户明确当前先不考虑数据，移出本轮 |
| Q8 资产导入 | 浏览器本地导入，还是仅加载开发者预置的模型？ | 页面选择或拖入本地 GLB，附带预置示例 | 已接受 |
| Q9 呈现操作 | 先查看与点选，还是同时提供场景摆放编辑？ | 自动居中与相机适配，支持旋转/缩放/平移查看和点选 | 已接受；摆放编辑后置 |

当前呈现层的关键产品分叉已经确定。文件会话生命周期、资源内嵌要求、错误恢复与性能指标口径作为最小实现边界写在本文，并在交互预览中展示；预览反馈进一步确定视觉与具体交互。

## 首个资产组合的调查结果

v1 预览已经匿名取得并实际加载以下资产。原始文件、转换脚本、来源记录及运行资产都保留在版本目录。

| 资产 | 来源、作者与许可 | 获取条件及验证边界 |
| --- | --- | --- |
| 显微镜 | [Industrial Microscope](https://polyhaven.com/a/industrial_microscope)，Lukas Walzer，[CC0](https://polyhaven.com/license) | 1k glTF、bin 与三张 JPEG 可匿名下载；保持原几何与贴图打包为内嵌 GLB，2,454,784 bytes。实际解析确认 16,598 三角形、2 个 mesh、1 个材质、3 张贴图，浏览器已渲染 |
| 室内 HDR | [Studio Small 03](https://polyhaven.com/a/studio_small_03)，Greg Zaal，[CC0](https://polyhaven.com/license) | [1K HDR](https://dl.polyhaven.org/file/ph-assets/HDRIs/hdr/1k/studio_small_03_1k.hdr) 已匿名下载并在浏览器加载，1,686,299 bytes |

此前 Sketchfab 显微镜候选的下载 API 需要账号认证。本版已采用可匿名取得的 Poly Haven 资产，模型获取不再依赖该候选。

## 交互预览 v1

打开 <http://127.0.0.1:5190/prototype/lab-viewer>。版本位于 `.scratch/lab-viewer/v1/`，使用真实应用壳与 UI 组件，GLB/HDR、文件导入、相机、点选及指标实际运行。账户和模板导航为模拟，加载/错误/空场景的情景控制放在独立的底部预览栏。

[体验记录](../ui/lab-viewer-experience.md)说明素材、验证边界与已接受的修正。源码、依赖锁定、截图与检查结果随版本保留；后续迭代保持 v1 可追溯。正式应用的登录后路由、权限、按需加载及包体预算仍需在产品实现时验证。

## 后续验证与交付路径

方案收敛后，按[体验设计流程](../agents/experience-design.md)提供版本化交互预览，再形成可观察的验收行为与规格。沿用已有预览批准或用户明确跳过预览的指示。

M0-A 的验收建议如下：

1. 登录后进入 Lab，左侧 Lab 为首要业务导航；知识库入口仍能使用。
2. 预置设备、材质与环境光照实际可见，画布像素检查与截图证明已渲染；桌面不同视口下模型完整取景，画布与导航、工具、信息面板布局清晰。
3. 从文件选择与拖拽导入同一资源内嵌 GLB 都能显示；旋转、缩放、平移、聚焦与重置操作有效。
4. 点击模型后显示正确资产名称与静态信息；点击空白可以清除选择，相机拖动不会意外触发选择。
5. 无效文件、缺失外部依赖或加载失败有明确反馈，随后可成功导入有效模型，前一个可用模型不会因失败导入而丢失。
6. FPS、draw calls、triangles 与 geometry/texture 数量可观察；JS heap / GPU 时间不可获取时显示不可用，并明确计量口径。
7. 连续替换模型、快速切换和离开再进入不会保留错误模型或失效选择；检查资源释放的趋势，避免根据单个内存采样作泄漏结论。
8. Three.js 相关代码按需加载，现有首屏与异步块预算实测通过；配套资产来源与署名记录完整。

页面测试负责导入控件、选择信息、加载与错误反馈。GLB/HDR 实际解析与渲染、相机交互、资源生命周期需要真实浏览器观察，默认 jsdom 测试不能证明这些行为。性能报告记录场景、视口、DPR、资产版本和浏览器环境；60 FPS 作为观察目标，当前不引入跨设备的硬门槛。

实施阶段遵循[工程流程](../agents/development-flow.md)与[测试策略](../testing/strategy.md)，交付相关业务、教程和所有权记录，完成 simplify 与 Standards + Spec review。用户已授权按接受的体验直接实施 M0；本文不改变已有票的状态，也不扩展该实施范围。

## 事实核对来源

- [R3F 安装与 React 版本对应](https://r3f.docs.pmnd.rs/getting-started/installation)
- [Drei Environment](https://drei.docs.pmnd.rs/staging/environment)
- [Drei useGLTF](https://drei.docs.pmnd.rs/loaders/gltf-use-gltf)
- [Three.js Object3D](https://threejs.org/docs/pages/Object3D.html)
- [Three.js WebGLRenderer](https://threejs.org/docs/pages/WebGLRenderer.html)
- [Three.js GLTFLoader 解析本地数据](https://threejs.org/docs/pages/GLTFLoader.html)
- [Three.js LoadingManager 的资源 URL 映射](https://threejs.org/docs/pages/LoadingManager.html)
- [glTF 2.0 GLB 与外部资源规范](https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html)
- [R3F 缓存与 useLoader](https://r3f.docs.pmnd.rs/api/hooks#useloader)
- [R3F 已有对象的重复使用](https://r3f.docs.pmnd.rs/api/objects#putting-already-existing-objects-into-the-scene-graph)
- [r3f-perf 指标实现](https://github.com/utsuboco/r3f-perf/blob/main/src/internal.ts)
- [r3f-perf 当前发布元数据](https://registry.npmjs.org/r3f-perf/latest)
- [glTF Transform CLI](https://gltf-transform.dev/cli)
- [glTF Transform v4.5.1 optimize 默认参数](https://github.com/donmccurdy/glTF-Transform/blob/v4.5.1/packages/cli/src/cli.ts)
- [Poly Haven 许可](https://polyhaven.com/license)
- [Khronos glTF Sample Assets](https://github.com/KhronosGroup/glTF-Sample-Assets)
