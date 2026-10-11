# 安装固定场景并管理一次 Simulation Session

目标：显式运行一个固定场景，并在两个桌面 Viewer 中观察同一个 Simulation Session。每个 Viewer 保留各自的相机、选择和 Inspector。

先完成[持久 Lab 与对象](persistent-world.md)和[持久数字资产](persistent-assets.md)。使用仓库指定的 Node、pnpm、Python 3.10+、venv 和 pip，以及 Linux 或 WSL Ubuntu。从仓库根目录执行 Bash 命令。它们创建隔离的开发数据。本章使用开发合成运动，不需要 GPU、Newton 或 Docker。可靠 Lab Recording 仍是后续能力。

## 配置由服务持有的来源

用 Ctrl+C 停止你之前启动的开发实例。创建 Python 环境并启动应用：

```bash
pnpm install --frozen-lockfile
python3 -m venv .scratch/session-python
.scratch/session-python/bin/python -m pip install -r tools/synthetic-motion/requirements.txt
LAB_WORD_SYNTHETIC_SESSION=true LAB_WORD_SYNTHETIC_PYTHON="$PWD/.scratch/session-python/bin/python" LAB_WORD_DATA_DIR=.scratch/session-tutorial-data pnpm dev
```

打开 <http://127.0.0.1:5173/lab>。注册或以普通 Member 登录。创建名为 `Shared Session` 的空 Lab。在资产库导入 `tests/fixtures/lab/cube.glb`，填写来源、许可与版本，再返回 Lab。安装选项来自已保存的资产库，不需要已有 Lab 对象。

普通 Node/Web 启动和构建不需要 Python。这个显式设置启用 loopback 开发来源。服务仅在 Start 后启动 Python。[来源监管器](../../apps/server/src/synthetic-source.ts)持有进程、stdin 管道和清理 ledger。它只发送一次固定启动条件，并保持管道打开。不要手动运行 `publisher.py --startup-stdin`。独立的[合成 fixture 教程](synthetic-motion.md)仍使用自己的显式启动合同。

## 安装并 Start

1. 打开**仿真会话**。
2. 在 **GLB 模型**中选择导入的资产。
   如果它在后续页，点击**加载更多**。列表读取失败时，点击**重试 GLB 模型列表**。
3. 点击**安装固定场景**。
4. 选择生成的**场景安装**，保留 `30 Hz`。
5. 点击 **Start**。
6. 等待**正在运行**和**运动已连接**，再关闭对话框。

固定场景包为 `development-synthetic@1`。安装登记 20 个独立 Entity 与 Scene Node，以及六个 joint key。第二份 Installation 创建不同对象身份。本章不升级场景包，也不为机器人每根 link 创建业务 Entity。

Start 固定保存实际布局、Installation、资产、参数和初始状态。来源第一帧重现这个初始状态。**正在启动**表示服务仍在等待初始帧。服务分配机器身份、唯一 Publisher 租约和 epoch。Viewer 不能选择 epoch 或替换 Publisher。

在第二个浏览器标签页打开同一 Lab。Viewer 自动观察活动会话。打开**仿真会话**并选择 `15 Hz`。转动这个 Viewer 的相机，选择另一个 Entity。两个 Viewer 显示相同的会话 UUID 与来源状态；相机和 Inspector 选择各自独立。**离开观察**只关闭此 Viewer 的订阅。**观察会话**会获取新票据。**关闭**保留观察连接。

## Pause 与 Resume

1. 在任一 Viewer 点击 **Pause**。
2. 等待**已暂停 · 仿真时间和位姿已冻结**。
3. 保持两个 Viewer 打开数秒，并在暂停期间打开第三个标签页。
4. 确认三个 Viewer 显示相同的冻结位姿。
5. 点击 **Resume**，等待**正在运行**。

**正在暂停**与**正在恢复**表示请求已受理，来源动作尚未完成。来源发送一个新的完整边界帧及关联回执。Pause 显示该精确边界，包括 `15 Hz` Viewer；它不会冻结较旧的插值位姿。仿真时钟保持固定，心跳继续。暂停期间晚加入的 Viewer 接收固定映射和完整缓存位姿。

