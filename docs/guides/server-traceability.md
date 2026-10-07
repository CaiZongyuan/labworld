# 用 Node 追溯与保留运行事实

目标：查询同一设备的历史、Lab 混合记录和趋势，再安全归档。先完成[世界同步](server-sync.md)，保留一个已运行的 sensor 或 centrifuge Entity。需要有效 Member 或 `lab:full` Agent。命令从仓库根目录运行。

## 查询已有事实

```bash
export LAB_API_BASE=http://127.0.0.1:3000
export LAB_ID='<lab-uuid>'
export LAB_ENTITY_ID='<sensor-or-centrifuge-uuid>'
read -rs LAB_API_KEY
export LAB_API_KEY
node examples/lab/query-history.mjs
node examples/lab/query-records.mjs
node examples/lab/query-trend.mjs
```

<<< ../../examples/lab/query-history.mjs

History 查询 observation、command、task 或 event。默认 20、最多 100 项，响应最多 256 KiB，范围最多 31 天。继续使用同一 Entity、类型和范围的游标。错误查询不修改 World；修正字段后重试。

Records 同时返回 Command、Task、Event 和 Run。它保留首次 `query_upper_bound`，按 `(recorded_at, record_type, id)` 全序分页。新记录不会进入旧分页窗口。停止程序的事件不猜测操作者，保留 unknown。已删除原 Command 后，关联 Task 不伪造来源。

Trend 查询 temperature 或 speed，包含 from、不包含 to。范围最多 24 小时，默认 600、最多 1000 个绘图项，包含 gap。数据库选择真实 first/last/min/max 样本，不跨来源、单位、质量、Run 或缺口连线。浏览器接收有界结果。World、Records 和 Trend 的整个请求最多 10 条实际 SQL，包含身份与事务控制。

## 清理结束记录，保留最后值

默认原始 Observation 保留 86400 秒；结束记录保留 2592000 秒。Run 没有新增清理策略。清理保留 Entity、配置、最后属性和未结束 Task。

```bash
curl -X POST "http://127.0.0.1:3000/api/v1/lab/labs/$LAB_ID/history/cleanup" \
  -H "Authorization: Bearer $LAB_API_KEY"
```

这条命令删除该 Lab 的过期持久记录。测试短保留期时，只使用可丢弃数据目录：设置 `LAB_OBSERVATION_RETENTION_SECS` 与 `LAB_RECORD_RETENTION_SECS`，再重启 Node 服务。两个配置允许 1–31536000 秒。查询中的 available_since 和 gap 如实说明保留缺口。

## 归档与外观

等 Task 结束，再停止 Run，然后运行：

```bash
node examples/lab/manage-entity.mjs
```

此脚本改变并归档所选 Entity。运行或未结束 Task 会阻止归档和定义变更。归档保留身份、引用及尚在保留期的记录。外观替换可在运行中进行；它不改变 Binding、Run、Task 或 Observation。定义变更保留旧 Run 的原定义和来源，新运行需要显式启动。

[History 与保留](../../packages/server/src/lab/history/use-cases.ts)、[混合记录](../../packages/server/src/lab/records/use-cases.ts)、[数据库趋势](../../packages/server/src/lab/history/trend.sql)及[生命周期](../../packages/server/src/lab/world/lifecycle.ts)拥有这些行为。完整 Node 合同验证入口为 `pnpm test:contract:server`，使用隔离目录并记录所属资源。正式 SDK 来源与默认应用组合切换仍是后续迁移。
