# 实验录制导出到 Blender 与 UE5：格式与验证边界

核对日期：2026-10-10。本文是 maintainer 研究笔记，服务于 [物理仿真接入与实验回放计划](../plans/newton-backend.md) 的设计访谈。用户已确认首版方式为：导出录制后，在 Blender 与 UE5 中导入并渲染；Lab Word 首版不承担自动启动渲染器与批量生成视频。

本次只读官方文档及有限本机路径，未安装软件、运行仿真、启动 Blender/UE5、导入模型或渲染。**下述路径是有官方能力依据的候选设计，尚未完成本项目的兼容性验证。** 本文不改变已接受的领域定义或架构决策。

## 判断

建议把可移植的 Recording 保持为实验真相，把 USD 作为第一种离线渲染导出格式。导出静态网格、机器人各连杆与试管的时间采样位姿，渲染端只读取已经发生的运动，不重新执行 Newton/MuJoCo 或抓取控制。这样，物理后端的选择与离线渲染器的选择可以分别验证。

USD 的时间采样变换、Blender 的变换缓存，以及 UE5 的 USD Stage / Level Sequence 支持为该路径提供基础。[USD 变换教程][usd-xform]、[Blender 4.5 USD][blender-usd]、[UE5.6 USD][ue-usd] 本次没有验证任意 Newton Viewer 输出可以直接进入两种工具；Viewer 输出仍需检查网格、引用、材质、坐标、时间与对象映射。

## 已核实的工具能力

| 工具与文档基线 | 官方支持 | 限制及本项目含义 |
| --- | --- | --- |
| Blender 4.5 USD importer | 时间变化的 transform 导入为对象上的 `Transform Cache` constraint；动态网格、曲线与点云通过 `Mesh Sequence Cache` modifier 读取。`Xform` 导入为 Empty，可保存变换层级。 | 不支持“一帧一个独立 USD 文件”的 USD file sequence。应交付含 time samples 的单个 stage 及其可解析依赖。缓存不等同于可独立编辑的普通关键帧。[Blender USD][blender-usd] |
| Blender 4.5 USD 材质与相机 | 可以导入 USD Preview Surface；支持 USD 相机的多个属性及动画。Y-up 场景导入时转换为 Blender Z-up。可以按 `metersPerUnit` 应用单位缩放。 | Preview Surface 转 Principled BSDF 是有损转换，不覆盖全部设置与 shader。相机 aperture 动画存在解释差异，部分灯光类型不支持。需要核对导入选项，不能只依赖默认值。[Blender USD][blender-usd] |
| UE5.6 USD Stage | 支持 `.usd`、`.usda`、`.usdc`、`.usdz`；USD Stage Actor 关联 Level Sequence。USD xform 动画显示为 Transform tracks；其他动画，如 float、boolean 和 skeletal bones，经 Time track 表示。 | 需启用 `USD Importer` 并重启编辑器。官方标注 USD 为 Beta。`Import Into Level`、Content Browser 资产导入与保留 USD Stage 的工作方式不同，不应假设它们保留完全相同的动画。[UE USD][ue-usd] |
| UE5.6 Movie Render Queue | 官方渲染流程要求可渲染的 Level Sequence，并启用 `Movie Render Queue` 插件后重启编辑器。可以渲染图像序列与影片。 | 官方分别说明了 USD 动画进入 Level Sequence 和 MRQ 渲染 Level Sequence；本次未找到直接验证本项目 USD Stage 录制从导入到 MRQ 输出的完整官方示例。必须实际检查序列求值、相机、引用与帧范围。[Movie Render Pipeline][ue-mrq] |
| UE5.6 Alembic importer | `.abc` 导入为 Geometry Cache 后，可以播放逐帧变化的网格。支持导入采样设置、法线处理、Face Sets 材质分配与 motion vectors。 | 单帧 Static Mesh 导入不保留动画。Geometry Cache 的成本随网格复杂度增长；材质分配需要源文件 Face Sets。该 5.6 文档正文仍有 UE4 的历史用语，不能据此扩大到任意版本的全部选项。[Alembic importer][ue-alembic] |

版本号表示本次查阅的文档分支，不表示本机安装版本，也不表示项目已批准这两个版本为支持合同。实施时应固定实际 Blender、UE5 和 USD 导出库版本，记录成功导入与渲染的组合；本次未验证其他版本的相同行为。

## 三种运动表示如何选择

