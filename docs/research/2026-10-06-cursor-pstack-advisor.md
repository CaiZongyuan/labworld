# Cursor pstack 与 Advisor：对 Codex 开发流程的接入调查

核对日期：2026-10-06。本文是 maintainer 研究笔记，供当前 `pm-development` + `ask-matt` 流程选择工具时使用。用户的主要环境是 Codex CLI / Codex 应用。本次读取官方仓库、技能协议和脚本，没有安装插件、执行插件脚本、改技能、创建工单或运行开发任务。质量、耗时和费用收益均未实测。

## 来源快照

Cursor 官方插件仓库固定为 `df581122cde17e6e27686b5a448bde23e4ad4318`。GitHub API 返回的提交时间为 `2026-10-06T01:05:41Z`，提交标题为 `feat(pstack): drop Sol, default to Opus xhigh and Grok (#511)`。该快照的 pstack manifest 版本为 `0.15.15`，Advisor 为 `1.0.0`。下面所有 Cursor 源码链接均固定此 SHA。[提交][commit]、[pstack manifest][pstack-manifest]、[Advisor manifest][advisor-manifest]

本地基线来自 [pm-development](../../.agents/skills/pm-development/SKILL.md)、[交付与返工控制](../../.agents/skills/pm-development/references/delivery.md) 和 [ask-matt](../../.agents/skills/ask-matt/SKILL.md)。这些文件含当前工作区的用户修改，本文以读取时的内容比较，不把它们描述成已经发布的上游版本。

## 判断

建议保留现有主流程，先借用 **Advisor 的咨询协议**，再按任务增加 pstack 的独立工具。当前 PM 已有 Advisor 触发条件、独立审查、证据复用和交付记录。pstack 的 `poteto-mode` 本身也是完整调度器，直接叠加会产生两套任务路由、模型政策、子 Agent 生命周期和验证要求。这个判断来自下面的规则比较，尚未通过对照开发任务验证。[PM 与交付控制](../../.agents/skills/pm-development/references/delivery.md)、[poteto-mode][poteto-mode]

**pstack 没有内置 Advisor 插件。** 固定快照的 pstack manifest 注册 `skills` 和 `agents`，其中 Agent 为 `poteto-agent`、`Comment Sicko`。Advisor 有自己的 manifest、`advisor` 技能、`advisor-subagent` 和 hooks。pstack 的 `arena`、`interrogate` 提供多模型探索或审查，但它们不等同于 Advisor 的会话状态与咨询协议。[pstack manifest][pstack-manifest]、[pstack Agent][poteto-agent]、[Advisor manifest][advisor-manifest]、[arena][arena]、[interrogate][interrogate]

## 两者解决的问题

| 工具 | 源码定义的任务 | 接到当前流程的位置 |
| --- | --- | --- |
| pstack `poteto-mode` | 将任务路由到 23 个 playbook，按角色选择模型，派发实现、设计探索、验证、审查与交付。它是一套完整工程流程。 | 与 `ask-matt` 路由和 PM 调度重叠。当前不建议同时作为主路由。 |
| pstack 独立技能 | `architect` / `arena` 比较设计，`interrogate` 做对抗审查，`blast-radius` 检查影响，`benchmark-checklist` 审核测量，`correct` 将重复错误变为结构或检查。 | 当某个阶段确实缺少方法时使用。保持现有 scope、owner 和验证入口。 |
| Advisor | 主 Agent 在重大决定、卡住或准备完成时，向只读第二模型提供证据与具体问题；主 Agent 继续执行并负责裁决。 | 当前 PM 的 Advisor 角色已有这个位置，可以补上 briefing 与结果格式。 |

上述任务定义见 [pstack README][pstack-readme]、[poteto-mode][poteto-mode]、[Advisor 技能][advisor-skill]。README 中“更高质量”“可以放心并行”“典型特性 1–3 次咨询”等表述是作者宣称；本次没有独立实验支持这些收益。[Advisor README][advisor-readme]

## Advisor 的实际协议

### 命令与触发

