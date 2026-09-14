# 内置 Qwen 子目录与多轮跟进诊断记录

实验日期：2026-09-10，实施与验收日期：2026-09-11。环境：Windows、Node 24.18、pnpm 11.9、内置 Qwen3.5-4B-Q4_K_M、正式 Runtime/Vulkan。**已完成用户批准的 Qwen 专用入口适配；实际子目录与同名文件的有限实测通过，完整稳定性及仓库门禁未全部通过。**第 1～4 节保留已撤回的原生候选及诊断历史；最终实现和当前版本证据见第 5 节起。

适用[执行计划](../superpowers/plans/2026-09-10-qwen-task-entry-stability.md)、[单一发送规格](../superpowers/specs/2026-09-08-single-send-expression-isolation-design.md)和[编程助手规格](../superpowers/specs/2026-09-05-ai-pet-coding-assistant-design.md)。用户于 9 月 11 日批准仅对 Qwen 实施[单次会话决策规格](../superpowers/specs/2026-09-10-qwen-conversation-decision-design.md)，原生候选与隔离原型的历史结论保持。

## 1. 复现与定位

直接只读查看用户设置和真实目录，确认 `E:/TempTest` 根目录包含 `a/`、`ab.txt`、`order.txt`、`test.txt`；`a/` 中只有空的 `abc.txt`。根目录的 `ab.txt` 也是空文件。未修改用户文件、设置、角色或 Provider 选择。

真实模型测试在隔离目录复制上述文件名与空文件，其他正文使用合成数据。实际人设复现读取当前角色的公开人设字段；可复现脚本使用独立合成人设，两者结果不能混成同一个样本。

固定输入：

1. 你帮我看看当前目录下都有什么呀
2. 当然可以让紫小宝看看啦
3. 那a目录下又有什么呀
4. 当然让紫小宝去看啦
5. 看吧，看看里面写了什么

原始实际人设复现仅有一次根目录 `read`，后续普通正文继续描述子目录文件和内容，没有相应工具事实。正式 Core 可通过相对路径读取 `a` 和 `a/abc.txt`，空文件真实返回 `content: ""`。没有发现执行器丢失 `a/` 前缀或把空文件当作不存在的证据。

已捕获的失败入口响应直接是普通正文，既没有原生 `tool_calls`，也没有漏解析的工具标记。同一连接另一次能返回合法空参数任务申请。请求为首条单一 system，当前用户消息在最后；没有发现该组输入被预算截断。主要失败点是 Qwen 在进入 Core 之前漏选任务，不能归因为不支持子目录。

## 2. 有限实验结果

| 实验 | 结果与边界 |
| --- | --- |
| 仅固定入口温度为 0 | 候选曾成功，复测再次漏调用；不构成充分修复 |
| 精简原生入口提示、补正反例、调整系统段顺序 | 部分实际人设运行读到真实 `a/abc.txt`；强调撒娇语气的合成人设仍漏调用。未证明稳定 |
| 原入口及 Core 均采用温度 0 | 仍能复现跟进时零范围、零工具并重复询问许可。已撤回全部参数改动 |
| 固定失败请求，仅替换原生工具 description | 仍复现编造目录内容，没有任务调用；未接入生产 |
| 精简 JSON 原型，固定 8 条请求 | 5 条任务、问候及两条负例的 kind 选择全部符合预期；初版两条 task 带了非空 text，未算严格通过 |
| JSON 原型增加严格 anyOf | 同一 8 条请求的意图和结构均通过；5 条 task 的 text 均为空。只验证入口 HTTP 响应，未接入正式适配器、Main、Core 或窗口 |

JSON 原型的普通讨论回复仍有“目录看起来有点乱”等未经读取的描述。8 条意图与形状通过，不等于聊天事实正确、任务端到端通过或已达到目标稳定性。不得把新的 JSON 实验写成原生 auto 已修复。

私有实验记录保存在 `.superpowers/sdd/2026-09-10-qwen-subdirectory/`：原始实际人设为 `actual-layout-conversation-trace.json`；最新原生候选失败为 `final-generation-confirm.log`；固定描述对照为 `entry-description.log`；严格 JSON 原型为 `entry-structured-strict.log`。原始 HTTP 记录不进入公开日志或 Renderer。

两条负例分别重置会话后运行：“你觉得a目录需要整理吗？”和“不要查看a目录，只告诉我如何整理文件夹。”范围申请及工具调用均须为零；不以自然回复正常结束替代这个判断。

## 3. 验证记录

下列测试大部分针对已撤回的原生候选，证明当时的适配及边界检查结果，**不证明缺陷修复或最终产品门禁通过**。

