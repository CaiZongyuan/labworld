> Captured design input. Original source: `docs/plans/Labworld-Digital-Twin-Foundation-V1-plan.md`.
> SHA-256 of the original source: `8514743b7fffffa9f4eaabbf69de150410331f07f15ddc26f6e97000fb4bfea2`.
> Relative links in this snapshot retain their original source-directory context.

# Labworld Digital Twin Foundation V1

状态：2026-10-02 两轮产品审阅已收敛。用户确认[审阅记录](../reviews/2026-10-02-digital-twin-foundation-v1-plan.md) Q1–Q4、Q6–Q9 的推荐，并将 Q5 明确为普通用户与 Agent 对 Lab 均可 full access。下文是已确认的产品范围与行为，后续交互预览、实施票及应用验证以此为输入。

已确认的首版边界：

| 维度 | 决定 |
| --- | --- |
| 世界范围 | 设备、Robot、Labware 与最小位置/包含关系；样品管理和物料账本后置 |
| 定义与创建 | 使用与内置设备程序对应的定义，用户可导入外观、配置参数和创建实例；通用能力/状态 schema 编辑器后置 |
| 模拟与实机 | 共用定义与访问合同，分别拥有 Entity 身份并可建立关联，见 [ADR 0007](../adr/0007-separate-simulated-and-physical-entity-identities.md) |
| 参考负载 | 单 Lab 100 个 Entity、20 个运行设备各 1 Hz、2 个同时观看的浏览器；同时记录模型资源体量 |
| 访问与操作 | 通过认证的普通用户和 Agent 均可完整读取、编辑和控制 Lab；同一业务合同，不按角色分级，见 [ADR 0008](../adr/0008-full-lab-access-for-users-and-agents.md) |
| 位置关系 | 普通拖动只修改三维摆放；显式位置操作修改人工登记的位于/包含关系 |
| 离心任务 | 转速、温度达标后计时；本次参数固定；忙碌拒绝再次 Start；Stop 减速后 cancelled，正常结束 completed，设备回到 idle |
| 移除与归档 | 移除节点保留设备；结束任务并停止程序后才可归档；被引用资产禁止直接删除 |
| 历史保留 | 原始观测 24 小时，已结束命令/任务及设备事件 30 天，可配置；身份、配置、最后观测和未结束任务独立保留 |

运行方式沿用 [ADR 0006](../adr/0006-server-owned-virtual-device-programs.md)：内置后端程序、实例独立、关闭页面继续运行；后端重启保留记录并标记原运行中断，由用户显式重新启动。

## 1. 本阶段目标

Labworld 当前已经具备 3D 资产导入、查看和基础管理能力。

当前代码的资产目录与本地文件仍保存在浏览器会话中，多实体持久布局、World API 和设备运行属于本阶段新增能力。最终保存恢复验收需要覆盖所引用的模型资源，不能只保存 Entity 与摆放数据。

下一阶段目标不是继续增强一个 3D Viewer，而是把 Labworld 推进成一个真正的：

**高性能、可扩展、Agent-native 的实验室数字孪生平台基础。**

本阶段需要建立实验室世界的统一信息模型，并通过一个完整的交互式 3D Digital Twin vertical slice 验证这套模型。

最终用户看到的不应该只是“一个可以加载 GLB 的实验室”，而应该是：

> 一个可以搭建、保存、查看、查询、交互，并持续接收设备状态变化的数字实验室。

同时，这套 World Model 后续应该能够自然连接：

- Virtual Device / Simulator
- IoT
- 实验设备
- Robot
- MHS
- MQTT
- SiLA
- OPC UA / LADS
- ROS 2
- OpenUSD
- Isaac Sim
- Vendor SDK / Serial / REST

但本阶段不要求真正集成这些完整基础设施。

核心是先把上层 abstraction 做正确。

---

# 2. 产品核心主轴

本阶段围绕以下核心概念及其关系建立整个系统：

```text
Asset
  ↓ register
Entity
  ├── Asset definition / representation
  ├── Location / containment relationships
  ├── Scene Node representations
  └── Where applicable: Capability / State / Binding
```