原插件在 Cursor 中以 `/add-plugin advisor` 安装。`/advisor` 开启当前会话，`/advisor <model>` 指定模型，`/advisor ask <question>` 可以单次咨询，`/advisor status` 只读状态，`/advisor nudge off` 关闭回合结束提醒，`/advisor off` 删除整个 `.cursor/advisor/`，包括日志。这些是原宿主命令，不能视为 Codex 已提供的接口。[README][advisor-readme]、[技能][advisor-skill]

技能明确要求用户主动开启，不得自行开启常驻模式。咨询时机有四类：

1. 重大决定：架构、迁移、公共 API、认证等。先有具体候选和证据，再咨询。
2. 卡住：同一失败经过两次实际修复仍存在，或准备加入 retry、sleep、宽泛异常处理、跳过检查等绕行。
3. 准备完成：修改逻辑或超过少量文件的任务，报告实际验证和未验证内容。
4. 用户直接请求第二意见。

约四次咨询是技能中的拆分任务提示，不是脚本强制上限。每个 checkpoint 至多再追问一次；无可用子 Agent 时说明一次并继续。它没有要求遇到普通步骤就咨询。[Advisor 技能][advisor-skill]

### 上下文与输出

briefing 包含原始需求及后续修正、调查与尝试、原文错误和相关 diff、`git status --short`、`git diff --stat`、待决问题、候选与当前倾向、实际验证。保留证据原文，删去无关内容时标记 `[...]`。恢复同一 Advisor 时只交付变化和新问题。密钥及 `.env` 值必须脱敏。[briefing 模板][advisor-briefing]、[技能][advisor-skill]

Advisor 通过前台 `Task` 调用运行，`subagent_type: "advisor-subagent"`，主 Agent 等它返回。开启模式后可以保存 Agent id，并以 `resume` 继续原 Advisor 上下文；模型变化时清除此 id。只读 Advisor 可读仓库和证据，如果 hooks 提供 transcript 路径，还可读当前会话记录。大记录先查大小，再读近期内容和用户消息，而非无条件读完整历史。[技能][advisor-skill]、[Agent][advisor-agent]

输出为 `Verdict / Why / Recommendations / Risks / Answers / Confidence`，建议约 400 个英文词以内。`proceed`、`proceed with changes`、`stop` 是咨询结论；主 Agent 应据代码事实和用户约束判断，错误意见可以被证据推翻。它不能替代非作者 Standards + Spec 审查或最终 head 的必需 CI。[Agent][advisor-agent]、[技能][advisor-skill]、[本地交付控制](../../.agents/skills/pm-development/references/delivery.md)

### 状态与 hooks

原插件把状态集中在项目根 `.cursor/advisor/`，不是按票或按 PM 运行隔离的目录。`state.json` 保存 model、Agent id、conversation id、transcript path、consult count。hooks 使用 `CURSOR_PROJECT_DIR` 定位状态，`CURSOR_PLUGIN_ROOT` 定位脚本。第二个会话执行 `/advisor` 会重绑该项目状态；默认保留 model、nudge 和 `log.md`，重置会话计数与 Advisor 上下文。因此不宜让同一项目的多个 Developer 会话分别开启、共同写这个状态。[技能][advisor-skill]、[hooks][advisor-hooks]、[共享实现][advisor-lib]

| Hook | 实际脚本行为 | 证据边界 |
| --- | --- | --- |
| `afterFileEdit` | 创建 `pending`，忽略插件自身状态路径。 | 依赖宿主触发该事件；脚本本身不扫描整个工作区 diff。 |
| `afterAgentResponse` | 保存回复末尾 400 bytes。 | 只是回合结束判断的输入。 |
| `subagentStop` | 对 `advisor-subagent` 的 `completed` 事件计数，清除 `pending`，把最多 6000 bytes 的 summary 追加到日志。 | 不解析 verdict，也不核对具体 revision、审查范围或 CI。咨询完成不能证明交付通过。 |
| `stop` | `completed` 且有 pending 时，发一次 `followup_message` 提醒，并清除 pending；配置 `loop_limit: 3`。 | 这是提示机制。它判断“在问用户”时只检查去空白后的最后一个 byte 是否为 ASCII `?`，不覆盖所有中文提问形式。 |

