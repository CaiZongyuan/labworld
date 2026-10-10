# Newton、MuJoCo 与 WSL Ubuntu：后端选择调查

核对日期：2026-10-10。本文是 [物理仿真计划](../plans/newton-backend.md) 的 maintainer 研究笔记，不是公共文档路由、引擎定案或运行通过记录。本轮只读取官方资料、源码和已有场景配置，没有安装环境、启动仿真、执行基准或创建 Docker 资源。

## 结论与证据边界

**Newton 支持 Linux，WSL2 Ubuntu 具备运行它的基础条件。** Newton `v1.6.0rc1` 官方安装文档列出 Linux x86-64/aarch64；NVIDIA 官方支持在 WSL2 中执行 Linux CUDA 应用。但所查 Newton 安装、兼容性与测试平台列表没有明确列出 WSL。这里的判断是组合两方支持范围的推断，不是 Newton 对 WSL 的单独保证，也不是本机运行证据。[Newton 1.6 安装][newton-install]、[兼容性][newton-compat]、[NVIDIA WSL][nvidia-wsl]

**Newton 与 MuJoCo 不是完全互斥、同一层的选项。** Newton 的 `SolverMuJoCo` 可以使用 MuJoCo Warp，也可以设置 `use_mujoco_cpu=True` 使用 MuJoCo-C CPU 后端。真正需要比较的是保留现有 Newton/kitless Isaac Lab 场景、在 Newton 场景层中选择 CPU 求解后端，以及移植到原生 MuJoCo 三条路径。[Newton 求解器源码][newton-solver]

**用户已确认先验证已有 kitless Newton/MJWarp 场景在 WSL2 的单环境控制链，保留 CPU 对照或备用路径。** 当前任务是一个 SO-101、一支试管与试管架的交互，不需要先引入 GPU 批量训练。如果这条复用路径无法在合理工作量内通过，再比较原生 MuJoCo 移植成本。不能仅凭 CPU 环境更轻就忽略现有 USD 场景和接触模型的移植，也不能用 GPU 批量吞吐的结果推断单场景更快。用户已确认验证方法，具体生产引擎待实测定案。

## 来源快照

现有场景的依赖基线由主调查记录为 Newton `1.6.0rc1`、Warp `1.17.0`、MuJoCo `3.12`、kitless Isaac Lab `3.0`。本文对 Newton 使用固定 `v1.6.0rc1` tag，对 Warp 使用固定 `v1.17.0` tag，对 MJWarp 依赖使用固定 `v3.12.0` tag。Newton 的最低版本声明不等于安装锁定：它声明 `warp-lang>=1.17.0`，MuJoCo 求解器 extra 声明 `mujoco-warp~=3.12.0` 和 `mujoco~=3.12.0`。[Newton manifest][newton-package]、[Warp 1.17 安装][warp-install]、[MJWarp 3.12 manifest][mjwarp-package]

为辨别旧基线与新文档差异，也读取了当日主分支。来源快照为：Newton `a6e1649b112e3d962b35f7dad66780dc55150588`（2026-10-09），MuJoCo `02e3cab23eadcc1284eef74e833e13a96ef39ccb`（2026-10-10），MuJoCo Warp `9a5455f593a27256d5c804ede3f603957a19604e`（2026-10-09）。这些是源码状态，不代表本项目安装了这些版本。[Newton 当日安装文档][newton-current-install]、[MuJoCo 当日文档][mujoco-python]、[MJWarp 当日 README][mjwarp-readme]

## Newton 在 WSL2 的运行条件