## Asset

描述：

> “这个世界里可能存在什么东西？”

Asset 是可复用的数字定义，而不是某个实验室里的具体设备。

资产定义、三维表示与设备实例分开：Equipment Model 是表达设备外观的一种 Asset Representation；更换外观不改变设备身份与运行行为。定义与实例建立明确版本关系，已有实例不能被共享定义的后续编辑静默改写。

V1 使用与内置设备程序对应的设备定义。用户可以导入三维外观、选择定义、配置参数和创建实例；任意能力/状态 schema 编辑器及用户执行代码不属于首版。静态资产可表达房间、工作台与器皿，无需附带设备程序。

例如：

- Laboratory / Room / Workcell
- Lab Bench
- Smart Light
- Temperature Sensor
- CO₂ Incubator
- Centrifuge
- Microscope
- Liquid Handler
- Robot Arm
- AMR
- Camera
- Labware

一个 Asset 可以包含多种 representation：

```text
GLB
STEP
USD
URDF
thumbnail
manual
documentation
```

也可以包含：

```text
classification
specifications
capability definitions
state schema
telemetry schema
event schema
supported interfaces
```

因此 Asset Library 最终不再只是 3D 文件库，而是：

**Physical Asset Catalog。**

---

# 3. Entity

Asset 被注册到一个具体 Lab 后，形成 Entity。V1 的对象范围包含设备、Robot、Labware 及表达其最小位置和包含关系所需的对象；例如烧杯登记在工作台上。样品管理与物料账本留待后续阶段。

例如：

```text
Asset:
Eppendorf Centrifuge 5910 Ri
```

可以产生：

```text
Entity:
centrifuge-01
centrifuge-02
```

Entity 表示：

> 实验室世界里实际存在的那个对象。

Entity 应拥有独立的：

```text
identity
name
serial / external identity
lab
asset definition reference / version
location / containment relationships
scene representations / placement references
runtime binding (where applicable)
state / health (where applicable)
```

虚拟设备和真实设备都使用相同的 Entity abstraction。

设备实例是设备类别的 Entity，Device 与 Equipment Instance 表达同一设备身份。Scene Node 负责对象在布局中的三维表示，一个 Entity 可由多个节点呈现；场景节点身份与对象身份独立。静态 Entity 可以没有控制能力和运行 Binding。

模拟设备和真实设备分别拥有 Entity 身份，可共用定义并建立模拟对应关系。未来接入实机复用上层合同，不把已有模拟对象原地变成真实设备；见 [ADR 0007](../adr/0007-separate-simulated-and-physical-entity-identities.md)。

---

# 4. Capability

Capability 描述：

> “这个 Entity 能做什么？”

例如：

```text
light.turn_on
light.set_brightness

centrifuge.run
centrifuge.stop

microscope.capture_image

robot.move
robot.pick
robot.place
```

Capability 是 Agent-native 设计的核心。

Agent 后续应该首先理解：

```text
Entity + Capability
```

而不是理解：

```text
MQTT Topic
ROS Topic
OPC UA NodeId
Serial Command
Vendor API
```

具体协议只是 Capability 的底层 Binding。

能力定义需要包含标识、版本、说明、参数类型、单位、范围和结果含义；同时区分定义上支持、当前绑定是否实现以及当前是否可执行和原因。忙碌、程序未运行、归档和未实现等原因对用户与 Agent 一致。只读测量属性经观测更新，不以 full access 将它改成可直接覆写的设备状态。

---

# 5. State

State 描述：

> “这个 Entity 现在是什么样？”

包括：

```text
operational state
health
reported values
telemetry
events
connection state
last observed time
data source
```

例如：

```text
centrifuge-01

connection: online
operation: running
speed: 11842 rpm
target_speed: 12000 rpm
temperature: 4.2 °C
remaining_time: 332 s
```

设备观测与当前状态必须保留以下信息；来源无法给出观测时间时明确表达未知，不冒充接收时间：

```text
source
observed_at
received_at
updated_at
quality / freshness
```