事实来源为 [mark-pending][advisor-pending]、[capture-response][advisor-response]、[record-consult][advisor-record]、[stop-hook][advisor-stop]、[hook 配置][advisor-hooks]。脚本依赖 Bash、`jq` 及常规 shell 工具；找不到 `jq` 时静默退出。状态更新用临时文件加 `mv`，源码没有把整个读取、修改和写回加锁；不能把原状态文件当作多会话安全的协调数据库。这是静态源码判断，本次未做并发或中断实验。[共享实现][advisor-lib]

## pstack 的实际依赖与流程差异

### 宿主、模型与脚本

默认模型来自固定快照的角色表：代码多用 `grok-4.7-xhigh-fast`，判断与复杂工作多用 `claude-opus-5-5-xhigh`；`arena`、`architect`、`interrogate` 默认两个模型席位。`/setup-pstack` 枚举 Cursor `Task` 可用模型，让用户选 reasoning budget，再写 `~/.cursor/rules/pstack-models.mdc`。`auto` / `inherit-parent` 是省略 model 字段、继承父模型的别名，不是 API 模型 id。配置必须以宿主真实可用模型为准。[setup-pstack][setup-pstack]、[poteto-mode][poteto-mode]

Advisor 默认另为 `cursor-grok-4.6-xhigh`；其 Agent frontmatter 写 `grok-4.6[effort=xhigh]`。两个插件的默认版本不相同，不能将它们合成同一模型策略。这些是 Cursor slug 和 frontmatter 语法，不表示安装了 Claude Code、Codex CLI 或某个 provider SDK。[Advisor 技能][advisor-skill]、[Advisor Agent][advisor-agent]

插件 manifest 没有声明它们自己的模型 API 服务或独立 API key。原调用协议使用 Cursor 的模型与子 Agent 能力；部分调查技能会发现并使用现有 MCP 来源。不能从“没有独立 API key 配置”推断所有可选工作流没有外部权限或付费依赖。[manifest][pstack-manifest]、[Advisor manifest][advisor-manifest]、[why][why]

| 功能 | 从源码确认的依赖 |
| --- | --- |
| 常规 poteto-mode | Cursor `Task`、可用角色模型、技能和 Agent 注册。每次 commit 前要求 `cursor-team-kit` 的 `deslop`，UI / CLI 验证调用该插件的 `control-ui` / `control-cli`。 |
| `watch-pr` 与 `orch` | Bun、`commander 14.0.0`。bootstrap 在依赖不存在或 lockfile 变化时自动运行 `bun install --frozen-lockfile`，随后重新执行入口。调用这些脚本会安装依赖，不是纯读取。 |
| `watch-pr` GitHub 读取 | 已认证的 `gh`，使用 PR 查询、checks 和 GraphQL。 |
| 大规模 Orchestrate | 当前 Agent store、Cursor cloud agents、`gt` stack metadata；`orch frontier` 从 Graphite 计算 frontier。它不是通用 GitHub Issues DAG 运行器。 |
| Shipping playbook | 默认 `gh`；可选 Origin。该 playbook 说明不要求 Graphite，与 Orchestrate 的 frontier 依赖不同。 |

来源为 [poteto-mode][poteto-mode]、[scripts package][scripts-package]、[bootstrap][bootstrap]、[watch-pr GitHub 实现][watch-github]、[Orchestrate][orchestrate]、[store 源码][orch-store]、[Shipping][shipping]。这些依赖按实际选用功能适用，不能全部算成每个独立技能的硬依赖。

### 与本地基线的重叠