| 命令或检查 | 实际结果 |
| --- | --- |
| 入口温度、提示及单 system 的最小 RED | 按预期失败；最小实现后对应定向测试通过 |
| 桌面 5 文件定向检查 | 162 项通过；随后真实模型仍失败 |
| Core 完整测试及类型检查 | 108 项通过、1 项跳过；类型检查通过 |
| 全 workspace 类型检查 | 通过 |
| `pnpm.cmd verify:desktop` | 单元阶段 44 项失败、2837 项通过，整体失败；后续阶段被阻断 |
| 独立 `pnpm.cmd test:security` | 16 项通过 |
| 独立 `pnpm.cmd test:integration` | 52 项通过、2 项失败；其中桌面 Agent 集成 38 项通过 |
| 独立全量 Electron 检查 | 70 项通过、10 项失败、1 项跳过；整体失败 |
| 后续桌面包测试 | 2367 项通过、38 项失败；命令中的 `--` 未实现文件筛选，实际运行了整个桌面包 |
| 诊断脚本语法及离线 prepare | 通过，源文件指纹一致，临时 bundle 清理完成；未执行模型 |

集成失败为角色素材夹具超时，以及 `provider-server.test.ts` 将自然正文按旧 JSON 解析。Electron 失败涉及角色工作室、窗口拖拽、自主行为、位置恢复、默认聊天提示及本地模型 fixture 回复不可见；本轮没有确认所有失败的根因，不能全部标记为既有问题。部分相关差异与此前验收记录一致，但这不是本次逐项基线复现。

完整日志分别为私有目录内的 `security.log`、`integration.log`、`electron.log`、`final-core.log`、`final-targeted.log`。候选 diff 保存为 `withdrawn-native-candidate.patch`，正式源码恢复后不保留该候选的入口提示、温度、Core 接口或对应测试。

9 月 11 日收尾时，恢复源码后的 Core 类型检查及公共声明生成通过，桌面构建与其边界校验通过；日志为 `restored-core-types.log`、`restored-desktop-build.log`。再次检查桌面及 Core 的只读 `git diff --exit-code` 返回 0；诊断脚本语法、离线 prepare、本文与关联规格／计划的链接和中文编码、`git diff --check` 均通过。这些是恢复与材料检查，不把前述完整门禁失败改写为通过。

## 4. 可复现诊断与后续门槛

```powershell
node tools/diagnostics/qwen-followup-probe.mjs
```

该脚本复用现有正式验收生命周期、Main 和 Core；临时构建只替换合成场景并观察本次 Core 原事件，不修改生产源码。模型资源未就绪时退出，不自动下载、不访问云 Provider。

自动化检查要求第 1 轮实际读取根目录、第 3 轮实际读取仅包含 `abc.txt` 的 `a`、第 5 轮实际读取 `a/abc.txt` 的空内容；上述目录查询必须在对应轮次产生范围申请。两条负例无范围和工具，所有轮次完成，模型与临时构建清理完成，五个相关源码指纹保持一致。此前较松的旧脚本曾把第 3 轮零工具记为整体通过，已收紧，旧结果不作为完成证据。

`automatedChecksPassed` 和退出码只表示这些自动化检查；`emptySummaryHint` 只是“空”等措辞的启发式命中，也可能命中“不是空文件”，不能证明语义正确。脚本输出第 1、3、5 轮 `ROUND_SUMMARY`，并始终标记 `summaryReview: required`；必须另行对照真实工具结果核对目录与文件正文。零工具、错目标或虚构总结均不能最终验收为通过，人工核对前不宣布完整场景成功。

脚本只在隔离根批准固定的精确只读命令；其他命令拒绝且记录失败，不放宽生产授权。曾出现 `Get-Content a\\abc.txt` 被测试白名单拒绝；这是独立失败分支，不能靠扩大白名单掩盖入口漏调用。

以上为诊断工具的验收规则，批准后的运行结果另见下文。真实 Windows 使用体验仍待用户人工确认，实施前的有限原型不能声明稳定性达标。

## 5. 已批准的最小实现

用户明确回复“行，那就为了适配Qwen就对他单独修改”后实施，仅修改两个生产文件：

- `apps/desktop/src/main/providers/local-model-provider.ts`：准确识别正式宿主会话入口，使用单次无工具私有 JSON 判别，严格校验后解包聊天正文或映射固定空参数任务申请。原文、人设、历史、预算、取消、generation 和错误隐私继续使用现有边界。
- `apps/desktop/src/main/conversation/conversation-chat-adapter.ts`：只导出原有宿主提示常量供准确识别，提示正文与原版本逐字一致。DeepSeek 不采用新协议。

