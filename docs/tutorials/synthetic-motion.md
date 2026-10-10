# 从 Synthetic Publisher 到两个 Lab Viewer

目标：让一个 Python Synthetic Publisher 驱动两个浏览器中的真实 GLB 对象。两个 Viewer 共用运动数据，分别操作相机和 Inspector。

先完成[持久 Lab 与对象](persistent-world.md)与[持久数字资产](persistent-assets.md)。需要仓库指定的 Node、pnpm、Python 3.10+ 和桌面浏览器。从仓库根目录执行命令。此教程使用本机 loopback fixture，不需要 GPU、Newton 或 Docker。

## 启动独立测试数据

停止先前的开发服务，再启动测试实例：

```bash
pnpm install --frozen-lockfile
LAB_WORD_MOTION_FIXTURE=true LAB_WORD_DATA_DIR=.scratch/motion-tutorial-data pnpm dev
```

打开 <http://127.0.0.1:5173/lab>。注册一个测试用户，创建名为 `Synthetic motion` 的 Lab。在资产库导入仓库内的 `tests/fixtures/lab/cube.glb`，填写名称、来源、许可和版本。将这个资产用于该 Lab 的一个对象，保证它出现在当前 Lab 的资产列表中。

1. 打开 **合成运动**。
2. 选择已导入的 GLB，保留 `30 Hz`。
3. 点击 **准备并加入测试会话**。
4. 关闭对话框，观察场景中新增的 20 个模型对象。

状态先显示等待 Publisher。准备操作只在首次创建时登记 20 个 Entity 和 Scene Node。它保存初始 Placement。每帧运动不会修改这些记录或 Registered Location。

在同一登录用户的第二个浏览器标签页打开相同 Lab。点击 **合成运动 → 加入已有会话**。第二个 Viewer 可以选择 `15 Hz`。关闭对话框不会停止运动连接。

## 启动 Python Publisher

在 **API 密钥** 页面创建具有 `lab:full` 的密钥。密钥必须属于创建 fixture 的用户。其他成员可以观看，但不能签发该 fixture 的 Publisher ticket。

创建独立 Python 环境：

```bash
python3 -m venv .scratch/motion-python
.scratch/motion-python/bin/python -m pip install -r tools/synthetic-motion/requirements.txt
```

在 Bash 的隐藏输入处输入密钥：

```bash
read -rsp 'Lab API key: ' MOTION_API_KEY
export MOTION_API_KEY
```

查询 Lab 身份。此命令只打印 Lab 名称与 UUID：

```bash
.scratch/motion-python/bin/python - <<'PY'
import json, os, urllib.request
request = urllib.request.Request('http://127.0.0.1:3000/api/v1/lab/labs',
    headers={'Authorization': 'Bearer ' + os.environ['MOTION_API_KEY']})
with urllib.request.urlopen(request, timeout=10) as response:
    for lab in json.load(response)['data']:
        print(lab['name'], lab['id'])
PY
```

将 `<lab-uuid>` 替换为测试 Lab 的 UUID，然后运行：

```bash
.scratch/motion-python/bin/python docs/examples/motion-launch.py --lab-id <lab-uuid> --duration 600
unset MOTION_API_KEY
```

[启动示例](../examples/motion-launch.py)读取 fixture 元数据，通过已认证 HTTP 申请一次性 Publisher ticket，再从 stdin 将 ticket 交给[Publisher](../../tools/synthetic-motion/publisher.py)。ticket 不出现在命令参数中。Publisher 与 Viewer 使用同一个 Node 监听端口。

两个浏览器应同时看到 20 个 GLB 对象沿平滑轨迹运动。分别旋转相机、选择对象并打开 Inspector。一个标签页的选择和相机不改变另一个标签页。运行过程中退出第二个 Viewer，再点击 **加入已有会话**。它应直接取得当前完整 Snapshot。

## 核对轨迹与边界

Synthetic Publisher 每秒采样 30 次。它发送 20 个 body pose 和 6 个 joint 值。每个完整二进制 Snapshot 是 632 字节。Viewer 使用接收单调时钟与固定仿真速率 `1`，在有界缓冲内插值。显示帧率与网络消息率是两个计量对象。

令 `t = sim_time_ns / 1e9`、`phase = i × 0.2`，body 索引 `i` 从 0 到 19：

```text
x = (i % 5 - 2) × 1.6 + 0.45 × sin(t + phase)
y = 0.65 + 0.15 × sin(2 × t + phase)
z = (floor(i / 5) - 1.5) × 1.4 + 0.35 × cos(t + phase)
yaw = 0.4 × t + i × 0.1
joint[j] = 0.5 × sin(t + j × 0.2), j = 0..5
```

wire 使用右手系、Y-up、米和 XYZW 四元数。pose 作用于 Scene Node 的世界根位姿。GLB 的居中、贴底 child offset 与固定比例 `0.35` 保留。[协议源码](../../packages/contracts/src/motion/index.ts)、[Python codec](../../tools/synthetic-motion/motion_codec.py)与[合成轨迹](../../tools/synthetic-motion/synthetic.py)定义可消费的公开合同。

Gateway 在内存保留当前帧。每 Viewer 只有一个 pending latest slot。它约束实际 WS `bufferedAmount`：64 KiB 软预算、256 KiB 硬预算；持续阻塞 2 秒的 Viewer 会断开。软预算触发时，该 Viewer 降至 15 Hz。快 Viewer 不等待慢 Viewer。

fixture 仅在 `LAB_WORD_MOTION_FIXTURE=true` 且服务监听 loopback 时开放。HTTP 与 WS 都检查真实连接来源，并拒绝带代理转发头的请求。Viewer 使用 30 秒有效的一次性 ticket；WS 准入前没有场景映射。Publisher 身份由独立 ticket 与固定路由确定。

HTTP DTO 来自 [Node 路由](../../packages/server/src/lab/motion/routes.ts)的 OpenAPI 生成。高频 pose 不写数据库、`world_clock` 或 SSE。现有 HTTP 与业务 SSE 保留各自职责。fixture 的绑定随服务停止而结束；已登记对象、资产和初始布局继续保存在测试目录。

## 一次失败与恢复

1. 在 Publisher 终端按 Ctrl+C。
2. 观察两个 Viewer 显示中断或陈旧，并冻结最后可信 pose。
3. 再次运行隐藏密钥输入和启动命令，取得新的 Publisher ticket 与服务端 epoch。
4. 观察两个 Viewer 收到新映射握手，再恢复当前 Snapshot。

Viewer 错误后可点击 **离开运动**，再点击 **加入已有会话**。重用旧 ticket、旧 epoch、重复 sequence 或错误映射应明确失败。Viewer 不会跨 epoch、时间倒退或长缺口插值。

结束时点击两个 Viewer 的 **离开运动**，停止 Publisher，再停止 `pnpm dev`。开发 supervisor 会停止所属 Node/Web 进程。测试目录包含本教程的持久资产与对象；需要保留时不要删除它。

Synthetic 只产生确定性数学轨迹。它不计算物理接触，也不创建生产 Simulation Session 或 Lab Recording。Newton、远程部署和可靠录制属于后续实施范围。

协议的 TS/Python golden 检查需要系统 Python 3；可用 `PYTHON` 指定可执行文件。正常 Node/Web 启动和构建不需要 Python。