| 表示 | 适合的运动 | 本项目选择 |
| --- | --- | --- |
| 静态 mesh + 时间采样 Xform | 刚体、机械臂各刚性连杆、夹爪部件、试管整体运动。Blender 和 UE USD 动画文档均有直接支持依据。[Blender][blender-usd]、[UE USD][ue-usd] | 首版优先。每个部件保留稳定对象映射，只写运动变化，无需逐帧重复网格。 |
| 逐帧网格 / Geometry Cache | 形变、流体、拓扑变化。Blender 支持动态 USD mesh，UE Alembic Geometry Cache 支持 vertex-varying sequence。[Blender][blender-usd]、[Alembic][ue-alembic] | 当前 SO-101、试管与架子均无需这种表示。以后出现液体或软体，再评估 USD mesh samples 或 Alembic。 |
| 骨架 / 关节动画 | 需要进入 DCC 骨架编辑、skinning 或 UE skeletal animation 工作流。Blender 可导入 USD skeleton；UE USD 支持 skeletal animation。[Blender][blender-usd]、[UE USD][ue-usd] | 首版不必为机器人建立渲染骨架。记录关节值可服务实验分析，但离线渲染应使用已求得的连杆位姿；只有关节值不足以重建自由运动的试管。 |

这里的选择是本项目的工程建议。它不意味着几种表示无法互相转换，也不意味着导入物理关节定义会让渲染器获得相同的求解行为。

### glTF 的边界

glTF 2.0 核心动画支持节点的 translation、rotation、scale 及 morph target weights；核心规范不覆盖任意属性动画，也不规定播放顺序、自动开始、循环或时间轴如何映射。[glTF 2.0 §3.11][gltf-spec] 因而 GLB 可以承载机械臂刚性部件的节点运动，但实验结果、命令、接触事件和回放策略仍需要 Recording 或 sidecar。材质动画等能力依赖扩展及目标工具的实际支持。

UE 的 glTF 文档确认 glTF/GLB 资产格式与扩展支持；Interchange reference 确认 `Import Into Level` 可接受 glTF/GLB，也提供骨骼动画导入设置。这些文档**不足以证明本项目任意 glTF 节点运动都会自动成为可供 MRQ 渲染的场景 Transform tracks**，不能把格式支持等同于整个工作流支持。[UE glTF][ue-gltf]、[Interchange reference][ue-interchange] Web 用 GLB 的选择可以保留；离线渲染首版优先验证 USD，避免同时扩大两个动画导出合同。

## 建议的导出合同

用户已在 Q19 确认 USD、相对路径资源、时间采样运动与事件文件的导出方向。以下是该方向所需的接口细节；具体 DTO、采样误差与支持版本在实施规格中固定：

1. **固定场景版本。** 导出 manifest 保存 Recording id、精确场景版本、资产内容校验值、导出器版本、完整/不完整状态，以及 Entity / link / USD prim path 的稳定映射。网格与纹理引用必须随包提供且可离线解析，不依赖作者本机路径或 Nucleus 在线服务。
2. **固定坐标与原点。** 明确长度单位、up axis、handedness、场景原点、模型原点及 parent-local/world transform 语义。USD 应显式写 `metersPerUnit` 与 `upAxis`：缺省 USD 长度单位是厘米；USD 采用右手系，UE 编辑器采用 Z-up 左手系。转换属于导出/导入边界，不能只改一个轴名字。[USD units][usd-units]、[USD up axis][usd-axis]、[UE coordinates][ue-coordinates]
3. **固定时间。** 保留原始仿真时间戳及其起点，显式写 stage 的 start/end、`timeCodesPerSecond` 和预览帧率。USD 的 `timeCodesPerSecond` 决定 sample 时间与秒的对应，`framesPerSecond` 用于时间轴显示；两者不应被当作求解器步长。[UsdStage API][usd-stage] 导出后的 frame/time 映射和重采样策略必须可检查。
4. **只烘焙已记录的运动。** 首版逐连杆及试管导出平移与旋转时间样本，网格不随刚体运动重写。导出层级保持固定；把世界位姿放到动画 parent 下时需先变成对应局部位姿，避免重复施加父变换。试管保持独立运动轨迹，不能在抓住时通过 reparent 或约束制造“成功”。
5. **保留实验含义。** 任务结果、命令、观测、失败与中断仍由 Recording 保存；渲染成功不证明抓取成功。序列播放无需 solver、控制器或 Physics API；导出的是视觉运动与结果映射，不是可再次执行的物理场景。
6. **区分采样与插值。** 比较录制采样点的位姿，并声明允许误差；中间时间的平滑与 motion blur 是显示处理。检查快速运动、旋转跨越边界、非整数时间样本和 MRQ 子帧求值；数据缺口不得被默认为一段已验证的物理运动。USD 默认属性求值使用线性插值，但不同属性与目标工具的变换求值仍需验证。[USD transforms][usd-xform]、[UsdStage API][usd-stage]

建议首版交付一个主 USD stage 与相对路径的网格、纹理依赖，加 manifest 和事件 sidecar。不要预先承诺复杂的 variants、PointInstancer、MDL、任意 shader、完整物理 schema 或所有 USD features 在两种工具中等价。

## 最小验证制品

制作一段短录制，包含初始静止、夹爪闭合、试管提起、移动与放置。制品应包括一台 SO-101 的各连杆、独立试管、静态四孔架、垫面和台面；只使用已确认可分发的资产。可以先以少量明确材质验证运动，不用高保真着色阻塞格式验证。

