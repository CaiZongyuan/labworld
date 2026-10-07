# 用 Node 运行设备程序

目标：运行两个独立照明实例，再观察传感器和离心 Task。先完成[Node 世界](server-world.md)，准备 Member 会话和有效的 `lab:full` Agent 密钥。需要仓库指定的 Node 24、pnpm 与 Linux 或 Windows。以下命令在仓库根目录运行，会写入开发数据。

## 得到真实设备报告

```bash
pnpm install --frozen-lockfile
pnpm dev
```

打开 <http://127.0.0.1:5173/lab>。登记两个 `light · 1.0` 的模拟 Entity，分别设置亮度 70 和 20。启动 A 的程序，再开启电源。Inspector 先显示 Command 等待，随后显示设备实际报告。启动 B 后，改变 A 不改变 B。

Agent 执行同一业务：

```bash
export LAB_API_BASE=http://127.0.0.1:3000
read -rs LAB_API_KEY
export LAB_API_KEY
node examples/lab/control-lights.mjs
node examples/lab/observe-temperature.mjs
node examples/lab/run-centrifuges.mjs
```

<<< ../../examples/lab/control-lights.mjs

第一个脚本检查独立 Run、实际属性、同键重试和 changed-parameter 409。第二个脚本检查两个独立 1Hz 传感器。第三个脚本等待准备、达标计时、减速和 Task 结果。每个脚本创建自己的 Lab；也可设置 `LAB_ID` 使用已有 Lab。

## 读结果，再决定恢复

`POST .../program/start` 首次返回 201，重复启动返回同一 Run 和 200。`POST .../actions` 返回 202 的 Command。保存其 ID，再查询 `GET .../commands/{id}`。接受命令不生成 Observation；后台程序执行后才报告实际值。`false` 和 `0` 是有效值。

Run 固定启动配置。离心 Task 固定自己的参数，只有转速达到 ±50 RPM、温度达到 ±0.5°C 后才累计计时。停止 Task 请求减速和取消，Run 继续运行；有未结束 Task 时停止 Run 返回 409。

响应不确定时，用原键和原参数重试。参数改变返回 409。完整 Command 过期后，原键返回 `410 lab.command_expired`，不会再次执行。查看结果后，使用新键才能请求新的操作。

关闭浏览器不会停止程序。停止服务并重新启动后，旧 Run 和未结束 Task 显示 interrupted。未确定的 Command 显示 unknown。服务保留最后值和已结束结果，要求显式启动新 Run。旧值不能作为当前可信值。

[设备用例](../../packages/server/src/lab/devices/use-cases.ts)、[生产运行与可信观测入口](../../packages/server/src/lab/devices/runtime.ts)和[纯规则](../../packages/server/src/lab/devices/domain.ts)拥有这些事实。可信观测入口没有 Member/Agent HTTP 注入路由。

下一步：[用 Node 同步世界](server-sync.md)。完整字段与错误见[生成 API](site:reference/api.md)。