因为 Agent 必须能够判断一条状态信息是否新鲜、来自哪里。

当前报告值由来源明确的观测形成；目标值、命令执行结果与测量值分别表达。未收到观测时显示未知，停止来源后保留最后观测并标记其新鲜度。新鲜度按属性或共同采样的一组属性判断，新的心跳不刷新旧测量的有效时间。

当前状态提供有界摘要；历史观测与事件通过独立的有范围查询回看，不在每次世界快照中附带全部历史。

---

# 6. Binding

Binding 描述：

> “这个 Entity 如何与虚拟世界或真实世界连接？”

例如：

```text
Simulator
MQTT
MHS
SiLA
OPC UA / LADS
ROS 2
REST
Vendor SDK
Serial
```

Domain Model 不应该被其中任何一种技术绑死。

理想状态：

```text
             共享 Asset / Capability / State 合同
                    /                   \
             模拟 Entity             真实 Entity
                  │                       │
          Simulator Binding       Physical Binding
                                          │
                               OPC UA / SiLA / ROS / SDK
```

接入不同 Binding 技术时，上层共用的合同：

```text
Asset
Entity
Capability
State
3D UI
Agent API
```

尽量不发生变化。

共用合同不要求共用实例身份：Simulator 和 Physical Device 分别连接自己的 Entity，模拟观测和真实测量归属各自记录。静态 Entity 可以没有 Binding；V1 只实现内置虚拟设备运行。

---

# 7. 3D Lab 必须成为 World Model 的真实视图

这一阶段不能只完成后台的数据模型。

必须让新的信息模型真正驱动 3D Lab。

当前：

```text
GLB
 ↓
Viewer
```

应该演化为：

```text
Lab
 ↓
Entity
 ├── Asset definition / representation
 ├── Scene Nodes / Placement
 ├── Location / containment relationships
 ├── State（适用时）
 └── Binding（适用时）
 ↓
3D Scene
```

Three.js 是：

**World Model 的可视化和交互层。**

而不是 source of truth。

---

# 8. Lab 场景应该支持真正的世界搭建

目标体验：

```text
Asset Library
     ↓
选择 / 拖入资产
     ↓
Register Entity
     ↓
放入 Lab
     ↓
Position / Rotation
     ↓
Save
     ↓
Refresh
     ↓
完整恢复 Lab World
```

在 3D Scene 中点击任意对象：

```text
3D Object
   ↓ entity_id
Entity
   ↓
Identity
Asset
Capabilities
State
Telemetry
Events
Binding
```

用户操作的是 Entity，而不是孤立的 Three.js Mesh。

### 摆放与登记位置

普通拖动、旋转和缩放只修改场景节点的 Placement。用户通过明确的“放到某位置”操作或 Inspector 选择位置，修改 Entity 的位于/包含关系，并标明人工登记来源；几何重叠不自动推断包含关系。两类信息在 Inspector 中分别可见。

### 保存与恢复

保存恢复覆盖 Lab、Entity、关系、场景节点、定义版本与引用的资产资源。用户导入的外观如用于持久 Lab，其文件和元数据也必须能跨刷新、跨浏览器恢复。布局保存与运行时观测各有自己的变更边界；两个客户端同时编辑出现版本冲突时，保留未保存输入并提示重新载入或重试，不静默覆盖另一方变更。

### 移除与归档

从场景移除只删除节点表示，设备身份和后端程序继续存在。归档设备前须结束其任务并停止设备程序；归档后停止接受新动作，但身份与尚在保留期内的记录可查。被引用资产禁止直接删除，须先解除引用；更换设备定义或程序也须在停止后进行。V1 不提供有记录对象的彻底删除。

---

# 9. 本版本必须包含一个最小 Realtime Runtime

为了证明这不是静态资产管理平台，需要加入一个足够轻量的 Virtual Device Runtime。

不要求现在引入：

```text
Ditto
MQTT
NATS
Kafka
ROS
Isaac Sim
```

可以使用当前架构中最简单可靠的 realtime channel。

状态更新路径是：