| 层 | 官方资料确认的事实 | 本项目仍须确认 |
| --- | --- | --- |
| Newton 1.6 | Python 3.10+；Linux x86-64/aarch64、Windows x86-64，macOS CPU；CUDA 12 基线要求 NVIDIA driver 545+，550+ 为推荐；不要求本地 CUDA Toolkit。[安装][newton-install] | Linux 依赖实际解析、场景导入、求解器创建和接触任务成功。 |
| Newton 1.6 测试平台 | Ubuntu 22.04/24.04、Windows、macOS CPU；测试 GPU 列表为 Ada、Blackwell。[兼容性][newton-compat] | 所查矩阵未列 WSL 和本机 Ampere；最低需求符合与该组合被测试是两件事。 |
| Warp 1.17 | Linux 与 Windows wheel 支持 CPU/CUDA；PyPI 标准 wheel 使用 CUDA 12.9。CUDA 12 构建的 Warp 基线要求 driver 525+，Newton 可以加上更严格要求。[Warp][warp-install] | 必须检查实际 wheel、CUDA device、JIT 编译与求解执行；`nvidia-smi` 不能代替这些证据。 |
| WSL2 CUDA | NVIDIA 支持 WSL2 上的 Linux CUDA 应用；CUDA 驱动由 Windows 驱动提供，不应在 WSL 内另装 Linux 显卡驱动。WSL 的 `nvidia-smi` 功能有限。[NVIDIA][nvidia-wsl] | 本机 WSL/内核、驱动库路径、设备内存与 CUDA 操作实际可用性。 |
| 当前新依赖 | Newton 主分支文档已进入 1.7：新安装会解析到 Warp 1.18，标准 wheel 使用 CUDA 13.4、要求 R580+ 和 Turing+；文档提供锁定 Warp 1.17 保留 CUDA 12 的路径。[当日安装文档][newton-current-install] | 不应把旧场景直接升级到浮动最新依赖；应分别记录复用基线与候选升级版本。 |

主调查提供的环境是 WSL2 Ubuntu x86-64、Python `3.12.3`、RTX 3070 Ti Laptop 8 GB、Windows driver `610.62`。这些信息与旧基线的 Python、GPU 架构和驱动门槛相容，但不能证明 Newton、Warp、MJWarp、Isaac Lab 或 USD 导入已成功。8 GB 显存是否足够也只能对实际场景、缓冲区和渲染配置测量。

Newton 求解与 Python viewer 是不同路径。优先无本地 GUI、把位姿交给 Lab Viewer 的运行方式，可先隔离 WSL OpenGL/窗口系统的影响。Newton 示例支持 `--viewer null`，也支持 `--viewer usd` 和 `--device` 参数；此事实不证明现有 Isaac Lab 入口接受同样的 CLI。[Newton 1.6 README][newton-readme]

## 引擎、加速实现与框架的关系

| 名称 | 实际层次 | 对当前任务的含义 |
| --- | --- | --- |
| MuJoCo-C 与 `mujoco` Python 包 | 原生动力学库与 Python 接口；官方支持 Linux/Windows/macOS，Python 包携带库。[编程文档][mujoco-programming]、[Python 文档][mujoco-python] | CPU 单场景控制可避免 GPU 求解依赖；原生接口直接读取模型、状态和接触，但现有 USD/Isaac Lab 场景仍需要适配。 |
| MuJoCo XLA / MJX | JAX API。当前文档区分 MJX-JAX 与 MJX-Warp，后者依赖 MuJoCo Warp；不同版本的名称和可用选项需要对应版本核查。[MJX 文档][mujoco-mjx] | 本次没有训练或 JAX 工作流，不需要因选择 MuJoCo 就同时引入 MJX。 |
| MuJoCo Warp / MJWarp | 针对 NVIDIA 的 GPU 加速 MuJoCo 实现；当前 README 表明支持 CPU 开发调试，快速仿真使用 NVIDIA GPU。[MJWarp README][mjwarp-readme] | 面向批量 GPU 计算有直接相关性，但本次单场景的延迟和资源需求尚未测量。 |
| Newton `SolverMuJoCo` | Newton 场景/状态与 MuJoCo-C 或 MJWarp 之间的求解适配，`use_mujoco_cpu=False` 为默认。[源码][newton-solver] | 可以先保留 Newton 模型层再选择 CPU/GPU；这与完全移除 Newton 是不同决策。 |
| kitless Isaac Lab + Newton | 场景组织、机器人动作/观测和任务框架，再由 Newton/MJWarp 计算物理。MJWarp 官方也说明该集成关系。[MJWarp README][mjwarp-readme] | 现有场景已经沿这条路径实现；依赖较多，但资产、初始状态与接触判据可复用。 |

**没有性能结论。** 官方项目描述的 high throughput 和多环境示例不能证明本项目单机械臂实时控制更快。单环境应看命令到状态的延迟、每步用时分布、实时倍率、启动/JIT 成本和资源占用；GPU 批量训练应另看同等工作量、输出正确性和吞吐。首版不新增训练任务。

## MuJoCo 在 WSL Ubuntu：求解与渲染分开验证

