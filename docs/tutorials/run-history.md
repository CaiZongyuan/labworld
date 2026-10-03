# 查询运行历史并清理过期记录

目标：查询一次离心任务及其温度报告。修改隔离开发部署的保留期。检查清理后的记录。

## 起始版本

起始提交为 `5fe3468`。[离心任务](centrifuge-tasks.md)提供独立的 Command、Run、Task 和结果身份。使用包含本章及迁移 `0026_lab_history.sql`、`0027_lab_command_receipts.sql` 的工作副本。本章实现 [Issue #9](https://github.com/CaiZongyuan/labworld/issues/9)。

在仓库根目录执行命令。用 `just dev` 启动服务。Member 需要有效会话。Agent 需要有效的 `lab:full` 密钥。清理会删除所选 Lab 的持久历史。短保留期只能用于可丢弃的开发数据。

源码：[历史 HTTP](../../crates/app/src/modules/lab/history.rs)、[保留策略](../../crates/app/src/modules/lab/history/retention.rs)、[迁移](../../migrations/0026_lab_history.sql)、[历史面板](../../packages/views/src/lab/history-panel.tsx)。

## 查询任务与温度

1. 完成上一章的一次离心任务。
2. 在 Lab 中选择该 Entity。
3. 在场景下方的**运行历史**中选择**任务**。

   任务显示固定参数、状态和独立的结果身份。

4. 打开**记录详情**。

   面板显示 Task 和 Run 身份。结果包含状态与结束原因。

5. 选择**观测**。

   温度报告显示 `degC`。每份原始报告仅包含来源在该时刻报告的属性。

6. 将**开始时间**设为任务准备时刻。
7. 将**结束时间**设为任务结束之后的时刻。
8. 选择**查询历史**。

   输入使用本地时间。浏览器发送 UTC 时间戳。详情分别显示来源时间与接收时间。

9. 若出现**更早记录**，选择该按钮。

   面板追加下一页。后续分页失败时，已加载记录仍保留。

10. 选择**事件**。

    事件记录程序、命令和任务的状态变化。可用时保留关联身份和操作者。

## 用 Agent 查询

先在设置中创建有效的 `lab:full` 密钥。从 Inspector 获取 Lab 和 Entity UUID。替换下列占位值。

1. 设置 API 地址。

   ```bash
   export LAB_API_BASE=http://127.0.0.1:3000
   ```

2. 设置 Lab 身份。

   ```bash
   export LAB_ID='<lab-uuid>'
   ```

3. 设置 Entity 身份。

   ```bash
   export LAB_ENTITY_ID='<entity-uuid>'
   ```

4. 读取密钥。

   ```bash
   read -rs LAB_API_KEY
   ```

5. 导出密钥。

   ```bash
   export LAB_API_KEY
   ```

6. 执行查询示例。

   ```bash
   node examples/lab/query-history.mjs
   ```

   示例读取与浏览器相同的任务、观测、命令和事件。它按游标继续读取。

完整请求与检查：

<<< ../../examples/lab/query-history.mjs

`GET /api/v1/lab/labs/{lab_id}/entities/{entity_id}/history` 必须提供 `record_type`、`from` 和 `to`。记录类型为 `observation`、`command`、`task` 或 `event`。

| 限制或字段               | 含义                                                             |
| ------------------------ | ---------------------------------------------------------------- |
| `from`、`to`             | RFC 3339 时间戳。包含 `from`，不包含 `to`。                      |
| 查询范围                 | 每次大于零且不超过 31 天。                                       |
| `limit`                  | 默认 20，允许 1 至 100。                                         |
| 响应                     | 不超过 256 KiB。每页可以少于 `limit`。                           |
| `next_cursor`            | 继续使用同一 Entity、类型和范围。游标为 null 时结束。            |
| 排序                     | 新记录在前。观测和事件按接收时间排序。命令和任务按创建时间排序。 |
| `observed_at`            | 观测的来源时间或事件发生时间。未知来源时间保持 null。            |
| `received_at`            | 观测和事件的接收时间，或命令和任务的创建时间。                   |
| `available_since`、`gap` | 更早的历史可能不完整或已删除。空页不能证明没有活动。             |

原始观测从本次迁移开始保存。最后值不能还原更早测量。Device Program Run 继续作为来源身份提供查询。

## 修改保留期并清理

原始观测默认保留 `86400 s`（24 小时）。已结束命令、已结束任务和设备事件默认保留 `2592000 s`（30 天）。观测和事件按接收时间计算保留期。任务从 `ended_at` 计算。命令从最终 `updated_at` 计算。

两个部署配置均允许 `1` 至 `31536000 s`。无效值会阻止 API 启动。重启后配置生效。增加保留期不能恢复已删除记录。

使用可丢弃的开发栈。以下配置会在五秒后删除原始观测，在一分钟后删除结束记录。

重启会中断已有 Run 和在途任务。需要新任务时，显式启动新 Run。

1. 停止开发栈。

   ```bash
   just dev-stop
   ```

2. 设置观测保留期。

   ```bash
   export LAB_OBSERVATION_RETENTION_SECS=5
   ```

3. 设置记录保留期。

   ```bash
   export LAB_RECORD_RETENTION_SECS=60
   ```

4. 启动开发栈。

   ```bash
   just dev
   ```

5. 完成一次短任务。
6. 等待超过 60 秒。
7. 开始一个时长为 `3600 s` 的任务。
8. 执行显式清理。

   ```bash
   node examples/lab/query-history.mjs --cleanup
   ```

   API 也会每 60 秒清理一次。每次每种记录最多删除 10,000 行。若 `more=true`，示例继续清理。

9. 用原身份查询已结束的 Task。

   清理后 API 返回 404。其 Result 和 Command 也会过期。最新一次已结束任务也适用。

10. 查询当前 Entity。

    身份、配置、最后逐属性值和在途任务仍在。每个属性保留实际来源时间、接收时间与新鲜度。

11. 查询保留边界之前的范围。

    `gap=true` 标记不完整历史。清理可能移除当前世界的 `task` 和 `task_result`。该变化会推进 `world.version`。布局版本保持独立。

12. 恢复较长保留期前，停止在途任务。

API 保留在途任务所需的 Start Command，直到任务结束。已结束 Command 可能先于 Task 过期。Task 保留原 Command 身份；此时 Command 查询返回 404。过期已结束任务不会作为永久摘要保留。

清理保留最小的请求键、规范化请求摘要与原 Command 身份。防重凭据迁移前已有的 Command 也适用。历史保留策略不删除这些防重凭据。完整 Command 过期后，同 key 重试返回 `410 lab.command_expired`。原操作不会再次执行。同 key 修改参数仍返回 `409 idempotency.conflict`。这些元数据不包含参数、结果或任务历史。

收到 `410` 后，先检查当前 Entity。只有显式请求新操作时，才使用新 key。

## 检查失败并恢复

1. 设置超过 31 天的范围。

   页面禁用查询。直接 HTTP 请求返回 `400 lab.invalid_input`。

2. 设置有效范围。
3. 选择**查询历史**。

连接失败时选择**重试历史查询**。密钥过期或撤销后，需要新的有效凭据。会话清理需要 CSRF。拒绝的清理不会改变历史。

## 下一阶段

历史查询与保留策略已实现。下一阶段提供 Entity 归档与安全外观替换。规模和完整体验验收随后交付。
