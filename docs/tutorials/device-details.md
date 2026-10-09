# 使用统一设备详情

目标：在同一个持久 Lab 中操作两台照明和两台离心机。分别核对请求目标、Command、实际 Observation、Device Program Run 和 Device Task 结果。

## 起始状态与完整变更

先完成[空间工作台](spatial-workbench.md)。使用本章配套源码，保留已有 Lab。需要有效 Member 会话。以下登记、启动、命令与停止操作写入持久开发数据。

本章以 [EntityDetail](../../packages/views/src/lab/entity-detail.tsx)组合操作、记录和详情。普通[设备操作](../../packages/views/src/lab/device-panel.tsx)和[离心任务](../../packages/views/src/lab/centrifuge-panel.tsx)复用已有生成 SDK。[工作台上下文](../../packages/views/src/lab/workbench-context.tsx)按身份、Lab、Entity 保存输入、命令尝试和来源操作。它继续持有唯一 World 查询与订阅。

没有新增 Lab API、运行引擎或授权角色。Universal App Shell 和 SaaS Core 不读取设备概念。

在仓库根目录运行：

```bash
pnpm install --frozen-lockfile
just dev
```

打开 <http://127.0.0.1:5173/lab>。默认先显示三维空间。选择已有 Lab，分别登记 `light@1.0` 的模拟对象 `Light A`、`Light B`，以及 `centrifuge@1.0` 的模拟对象 `Centrifuge A`、`Centrifuge B`。

## 得到第一条实际反馈

1. 从目录或场景选择 `Light A`。名称、登记位置和模拟身份直接可见。没有报告的属性显示 **未知 · 无观测**。
2. 在 **操作** 点击 **启动程序**，确认程序运行状态。照明在下一步动作后才产生实际属性报告；启动成功本身不产生观测。
3. 切换 **电源**。查看 **请求电源目标** 和命令反馈。电源控件与 **观测电源** 只随报告变化。
4. 在 **目标亮度 (%)** 填写 `35`，点击 **设置**。等待 **观测亮度** 报告 `35 %`。
5. 选择 `Light B`，启动它并设置不同亮度。返回 A，确认输入、尝试、Run 和报告各自独立。
6. 打开 **详情**，查询完整 Entity、定义、Binding、Run 及逐属性来源。原始 ISO 时间保留服务器返回的精度。

当前 Binding 和 Run 的身份独立展示。照明尚未报告时，也能查询刚启动的 Run；重启后，旧报告所属 Run 与当前 Run 分开。Task、所属 Run、Command 和结果身份来自各自的实际记录，旧结果不会被当作新 Run 的任务。

手机中，选中设备后场景与底部详情同时保持可见。操作页保留实际值、单位、质量及新鲜度；完整逐属性来源和时间在 **详情** 查询。离心开始/停止固定在参数滚动区之外。

实际值与目标值可以不同。Command 的 `accepted` 表示请求已登记，`executing` 表示正在执行，`succeeded` 表示执行结果。它们不能代替设备报告。

## 当前值与最后报告值

统一判定来自 Lab 的[观测读取模块](../../packages/views/src/lab/observation-state.ts)：

<<< ../../packages/views/src/lab/observation-state.ts

传感器需要温度，照明需要电源和亮度，离心需要转速和温度。每个关键属性必须同时满足下列条件，设备才具有当前有效关键观测。

| 条件               | 可核对的字段                             |
| ------------------ | ---------------------------------------- |
| 类型正确的真实值   | 属性 `value`；零和 `false` 有效          |
| 当前时效           | 属性 `freshness=current`                 |
| 已知来源时间       | 属性 `observed_at` 非空                  |
| 良好质量           | 属性 `quality=good`                      |
| 当前来源           | 属性 `binding_id` 与当前 Binding 相同    |
| 正在运行的当前 Run | 属性 `run_id` 相同，Run 状态为 `running` |

页面还将连接中断表达为只读最后快照。缺失值不补零。来源停止、旧 Binding 或新 Run 尚未报告时，旧值保留原时间与来源，并标为最后报告值。心跳或另一个属性的更新不刷新这个属性。

登记位置来自实际 `located_in` / `contains` 关系。三维 Placement 和相机变化不能证明对象已搬动。未接入的真实对象保留身份；能力的声明、实现和当前可执行性分别显示。

## 离心任务与结束结果

1. 选择 A，启动程序。Run 启动本身不创建 Task。
2. 输入转速、温度和时长。允许范围来自实际 Capability。点击 **开始离心**。
3. 观察准备阶段。转速和温度达标后才开始有效计时。计时来自后端 Task。
4. 切换 B，提交不同参数。返回 A，在途控件显示该 Task 固定的参数。
5. 在 B 点击 **停止离心**。确认后等待减速至零，再核对 `cancelled`。
6. 让 A 正常结束，核对 `completed`。设备的观测阶段 `idle` 与结束结果分别显示。
7. 关闭页面后再打开同一 Lab。后端任务仍继续，保留期内的结果仍可查。

停止 Task 与停止 Run 是两种操作。活动 Task 期间不能停止程序。停止任务的 Command 已执行，也不代表减速已经结束。

## 来源恢复与不确定尝试

运行中来源缺少有效观测时，可点击 **重新启动程序**。确认后先 Stop，再 Start。Stop 失败时不继续 Start。Stop 成功而 Start 失败时，页面保留已停止的事实；点击 **启动程序** 显式恢复。

新 Run 不续跑旧 Task，也不清除旧 Task 结果。需要新任务时，另行提交。旧属性在新报告到达前仍保留旧 Run 和时间。

参数或忙碌拒绝后修正输入，原观测保持。传输结果不确定时，使用 **重试同一命令** 保留原键；已有 Command 身份时，使用 **刷新命令** 查询原记录。`unknown` 不触发同 Run 的新键自动执行。

断线保留输入、尝试和最后同步时间，禁用新设备操作。重新连接取得最新 World。凭据失效或撤销后走现有登录恢复，清除受保护缓存，不重放旧动作。

## 记录、验证与下一章

**记录** 使用原单设备历史，保留设备、类型、时间范围、分页及保留缺口。选择原始 Observation 可查询报告。加载失败保留已加载记录并可重试。Lab 级运行记录和趋势由各自章节承接。

```bash
pnpm typecheck
pnpm exec vitest run apps/web/src/lab-device-details.test.tsx apps/web/src/lab-devices.test.tsx apps/web/src/lab-centrifuges.test.tsx apps/web/src/lab-sensors.test.tsx apps/web/src/lab-sync.test.tsx
node scripts/e2e.mjs tests/e2e/lab-device-details.spec.ts
```

Views 只用 MSW 替代 HTTP。浏览器验证使用隔离的真实身份、API、PostgreSQL、Worker、RustFS 和 WebGL，检查关闭浏览器后的任务、独立设备、代表视口和实际画布。测试栈不能指向已有开发或生产数据。

继续[后端照明控制](backend-lights.md)，完成 Member 与有效 `lab:full` Agent 的公开请求和失败恢复。
