# 维护项目文档

目标：随 Lab Word 功能交付可跟做、可查阅的文档。写作模式参考 [axum-saas-template](https://github.com/CaiZongyuan/axum-saas-template/tree/83f1f71bd166af8b604dd50124abc85242b82177/docs) 在 2026-10-01 的版本；主题与事实来自 Lab Word 当前源码。

## 先确定读者任务

| 类型 | 内容顺序                                                   | 完成条件                      |
| ---- | ---------------------------------------------------------- | ----------------------------- |
| 教程 | 开发目标、前章状态、完整变更、运行、结果、失败检查、下一章 | 同一份 Lab 代码可以继续下一步 |
| 指南 | 目标、前提、源码和公共接口、最小完整操作、验证、恢复       | 从本页独立进入也能完成任务    |
| 概念 | 定义、实际关系图、最小例子、取舍、边界、实践入口           | 能理解何时使用与失败范围      |
| 参考 | 事实来源、分类、参数、返回、错误、限制、使用链接           | 能查到当前合同                |
| 概览 | 产品范围、当前阶段、任务入口、首个结果                     | 读者知道从哪里开始            |

设备查看、GLB 导入和 Lab 开发是自己的学习路径。平台知识按 Lab 真正需要的能力链接；历史模板工单、SaaS 课程和模板推广内容不作为产品文档。

## 写一条可验证路径

先检查公开接口与实际源码，再写“文件位置 → 完整操作 → 命令 → 观察结果 → 一个失败与恢复”。注明执行目录、依赖、占位值及是否写入持久数据。先让读者得到结果，再解释原因。

明确区分正式实现、隔离预览和计划。截图应来自实际版本，记录身份与数据是否模拟。页脚 SHA 表示构建源码，不能代替运行与教学验证。

## 简明技术语言：ASD-STE100-inspired {#simplified-technical-language}

在线文档采用 **80% of the way to ASD-STE100** 的写作目标。参考 [ASD-STE100 Simplified Technical English](https://www.asd-ste100.org/) 的简明技术英语原则，让操作、条件和结果更容易理解。“80%”表示借鉴程度，不是可计算的合规分数；本项目不声明完整符合其写作规则或受控词典。

| 规则                       | 在 Lab Word 文档中如何使用                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 短句，一个句子一个主要意思 | 英文操作句以不超过 20 词、说明句以不超过 25 词为目标；过长时先拆句。中文按意思拆句，不套用英文词数。          |
| 主动语态，明确执行者       | 操作用动词开头，例如 `Open`、`Run`、`Select`；描述行为时指出 API、Worker 或浏览器做什么。                     |
| 一步一个动作               | 把操作写成编号步骤，紧接预期结果。依赖、权限、条件和警告放在相关动作之前。                                    |
| 常用词，稳定含义           | 优先使用 `use`、`start`、`stop`、`check`。同一概念使用同一术语，领域词汇以 [CONTEXT](../../CONTEXT.md) 为准。 |
| 保留准确的技术名称         | 保留 GLB、Entity 等必要术语，并在首次使用时解释。命令、路径、API 字段、错误码和界面标签保持原样。             |
| 条件和失败可直接判断       | 写明触发条件、结果和恢复动作。保留 `must`、`should`、`can` 的约束差别、否定含义、单位、数值范围及权限边界。   |

每段围绕一个主题；把操作与解释分开。中英文保留相同的前提、步骤、结果和失败边界，句式可以各自自然表达。

例如，把 “After adding SQL, migrate and restart development so the embedded migration set is refreshed.” 改成：

1. After you add SQL migrations, run `just migrate`.
2. Restart development.

The restart updates the migration set in the binary.

提交前逐段核对上表，并与源码和另一语言版本比较。词数是编辑提示，不能代替语义审查。`docs:check` 检查文档结构与来源关系，不验证 STE 合规性。

## 登记与验证

在中文文件旁创建 `.en.md`，在 [site.json](../site.json)登记稳定 id、两组标题与 source、发布 route、group 和 type。连续章节用 `previous`/`next` 的 id；不相关页面不自动串联。

Markdown 为正文来源；API 来自当前 Node Zod/OpenAPI 与冻结旧栈 OpenAPI；配置来自当前 Node parser 与冻结 Settings。受检查的完整源码可用 `<<<` 引用，避免复制第二份代码。`apps/docs/.generated` 与构建产物由脚本生成；站点图片放在 `apps/docs/public/`。

```bash
pnpm docs:check
pnpm docs:build
just e2e-docs
```

前两项检查正文来源、双语关系、生成参考和构建链接；浏览器验证语言、主题、搜索和部署 base。业务 HTTP、组件及实际三维渲染分别按[测试策略](../testing/strategy.md)验证。

Lab Word 尚未发布继承模板的教学路径，清理时已移除无关页面；保留已采用页面的稳定 route。以后重组已发布的 Lab 页面时维护真实旧链接，避免从旧模板移植悬空导航。

## 维护入口

[CONTEXT](../../CONTEXT.md)维护词汇，[ADR 0005](../adr/0005-lab-digital-twin-on-saas-foundation.md)记录产品边界，[开发流程](../agents/development-flow.md)与[作者规则](../agents/documentation.md)约束交付。原有[文档理念](../document-guild.md)保留为写作参考。

完成验证后按[发布指南](../getting-started/publish-docs.md)处理线上站点。
