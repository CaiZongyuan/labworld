---
name: development-timeline
description: 记录开发阶段和验证证据，生成离线 HTML 交付时序、阻塞与改进报告。用于 PM 里程碑结束、暂停、移交或开发复盘。
---

# 开发交付时序

让用户看清本次做完了什么、还有什么未完成、哪里返工或等待、下次改什么。优先在开发期间记录阶段变化，结束时复用证据；报告本身不增加产品门禁或触发额外开发。

## 开始与阶段记录

1. 为当前授权任务建立一个本地报告目录。第一次记录时读 [数据与证据契约](references/data-contract.md)，创建简短报告 JSON；不同项目使用同一结构，不复制本项目票号和结论。
2. 记录派发/阶段开始结束、实际等待原因、角色借调、关键验证/审查发现、修复和集成。使用 [record-event.mjs](scripts/record-event.mjs)，或直接复用已有结构化 runner 记录；不逐工具调用打点。
3. 票/PR/tracker 与实际交付结果是权威来源。记录本地成果、集成成果和未验证部分的区别，不用测试绿色推断票已完成。

```bash
node /path/to/development-timeline/scripts/record-event.mjs \
  --journal .scratch/task/events.jsonl start --id sdk-check \
  --lane "API ticket" --kind command --category validation --label "SDK check"
node /path/to/development-timeline/scripts/record-event.mjs \
  --journal .scratch/task/events.jsonl end --id sdk-check --outcome passed
```

时间默认表示实际记录时刻。历史时间仅在证据支持时用 `--at`；不能倒推模型思考、排队或命令开始时间。多 actor 可各自记录 journal，渲染时合并。

## 报告与归因

在任务/里程碑结束、暂停或移交时更新 task 状态、票/交付结果、发现与保留资源，然后生成报告。失败或部分交付照常出报告，不等全部问题解决。

```bash
node /path/to/development-timeline/scripts/render.mjs \
  --input .scratch/task/report.json --events .scratch/task/events.jsonl \
  --output .scratch/task/timeline.html
```

- 将原因写成“规则/选择 → 实际执行 → 结果 → 修改方向”，分开必要验证、规则过度解释、执行错误和未证推断。无需凑满固定数量的发现或规则。
- phase 区间包括可能的编码、阅读和等待；command 区间包括启动/清理，仍不等于 CPU。点事件、保存时间和无结束的阶段不计持续耗时。并行区间累计与去重覆盖分列，未知 gap 保持未知。
- 浏览器调用区分实际执行/零收集、预期红/产品缺陷/测试前提错误；先检查已有谓词是否证明用户要求，不把失败次数直接叫浪费。
- 指出真正有价值的交付和验证。无法精确分摊小时数时说明证据限度；提出可操作改法而非用笼统效率标签归责。
- 只加载支撑未决问题的原始证据；缺少历史记录时出轻量报告，不重新执行产品测试或大规模招募审计团队补齐图表。

## 检查与交付

检查 JSON、事件时间、状态、相对证据路径与脱敏；用已有浏览器能力打开离线 HTML，检查筛选、详情和主要视图。按报告用途选代表桌面视口；不自动新增 Web 移动端产品测试。

HTML 不依赖服务或 CDN。给用户可直接打开的文件链接、简短完成情况和最重要的改进；详细方法、测试结果和规则分析放在报告里。公开发布、上传或变更 tracker 仍遵守原授权，生成本地报告不构成这类授权。
