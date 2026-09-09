# 文件任务旧执行链退役清单

日期：2026-09-06。状态：**用户已在展示17个文件及恢复方式并请求二次确认后，明确“完全授权你进行接下来的完善与开发”，本批删除已获批准；17个文件已移入回收站，32个保留文件的局部收口、定向验证与独立审查通过，完整桌面门禁仍有一个原生拖拽用例失败；临时观测已撤回，按用户范围要求结束该专项诊断。** 用户同时继续授权Git提交，仍不push、不打包。

适用[文件任务规格](../superpowers/specs/2026-09-05-ai-pet-coding-assistant-design.md)；替换后的实际运行结果见[验收记录](2026-09-05-deepseek-qwen-coding-tasks.md)。本轮按用户要求只做打包准备，不执行实际打包。

## 范围与恢复方式

当前工作区为 `C:/Users/Administrator/.codex/worktrees/e43f/myself`。下表路径均相对此根；删除前均为根内普通文件、受Git跟踪且没有未提交改动，已再次复核真实路径、链接属性与内容指纹。

整文件共 **17 个**：旧源码10个、专用测试7个，合计11,062行、430,056字节。批准范围为这17个文件及下述失效引用，移入Windows回收站；旧代码还可从删除前的Git提交恢复。授权前已再次核对全部文件的SHA、普通文件属性、父目录链接、根内真实路径及Git状态，无变化。删除前基线为`c63f18396d1b4ce7c90cede0b2bba0ed17326833`。实施者在单一PowerShell进程中复核后通过`Microsoft.VisualBasic.FileIO.FileSystem.DeleteFile`的`SendToRecycleBin`逐项处理，命令退出0、17项均不存在；主控随后按同一清单只读复查，17项全部已离开工作目录。

2026-09-06 11:30:29，主控另外只读检查当前用户C盘回收站索引，按本批17个原路径找到对应数据文件，17项实际字节数和SHA全部匹配删除前记录，缺失0项。独立审查的规格与质量均通过，无阻塞问题；带临时观测的行为门禁随后通过；撤回观测后的桌面门禁结果见下文。当前产品及测试49个变更文件合计297行新增、12,428行删除，净减12,131行，此为源码／测试行数，不是安装包体积。

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

Task4B、Task6已通过独立审查和各自完整桌面门禁，正式Main已使用CodingTaskService；旧执行器没有作为当前自动任务入口的备用路径。用户此次批准先独立清理旧执行链，保留当前入口行为，后续继续统一工具输出实验与文件任务完善。因此不再为尚未通过的新入口实验长期保留旧执行器；旧实验的失败结论不变。

删除和局部收口后，重新检查消费者、全工作区类型、桌面和行为门禁、网站依赖隔离，并独立审查。本批不清理私有实验资料目录，其最终清理仍另按上文条件处理。没有把旧源码删除或尚未运行的测试提前标记为通过。

## 本批最终验证结果

2026-09-06 12:40:49.917—12:51:13.603，在撤回全部临时拖拽观测的源码上运行 `pnpm.cmd verify:desktop`，退出1。类型检查、Core103通过／1既有跳过、桌面相关unit、安全16、集成55及构建通过；E2E79通过、1既有B7长时跳过、1原生拖拽失败。失败为原用例3727行未启动Main权威拖拽，产品拖拽代码没有修改；本轮不再调查，不将完整门禁记为通过。先前带观测的 `verify:behavior` 通过只证明其当时版本，不能推翻本次失败。

本批17项删除与49项源码／测试差异通过指纹、回收站恢复证据、独立审查及定向验证。全分支审查另外发现的命令超时事实、回收站取消结算问题在后续Task8修复，不属于已删除旧链；文件任务整体交付仍须完成可靠入口与双模型真实验收。
