# 控制机器人并确认任务结果

从[Newton 环境](newton-motion.md)和[安全观看](secure-motion.md)继续。本章保留同一个 Lab、SO-101 安装和固定 GLB。使用当前 checkout、Node 24 和前章的 Python 环境。操作会写入 Command、Task 和独立 Recording。

目标：提交 Home、六关节目标或夹爪目标。用两个 Lab Viewer 查看同一个任务，并区分请求受理、实际完成和取消结束。本章不提供跨位置 Pick & Place。

## 启动可控制的场景

1. 按 Newton 章节配置并启动 Lab World Server。
2. 登录后打开该 Lab 的**仿真会话**。
3. 选择 `so101-vial@2`。

   新安装使用版本 2。旧 `so101-vial@1` 运行固定演示轨迹。在没有活动会话时，选择**启用机器人控制**。升级保留 Entity、GLB 和布局。它不修改正在运行的快照。

4. 选择 **Start**。
5. 等待**正在运行**和**运动已连接**。
6. 选择 SO-101，在 Inspector 的**操作**中找到**机器人控制**。
7. 打开第二个已登录浏览器，选择同一个 Lab 和机器人。

Start 保持初始姿态，等待动作。六个可视连杆和机器人底座仍属于同一个 Entity。仅有能力定义的普通机器人没有可执行的 Newton 控制。来源必须确认运行绑定后，面板才提供动作。

## 提交动作并观察结果

1. 选择 **Home · 回初始姿态**。
2. 观察**请求已受理 · 等待来源回执**。
3. 在**当前 / 最近机器人任务**中等待**动作已完成**。

Home 使用 `[0,0,0,0,0,0.7] rad`，包括夹爪目标。来源核对实际关节与目标的误差，以及实际关节速度。连续十个 30 Hz 样本必须满足误差不超过 `0.02 rad`、速度绝对值不超过 `0.05 rad/s`。发送目标或收到 HTTP `202` 不满足此判据。

4. 将 `so101/shoulder_pan` 设置为 `0.2 rad`。
5. 选择**应用六关节目标**。
6. 等待来源确认结果。
7. 将**夹爪目标 (rad)**设置为 `0.7`，选择**应用**。

滑块和输入框只编辑目标草稿。它们不改变物理状态或世界布局。六个关节按当次快照的 `profile.joint_order` 排列；范围使用同一 profile 的精确 `joint_limits`。夹爪是第六个转动关节，不使用毫米。接触阻挡可能使任务返回 `failed` / `target_not_reached`。

两个 Viewer 通过同一个世界和任务服务接收状态。来源报告阶段为 `moving`、`settling` 或 `cancelling`。实际关节、速度和来源时间属于 Observation。它们与目标草稿分别显示。浏览器不预测任务成功。

## 用 Node 或 Python 调用正式接口

先从 Inspector **详情**取得 Lab 和机器人 Entity UUID。Agent 需要设置中创建的有效 `lab:full` API key。普通成员使用现有登录 Cookie，并在写请求中带 `x-csrf-token`。两种身份使用同一个动作路径。

从仓库根目录设置环境。将 UUID 占位值替换为实际身份：

```bash
export LAB_API_BASE=http://127.0.0.1:3000
export LAB_ID='<lab-uuid>'
export ROBOT_ID='<robot-entity-uuid>'
read -rs LAB_API_KEY
export LAB_API_KEY
export ROBOT_REQUEST_KEY="$(node -e 'console.log(crypto.randomUUID())')"
ROBOT_ACTION=home node docs/examples/robot-controls.mjs
```

示例先打印请求键、Command 和 Task 身份。它只提交一次动作，再读取该 Task 和独立结果，最长等待 30 秒。成功结果为 `completed`；取消结果为 `cancelled`。失败、未知或仍未结束时，它以非零状态退出，不再次发送动作。

完整 Node 示例：

