# 固定 Newton 环境并观察 SO-101

从[录制章节](recording.md)继续。本章使用一台 SO-101、试管、四孔架和垫面。Newton/MJWarp 在 Linux 或 WSL GPU 上求解。两个 Lab Viewer 读取同一会话。普通 Node/Web 启动不需要这些 Python 依赖。

## 固定输入和环境

使用 CPython 3.12.3、Newton 1.6.0rc1、Warp 1.17.0、MuJoCo/MJWarp 3.12.0 和 websockets 15.0.1。实际版本仍由探测报告和 Recording 来源头记录。当前适配直接使用 Newton API，不启动 Isaac Sim Kit。Isaac Lab 若存在，来源头记录其版本；未安装则记录 `null`。

已有环境可以只读使用。不要在已有用户项目或其虚拟环境中安装、修改或输出文件。需要安装时，在本仓库自己的临时目录创建环境。以下命令从仓库根目录执行：

```bash
uv venv --python 3.12.3 .scratch/newton-env
uv pip install --python .scratch/newton-env/bin/python -r tools/newton-motion/requirements.txt
PYTHONDONTWRITEBYTECODE=1 .scratch/newton-env/bin/python -B tools/newton-motion/prepare.py --output .scratch/newton-scene
```

`prepare.py` 核对仓库内十个固定 GLB，通过生产加载器恢复 base GLB 内的精确物理归档。归档保留 13 个原厂 STL、六个 follower 和五个 moving 派生碰撞文件、许可及来源清单。此步骤不访问网络或生成新碰撞体。输出必须是新的目录；保留失败目录用于检查。

