# 查询整个 Lab 的运行记录

目标：用生成 SDK 读取同一 Lab 的 Command、Task、Event 和设备程序 Run。按设备、类别和时间筛选，并稳定读取下一页。

## 起始状态

使用包含 [records.rs](../../crates/app/src/modules/lab/records.rs) 的源码版本。先完成[离心任务](centrifuge-tasks.md)或[后端照明控制](backend-lights.md)。Lab 中需要真实的 Run、Command 和事件；离心动作还会建立 Task。

在仓库根目录执行命令。运行 `pnpm install --frozen-lockfile`，然后运行 `just dev`。普通 Member 使用有效会话。Agent 使用有效的 `lab:full` API key。下列查询不写入 World，不清理记录。

源码：[混合记录投影](../../crates/app/src/modules/lab/records/list.sql)、[分类覆盖范围](../../crates/app/src/modules/lab/records/coverage.sql)、[部署保留策略](../../crates/app/src/modules/lab/history/retention.rs)。生成合同来自 Rust OpenAPI。

## 取得前两页

1. 在 Lab 的 Inspector 中取得 Lab UUID。
2. 在设置中创建 `lab:full` API key。
3. 设置 API 地址与 Lab 身份。

   ```bash
   export LAB_API_BASE=http://127.0.0.1:3000
   export LAB_ID='<lab-uuid>'
   ```

4. 读取并导出 key。

   ```bash
   read -rs LAB_API_KEY
   export LAB_API_KEY
   ```

5. 运行示例。

   ```bash
   node examples/lab/query-records.mjs
   ```

   `pages` 包含最多两页。每页默认最多 20 项。还有下一页时，最后一页保留 `next_cursor`；这不是全历史导出。

完整 SDK 调用与检查：

<<< ../../examples/lab/query-records.mjs

脚本使用应用的生成 SDK。它检查顺序、字节与身份，提交一次非法 `limit=101`，然后恢复合法查询。非法查询返回 400；恢复查询返回 200。有效 Member 可改用 `LAB_SESSION_COOKIE`，值是当前 `labos_threejs_session=...` Cookie；HTTPS 部署使用 `__Host-labos_threejs_session=...`。两种身份读取同一事实，不猜测历史操作者。

## 筛选并继续

设置 `LAB_ENTITY_ID='<entity-uuid>'` 只读取该设备。省略它时读取全部对象，包括尚在保留范围内的已归档 Entity。

设置 `LAB_RECORD_TYPE=command`、`task`、`event` 或 `run`。省略它时混合四种类别。原始 Observation 不在此列表中；[单设备原始历史](run-history.md)仍可使用。

用 `LAB_RECORDS_FROM` 和 `LAB_RECORDS_TO` 提供 RFC 3339 时间。范围包含 `from`，排除 `to`，长度大于零且最多 31 天。例如：

```bash
export LAB_RECORDS_FROM=2026-10-04T00:00:00Z
export LAB_RECORDS_TO=2026-10-05T00:00:00Z
export LAB_RECORDS_LIMIT=2
node examples/lab/query-records.mjs
```

`GET /api/v1/lab/labs/{lab_id}/records` 使用相同参数。`limit` 默认 20，允许 1 到 100。下一页携带原 `from`、`to`、设备、类别和 `next_cursor`。更换筛选时去掉游标。

第一页固定 `query_upper_bound=min(to, queried_at)`。后续页使用同一上界。刷新时开始新的无游标查询。记录按 `recorded_at`、类别名、UUID 递减排序，并列时间也有稳定顺序。

| 字段或类别                                 | 含义                                                             |
| ------------------------------------------ | ---------------------------------------------------------------- |
| Command / Task `recorded_at`               | 原创建时间。Task 保留独立身份、参数、结果与 `command_id`。       |
| Event `recorded_at`                        | 原接收时间。发生时间保留在 `data` 中。                           |
| Run `recorded_at`                          | 不可变的 `started_at`。结束后另返回真实 `ended_at` 与 `state`。  |
| `actor_id` / `actor_source` / `actor_role` | 可证的发起者身份、请求来源与角色。未知值保持 null 或 `unknown`。 |
| `source` / `binding_id` / `run_id`         | 原 Run 的 Binding 与模拟或实机来源。不会改用设备当前 Binding。   |
| `archived_at`                              | 原 Entity 的归档事实。归档不丢弃保留期内记录。                   |

Command 使用持久 `actor_source`。Task 从关联 Command 取得发起者；Command 已清理时，Task 仍保留 `command_id`，发起者变为未知。Run 的 `started_by` 只解释启动者，不能证明 Member/Agent 请求来源或停止者。旧程序停止 Event 若只保存启动者，本查询返回未知停止操作者。停止与状态变化不移动 Run 的记录时间，也不伪造 Stop Command。

## 解释保留边界和失败

响应的 `retention` 是部署实际策略。默认原始 Observation 保留 24 小时，已结束 Command/Task 与 Event 保留 30 天。Run 的 `coverage.retention_seconds` 为 null；本查询不新增 Run 清理规则。

`coverage` 按请求类别返回采集开始、所有当前筛选对象均已采集的边界、已清理边界和请求范围内最早/最新保留记录。`gaps` 标记 `capture`、`partial_capture` 和 `retention` 的已知不完整区间。`available_since` 是可能完整的边界；Command/Task 的未结束记录和较晚结束记录可以更早开始。`preserves_unfinished` 表示这一例外。空页不能证明历史没有活动，也不能恢复已清理事实。

每页最多 100 项、256 KiB。较大记录会减少每页项数，游标继续保留剩余项。单项无法放入预算时返回 `413 lab.records_too_large`。缩小时间或类别筛选后重新查询。

未知参数、非法范围、类别或错误游标返回 400。不存在或跨 Lab 的 Entity 返回 404。无效、失效或撤销身份返回 401；缺少 `lab:full` 的 key 返回 403。修正参数或取得有效凭据后，从无游标查询恢复。拒绝后的读取不改变 World、记录或设备任务。

后续工作视图可复用此公开查询。当前教程直接验证 HTTP/SDK，不要求尚未交付的运行记录页面。