<<< ../examples/robot-controls.mjs

使用 Python 标准库执行同一个操作：

```bash
export ROBOT_REQUEST_KEY="$(node -e 'console.log(crypto.randomUUID())')"
ROBOT_ACTION=home python3 docs/examples/robot-controls.py
```

完整 Python 示例：

<<< ../examples/robot-controls.py

每次新动作创建新请求键。用 `ROBOT_ACTION=joints` 和 `ROBOT_JOINTS='[0.2,0,0,0,0,0.7]'` 提交关节目标。用 `ROBOT_ACTION=gripper` 和 `ROBOT_GRIPPER=0.7` 提交夹爪目标。

| 动作       | `POST .../entities/{entity_id}/actions` 请求                                   |
| ---------- | ------------------------------------------------------------------------------ |
| Home       | `{"capability":"robot.home","parameters":{}}`                                  |
| 六关节目标 | `{"capability":"robot.move_joints","parameters":{"joints":[0.2,0,0,0,0,0.7]}}` |
| 夹爪目标   | `{"capability":"robot.set_gripper","parameters":{"position":0.7}}`             |
| Cancel     | `{"capability":"robot.cancel","parameters":{}}`                                |

查询 `.../commands/{command_id}` 查看受理与执行记录。查询 `.../tasks/{task_id}` 查看指定任务。查询 `.../results/{result_id}` 查看该 Task 的结果。以上路径都在 `/api/v1/lab/labs/{lab_id}/entities/{entity_id}` 下。

## 检查忙碌拒绝和 Cancel

1. 开始一个关节目标任务。
2. 在它结束前，用另一个新请求键提交 Home。

   API 返回 `409` / `lab.device_busy`。原 Task 保持不变。Inspector 同时禁用新的 Home、关节和夹爪动作，并保留 **Cancel · 取消任务**。

3. 选择 Cancel，或以新请求键运行 `ROBOT_ACTION=cancel` 示例。
4. 观察**已请求取消 · 等待结束**。
5. 等待**取消已结束**。

Cancel 停止当前轨迹并保持测得的关节姿态。取消结束不表示试管已放置。暂停期间可以请求 Cancel；它不会隐式 Resume。需要物理继续静止确认时，显式 Resume，或 Stop 并检查结束结果。

Pause 冻结仿真时间、位姿和任务进度。Resume 继续原任务。Reset 结束旧 Session 和 Recording，从原快照创建新的身份。普通 Start 使用最新已保存布局。

## 恢复未知结果并检查录制

HTTP 受理响应丢失时，保留原请求键和完全相同的参数。Inspector 提供**重试同一命令**。CLI 可以保留 `ROBOT_REQUEST_KEY` 再显式运行同一输入。服务返回原 Command，不创建重复 Task。修改同一键的参数返回 `409` / `idempotency.conflict`；过期键返回 `410` / `lab.command_expired`。

来源失联、服务重启或 Recording 写入故障会中断未完成任务。Cancel 期间断线也可能留下未知结果。已确认完成的结果保留。不要将 `unknown` 或 `interrupted` 解释为完成或取消成功。检查原 Command、Task、结果和录制后，显式 Start 新会话。服务不会自动重放旧动作。

按[录制章节](recording.md)读取当次 Recording。核对命令受理、逐属性观测和 Task 转换；它们在转换时采集。录制中的真实仿真时间与服务审计时间分别保留。直播帧或最后一条数据库状态不能代替完整操作过程。

本章交付 Home、关节目标、夹爪和 Cancel。跨位置 Pick & Place、稳定目标放置、真实跨主机和长测留待后续实现与验收。前章约 9 mm 提起证据只描述固定演示的已验证窗口。

源码：[控制面板](../../packages/views/src/lab/robot-panel.tsx)、[正式动作](../../packages/server/src/lab/devices/use-cases.ts)、[Newton 控制器](../../tools/newton-motion/controller.py)。