验收时，必须在固定版本的两个工具分别完成：

1. 从解压后的目录加载 USD，检查引用全部解析，模型数量、大小、原点和方向正确。关闭仿真后仍可拖动任意时间；重新打开项目后缓存引用仍存在。
2. 对初始、提起、放置和末尾的多个已记录时间点，读取机器人部件与试管位姿，转换回合同坐标后比较；另查旋转中间帧与速度较快片段。误差阈值在实施验收中固定。
3. Blender 检查 Transform Cache / Mesh Sequence Cache 及场景帧范围；UE 检查 USD Stage Actor 的关联 Level Sequence 和变换轨道，不仅观察某一帧静态模型。
4. 在两个工具各设置明确的相机、灯光与材质，渲染短图像序列；UE 使用 MRQ。确认渲染序列包含运动与预期末帧，重开项目后仍能复现。首版流程由使用者导入并渲染，Lab Word 只负责导出及提供操作说明。
5. 根据 Recording 的失败/中断信息核对 sidecar。不完整录制只渲染实际保留的范围，不把截断结果呈现为任务完成。

这是建议的实施验证，而非已执行记录。官方分别证明导入、动画与渲染能力；实际制品仍需完成上述跨工具验证后才能称为支持。

## 视觉一致性的边界

运动与任务结果可以共用相同录制，**最终画面不会自动一致**。Blender 的 Preview Surface 转换本身可能有损；UE USD Stage 不自动生成 lightmap，使用静态光照构建时可能得到黑场景。[Blender 材质][blender-usd]、[UE USD workflow][ue-usd] 相机、灯光、材质、色彩管理、曝光、透明试管的折射及 renderer 设置分别影响画面，应在各工具准备和验证。用户在 DCC 中修改视觉时，不应回写实验的已记录接触结果与轨迹。

## 有限本机检查

读取 `PATH` 中的 `blender`、`UnrealEditor`、`UnrealEditor-Cmd`，均未找到。另查 `/usr/share/blender`、`/opt/blender`、`/opt/UnrealEngine`、`/home/caii/UnrealEngine`，以及 C/D 盘常见 `Program Files/Blender Foundation` 与 `Program Files/Epic Games` 路径，均未定位安装。

这只表示检查过的路径未发现安装，不能证明整机未安装。没有全盘搜索，也没有启动 GUI；实际本机版本未知。

## 官方来源

- [Blender 4.5：Universal Scene Description][blender-usd]。重点为 Importing USD Files / Animations / Materials / Import Options；读取页显示更新日期 2026-10-09。
- [UE5.6：Universal Scene Description][ue-usd]。重点为 Authoring and Editing Animation / Enabling the USD Import Plugin / USD Stage Workflow。
- [UE5.6：Movie Render Pipeline][ue-mrq]。重点为 Movie Render Queue prerequisites；没有在本项目执行该路径。
- [UE5.6：Alembic File Importer][ue-alembic]。重点为 Import as Geometry Cache。
- [UE glTF File Format Support][ue-gltf] 与 [UE5.6 Interchange Import Reference][ue-interchange]。注意格式、扩展、骨骼动画与场景时间轴能力的差别。
- [OpenUSD：Transforms, Animation, and Layer Offsets][usd-xform]、[UsdStage API][usd-stage]、[linear units][usd-units]、[up axis][usd-axis]。此次 release 文档为 USD 26.08，不代表本项目已安装该库版本。
- [Khronos glTF 2.0 specification][gltf-spec]，§3.11 Animations。
- [UE5.6 Coordinate System and Spaces][ue-coordinates]。

[blender-usd]: https://docs.blender.org/manual/en/4.5/files/import_export/usd.html
[ue-usd]: https://dev.epicgames.com/documentation/en-us/unreal-engine/universal-scene-description-in-unreal-engine?application_version=5.6
[ue-mrq]: https://dev.epicgames.com/documentation/en-us/unreal-engine/movie-render-pipeline-in-unreal-engine?application_version=5.6
[ue-alembic]: https://dev.epicgames.com/documentation/en-us/unreal-engine/alembic-file-importer-in-unreal-engine?application_version=5.6
[ue-gltf]: https://dev.epicgames.com/documentation/en-us/unreal-engine/gltf-file-format-support-in-unreal-engine
[ue-interchange]: https://dev.epicgames.com/documentation/en-us/unreal-engine/interchange-import-reference-in-unreal-engine?application_version=5.6
[ue-coordinates]: https://dev.epicgames.com/documentation/en-us/unreal-engine/coordinate-system-and-spaces-in-unreal-engine?application_version=5.6
[usd-xform]: https://openusd.org/release/tut_xforms.html
[usd-stage]: https://openusd.org/release/api/class_usd_stage.html
[usd-units]: https://openusd.org/release/api/group___usd_geom_linear_units__group.html
[usd-axis]: https://openusd.org/release/api/group___usd_geom_up_axis__group.html
[gltf-spec]: https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html
