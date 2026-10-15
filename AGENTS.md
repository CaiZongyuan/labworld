# 在本仓库中工作

在更改领域术语之前，请阅读 CONTEXT.md；在更改架构之前，请阅读相关的 docs/adr/ 决策。[产品范围](docs/architecture/lab-word.md) 区分当前实现与目标行为；在假定某个已记录的命令或功能已经存在之前，请检查仓库。

### 工程流程

对于面向用户的 UI、UX 或工作流变更，请阅读 [experience-design.md](docs/agents/experience-design.md)。桌面 Web 是默认范围；仅当用户或已批准的任务明确包含移动端时，才添加移动端适配与验证。复用已接受的预览和最新的明确范围变更，包括无需再次预览即可继续的指示。

对于实现，请阅读 docs/agents/development-flow.md 和 docs/testing/strategy.md。通过已商定的公共测试接口处理一个无阻塞的垂直工单。WIP 提交和获授权的草稿 PR 可以保存进度；完成和合并到 main 需要简化、独立的 Standards + Spec 审查以及必需的最终 head CI。项目流程明确覆盖冲突的导入技能默认设置；保持导入技能不变。

在 issue 完成时或 PR 合并前，在最终验证和代码审查之前运行仓库自有的 [reduce-complexity](.agents/skills/reduce-complexity/SKILL.md) 步骤；当变更未变时复用结果。在 Epic 完成时，使用其更广泛的简化调查。将这些步骤编排进仓库工作流，同时保持导入技能不变，以便上游更新。

对于协调开发、轻量级阶段记录和交付时分析，请使用 [development-timeline](.agents/skills/development-timeline/SKILL.md)。记录阶段变更、等待和返工，而不是每个动作；其报告不是额外的合并门禁。

### 环境与跟踪器维护

在任务清理、会话恢复和每周 PM 维护轮次时，请遵循 [environment-maintenance.md](docs/agents/environment-maintenance.md)，以核对工作树、临时输出、包缓存和未关闭的 issue/PR。保留可恢复的源代码，并在移除前检查实际消费者；记录回收的空间和保留的所有者。