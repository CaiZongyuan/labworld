# 数据与证据契约

使用 JSON 报告与可选 JSONL 事件。创建时只填必要事实，完成时补实际结果；没有对应工作就省略 rules/tests/resources，不复制示例计数。脚本不读取 GitHub、执行命令或推断集成状态。

## 最小报告

```json
{
  "project": "Project name",
  "title": "Development delivery",
  "snapshotAt": "2026-10-05T01:00:00Z",
  "task": {
    "status": "partial",
    "goal": "Approved result",
    "startedAt": "2026-10-04T10:00:00Z"
  },
  "scope": { "platform": "desktop-web", "mobile": false },
  "tickets": [],
  "events": [],
  "findings": []
}
```

示例时间不代表实际工作。task.status 为 `in-progress|completed|partial|blocked|paused`；completed 指实际授权结果完成，不从退出码自动生成。

## 事件

| 字段 | 含义 |
| --- | --- |
| id, lane, label | 唯一身份、票/角色/阶段轨道和简短事件名称 |
| kind | `phase` 推进窗口；`command` 有记录的运行；`wait` 已确认等待；`point` 时间点 |
| category | `implementation|review|validation|diagnosis|integration|coordination` |
| start, end | 含时区 ISO 时间；end 可缺失。点事件没有 end，缺结束不补到 snapshot |
| outcome | `passed|failed|expected-red|skipped|unknown`；expected-red 需要实际击中目标断言，不能按文件名猜 |
| confidence | `verified|inferred|unknown`；说明证据支持的命题，不把已知时间偷换为已知原因 |
| actor, revision | 实际执行者与 commit/tree，可缺失但不能填旧对象冒充当前 |
| reason, detail | 等待原因、检查范围、失败分类或保留的未知项 |
| evidence | `[{"href":"relative/log-or-http-url","label":"Short source"}]` |

只以有结束的 command 计算记录运行区间。所有轨道的并行区间可重叠，累计之和可能超过任务 wall time；去重 union 表示至少有一个已记录命令运行的区间，两者都不是 CPU 或全部开发工作。

文件 mtime 只可标为“产物保存”point，不能当 reviewer 开始/结束。未知间隔留空；已知有编码/复验但无精确分配时写说明，不能涂成全等待。

## 可选结果

- tickets: `{id,title,status,url?,blockers:[],delivered:[],pending:[]}`。status 为 `integrated|in-progress|ready|blocked|not-started`。有 tracker 时用实际状态及 merge 证据，不能仅由 ready 标签推断可启动。
- findings: `{id?,title,mechanism,impact?,proposal,confidence,evidence:[]}`。mechanism 解释原因如何导致结果，不只重复“启动晚/测试多”。
- rules: `{id,title,source?,quote?,actual,mechanism,proposal,retain?,classification?,confidence?,evidence:[]}`。classification 可用 `rule-design|misapplication|execution-error|necessary|unproven`。
- tests: `{id?,label,method,start?,end?,uiExecuted?,outcome,cause,fix?,evidence:[]}`。标明真实栈或 HTTP 替代、测试发现数量、目标对象、预期红与准备错误。未使用浏览器无需 tests 页。
- resources: `{name,owner,purpose,disposition}`。disposition 为 `cleaned|retained|unknown`，以实际 owned ledger/最终盘点支持；无资源记录不能推断已清理。

证据路径相对存放它的 JSON/JSONL 文件，渲染到另一目录时重定位。不要保存凭据、完整环境、认证头/cookie、原始含密请求或签名 URL；记录命令名、退出、公共对象身份、源码版本与脱敏路径即可。报告默认本地保存。

## 轻量 journal

helper 不执行业务命令。开始后可结束同一 id，下一次尝试用新 id；相同动作的多个命令按需要记录，不要求每个工具调用一条。

合并多 actor journal 时 id 应包含 actor/票/阶段前缀并全局唯一；每个 actor 使用自己的文件。报告 JSON 与 journal 不重复登记同一事件，已汇总的事件应选择一个来源。

```json
{"type":"start","at":"2026-10-04T10:00:00Z","event":{"id":"api-test","lane":"API","kind":"command","category":"validation","label":"HTTP behavior","start":"2026-10-04T10:00:00Z","outcome":"unknown","confidence":"verified","evidence":[]}}
{"type":"end","at":"2026-10-04T10:00:12Z","eventId":"api-test","outcome":"passed","confidence":"verified","evidence":[]}
{"type":"point","at":"2026-10-04T10:01:00Z","event":{"id":"review-found","lane":"API","kind":"point","category":"review","label":"Boundary finding","start":"2026-10-04T10:01:00Z","outcome":"unknown","confidence":"verified","evidence":[]}}
```

结束记录保留开始的 detail/evidence；显式提供的 actor/reason/revision 更新对应字段，省略时保留开始值。end 未指定 confidence 时沿用开始的置信度，只有新证据支持时才显式更新。孤立结束可标为“起点未记录”的 point 和警告，不补造起点。阶段登记时刻不一定是实际命令起点，已有 runner 精确记录优先。