没有修改 Core、文件路径解析、模型连接、任务授权或独立表现协议，没有新增依赖、模型请求、重试、协议回退或关键词路由。任务决定仍须进入 Main 范围确认，模型不能自授文件权限；替换后的 Qwen 正式入口只有一条协议路径。

TDD 先确认本地 Provider 新断言出现 27 项预期失败，再完成最小实现并通过 65 项测试。Main 组合新增 6 条边界用例，覆盖确认前零执行、拒绝、取消／reset 后迟到输出及伪造许可；对应 RED/GREEN 完成后，完整组合 27 项通过。最后联合 ChatAdapter、协调器及云 Provider 共 201 项通过。

本地进程测试夹具删除旧正文／能力联合 JSON 及退役文件工具回复，改为当前私有判别和独立表现协议。实际 LocalModelProvider 到假进程 HTTP 的新增测试先复现手写 Schema 不一致导致的 HTTP 400，再修正夹具；11 项通过。未通过修改生产 Schema 迁就夹具。

独立子智能体从规范、规格和最终诊断判定检查，未发现本范围内可行动问题；确认 DeepSeek 原提示字节一致、未许可命令不能被探针当作通过。该审查不替代真实模型和窗口验收。

## 6. 当前实现的真实模型证据

全部文件操作仅发生在验收器新建的隔离目录，用户目录和人设设置未修改。最后生产改动是补充 Qwen 私有提示：直接询问磁盘事实也应申请查阅任务，不因尚未读取而重复口头询问。下表只将该改动后的记录作为当前源码证据。

| 当前源码场景 | 每轮事实与结果 |
| --- | --- |
| 实际角色人设，根目录 → `a` → `abc.txt` 三轮自然请求 | 三轮均申请范围并实际 `read`，路径依次为 `.`、`a`、`a/abc.txt`；根目录四项正确，子目录仅 `abc.txt`，末轮真实空正文且总结正确。通过 |
| 简洁合成人设，根目录与子目录均含 `ab.txt`，正文不同 | 三轮均申请范围并实际 `read`，路径依次为 `.`、`a`、`a/ab.txt`；最终显示子目录随机正文，不含根目录随机正文。通过 |
| 两组自然三轮后的讨论与明确拒绝 | 每条负例先重置会话；`你觉得a目录需要整理吗？`、`不要查看a目录，只告诉我如何整理文件夹。` 均零范围、零工具。任务隔离通过；个别独立表现输出校验失败，普通聊天仍交付 |
| 强合成人设，截图固定五轮加两个负例 | 第 1、3、5 轮实际正确读取根目录、`a` 和空 `a/abc.txt`，总结经人工核对正确；两条负例零任务。但第 2、4 轮额外申请白名单外命令，整组退出码 1、`automatedChecksPassed:false`，完整场景失败 |

当前源码自然三轮的提示依次为“你帮我看看当前目录下都有什么呀”“那a目录下又有什么呀”“看看里面的abc.txt写了什么，把完整内容显示给我。”；同名文件场景最后文件名改为 `ab.txt`。它们代表正常任务完成后的下一项请求，不能替代截图中重复确认的完整五轮。

强人设第 2 轮已经实际读到空文件，仍提出 `powershell -Command "Get-Content 'a\abc.txt' -ErrorAction SilentlyContinue"`；第 4 轮提出 `dir "a\abc.txt"`。两者未在诊断预批准命令集合内，按原许可边界拒绝。此失败说明后续任务的命令选择仍可能增加确认或中断，不是子目录被解析为根目录；没有扩大白名单或放宽生产许可将它改写为通过。

当前版本证据在会话私有目录：`decision-final-actual-natural.log` 与对应 conversation trace、`decision-same-name-facts.log` 与对应 trace、`decision-final-followup.log`。自然三轮通过记录含真实读工具与范围事件，实际人设末轮有空文件 URI／内容检查；所有运行均清理模型，未调用云 Provider。强人设探针另记录五份源码指纹、bundle 指纹及清理事实，源码未变。

以下实现期间失败也保留，不与最终版本的通过片段拼接：

- 初版私有协议的实际人设固定五轮，在重复确认时产生 `cd ... && .\ab.txt` 的未许可命令；已拒绝，整组失败，见 `decision-actual.log`。
- 初版私有协议的简洁人设同名文件三轮，前两轮返回聊天，仅最后正确读取子文件。旧临时脚本只检查末轮，曾输出场景通过；人工复核判定整组失败，见 `decision-same-name.log`。随后补充事实查询提示；最终同名文件归档 bundle 仍用末轮硬断言，其三轮通过结论来自人工核对 trace 中每轮申请、真实读取与成功状态。此后收紧临时自然三轮脚本，要求每轮成功、范围申请及实际工具事实，再运行 `decision-final-actual-natural`，该实际人设归档 bundle 已包含逐轮硬断言。
- 初版私有协议强人设固定五轮曾通过，但不能用于宣称最终源码五轮通过。