```text
Device Runtime
     ↓
State change
     ↓
World Model
     ↓
Realtime update
     ↓
UI / 3D Scene / Agent API
```

### 命令、程序运行与设备任务

普通用户和 Agent 通过同一命令入口提交动作，后端记录操作者、参数和执行结果。设备程序处理动作后产生观测，当前状态、Inspector 和三维表现由观测更新；命令被接受不直接改写实际测量值。

| 概念 | 含义 |
| --- | --- |
| Device Command | 一次动作请求及其执行结果；启动成功不等于设备任务完成 |
| Device Program Run | 一个实例的设备程序从启动到停止或中断的一段运行 |
| Device Task | 一次离心等持续任务，记录本次参数、进度、结束原因和结果 |
| Observation | 设备报告的值及来源、时间和质量信息 |

同一命令的同键同参数重试返回同一记录，同键不同参数报告冲突。新命令仍需经过参数与设备当前可执行状态校验；忙碌拒绝、失败、中断和结果不确定均不能伪装成成功，也不能因响应丢失自动重复执行动作。

设备程序在后端运行，同类实例相互独立。关闭浏览器继续运行；后端重启保留身份、配置、最后观测与记录，原程序运行及未结束任务标记中断，由用户显式重新启动，沿用 ADR 0006。

### 快照、订阅与恢复

初始世界快照与后续更新有明确的衔接和版本信息。重复或迟到观测不回退当前状态、不刷新旧测量的新鲜度；部分报告保留未出现的属性，旧运行或旧 Binding 的消息不能覆盖新来源。多个客户端读取同一版本时表达相同事实。

连接中断可辨认，重连后恢复最新快照；慢客户端积压有界。身份或凭据失效后，读取、操作和订阅均终止相应访问。具体传输与持久化机制由开发者决定。

### 历史回看

原始观测默认保留最近 24 小时；已结束的命令、任务和设备事件默认保留 30 天。部署配置可调整期限。未结束任务以及设备身份、配置、最后观测独立保留；最后观测即使保留也须如实标记过期。

查询按时间范围回看并限制分页与载荷，明确显示已超出保留范围的数据缺口。保留窗口、清理行为与配置调整纳入公开验收，记录参考负载下的实际存储规模。

---

# 10. 建议用几个 Progressive Virtual Devices 验证设计

不要求把系统写死成这些设备，只把它们作为 architecture test cases。

## Smart Light

验证：

```text
Capability
Command
State
Visual Feedback
```

例如：

```text
Turn On
 ↓
Device Command
 ↓
Device Program 执行
 ↓
Observation: on
 ↓
3D Scene light changes
```

---

## Temperature Sensor

验证：

```text
Telemetry
Realtime update
History / freshness
```

---

## Centrifuge

这是本阶段最重要的复杂设备示例。

验证：

```text
State Machine
Device Program / Device Program Run
Command
Telemetry
Event
Device Task
Result
```

例如运行：

```text
12000 rpm
4 °C
10 min
```

设备运行阶段示意：

```text
IDLE
 ↓
PREPARING（加速与温控）
 ↓
RUNNING
 ↓
DECELERATING
 ↓
IDLE
```

转速和温度进入设备程序定义的目标容差后进入 RUNNING，开始计算 10 分钟；准备与减速不计入该时长。本次任务固定提交时的参数，忙碌时拒绝第二次 Start，运行中可以 Stop。

正常完成经减速后，任务结果为 completed，设备回到 idle。Stop 经减速后，任务结果为 cancelled，设备同样回到 idle；失败和后端重启中断分别保留失败或中断结果。命令接受、任务结束和设备当前状态分别展示。以上是虚拟示例的行为，不宣称与某个实机型号的全部行为一致。

UI 中能够实时看到：

```text
RPM
Temperature
Remaining Time
Current State
Events
```

Three.js 中可以有相应视觉反馈，例如 Rotor 根据 RPM 进行客户端动画。

演示资源需提供可辨认的转子节点、旋转轴与显示映射；选择适合演示的资产完成这一合同，不假设任意 GLB 都能自动识别转子。至少两个同类实例验证参数、任务、观测和可变外观的独立性。离心机的温控渐变与长任务共同覆盖已确认的两类行为。