素材来自 [TheRobotStudio/SO-ARM100](https://github.com/TheRobotStudio/SO-ARM100/tree/a758567c3978dfeefe282ede0500085a48fe8f78/Simulation/SO101)。采用仓库发布的 Apache-2.0 描述与网格。试管、架和垫面由 Lab Word 编写。来源、许可、导出器与电机参数署名见 [NOTICE](../../tools/newton-motion/scene/NOTICE.md) 和 [LICENSE](../../tools/newton-motion/scene/LICENSE)。本章不使用许可尚未确认的 NVIDIA 转换资源，也不声称两种模型具有相同动力学。

## 先验证实际 GPU

```bash
PYTHONDONTWRITEBYTECODE=1 .scratch/newton-env/bin/python -B tools/newton-motion/probe.py \
  --base-glb .scratch/newton-scene/base.glb --cache .scratch/newton-probe-cache \
  --steps 120 --output .scratch/newton-probe.json
```

探测必须实际初始化 `cuda:0`，加载固定场景并执行 120 个物理 step。报告记录依赖、设备、准备时间、求解、控制和批量读取窗口。它不证明 Viewer、Recording 或抓取成功。首次物理失败应先检查碰撞、初态和驱动参数；不要修改接触成功条件。

基础 GLB 保留一个固定物理 ZIP。加载器先核对整个 GLB 和归档的可信校验值，再按固定成员名单解压。仅有匹配的 extras 声明不够。丢失、变换或损坏的归档会在导入求解器之前失败。

## 安装并启动

按[快速开始](../getting-started/quickstart.md)建立 Node 数据目录和登录。启动服务前配置固定来源：

```bash
LAB_WORD_NEWTON_SESSION=true \
LAB_WORD_NEWTON_PYTHON="$PWD/.scratch/newton-env/bin/python" \
LAB_WORD_NEWTON_SCENE_DIRECTORY="$PWD/.scratch/newton-scene" \
pnpm dev
```

服务使用自己数据目录下的临时缓存、进程账本和共享编译缓存。一次只管理一个本地 GPU 来源。准备阶段尚未分配 Publisher lease。准备完成后才取得 lease、epoch 和 Recording 凭据。生产心跳与可靠采集时限保持原值。准备阶段可以 Stop；父进程退出或 stdin 关闭会结束其来源。

创建一个 Lab。将十个生成的 GLB 导入资产库，然后在会话面板选择 **安装 SO-101 Newton 场景**。也可以用拥有 `lab:full` 的 Agent key 执行完整安装：

```bash
node tools/newton-motion/install_scene.mjs --server http://127.0.0.1:3000 \
  --lab <lab-uuid> --directory .scratch/newton-scene --output .scratch/newton-install.json
```

通过环境变量 `LAB_WORD_API_KEY` 提供 key，勿写入命令或安装账本。脚本创建持久 Asset 和 Scene Installation。失败后保留已完成的资产与账本，检查结果后继续操作。脚本不会删除其他资产。

在会话面板选择 `so101-vial@1`，点击 Start。打开第二个已登录浏览器并观察同一 Lab。两端应看到相同 SO-101 连杆和试管位姿，各自保留相机与选择。画面来自实际 Newton 状态。固定轨迹只产生关节控制目标；机器人正式 Command/Task 控制由后续章节交付。

## 对照三个物理时刻

对照静止、实际夹起、释放后这三个时刻。使用独立的源状态与 Viewer 世界变换样本。必要时在启动 Node 前设置 `LAB_WORD_NEWTON_EVIDENCE_DIRECTORY` 为自己的验证目录。来源最多保留前 900 个原始采样见证，记录实际接触和状态。这个显式测量模式增加接触与速度读取，其开销单独记录。阶段名称只表达轨迹目标，不代表成功。

当前程序保留试管盖局部中心 `z=0.094 m` 和原初态。夹爪从盖高度沿长轴水平进入；闭合目标为 `0.4 rad`，抬升时继续到 `0.3 rad`，保持和放低时到 `0.2 rad`。内部抬升目标为 `0.012 m`。实际 GPU 证据达到约 9.00 mm 抬升，并通过连续 10 个控制样本的双侧 ≥6 mm 保持检查。释放后，从 step 3448 到 3560 的连续 15 个样本满足就位条件。最后的 step 4320 未满足这些条件；实测只验证该窗口，不表示永久就位。轨迹还记录了 step 968 的短暂肩部与下臂接触，因此不证明全路径无碰撞。Viewer 与 Recording 的应用验收单独进行。

源坐标为右手 Z-up、米和 XYZW。wire 使用右手 Y-up、米和 XYZW。转换把源 `(x,y,z)` 映射到 `(x,z,-y)`。GLB 的居中和贴底仍位于模型子节点；固定 `body_to_visual` 校正只组合一次。机器人有一个 Entity，各连杆拥有独立可视目标；试管、架和垫面保留各自身份。

物理 step 为 240 Hz，控制与可靠源采样为 30 Hz。每次读取按固定 body/joint key 批量执行。读取、编码和 writer 独立。以同一初态分别 Start 两次，在 HTTP 请求中选择 `live_rate_hz: 15` 或 `30`，对照相同物理 step 的结果。15 Hz 只选择较少的直播帧；可靠源采样与 GPU readback 仍是 30 Hz。暂停、恢复和停止边界始终发送，并先取得可靠采集的精确 durable ACK。

Pause 冻结物理与仿真时间。Resume 继续原状态。Reset 使用原始快照，创建新 Session 和 Recording。再次普通 Start 使用最新保存布局。固定 profile 要求单位可视缩放。布局不符合此约束时会明确拒绝。

## 检查 Recording 和一次失败

按[录制检查](recording.md)确认停止后的完整性、源序列和事件。来源头必须为 `newton`，并记录实际软件、GPU、驱动、profile 和直播档位。归档和全部 GLB 由正式 Recording 文件引用保留。

对保留的依赖读取使用：

```text
GET /api/v1/lab/labs/{lab_id}/recordings/{recording_id}/resources/{file_id}
```

`file_id` 来自当次 manifest 的 `snapshot.world.assets[*].representation`。响应是已经核对的原始文件字节。当前 Asset 或本地场景缓存缺失时，Recording 仍可提供自己的依赖。跨 Recording 的文件、已删除 Recording 或未知文件返回受控 404。读取期间持有已经打开的内容流；取消会释放它。

用一个同名但不同校验值的 GLB 替换安装请求中的映射。安装必须返回 `lab.newton_representation_mismatch`。另一个 Publisher 若在 HELLO 中提交错误 `scene_hash`，不得注入运动。恢复时使用原始固定文件并显式 Start 新会话；来源不会自动重连或重放旧实验。

停止后确认进程账本为 `cleaned`，临时解压目录已移除。共享 Warp 编译缓存和显式验证见证可保留，记录其 owner 和用途。真实公网与跨主机验收仍需后续部署环境；本地回环结果不代表它们已经通过。

实现入口：[固定场景生成](../../tools/newton-motion/prepare.py)、[可信加载器](../../tools/newton-motion/scene_loader.py)、[Newton 采样](../../tools/newton-motion/physics.py)、[独立 writer](../../tools/newton-motion/publisher.py)。
