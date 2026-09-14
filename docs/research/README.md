# Agent 与文件任务研究资料索引

更新日期：2026-09-10。

本目录保存源码调查和外部框架参考资料。**研究文档用于帮助作出决定，不等于已批准规格，也不证明功能已经实现或验收通过。** 开始修改前仍须遵循[仓库协作规则](../../AGENTS.md)。

## 当前优先阅读

| 顺序 | 文档 | 用途 |
| --- | --- | --- |
| 1 | [文件操作与任务执行：现状、参考实现及后续改造依据](2026-09-10-agent-execution-architecture-review.md) | 说明当前真实调用链、OpenCode 来源、V2 与产品入口差异、自研接缝、历史证据边界和后续改造选项。 |
| 2 | [框架与 Agent 执行能力参考资料](2026-09-10-agent-framework-reference-guide.md) | 比较候选 SDK、Agent 框架及编程执行层，提供官方入口、适用范围和与本项目有关的限制。 |

两份文档应配合阅读：先确定我们的问题发生在哪一层，再判断外部组件能否替换该层并减少自研职责。当前没有批准迁移到其中任何新框架。

## 关联的规格与验收

- [领域词汇](../../CONTEXT.md)：统一普通聊天、文件任务、任务范围、具体许可和角色表现的含义。
- [编程助手规格](../superpowers/specs/2026-09-05-ai-pet-coding-assistant-design.md)：当前有限 OpenCode Core 的架构和授权边界。
- [单一发送与独立表现规格](../superpowers/specs/2026-09-08-single-send-expression-isolation-design.md)：单一输入入口与角色表现隔离。
- [DeepSeek / Qwen 编程任务验收记录](../operations/2026-09-05-deepseek-qwen-coding-tasks.md)：早期核心接入和真实模型场景的结果及限制。
- [单一发送与独立表现验收记录](../operations/2026-09-08-single-send-expression-acceptance.md)：后续入口替换后的实际结果与未覆盖项。
- [OpenCode 来源与本地适配说明](../../vendor/opencode/README.md)：固定提交、补丁、提取范围和宿主边界。

规格表示获批方向，源码表示当前实现，验收只证明其日期和范围内的结果。出现冲突时先记录和确认，不能用研究建议覆盖现行规格。

## 历史研究

以下文件保留调查历史和可复用的设计经验。涉及旧 AgentLoop、旧文件工具服务或旧入口的分析只适用于其当时基线；不能把其中的“当前”当作 2026-09-10 的运行路径。

| 历史文档 | 今日阅读边界 |
| --- | --- |
| [2026-08-22 DeepSeek Harness 轻量复用研究](2026-08-22-deepseek-harness-lightweight-reuse-review.md) | 当时围绕旧执行链的复用取舍；保留旧循环等建议已不适用于后来的有限 Core 方案。 |
| [2026-08-22 文件工具复用候选](2026-08-22-file-tool-reuse-candidates.md) | 可参考职责拆分方法；具体接入建议需按现有 Core 和模型重新判断。 |
| [2026-08-24 开源 Agent 文件执行模式](2026-08-24-open-source-agent-file-execution-patterns.md) | 上游机制参考仍有价值，旧本地代码定位和入口分析按历史阅读。 |
| [2026-08-24 OpenCode 文件工具执行闭环](2026-08-24-opencode-file-tool-execution-patterns.md) | V2 工具源码分析可参考；关于产品主入口的适用说明已补充纠正，优先看本次现状报告第 4 节。 |

后续新增研究应写明日期、源码/版本基线、官方来源、已核实事实与待验证推断；新决定写入规格，执行拆解写入计划，真实运行结果写入验收记录。