---

## Robot

本阶段只需要证明 abstraction 可以容纳 Robot：

```text
robot-01

Declared capabilities:
move
pick
place

State:
unknown / no observation

Binding:
not configured

Execution:
not implemented
```

不要求本阶段真正实现 ROS 控制。

move/pick/place 可以作为能力描述出现，但未交付执行实现时必须明确标为未实现，不出现在“当前可执行”的结果中；静态展示也不伪造设备观测或在线状态。

---

# 11. 人和 Agent 必须面对同一个世界

这是一个重要架构原则。

Human：

```text
Three.js
 ↓
Entity Inspector
```

Agent：

```text
World API
 ↓
Entity
```

二者必须读取和修改同一个 World Model，设备动作也经过同一业务入口。

不要形成：

```text
3D UI 有一套状态

Agent / IoT 又有另一套状态
```

最终应该是：

```text
                World Model
                /         \
               /           \
          Human UI       Agent API
```

### 用户与 Agent 的访问合同

通过认证的普通用户和 Agent 均可完整访问本部署企业内的 Lab 业务，包括创建 Lab、导入和管理资产、注册和配置 Entity、编辑布局、修改登记关系、发送设备命令、查询记录以及按规则移除或归档对象。不按 Owner/Admin/Member 分级，不增加逐 Lab 授权界面；决定见 [ADR 0008](../adr/0008-full-lab-access-for-users-and-agents.md)。

浏览器使用会话，Agent 使用有效 API 凭据，均记录操作者并进入同一业务逻辑。会话写入沿用已有 CSRF 校验，过期、撤销或无效身份被拒绝。两类调用者共享参数校验、设备忙碌、归档和资产引用约束。

---

# 12. Agent-facing World Interface

本阶段提供可由 Agent 直接调用的 World API，覆盖与普通用户相同的 Lab 读写和控制能力，无需新建完整 Agent Runtime。查询入口能够回答：

```text
这个 Lab 里面有什么？

centrifuge-01 是什么？

它在哪里？

它能做什么？

它当前什么状态？

它是否在线？

它的数据是什么时候观测到的？

它连接的是 Simulator 还是真实设备？

有哪些 Entity 可以完成 centrifuge.run？

当前有哪些设备正在运行？
```

API 应该是 semantic / world-oriented，而不是暴露底层协议细节。

写入入口覆盖 §11 的完整操作集合，直接复用用户界面的业务实现。Agent 能提交 Start/Stop 并查询命令与任务结果，浏览器随同一设备观测变化；普通用户也能操作由 Agent 创建的对象。现有 API key 读取认证不等于已经具备写入路径，实施需补齐同一业务接口的会话与 API 凭据接入。

---

# 13. 性能原则

这个项目最终需要支持大型实验室场景，因此本阶段就应建立正确的性能边界，但不要提前做无证据的复杂优化。

### 已确认的参考负载

首版以单 Lab 100 个 Entity、其中 20 个运行设备各每秒一次语义更新、2 个同时观看的浏览器作为参考负载。1 Hz 指设备语义更新频率，渲染动画仍由客户端按帧推进。

测量记录可见节点数、独立模型数、模型与纹理体量、浏览器及硬件，才能解释同样实体数下的渲染成本。参考负载是验收设计输入，不代表已有性能保证；查询/载荷/积压的确定性预算在相关切片中据实建立，FPS 与延迟按既有策略记录环境与趋势。

重点原则：

### 业务状态与渲染状态分离

```text
World Model
=
Semantic State

Three.js
=
Rendering Runtime
```

---

### 高频 Telemetry 不应该导致整个 React Tree 重渲染

应该允许：

```text
entity-level
feature-level
```

订阅与更新。

---

### 服务端不传渲染帧

例如：

```text
centrifuge RPM = 12000
```

服务端只传：

```text
12000 rpm
```

Rotor 的 60 FPS rotation 应由客户端渲染循环计算。

---

### Asset 要为未来多表示形式留下空间

