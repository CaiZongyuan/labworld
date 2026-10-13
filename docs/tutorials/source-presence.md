# 生成来源配置并让程序报到

目标：让一个来源在没有 Scene Installation 或 Observation Segment 时上线。来源身份属于选定 Lab。一次 Source Run 和连接代次分别记录，来源在线只表示接入健康。

先完成[快速开始](../getting-started/quickstart.md)。普通 Node/Web 启动不需要 Newton 或 Python。下文的来源客户端需要 Python 3.10+，只使用标准库；不安装包、不读取 GPU。桌面浏览器负责配置，已有程序负责自己的运行。

## 生成一次性配置

1. 登录 `/lab`，创建或选择目标 Lab。
2. 在工具栏打开 **来源**。
3. 填写 **来源名称**，例如 `原 SO-101 世界`。
4. 点击 **创建来源接入配置**。
5. 点击 **复制配置**，保存为自己的私有 JSON 文件，例如 `.scratch/my-source.json`。
6. 关闭对话框。此处显示的凭据会清除，普通来源查询不返回它。

这会登记持久 Lab Source，并生成有效期 30 天的来源凭据。配置含服务地址、Lab、source 和 Machine 身份。保存好完整配置。不要把文件内容放入日志、URL、Git 或公开资源账本。Linux/WSL 可用 `chmod 600 .scratch/my-source.json` 限制文件读取。

同一世界配置下次启动复用此文件，不再创建来源。另一份独立世界使用另一份来源配置。**轮换配置 · 撤销旧凭据**生成新凭据并结束旧接入，保留 source 身份。配置无法再次读取；若丢失，给已登记来源生成新配置。

## 先检查正常接入

从仓库根目录执行：

```bash
python3 -B tools/source-client/presence.py \
  --config .scratch/my-source.json --phase ready --duration 20
```

回到 **来源**。这份来源应显示 **来源已连接**、**适配器已就绪**和最后心跳时间。命令只建立独立接入，不创建场景或设备报告，也不证明求解器正在推进。关闭对话框后，工具栏仍显示已连接来源的数量。

20 秒结束后，客户端释放自己的连接。界面显示 **来源失联**。若进程异常退出，最后心跳超过 5 秒后显示失联；最后心跳时间保持原值。再次执行同一命令，来源身份相同，运行身份及连接代次独立。

## 在原程序的启动回调中加载

支持 `--external_callback` 的 Isaac Lab 启动入口可加载本仓库的轻量回调。先记录原入口命令，再加入以下环境与参数。路径中的 `<repo>` 是本仓库绝对路径，`<private-config>` 是上述 JSON 文件绝对路径。

```bash
PYTHONPATH="<repo>/tools/source-client:$PYTHONPATH" \
LAB_WORLD_SOURCE_CONFIG="<private-config>" \
<原 Python 和启动参数> --external_callback isaaclab_presence.install
```

保留原程序的 GUI 或无头参数。回调不依赖渲染路径；它只启动独立心跳线程。原项目与 Python 环境可保持只读，无需复制代码进原项目。

原命令若已有 `--external_callback`，将原回调名保存为 `LAB_WORLD_SOURCE_CALLBACK`，再把该参数的值改为 `isaaclab_presence.install`。不要追加第二个同名参数，也不要丢弃原回调。例如原 SO-101 评估入口使用 `isaaclab_tutorial.utils.evaluation.install_episode_counter`：

```bash
LAB_WORLD_SOURCE_CALLBACK=isaaclab_tutorial.utils.evaluation.install_episode_counter \
PYTHONPATH="<repo>/tools/source-client:$PYTHONPATH" \
LAB_WORLD_SOURCE_CONFIG="<private-config>" \
<原 Python 和启动参数> --external_callback isaaclab_presence.install
```

来源回调先执行原回调，并原样返回其未消费参数。没有原回调时返回 `None`，让 Isaac Lab 保留全部 Hydra 参数。原命令中的 `presets=newton_mjwarp`、`env.sim.dt=0.0125` 等覆盖值不会因为接入来源被清除。用正常入口的 `--cfg job` 可先检查解析后的配置；此模式不启动求解器或执行实验。

其他 Python 入口可从 [presence.py](../../tools/source-client/presence.py) 使用 `start_presence(config_path)`。保留返回的客户端；初始化完成时调用 `set_phase('ready')`，原程序正常结束时调用 `close()`。网络失败或授权拒绝只更新客户端 `status`，不会停止调用方、模型或求解器。`close()`只释放这个客户端的连接。

本章节交付来源在线链路。场景提取、同步和实时观察需要各自的接入功能。该回调不扫描未接入的 Newton 进程，也不生成运动、测量或实验结果。

## 检查一次拒绝和恢复

在来源已连接时点击 **撤销来源访问**。来源应显示 **访问已撤销**和 **来源失联**。旧配置的下一次请求被拒绝；独立客户端显示 `authorization_failed`。原程序继续自己的运行。

对同一份配置同时运行两份客户端，第二份收到连接冲突。它只能等待原连接释放或失联期限结束，不能覆盖健康来源。需要独立世界时，生成另一份配置。

从已登记来源生成新配置，再启动客户端。source 身份保持不变，旧凭据、连接 UUID 和 epoch不能覆盖新状态。凭据过期时同样需要新配置。重启 Lab World Server 后，旧接入显示失联，仍运行的客户端重新报到。

接口由 [来源路由](../../packages/server/src/lab/sources/routes.ts)提供并生成到 SDK。Member/Agent的登记、配置与撤销使用现有 `lab:full` 和 Cookie/CSRF边界；来源凭据仅能访问获准 Lab 中自己的接入。Source凭据的认证用途与旧 Session Publisher分开。

结束验证时停止自有客户端。保留或自行删除自己的私有配置。不要停止其他来源或原生服务，不使用全局进程清理。
