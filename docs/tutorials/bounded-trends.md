# 查询有界、来源明确的趋势

目标：用生成 SDK 查询一个 Entity 的温度或实际转速。识别真实样本、简化粒度和历史缺口。

## 起始状态

先完成[连续温度](continuous-temperature.md)或[离心任务](centrifuge-tasks.md)。使用包含本章[趋势路由](../../crates/app/src/modules/lab/trend.rs)的源码版本。API 与设备程序应已启动；查询不需要浏览器持续打开。

在仓库根目录执行命令。Member 需要有效会话；Agent 需要有效 `lab:full` 密钥。查询与失败检查只读，不创建对象、启动程序或改变保留期。

源码：[数据库趋势读模型](../../crates/app/src/modules/lab/trend.sql)、[公开 HTTP 验证](../../apps/api/tests/lab_trends.rs)、[生成 SDK](../../packages/sdk/src/generated/sdk.gen.ts)。原始观测仍从[运行历史](run-history.md)查询。

## 取得第一个结果

1. 在 Lab 中选择已报告温度的传感器或离心机。
2. 从 Inspector 取得 Lab 和 Entity 的 UUID。
3. 在设置中创建 `lab:full` API 密钥。
4. 设置 API 地址与两个身份。替换占位值。

   ```bash
   export LAB_API_BASE=http://127.0.0.1:3000
   export LAB_ID='<lab-uuid>'
   export LAB_ENTITY_ID='<entity-uuid>'
   ```

5. 读取密钥并导出变量。

   ```bash
   read -rs LAB_API_KEY
   export LAB_API_KEY
   ```

6. 执行完整示例。

   ```bash
   node examples/lab/query-trend.mjs
   ```

   示例通过生成的 `getLabEntityTrend` 读取最近一小时温度。它检查点数和响应大小，发送一个非法预算，再用原查询恢复。

完整源码：

<<< ../../examples/lab/query-trend.mjs

SDK 在工作区提供 TypeScript 源码。示例用已有 Vite 加载该 SDK；它不启动 Web 服务。应用代码可直接从 `@labos-threejs/sdk` 导入 `createApiClient` 与 `getLabEntityTrend`。

Member 使用同一方法，发送有效 `cookie` 请求头。运行 Node 示例时，可用 `LAB_SESSION_COOKIE` 代替 `LAB_API_KEY`。不要把凭据写入源码或日志。

## 改变查询范围

1. 查询离心机的实际转速时，设置属性。

   ```bash
   export LAB_TREND_PROPERTY=speed
   ```

2. 设置 UTC 半开范围。替换为该设备实际报告的时间。

   ```bash
   export LAB_TREND_FROM=2026-10-04T08:00:00Z
   export LAB_TREND_TO=2026-10-04T09:00:00Z
   export LAB_TREND_POINTS=600
   ```

3. 再运行示例。

`GET /api/v1/lab/labs/{lab_id}/entities/{entity_id}/trend` 需要 `property`、`from` 和 `to`。首版属性是 `temperature` 和 `speed`，且必须属于该 Entity 的当前状态或已持久 Binding 的原数值状态定义。归档或替换为静态定义后，旧报告仍保留原 Binding 与 Run，且可以在保留范围内查询。

| 字段或限制                                            | 含义                                                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `from`、`to`                                          | RFC 3339 时间戳。包含 `from`，不包含 `to`。范围大于零且最多 24 小时。                |
| `max_points`                                          | 默认 600，允许 1 至 1000。全部样本和每个 gap 各计一项。                              |
| 完整响应                                              | 最多 256 KiB；普通 Member 认证在内最多 10 SQL。                                      |
| `raw_sample_count`                                    | 范围内保留的唯一真实属性样本数。重复、空报告及其他属性不增加数量。                   |
| `returned_sample_count`、`plot_item_count`            | 返回真实样本数；样本数加 gap 数。                                                    |
| `sampling_strategy`、`resolution_seconds`             | 每段数据库桶内保留 first/last/min/max。零分辨率表示该段未简化。                      |
| `segments`                                            | 每段保留原 Binding、Run、source、unit、quality 和来源时间已知性。                    |
| `samples`                                             | 原值、原序列、原身份、`observed_at`、`received_at` 和 `expires_at`。按接收时间排序。 |
| `gaps`                                                | 包含时间范围和原因。来源、Run、Binding、单位或质量切换也可有零时长边界。             |
| `captured_since`、`retained_since`、`available_since` | 采集开始、实际保留下界和两者的较晚值。清理不可恢复。                                 |
| `first_report_at`、`last_report_at`                   | 本次范围内第一和最后一份真实属性报告。无报告时为 null。                              |

不同单位分别查看，不自动换算。段间不得连线、补零、插值或向前填充。过期末端不延长到当前时间。未知来源时间保持 null；坏质量、质量不确定和来源时间未知应与有效观测分开显示。一个孤立真实样本仍应显示为点。

内置连续来源每秒报告一次。相邻该属性报告超过两个报告周期时，查询标记 `collection_gap`；属性到期或来源结束也断开。响应使用部署的实际保留策略。没有样本与请求失败是不同结果。

Run 在属性到期前正常停止时，缺口标记 `run_stopped`；持久 Run 已中断时标记 `run_interrupted`。这些原因来自真实 Run 状态。样本的原 `expires_at` 不变。

查询保留属性接收时间的原精度。边界落在微秒网格之间时，半开比较仍使用完整时间；秒进位不会补造样本或改变原时间。PostgreSQL 行时间只用于索引候选筛选，最终筛选与采样都在数据库内完成。

## 检查失败并恢复

示例的 `max_points=1001` 请求得到 400，随后原请求仍可读取。未知或非数值属性、非法范围和身份格式也返回 400。未知或跨 Lab Entity 返回 404。

过期或撤销凭据返回 401；缺少 `lab:full` 返回 403。用有效身份重新查询，不能从错误响应推断设备没有观测。

如果真实段和缺口无法放入点数或字节预算，API 返回 413 与 `lab.trend_budget_exceeded`。缩短时间范围后重试；接口不会静默截断原范围。空 `segments` 仅表示本次没有可返回的属性样本，仍需读取 gap 和可用范围。

继续[对象生命周期](entity-lifecycle.md)，保留同一 Entity 的身份和历史。图表消费者使用本章生成合同；本章只交付公开查询。