同一个 Asset 未来可能具有：

```text
preview
runtime GLB
CAD
collision representation
USD
URDF
```

不要默认一个 GLB 就代表整个数字资产。

---

### 性能优化由 measurement 驱动

不要为了“未来可能需要”提前加入大量：

```text
LOD
Instancing
Worker
Streaming
custom renderer
```

先保持正确边界，并继续沿用项目已有的性能检测体系。

---

# 14. 本阶段明确不要求

不要为了追求“大而全”延缓这一版本。

暂时不要求：

```text
真实实验设备接入
完整 MQTT infrastructure
Eclipse Ditto
SiLA implementation
OPC UA / LADS implementation
ROS 2
OpenUSD
Isaac Sim
Robot motion planning
Agent 自主规划、调度与执行系统（调用本版 Lab API 已在范围内）
LabIR
完整 historical telemetry platform
完整 safety runtime
样品管理与物料账本
通用能力 / 状态 schema 编辑器
模拟 Entity 原地切换成真实设备
Lab 角色分级或逐 Lab 授权管理
```

但当前 architecture 不应该阻止这些能力以后作为 Adapter / Runtime 加入。

---

# 15. 最终演示必须是一条完整产品链

这个版本完成以后，希望通过以下流程直接验收。

## Demo 1 — Asset Library

进入 Asset Library。

看到不同类型：

```text
Environment
Infrastructure
IoT
Sensor
Instrument
Robot
Labware
```

Asset 有自己的：

```text
3D representation
metadata
specifications
capabilities
state definitions
interfaces
```

---

## Demo 2 — Build a Lab

创建一个 Lab。

选择或创建 Environment。

从 Asset Library 中加入：

```text
Light
Temperature Sensor
Centrifuge
Robot
Lab Bench
Labware
```

放入 3D Lab。

调整 Placement。

保存。

刷新浏览器后 World 完整恢复。

使用至少一份用户导入并持久保存的 GLB，在另一个浏览器打开同一 Lab 后仍可加载。将器皿登记在工作台上，分别验证普通拖动与显式修改登记位置；布局保存冲突时保留当前草稿。

---

## Demo 3 — Inspect Entity

点击 3D 中的 Centrifuge。

看到：

```text
Centrifuge 01

Asset
Identity
Location
Connection
Capabilities
State
Telemetry
Events
```

---

## Demo 4 — Live Interaction

给虚拟 Centrifuge 设置：

```text
12000 rpm
4 °C
10 min
```

点击 Start。

看到：

```text
IDLE
→ PREPARING（加速与温控）
→ RUNNING
```

RPM 和温度实时变化。

Event timeline 更新。

3D Rotor 对应运行。

转速和温度达标后开始倒计时；正常结束经减速后任务 completed、设备 idle。另一次运行点击 Stop，经减速后任务 cancelled、设备 idle。第二个同类实例保持独立，忙碌时重复 Start 不创建第二个任务。

---

## Demo 5 — Simple World Interaction

点击 Light：

```text
Turn On
```

设备程序执行后报告观测，界面与三维状态变成：

```text
ON
```

3D Lab 中产生对应视觉变化。

---

## Demo 6 — Agent-ready World

通过 World API 可以查询：

```text
当前实验室有哪些设备？

哪些设备支持 centrifuge.run？

哪些 Entity 正在运行？

centrifuge-01 当前状态是什么？

数据多久以前更新？

它使用什么 Binding？
```

再用有效 Agent API 凭据创建或配置一个实体、修改登记位置并发出 Start/Stop。普通用户的浏览器看到同一对象、任务和观测，可以继续操作；反向从浏览器发起动作，Agent 查询到相同结果。普通用户和 Agent 都能使用完整 Lab 操作集合，未实现能力、忙碌和无效参数得到相同业务结果。

这证明 Human UI 与 Agent 共同读取、修改和操作同一个实验室世界。

---

# 16. Definition of Done

本阶段完成的判断标准不是“数据库表和页面完成了”。

而是：