| pstack 规则 | 当前已有规则 | 接入处理建议 |
| --- | --- | --- |
| 非平凡变化跑 `how`；跨函数边界跑 `architect`；设计至少两个完整候选。 | `grill-with-docs`、`prototype`、`codebase-design` 处理问题澄清和模块设计，PM 复用已接受体验。 | 只对未决高风险设计做候选比较，避免每张票重复探索已接受的设计。 |
| `interrogate` 默认双模型对抗审查。 | 默认一名非作者分开报告 Standards + Spec；高风险或里程碑优先双人。 | 用它增强或承担高风险独立审查，显式保留两轴，不再附加一个每票必跑的审查轮。 |
| 默认给新任务、修复回合派发 fresh Agent。 | PM 按阶段复用非作者角色与未变审查覆盖；恢复时接续原实施者。 | 以本地生命周期为准；新设计争议需要独立上下文时才重新开 Agent。 |
| Orchestrate 的 ledger 以 PR + head SHA 记录 verdict，新 SHA 清旧 verdict；Shipping 另有 patch-id 复用规则。 | 本地按语义 delta、依赖、环境和实际覆盖决定证据复用，最终 head 必需 CI 强制。 | 保留本地证据规则，避免 restack 后无判断地重跑全部行为测试。 |
| `show-me-your-work` 的 decision TSV、Orchestrate 的 store 和派生 status。 | `current.md` + development-timeline journal 与离线交付报告。 | 借用 decision 字段，写入现有记录，不维护第二个状态真源。 |
| `reflect` 将会话学习转为技能修改；`correct` 自动修复重复错误并建立 enforcement 表。 | `retro` + development-timeline 已负责回顾；项目要求导入技能保持可更新。 | 使用本次回顾发现来选结构性改进，原上游文件保持不变，项目适配放在 owned wrapper。 |

来源为 [poteto-mode][poteto-mode]、[architect][architect]、[interrogate][interrogate]、[Orchestrate][orchestrate]、[Shipping][shipping]、[reflect][reflect]、[correct][correct] 与 [本地 PM](../../.agents/skills/pm-development/SKILL.md)。此外，poteto-mode 的 Autonomy 允许自行进行 team chat 等外部动作；当前会话的发送消息授权规则仍优先，不能靠导入工作流扩大权限。[poteto-mode][poteto-mode]

## 面向 Codex 的可移植部分

Codex 官方支持从 `.agents/skills` 发现技能，并支持在 `.codex/agents/*.toml` 定义子 Agent 的 model、`model_reasoning_effort`、`sandbox_mode` 等。官方给出了只读分析角色示例。技能包的 `agents/openai.yaml` 还可设置 `allow_implicit_invocation: false`。这些能力可承载项目自己的 Advisor 或设计检查入口。[Codex skills][codex-skills]、[Codex subagents][codex-subagents]

可复用的是 Markdown 中的问题模型、briefing、证据要求和返回格式。需要适配的是 Cursor manifest、`Task` 字段、`resume`、model slug、Custom Mode、`CURSOR_*` 状态路径和 hooks 的事件协议。Codex 官方已经提供 hooks，包括 `PostToolUse`、`SubagentStop`、`Stop` 和 session lifecycle 事件。Codex 使用 `.codex/hooks.json` 或配置内 hook，JSON 输入包含 `session_id`、`transcript_path`、`cwd`、`hook_event_name`；这与 Advisor 脚本的 Cursor 事件和 `conversation_id` 不同。插件根变量也不同。新增或变更 hook 需经过 `/hooks` review/trust；因此原 hooks 必须适配事件名、payload 和输出协议，不能直接复制。第一轮试用可以先只用 skill / Agent 指令，不配置 hooks。[Advisor hooks][advisor-hooks]、[共享实现][advisor-lib]、[Codex hooks][codex-hooks]

本次运行上下文仅暴露 OpenAI 系列子 Agent 模型，未暴露 Grok / Claude slug。跨厂商第二意见需要另行确认实际 provider、凭据和调用接口。先用独立只读 Agent 与不同上下文可以获得一次独立判断；它不应被称为已经实现多厂商多模型 Advisor。本文没有新增这种适配。[Codex subagents][codex-subagents]

Codex 官方说明同名技能不会自动合并，因此不要把 pstack 的 `tdd` 或 `teach` 直接叠到当前同名技能上。项目 wrapper 使用可区分的名称，并指向固定版本的原协议；导入文件保持原样，项目覆盖单独维护。[Codex skills][codex-skills]、[本地 AGENTS](../../AGENTS.md)

## 最小接入方案与验证问题

以下是建议，尚未实施。