因此本次可确认 Qwen 专用适配已解决所测明确子目录请求的入口漏申请，并能正确读取空文件及同名子文件；尚不能声称所有连续对话稳定，或整体已达到 OpenCode 的可靠性水平。

## 7. 当前源码门禁与交付状态

当前定向命令为：

```powershell
node node_modules/vitest/vitest.mjs run --config apps/desktop/vitest.config.ts apps/desktop/tests/local-model-provider.test.ts apps/desktop/tests/main-conversation-composition.test.ts apps/desktop/tests/conversation-chat-adapter.test.ts apps/desktop/tests/conversation-coordinator.test.ts apps/desktop/tests/openai-provider.test.ts
```

| 检查 | 当前实际结果 |
| --- | --- |
| 上述五文件定向测试 | 201 项通过，最终提示改动后重新运行通过 |
| `pnpm.cmd verify:desktop` 中全 workspace 类型检查 | 通过 |
| 同一门禁中的 Core 完整测试 | 108 项通过、1 项跳过 |
| 同一门禁中的单元测试 | 2884 项通过、40 项失败，整体失败，后续阶段被阻断 |
| `pnpm.cmd test:security` | 16 项通过 |
| `pnpm.cmd test:integration` | 64 项通过、1 项失败；本地进程夹具 11 项包含在通过项中 |
| `pnpm.cmd --filter @myself/desktop build` | 通过，含 preload、MCP 及本地模型生产边界校验 |
| 窄范围真实 Electron 本地模型生命周期 | 1 项通过；使用最终桌面构建和脚本化本地进程，不能替代真实 Qwen 推理实测 |

当前集成唯一失败是 `tests/integration/provider-server.test.ts:161` 将自然正文“向左移动”按旧 JSON 解析。同一失败在新协议实施前的日志已存在；本次未修改共享云 Provider 夹具或 DeepSeek 行为来消除它。

最终单元失败集中在 7 个未修改测试文件：角色动作编辑 3 项、角色运动 IPC 1 项、角色包服务 3 项、角色 V3 切换 1 项、Explorer 资源边界 1 项、桌宠位置 1 项、视觉几何 30 项。其中包括两项 5 秒超时。本次没有逐项恢复基线复现，不把 40 项一概标记为既有问题，也不将完整门禁标记通过。桌面构建和相关 Electron 检查已另行执行通过；未重新执行无关的全量 Electron 场景。

Electron 命令为：

```powershell
pnpm.cmd exec playwright test --config tests/playwright.config.ts desktop.spec.ts --grep '内置本地模型在真实 Electron 中经历加载、CPU 就绪、云路由恢复与退出清理'
```

该用例先验证加载阻止发送、本地聊天正文可见、Qwen 任务申请生成原范围卡及确认前零写入，再验证关闭本地模型后撤销旧卡、进程与 token 文件消失、云路由恢复、重新启用与最终退出清理，并检查公开日志不含私有哨兵。最终 1 项通过，耗时 8.5 秒。

首次运行已走过本地路径，但在云回复处失败。私有诊断证明：关闭本地模型释放待确认状态后，既有活动匹配先发出无工具的两字段 JSON 请求，消耗了测试预留给云聊天的首条回复；它不是自主心情请求。仅在本生命周期测试中复用 `activityMatchStep()` 并严格检查活动提示和根 Schema，发送聊天前等待该条完成，云请求总数精确从 2 改为 3；没有修改云 Provider、产品设置或共享测试服务器。两轮诊断 RED 后，最终 GREEN，临时诊断代码已移除。

当前门禁日志为 `decision-final-targeted.log`、`decision-verify-desktop.log`、`decision-security.log`、`decision-final-integration.log`、`decision-final-desktop-build.log`、`decision-electron-lifecycle-final-green.log`。Electron 首次失败保留为 `decision-final-electron.log`；请求类型证据为 `decision-cloud-sequence.json`，只记录合成请求的结构及类型布尔值。

最终只读差异确认 ChatAdapter 仅有常量导出和引用改名，DeepSeek 原宿主提示字节一致；Core、云 Provider、官网、CloudBase 和扫描器源码无本次差异。相关文档链接与中文编码、`git diff --check` 通过；真实 Qwen 进程清理完成。用户原有研究资料修改保持。

未修改用户 Provider 选择、真实文件、角色、安装版或官网业务；没有 Git 写操作、安装或发布。真实 Windows 使用体验、用户安装环境与更长连续任务仍待人工确认。
