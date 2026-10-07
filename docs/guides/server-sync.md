# 用 Node 同步同一世界

目标：让两个浏览器和 Agent 读取同一设备事实。先完成[设备程序](server-devices.md)，运行 `pnpm dev`，并准备两个有效 Member 会话。命令从仓库根目录运行；订阅不会清理历史。

## 查看另一窗口的操作

1. 在两个独立浏览器中打开同一 Lab。
2. 在第一页选择照明 Entity，并开启电源。
3. 在第二页选择同一 Entity。

第二页通过服务读取同一 Observation、Binding 和 Run。它不在浏览器中生成权威设备状态。

Agent 使用同一 `lab:full` 密钥：

```bash
export LAB_API_BASE=http://127.0.0.1:3000
export LAB_ID='<existing-lab-uuid>'
read -rs LAB_API_KEY
export LAB_API_KEY
node examples/lab/observe-world.mjs
```

<<< ../../examples/lab/observe-world.mjs

`GET /api/v1/lab/labs/{lab}/world/subscribe` 先发送 snapshot，再发送 `runtime_status`。后续 update 使用前一份 `base_version`。断线后重新订阅，从新 snapshot 开始。版本不连续时，客户端重新读取世界。

## 结束旧凭据的访问

注销订阅使用的会话，或撤销 Agent 密钥。旧连接发送 `access_ended` 并关闭。相同用户的另一登录不能恢复旧连接。使用新的有效凭据重新订阅，得到当前 snapshot。

服务每 250ms 复核原始凭据，并在每次排队事件交付前再次复核。复核不刷新会话空闲时间。身份、成员或所需 scope 失效后，服务丢弃排队业务事件。

每事件最多 1 MiB，最多 8 个待发事件。初始 snapshot 超限返回 413。后续超限或慢消费者收到 resync 后关闭。终止事件优先于排队业务内容。重新订阅恢复，不要求浏览器保留旧事件队列。

[共享世界投影](../../packages/server/src/lab/world/use-cases.ts)、[订阅生产者与 Body 交付](../../packages/server/src/lab/world/subscriptions.ts)及[原凭据复核](../../packages/server/src/core/api-keys/authentication.ts)拥有这些事实。生产轮询在启动阶段创建；每次数据库操作有自己的有限计量范围。

下一步：[Node 运行追溯](server-traceability.md)。