1. **保留 `ask-matt` 入口与 PM owner。** 需求、Spec、tickets 仍按现有流程；Developer 继续通过约定公共接口实现和验证。
2. **补齐 PM Advisor 的输入输出合同。** 输入只包括当前争议、原始约束、可复核证据、候选、具体问题和未验证项。输出为 verdict、下一步和剩余风险。仅 PM 管理咨询状态，按 run / ticket 隔离，不共享 Cursor 的单项目状态文件。
3. **先试一个独立 pstack 方法。** 小改动风险不明时试 `blast-radius`；测量性能时试 `benchmark-checklist`；未决复杂模块设计试 `architect` / `arena`。后两者限定为设计产物，不让它们启动第二套实施与交付流程。
4. **审查容量按现有风险判断。** `interrogate` 可以替换或增强高风险审查，不把“Advisor 同意”作为审查或 CI 的替代证明。
5. **复用验证 harness 与记录。** 本项目已有 [just check / check-full](https://github.com/CaiZongyuan/labworld/blob/legacy-rust-final/justfile)、[Vitest / Playwright 与检查命令](../../package.json)、[CI](../../.github/workflows/ci.yml)，不能按“没有测试框架”重新生成整套验证。`create-verification-skill` 自身要求先找既有 harness；可借它的 feature map 与 Launch / Doctor / Drive / Evidence / Cleanup 来补足 Agent 如何使用现有入口。改进记录进入现有 development-timeline / retro。[verification 生成器][verification]、[本地交付控制](../../.agents/skills/pm-development/references/delivery.md)

对一个真实高风险设计或连续返工任务做试用即可判断是否继续。记录 Advisor 是否找到可证伪、原流程遗漏的问题；修复是否减少后续返工；实际新增等待、输入输出用量及费用；是否重复已有 reviewer 工作。没有新证据或只给泛化意见的咨询记录为无有效发现。不以 Agent 数量、讨论长度或一致意见数量作为收益。这是评估建议，不是新增完成门禁。

## 费用与未决事实

Advisor README 宣称每次 consultation 的 briefing 通常为数千 tokens 加额外阅读，典型功能需要 1–3 次；默认 Grok 使用 Cursor Models usage pool，并被作者称为强模型中较便宜的选择。源码没有价目表、预算计量或费用上限，也没有证明一次子 Agent consultation 等同于一次底层 provider API 请求。实际价格与账户额度应以运行时宿主和账户为准。[Advisor README][advisor-readme]、[Advisor 技能][advisor-skill]

pstack 的 setup guide 明确说它会为子 Agent 与 review panel 花费额外 tokens，建议降低 reasoning budget、缩短 panel 列表或继承主模型。`architect` 默认至少两个候选再加一名 cross-judge，且会先运行 `how`；这些是额外工作，不是免费判断。没有任务对照数据，不能证明它比当前 PM 更快或更省钱。[setup guide][setup-guide]、[architect][architect]、[arena][arena]

尚未确认：Codex 上的具体 wrapper 行为；所选模型和 reasoning tier 的账户可用性；跨厂商适配；本项目适配后 hooks 对各编辑入口的实际覆盖；并行或中断恢复；本项目净质量、耗时和费用收益。这里的 hook 未决项指项目适配验证，Codex 官方已列出 apply_patch、exec 与 MCP 等工具的事件覆盖。本次结果只支持选择下一步试用范围。[Codex hooks][codex-hooks]

[commit]: https://github.com/cursor/plugins/commit/df581122cde17e6e27686b5a448bde23e4ad4318
[pstack-manifest]: https://github.com/cursor/plugins/blob/df581122cde17e6e27686b5a448bde23e4ad4318/pstack/.cursor-plugin/plugin.json
[pstack-readme]: https://github.com/cursor/plugins/blob/df581122cde17e6e27686b5a448bde23e4ad4318/pstack/README.md
[poteto-mode]: https://github.com/cursor/plugins/blob/df581122cde17e6e27686b5a448bde23e4ad4318/pstack/skills/poteto-mode/SKILL.md
[poteto-agent]: https://github.com/cursor/plugins/blob/df581122cde17e6e27686b5a448bde23e4ad4318/pstack/agents/poteto-agent.md
[setup-pstack]: https://github.com/cursor/plugins/blob/df581122cde17e6e27686b5a448bde23e4ad4318/pstack/skills/setup-pstack/SKILL.md
[setup-guide]: https://github.com/cursor/plugins/blob/df581122cde17e6e27686b5a448bde23e4ad4318/pstack/docs/guide/01-setup.md
[arena]: https://github.com/cursor/plugins/blob/df581122cde17e6e27686b5a448bde23e4ad4318/pstack/skills/arena/SKILL.md
[architect]: https://github.com/cursor/plugins/blob/df581122cde17e6e27686b5a448bde23e4ad4318/pstack/skills/architect/SKILL.md
[interrogate]: https://github.com/cursor/plugins/blob/df581122cde17e6e27686b5a448bde23e4ad4318/pstack/skills/interrogate/SKILL.md
[why]: https://github.com/cursor/plugins/blob/df581122cde17e6e27686b5a448bde23e4ad4318/pstack/skills/why/SKILL.md
[correct]: https://github.com/cursor/plugins/blob/df581122cde17e6e27686b5a448bde23e4ad4318/pstack/skills/correct/SKILL.md
[reflect]: https://github.com/cursor/plugins/blob/df581122cde17e6e27686b5a448bde23e4ad4318/pstack/skills/reflect/SKILL.md
[verification]: https://github.com/cursor/plugins/blob/df581122cde17e6e27686b5a448bde23e4ad4318/pstack/skills/create-verification-skill/SKILL.md
[orchestrate]: https://github.com/cursor/plugins/blob/df581122cde17e6e27686b5a448bde23e4ad4318/pstack/skills/poteto-mode/playbooks/orchestrate.md
[shipping]: https://github.com/cursor/plugins/blob/df581122cde17e6e27686b5a448bde23e4ad4318/pstack/skills/poteto-mode/playbooks/shipping.md
[scripts-package]: https://github.com/cursor/plugins/blob/df581122cde17e6e27686b5a448bde23e4ad4318/pstack/skills/poteto-mode/scripts/package.json
[bootstrap]: https://github.com/cursor/plugins/blob/df581122cde17e6e27686b5a448bde23e4ad4318/pstack/skills/poteto-mode/scripts/bootstrap.ts
[watch-github]: https://github.com/cursor/plugins/blob/df581122cde17e6e27686b5a448bde23e4ad4318/pstack/skills/poteto-mode/scripts/watch-pr/github.ts
[orch-store]: https://github.com/cursor/plugins/blob/df581122cde17e6e27686b5a448bde23e4ad4318/pstack/skills/poteto-mode/scripts/orch/store.ts
[advisor-manifest]: https://github.com/cursor/plugins/blob/df581122cde17e6e27686b5a448bde23e4ad4318/advisor/.cursor-plugin/plugin.json
[advisor-readme]: https://github.com/cursor/plugins/blob/df581122cde17e6e27686b5a448bde23e4ad4318/advisor/README.md
[advisor-skill]: https://github.com/cursor/plugins/blob/df581122cde17e6e27686b5a448bde23e4ad4318/advisor/skills/advisor/SKILL.md
[advisor-agent]: https://github.com/cursor/plugins/blob/df581122cde17e6e27686b5a448bde23e4ad4318/advisor/agents/advisor-subagent.md
[advisor-briefing]: https://github.com/cursor/plugins/blob/df581122cde17e6e27686b5a448bde23e4ad4318/advisor/skills/advisor/references/briefing-template.md
[advisor-hooks]: https://github.com/cursor/plugins/blob/df581122cde17e6e27686b5a448bde23e4ad4318/advisor/hooks/hooks.json
[advisor-lib]: https://github.com/cursor/plugins/blob/df581122cde17e6e27686b5a448bde23e4ad4318/advisor/hooks/lib.sh
[advisor-pending]: https://github.com/cursor/plugins/blob/df581122cde17e6e27686b5a448bde23e4ad4318/advisor/hooks/mark-pending.sh
[advisor-response]: https://github.com/cursor/plugins/blob/df581122cde17e6e27686b5a448bde23e4ad4318/advisor/hooks/capture-response.sh
[advisor-record]: https://github.com/cursor/plugins/blob/df581122cde17e6e27686b5a448bde23e4ad4318/advisor/hooks/record-consult.sh
[advisor-stop]: https://github.com/cursor/plugins/blob/df581122cde17e6e27686b5a448bde23e4ad4318/advisor/hooks/stop-hook.sh
[codex-skills]: https://developers.openai.com/codex/skills/
[codex-subagents]: https://developers.openai.com/codex/multi-agent/
[codex-hooks]: https://developers.openai.com/codex/hooks/
