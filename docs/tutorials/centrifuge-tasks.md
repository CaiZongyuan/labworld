# 执行离心任务并在重启后恢复

当前服务使用 Node 24 与 TypeScript，默认验证 desktop web。命令在仓库根目录运行；Linux/Windows 不需要 Docker。实现入口见[Node 设备](../guides/server-devices.md)、[同步](../guides/server-sync.md)和[追溯](../guides/server-traceability.md)。

目标：完成一次离心并取消另一次。查询各自的身份。在关闭浏览器或重启后端后保留结果。

## 起始版本

使用包含本章 Node 实现的当前 checkout。先完成[连续温度](continuous-temperature.md)，取得后端 Run 和属性观测。[旧 Foundation 旅程](complete-foundation.md)仅作为历史版本与负载参考；完整 Node 客户端旅程将在后续客户端迁移中验证。

在仓库根目录运行命令。这些操作写入持久开发数据。普通成员需要有效会话。Agent 需要有效的 `lab:full` API key。

源码：[任务 HTTP 合同](../../packages/server/src/lab/devices/routes.ts)、[后端程序](../../packages/server/src/lab/devices/domain.ts)、[迁移](../../packages/server/migrations/0000_baseline.sql)和[任务面板](../../packages/views/src/lab/centrifuge-panel.tsx)。

## 完成一次任务

1. 安装依赖。

   ```bash
   pnpm install --frozen-lockfile
   ```

2. 启动开发环境。

   ```bash
   pnpm dev
   ```

3. 打开 <http://127.0.0.1:5173/lab>。
4. 创建或打开一个 Lab。
5. 选择**登记对象**。
6. 选择 `centrifuge@1.0`。
7. 在名称栏输入 `Centrifuge A`。
8. 选择**登记**。
9. 选择**启动程序**。

   API 创建 Device Program Run（设备程序运行）。首条观测显示空闲。启动程序不会开始离心任务。

10. 将**目标转速 (rpm)**设置为 `6000`。
11. 将**目标温度 (degC)**设置为 `22`。
12. 将**任务时长 (s)**设置为 `6`。
13. 选择**开始离心**。

    API 接受 Command（命令）并保留 DeviceTask（设备任务）。任务参数固定。**操作**显示各动作的 Command 反馈和当前 / 最近任务。打开 **详情**查看 Command、Run、Task 和结果身份，再返回 **操作**。

14. 等待**已完成**。

    准备阶段使转速和温度达到容差。任务随后计时六秒。设备再减速。转速归零后结果变为 completed。设备回到 idle，程序继续运行。

目标值是任务输入。在途任务显示后端固定参数，不能修改。有效计时进度来自 Task 的 `elapsed_seconds`，不使用浏览器计时器。结束结果独立显示，idle 或新 Run 不覆盖它。两台 Entity 各自保留目标和反馈。观测值是设备报告的测量值。后端按 `1 Hz` 采样。转速容差为 `50 rpm`。温度容差为 `0.5 degC`。加速和减速速率为 `3000 rpm/s`。温度每秒最多改变 `2 degC`。这些是演示程序规则，不是实机精度保证。

允许转速为 `500` 至 `15000 rpm`。温度为 `-10` 至 `40 degC`。时长为 `6` 至 `3600 s`。Run 固定 `initial_temperature` 配置，默认值为 `22 degC`。后续配置修改不会改变该 Run 或在途任务。

## 取消另一台的任务

1. 使用同一定义登记 `Centrifuge B`。
2. 选择**启动程序**。
3. 将**任务时长 (s)**设置为 `60`。
4. 选择**开始离心**。
5. 在任务执行期间选择**停止离心**。

   任务进入减速。转速归零后结果变为 cancelled。程序继续运行。Centrifuge A 保持独立的配置、任务和观测。

**停止离心**取消在途 DeviceTask。**停止程序**结束 Device Program Run。在途任务期间，API 拒绝停止程序。没有在途任务时，可以停止程序。

