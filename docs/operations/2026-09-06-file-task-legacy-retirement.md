# 文件任务旧执行链退役清单

日期：2026-09-06。状态：**待新链验证收口及用户二次批准，尚未执行删除**。

适用[文件任务规格](../superpowers/specs/2026-09-05-ai-pet-coding-assistant-design.md)；替换后的实际运行结果见[验收记录](2026-09-05-deepseek-qwen-coding-tasks.md)。本轮按用户要求只做打包准备，不执行实际打包。

## 范围与恢复方式

当前工作区为 `C:/Users/Administrator/.codex/worktrees/e43f/myself`。下表路径均相对此根，当前均为根内普通文件、受 Git 跟踪且没有未提交改动；删除前再次复核真实路径、链接属性与内容指纹。

整文件共 **17 个**：旧源码10个、专用测试7个，合计11,062行、430,056字节。批准后移入Windows回收站；旧代码还可从删除前的Git提交恢复。实际删除前提交及结果在执行后记录，本清单不代表已经获得批准。

| 路径 | 删除原因 |
| --- | --- |
| `apps/desktop/src/main/agent/agent-service.ts` | 旧文件任务服务，正式入口已改用CodingTaskService |
| `apps/desktop/src/main/agent/main-agent-session-factory.ts` | 旧执行器与权限组合工厂 |
| `apps/desktop/src/main/agent/pending-action-store.ts` | 旧逐动作票据和续接机制 |
| `apps/desktop/src/main/agent/powershell-tool.ts` | 已由原Core及Windows Job承接的旧命令执行器 |
| `apps/desktop/src/main/conversation/capability-transaction.ts` | 已退出正式链的第二份任务账本与完成裁判 |
| `packages/agent-core/src/agent-loop.ts` | 已替换的旧单工具循环 |
| `packages/agent-core/src/capability-clarification-tool.ts` | 只供旧循环使用的澄清伪工具 |
| `packages/agent-core/src/tool-result.ts` | 只供旧循环使用的结果包装 |
| `packages/file-tools/src/file-tool-service.ts` | 已替换的旧文件执行器 |
| `packages/file-tools/src/recycle-bin-port.ts` | 只供旧文件执行器使用的接口 |
| `apps/desktop/tests/agent-service.test.ts` | 旧服务专用测试 |
| `apps/desktop/tests/main-agent-session-factory.test.ts` | 旧组合工厂专用测试 |
| `apps/desktop/tests/pending-action-store.test.ts` | 旧票据专用测试 |
| `apps/desktop/tests/powershell-tool.test.ts` | 旧命令执行器专用测试 |
| `apps/desktop/tests/capability-transaction.test.ts` | 旧任务账本专用测试 |
| `packages/agent-core/tests/agent-loop.test.ts` | 旧单工具循环专用测试 |
| `packages/file-tools/tests/file-tool-service.test.ts` | 旧文件执行器专用测试 |

## 同批局部收口

整文件删除需要同时剪除共用文件中的旧导出、旧循环专属类型、内置旧工具工厂、旧参数Schema和无人使用的授权根测试夹具字段；正式Conversation端口的旧类型别名与工厂命名按现有CodingTask类型统一。仅移除`packages/file-tools`中已经没有消费者的直接依赖，保留OpenCode仍使用的依赖记录，并复核网站依赖图。

补充反向引用核对确认：旧`PendingAction/pending_action`只服务逐动作票据，需要从共享契约、Renderer任务存储及其旧测试分支中剪除；角色Service/Director也仅移除这类旧事件分支。现有`task_permission_required`、许可队列、确认/拒绝IPC及`awaiting_confirmation`阶段继续保留，角色在任务等待时的阻塞测试继续验证。此项是旧协议退役，不新增角色状态或动画规则。

保留`agent-core`与`file-tools`包中的有效职责，以及普通聊天、Provider、披露、会话、角色、Explorer、Qwen进程清理、路径保护、相对路径Schema和语义路由。已迁移的`local-model-acceptance-runner.ts`继续使用。MCP保留源码和所需泛型注册表／权限策略，运行时继续禁用。

## 本任务临时资料

最终独立审查和公开验收记录完成后，另清理本计划专属目录：

`C:/Users/Administrator/.codex/worktrees/e43f/myself/.superpowers/sdd/2026-09-05-deepseek-qwen-coding-tasks`

目录用于本轮临时日志、源码快照、调查及审查材料；当前约597个文件、103MB，无链接，审查期间仍会产生同类临时资料。清理范围仅此目录，公开规格、计划和验收记录保留。执行前重新核对目录及内容范围，移入Windows回收站。此项同样等待用户二次批准，且只在最终审查完成后执行。

## 执行前提

新链的正式入口、实际模型、现有界面和相关自动化验证按真实结果完成收口，并通过独立审查；之后依据`AGENTS.md`第5、8节取得大量删除的第二次明确批准。删除和局部收口后，重新检查消费者、类型、相关测试和网站隔离。没有把旧源码删除或尚未运行的测试提前标记为通过。