> Labworld 可以把数字资产注册为持久 Lab 中的 Entity，表达位置、包含关系与三维摆放；设备实体通过 Capability、State、Binding 与 Virtual Runtime 形成交互闭环。普通用户和 Agent 均可完整操作同一个世界，3D Scene、Inspector 和 World API 对身份、观测、命令和任务结果保持一致。

做到这一点，就可以认为：

**Labworld 已经从 3D Asset Viewer 进入 Digital Twin Platform 阶段。**

### 必须验证的公开行为

| 行为 | 可观察的验收结果 | 主要验证入口 |
| --- | --- | --- |
| 保存并重开 Lab | 自定义模型资源、定义引用、实体、节点与关系跨浏览器恢复；保存冲突保留草稿 | 真实 HTTP/数据库、页面、真实浏览器 |
| 同模型多实例 | 两个实例的配置、任务、观测和可变外观相互独立 | HTTP、页面、实际三维画面 |
| 三维摆放与登记位置 | 普通拖动只改节点；显式位置操作修改关系并显示人工来源 | 关系 API、可操作页面与浏览器 |
| 普通用户与 Agent 操作 | 普通成员会话与有效 Agent 凭据均能执行相同 Lab 创建、编辑、命令和归档操作 | 真实 HTTP/数据库、浏览器与 API 客户端 |
| 身份与凭据生命周期 | 会话写入遵守 CSRF；无效、过期或撤销凭据不能产生变更；订阅反映身份失效 | HTTP 与公开订阅接口 |
| 命令与持续任务 | 同键重试不重复运行；无效参数和忙碌被拒绝；达标后计时，完成与取消可区分，设备回到 idle | HTTP/公开运行接口与受控时钟、页面 |
| 观测真实性 | 未知、过期、来源、时间和质量可辨；命令成功不伪造测量，迟到/重复/部分报告处理正确 | 公开观测入口、状态 API 与页面 |
| 多客户端同步 | 快照与更新衔接；断线可辨认；重连恢复最新状态，旧来源不覆盖新状态 | 公开订阅接口、双浏览器 |
| 生命周期 | 关闭浏览器继续运行；后端重启保留记录并标中断，显式重新启动形成新运行 | 真实运行与持久化接口、浏览器 |
| 移除与归档 | 删除节点保留设备；运行中拒绝归档/更换程序；有引用资产拒绝直接删除；归档记录可查 | HTTP/数据库与页面 |
| 历史范围 | 24 小时观测、30 天已结束记录及可配置期限生效；分页有界、缺口明确；清理不删除最后观测或未结束任务 | 历史查询与公开清理能力、受控时钟 |
| 参考负载与画面 | 记录 100 实体、20 个 1 Hz 设备和 2 个浏览器的运行结果、模型体量与硬件；真实画布体现设备反馈 | 确定性预算、参考负载报告、真实 GLB/WebGL |

复用[测试策略](../testing/strategy.md)中约定的 HTTP、可操作页面和真实浏览器接口。渐变、时长与竞态采用可控时钟和显式同步点，失败后继续核对可观察结果。传输与存储实现由开发者选择，以上业务合同随对应切片交付。

---

# 17. 工程实现原则

具体以下内容由开发者根据现有代码自行判断：

```text
database schema
JSONB vs relational modelling
module boundaries
API shape
realtime transport
frontend state management
3D scene architecture
runtime architecture
test strategy
migration strategy
```

目标和边界比具体实现方式更重要。

新增搭建、Inspector、运行反馈与失败恢复先按[体验设计流程](../agents/experience-design.md)形成版本化交互预览，复用已接受的 Viewer 视觉方向；然后把本计划的公开行为转为纵向实施票和测试。具体实现自由以这些已确认行为及相关 ADR 为边界。

优先：

1. 领域模型正确；
2. 数据 ownership 清晰；
3. Human / Agent / Runtime 使用同一个 World Model；
4. Virtual / Physical 能共享 abstraction；
5. 高性能边界正确；
6. 不为不存在的问题制造复杂度。

---

# 18. GitHub Issues + Git Worktree 并行开发

本阶段采用：