Resume 排除暂停期间的真实时间。它的可信边界建立新的接收时钟片段。同一服务端 epoch 内 sequence 保持递增。Viewer 不跨暂停区间插值，也不以重复 WELCOME 重置缓冲。运动接收新鲜度、连接健康和会话生命周期分别表达。

## 比较 Reset 与下次 Start

1. 暂停会话，记下 UUID。
2. 关闭对话框。选择一个安装对象，打开**编辑布局**。
3. 修改 X Placement 和尺度，保存布局。
4. 返回**运行**视图。当前会话仍使用原来的固定几何和位姿。
5. 打开**仿真会话**，点击 **Reset**。
6. 等待新会话运行。它的 UUID 改变，启动快照仍是原快照。
7. 点击 **Stop**，等待**已停止**。Viewer 返回最新保存的布局。
8. 点击 **Start**。这次普通 Start 使用刚保存的 Placement 和尺度。

布局编辑器预览下次 Start。保存不改变活动仿真。Reset 结束并隔离旧会话，清空 Viewer 缓冲，再获取绑定新会话的票据和映射。它保留已保存的 Placement 与 Registered Location。活动 Installation 不能悄悄改变对象归属或资产绑定；被拒绝的结构编辑保持原状态。其他 Lab 对象与 Device Program Run 保留各自行为。Inspector 读取当前 Entity 事实。

## 检查冲突与拒绝

保持会话运行或暂停，停止其他标签页的控制操作。在已登录 Lab 页面的浏览器 Console 中列出 Lab UUID：

```js
(await (await fetch('/api/v1/lab/labs')).json()).data.map(({ id, name }) => ({
  id,
  name,
}));
```

把下面的完整函数粘贴到 Console。然后以 `Shared Session` 的 UUID 调用 `await checkSessionRefusals('<lab-uuid>')`：

<<< ../examples/session-refusals.js

预期输出为 `{ conflict: 409, denied: 403, unchanged: true, session_id: ... }`。第一个请求使用过期 revision。第二个请求省略 CSRF。两个请求都不改变会话。浏览器与有效的 `lab:full` Agent 使用同一 Lab 权限合同。Core 机器凭据独立，仅能使用专属的会话准入合同。

对话框表达冲突、访问拒绝、来源不可用和离线状态，并保留选择。**重试**读取当前权威状态并重新连接观察；它不重放 Start、Reset 或其他已受理动作。

## 中断与结束

在会话运行期间用 Ctrl+C 停止 `pnpm dev`。使用同一命令和数据目录重新启动。之前的会话显示**会话已中断**。显式 Start 新会话。重启不会恢复旧实验或重放动作。

如果 Python 不可用，Start 报告来源失败或中断会话。检查配置的可执行文件，重新启动服务，再重试。服务使用有限的回执与运动失联期限。回执缺失、心跳丢失或运行来源停滞都会停止会话。主动 Pause 不参加运行来源进度检查。

结束时 Stop 会话、关闭对话框，再停止 `pnpm dev`。监管器释放自己持有的来源进程与 socket。ledger 保留在 `.scratch/session-tutorial-data/runtime/synthetic-sources/`。按需要保留教程数据目录和 Python 环境。不要移除其他 worktree 的进程或数据。

来源：[会话 owner](../../packages/server/src/lab/sessions/service.ts)、[HTTP 路由](../../packages/server/src/lab/sessions/routes.ts)、[SDK 生命周期流](../../packages/sdk/src/simulation-session.ts)、[会话控件](../../packages/views/src/lab/simulation-session-controls.tsx)、[运动缓冲](../../packages/sdk/src/motion-buffer.ts)与 [body 到可视目标校正](../../packages/views/src/lab/motion-scene.ts)。来源参数默认 translation amplitude 为 `0.45`、angular speed 为 `1`、joint amplitude 为 `1`。Start HTTP 为每项接受 `0` 到 `10` 的有限值。这些数学轨迹不计算物理接触。

继续[空间工作台](spatial-workbench.md)。生产 Newton、持久 Recording、远程入口和机器人任务仍是独立工作。