原生 MuJoCo 的无画面求解不需要 OpenGL。官方明确库本身没有显式 OpenGL 依赖，只要不调用 `mjr_` 渲染函数就可用于没有 OpenGL 的系统。因而 WSL 中只计算动力学、读状态/接触、传给 Three.js 的候选路径，不必先解决 Python GUI。[可视化文档][mujoco-visualization]

如果需要 MuJoCo 自带画面，应另外验证：Linux 的窗口路径使用 GLX/X11；无窗口软件渲染可使用 OSMesa，硬件离屏渲染可使用 EGL。CUDA 能用不代表 EGL 或 viewer 能用。Microsoft 的 WSL GUI 文档给出 WSLg/Windows 与驱动要求，但这也不是本机 MuJoCo GUI 的通过记录。[MuJoCo 可视化][mujoco-visualization]、[Microsoft GUI][wsl-gui]

原生 MuJoCo 的 Linux 支持和无画面接口提供了 WSL CPU 路径的基础条件；所查 MuJoCo 页面也没有单独给出本项目 WSL 组合的保证。本轮没有在本机执行 `import mujoco`、加载场景或渲染。

## 现有场景的复用与移植边界

只读检查 `/mnt/d/Projects/Robots/IsaacLabTutorial` 的 `README.md`、`pyproject.toml`、`src/isaaclab_tutorial/assets/__init__.py` 与 `tasks/place_vial/config/so101/env_cfg.py`：机器人和器皿通过 USD spawn，场景引用 `vial.usda`、`rack.usda` 和 `mat.usda`；配置使用 `NewtonManager` callback、`NewtonCfg`、`NewtonCollisionPipelineCfg` 与 `MJWarpSolverCfg`。README 还记录 USD 导入线程 workaround。因此这份场景不是一份已经可由原生 MuJoCo 直接加载的 MJCF。

复用 kitless Newton/MJWarp 应核查 Windows `.venv` 中的源版本和锁定依赖，并在 WSL 建立独立 Linux 环境；Windows 安装存在不等于 Linux 环境已配置。所有资产、模型引用和许可仍需核查，不能从本机路径推断可发布。

Newton 1.6 求解器确实提供 `use_mujoco_cpu=True`，但本轮没有核查 Isaac Lab `MJWarpSolverCfg` 是否直接暴露该参数，也没有验证当前场景仅更换此开关就能运行。CPU 路径与 GPU/碰撞路径对部分接触参数的处理可能不同：官方说明 force-space 接触刚度处理在特定 Newton-contacts GPU 路径生效，CPU 后端不采用相同的逐接触双刚体因子。首版必须重新验收抓取与放置结果。[求解器源码][newton-solver]、[接触映射文档][newton-solver-doc]

`SolverMuJoCo(..., save_to_mjcf="model.xml")` 可以保存从 Newton 生成的 MuJoCo 模型，官方定位为调试入口。它可帮助评估移植，不是“导出文件等于完成原生 MuJoCo 移植”的保证：控制器、物体身份、reset、接触观测与任务终止逻辑仍在框架里；求解器默认 `skip_visual_only_geoms=True`，导出的物理模型也不能自动充当完整高质量外观场景。[源码][newton-solver]

Newton 的 MJCF importer 是另一方向（MJCF → Newton），存在不支持的 geom、显式质量和某些约束转换提示；不能据支持 MJCF 一句就承诺两端模型和求解完全等价。[MJCF importer][newton-mjcf]

## 最小可判定比较实验（尚未执行）

先确定一个可加载的单环境资产和固定初始条件，再对候选路径使用一致的机器人关节、夹爪、试管质量/惯量、碰撞形状、摩擦、接触参数、目标初始布局、时间步与控制频率。各引擎的参数语义不能直接按名字假定相同；如果无法构造一致工作量，应报告不一致，不能给出公平快慢排序。