内置外观命名转子节点 `centrifuge-rotor`，旋转轴为节点自身的 Y 轴。浏览器根据观测 `speed` 的 RPM 计算旋转。每个实例具有独立转子和可变材质。导入 GLB 没有转子映射。即使 Entity 运行任务，导入外观仍保持静态。

## 用 Agent 查询

前提：已有设置中的有效 `lab:full` key，以及 **详情**中的 Lab 身份。终端隐藏 key 输入。

1. 设置 API 地址。

   ```bash
   export LAB_API_BASE=http://127.0.0.1:3000
   ```

2. 设置 Lab 身份。

   ```bash
   export LAB_ID='<lab-uuid>'
   ```

3. 读取 key。

   ```bash
   read -rs LAB_API_KEY
   ```

4. 导出 key。

   ```bash
   export LAB_API_KEY
   ```

5. 运行示例。

   ```bash
   node examples/lab/run-centrifuges.mjs
   ```

   示例完成一次任务并取消另一次。它分别查询 Command、Run、Task 和结果，并检查同命令重试与忙碌拒绝。

完整请求与检查：

<<< ../../examples/lab/run-centrifuges.mjs

| `/api/v1/lab/labs/{lab_id}/entities/{entity_id}` 后的查询路径 | 含义                           |
| ------------------------------------------------------------- | ------------------------------ |
| `/commands/{command_id}`                                      | 动作请求的接受与执行结果       |
| `/runs/{run_id}`                                              | 程序配置和生命周期             |
| `/tasks/{task_id}`                                            | 固定任务参数、已计时与生命周期 |
| `/results/{result_id}`                                        | 独立任务结果与结束原因         |

Start Command 的 succeeded 表示程序开始了任务，不表示任务已完成。减速期间结果仍为 pending。任务可以结束为 completed、cancelled、failed、unknown 或 interrupted。异常报告产生 failed，不确定报告产生 unknown。两者后续均不能变为 completed。

## 关闭浏览器并重启后端

1. 开始一个时长为 `60 s` 的新任务。
2. 关闭全部浏览器窗口。
3. 等待任务结束。
4. 重新打开同一个 Lab。

   结果仍可查询。后端不依赖浏览器推进任务。

5. 再开始一个时长为 `3600 s` 的任务。
6. 记录该任务的 Entity、Command、Run、Task 和结果身份。
7. 在任务执行期间停止开发环境。

在运行 `pnpm dev` 的终端按 Ctrl+C。

8. 再次启动开发环境。

   ```bash
   pnpm dev
   ```

9. 原页面显示**连接中断**时，选择**重新连接**。
10. 打开同一个 Lab。

旧 Run、未结束任务和结果显示 interrupted。参数和最后观测保留。后端不会自动续跑任务。

11. 选择**启动程序**。

    API 创建新 Run。首条观测显示 idle。原任务结果仍为 interrupted。旧 Run 的报告不能覆盖新 Run。

12. 选择**开始离心**以显式请求新任务。
13. 使用上表中的查询路径和已记录的身份读取旧记录。

    重启不会改变 completed 或 cancelled 结果。记录在配置的保留期内可查。

## 检查失败并恢复

1. 在任务执行期间使用新的 `Idempotency-Key` 再发一次 Start。

   API 返回 HTTP `409`，错误为 `lab.device_busy`。原任务与参数保持不变。

2. 选择**停止离心**。
3. 等待 idle。
4. 再发新的 Start。

   API 接受具有新身份的新任务。

响应丢失时：

1. 使用相同参数和相同 key 重试。

   API 返回相同的 Command 和 Task。同 key 不同参数返回 `409 idempotency.conflict`。failed 或 unknown Command 不会自动使用新 key 重试。

2. 查询任务结果，再决定下一步。

程序中断或任务失败时：

1. 程序显示 interrupted 时，选择**启动程序**。
2. 任务显示故障或结果不确定时，读取结束原因。
3. 等待 idle。
4. 选择**开始离心**以请求新任务。

## 下一阶段

继续[运行历史与保留策略](run-history.md)，查询任务和温度并检查清理结果。清理后，过期已结束 Task、Result 和 Command 返回 404。之后按[对象生命周期](entity-lifecycle.md)归档 Entity 或独立替换外观。