**GitHub Issues 作为唯一任务和依赖管理入口，Git Worktree 作为并行开发隔离方式。**

不要让多人 / 多 Agent 在同一个 working tree 中并行修改。

建议：

```text
main
 │
 ├── worktree / issue-101-asset-model
 ├── worktree / issue-102-entity-registry
 ├── worktree / issue-103-lab-world
 ├── worktree / issue-104-realtime-runtime
 ├── worktree / issue-105-3d-integration
 └── worktree / issue-106-world-api
```

原则：

> **One Issue → One Branch → One Worktree → One PR。**

每个 Issue 描述：

```text
Goal
Why
Scope
Dependencies
Acceptance
Non-goals
```

不要在 Issue 中写过多 implementation instructions，除非存在明确 architecture constraint。

---

# 19. Issue 拆分原则

按可以独立验收的 capability 切，而不是按“前端 / 后端 / 数据库”机械拆分。

例如一个 Issue 更适合：

```text
Register Asset as Entity
```

而不是：

```text
Create entities table
```

因为前者描述的是产品能力。

可以建立一个总 Epic：

# Digital Twin Foundation V1

下面并行几个 Workstream：

```text
Asset Foundation

Entity & Lab World

3D World Integration

Capability / State Model

Virtual Device Runtime

Realtime World

World API

Centrifuge Vertical Slice

Performance & Validation
```

具体拆分由开发者根据依赖关系调整。

---

# 20. 并行开发时优先先锁定共享 Contract

为了避免多个 Worktree 最后大量冲突，最先应该收敛的是：

```text
Asset
Entity
Entity Relationship
Scene Node
Capability
State
Binding
Device Command
Observation
Device Program Run / Device Task
World Snapshot
Realtime Event
```

这些核心 contract。在第一条完整链路中验证它们：持久资产与设备登记、两个独立照明实例、命令与观测、三维反馈以及普通用户/Agent 的同一操作入口。

Contract 稳定以后：

```text
backend
frontend
3D
virtual device
Agent API
```

按真实依赖并行推进后续纵向切片。接口草稿先帮助对齐，第一条可运行链路再证明其足够；不同 Workstream 的名称不直接对应长期横向大票。

如果某个 Issue 需要改变这些共享 contract，应明确标记依赖，并优先合并 contract change，再让其他 branch rebase。

---

# 21. Integration 原则

不追求一次性巨大 PR。

优先：

```text
small vertical changes
+
continuous integration
```

而不是最后把几个长期 Worktree 一次性合起来。

每个 PR 合并后：

```text
remaining worktrees
→ update / rebase
→ continue
```

避免形成长期分叉。

GitHub Issue 是：

> 工作状态、依赖和验收标准的 source of truth。

代码本身是：

> implementation source of truth。

Spec 是：

> 产品方向和 architecture intent。

三者不要混在一起。

---

# 22. 开发者拥有设计自由

这支团队不需要被详细步骤限制。

如果开发过程中发现：

- draft 中的 abstraction 不合理；
- 当前仓库已有更好的模式；
- 有更简单的实现可以达到同一目标；
- 某个模块应该合并或拆分；
- 某些字段不应该现在建模；
- 某项基础设施完全没有必要；

允许重新设计。

唯一要求是：

> 任何显著改变核心 World Model 或长期 architecture boundary 的决定，需要在 Issue / ADR 中记录理由，让后续开发者能够理解为什么这么设计。

---

# 最终目标

这一阶段结束后，Labworld 应该可以展示这样一件事：

> **“这里不是一个 3D 模型。这里是一个正在运行的数字实验室。”**

资产能够进入世界，成为 Entity；

设备 Entity 有能力、有状态、有实时反馈，静态对象表达位置与关系；

人可以在 3D 世界中直接与它交互；

Agent 可以通过同一个世界模型理解它；

今天通过 Simulator 验证虚拟设备；

明天登记真实的 IoT、离心机、培养箱和机器人，复用相同定义与上层合同，同时保留独立的真实对象身份和记录。

这就是 Digital Twin Foundation V1 要证明的核心。