1. **运行条件**：固定 Python、框架、Newton/MuJoCo/MJWarp/Warp、driver、设备和环境数；记录无画面模式。先完成导入、初始化、真实求解与停止清理；GPU 候选必须有实际 GPU kernel/step 证据。
2. **共同接口**：以同一业务合同执行 Home、关节目标、夹爪开合、预定义 Pick & Place 和取消；观测包含仿真时间、关节实测值、各刚体位姿、接触来源、任务阶段与结果。
3. **真实接触通过标准**：夹爪靠接触提起试管、搬运过程中未掉落、释放后进入目标孔位并稳定；判据取自已验证场景并明确阈值与稳定时窗。不得用焊接/强制附着代替抓取。未夹住、掉落和未放稳必须分别产出失败结果。
4. **稳定与交互**：同样初始条件重复任务，检查失败率、非有限数、异常穿透、不可控振荡，以及忙碌时冲突拒绝和显式取消。重复数量与通过阈值在执行前确定。
5. **测量范围**：分别记录首次启动/JIT 与预热后的单步/命令延迟分布、实时倍率、CPU/RSS、GPU 显存与采样方式。状态输出量和采样频率一致；不把渲染耗时混进无画面求解指标。
6. **录制独立性**：保存完整时间、对象映射、位姿、命令、接触和结果，再停止 Python/服务，通过浏览器独立回放核对历史；中断时保留缺口标记。引擎比较不应要求回放重新求解物理。

本实验的结果可以是选择复用 Newton/MJWarp、保留 Newton 模型但采用 CPU 求解，或承担原生 MuJoCo 移植。它不要求实现三个生产后端；可替换边界与“首版只实现一个后端”的已确认范围保留。

## 外部渲染与引擎选择的关联

用户选择的是导出已录制结果后在 Blender/UE5 导入渲染。原生 MuJoCo 官方已经提供 USD exporter，可存储场景与运动轨迹并用于 Blender 等外部渲染；Newton 示例也支持 USD 输出。因此“能导出外部渲染”本身不足以决定选择哪一个求解引擎。[MuJoCo USD exporter][mujoco-python]、[Newton 示例][newton-readme]

这只确认上游存在相关导出接口，没有证明当前场景资产、时间采样、材质或 UE5 导入已通过。业务录制应保留独立身份与时间语义，外部渲染是对相同历史结果的转换。USD 在 Blender/UE5 的版本、单位、轴向、材质与动画限制由另一个渲染调查核查；本文件不承诺现成无损的双目标导出。

[newton-install]: https://github.com/newton-physics/newton/blob/v1.6.0rc1/docs/guide/installation.rst
[newton-compat]: https://github.com/newton-physics/newton/blob/v1.6.0rc1/docs/guide/compatibility.rst
[newton-package]: https://github.com/newton-physics/newton/blob/v1.6.0rc1/pyproject.toml
[newton-readme]: https://github.com/newton-physics/newton/blob/v1.6.0rc1/README.md
[newton-solver]: https://github.com/newton-physics/newton/blob/v1.6.0rc1/newton/_src/solvers/mujoco/solver_mujoco.py
[newton-solver-doc]: https://github.com/newton-physics/newton/blob/v1.6.0rc1/docs/solvers/mujoco.rst
[newton-mjcf]: https://github.com/newton-physics/newton/blob/v1.6.0rc1/newton/_src/utils/import_mjcf.py
[newton-current-install]: https://github.com/newton-physics/newton/blob/a6e1649b112e3d962b35f7dad66780dc55150588/docs/guide/installation.rst
[warp-install]: https://github.com/NVIDIA/warp/blob/v1.17.0/docs/user_guide/installation.rst
[mjwarp-package]: https://github.com/google-deepmind/mujoco_warp/blob/v3.12.0/pyproject.toml
[mjwarp-readme]: https://github.com/google-deepmind/mujoco_warp/blob/9a5455f593a27256d5c804ede3f603957a19604e/README.md
[mujoco-programming]: https://github.com/google-deepmind/mujoco/blob/02e3cab23eadcc1284eef74e833e13a96ef39ccb/doc/programming/index.rst
[mujoco-python]: https://github.com/google-deepmind/mujoco/blob/02e3cab23eadcc1284eef74e833e13a96ef39ccb/doc/python.rst
[mujoco-mjx]: https://github.com/google-deepmind/mujoco/blob/02e3cab23eadcc1284eef74e833e13a96ef39ccb/doc/mjx.rst
[mujoco-visualization]: https://github.com/google-deepmind/mujoco/blob/02e3cab23eadcc1284eef74e833e13a96ef39ccb/doc/programming/visualization.rst
[nvidia-wsl]: https://docs.nvidia.com/cuda/wsl-user-guide/index.html
[wsl-gui]: https://learn.microsoft.com/en-us/windows/wsl/tutorials/gui-apps
