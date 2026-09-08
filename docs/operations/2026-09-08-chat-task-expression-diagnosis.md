# 单一发送入口与角色执行诊断

日期：2026-09-08。源码基线：`1338bc7c`；文件阶段对照点：`d8a25f47`。

本文前半部分记录上述基线上的只读调查，末尾补充实施期间的真实检查；不是修复完成证明，也不批准新的实现方案。最初调查没有修改业务代码或执行文件任务。后续实现与实际通过范围以[独立验收记录](2026-09-08-single-send-expression-acceptance.md)为准；网站、CloudBase、扫描器、依赖及源模型配置保持不变，未打包或推送。

## 用户本轮确认的交互规则

1. 去掉“作为任务发送”，由同一个发送入口下的模型理解聊天与任务。模型申请任务后仍需 Main 的范围授权；单一入口不等于自动获得文件权限。
2. 对“当前目录是不是很乱”这类讨论，先说明尚未查看，征得用户同意后再申请读取。后续“可以，先看看”必须承接前文。
3. 实际移动时优先播放适合行走的动作；心情独立保留和衰减，停止后依据剩余心情选择状态。
4. 没有适合行走的动画时暂不移动，提示配置对应状态与动作。
5. 日常聊天尽量让文字与表现同时出现；没有匹配动作时，保持当前表现原有的正常生命周期。明确要求动作却缺少对应素材时，提示配置，不假装执行。

这些规则明确替代旧明确任务入口优先交付、八秒后允许 idle 位移，以及普通聊天无匹配即撤销当前表现的对应行为。其他已批准边界继续有效；正式规格仍需同步对应替代关系。

## 调查方法及边界

- 对比 Git 历史、现行入口、Provider、Director、Engine、Main IPC 与 Renderer 播放链。两项独立只读审查分别覆盖 OpenCode 入口及角色执行。
- 在内存中打包并调用真实 `CapabilityIntentRouter`；不修改源文件、不启动执行器。
- 启动当前开发版本观察原生桌宠，再结束本次启动的开发进程。持续移动使原生输入定位出现窗口边界变化；没有取得可靠的聊天界面复现或动画同步观察，不能记为视觉验收通过。
- 隔离调用当前正式 `ConversationChatAdapter` 与 Provider，使用已发布“紫色桌宠”的公开角色目录（三个状态、三个动作）。本地 Qwen 使用正式 Runtime/Vulkan；DeepSeek 使用现有 `deepseek-v4-flash` 与 Main 私有凭据回调。
- 两组隔离请求分别从空历史开始，保留组内真实助手正文；运行事实固定为聊天中、静止、无任务或拖拽。没有重建截图当时的完整会话、心情和计时上下文。
- 请求保留正式 SSE 路径。诊断在私有内存中读取响应副本后交给正式解码器，只输出状态码、长度、结构类型、能力类别和稳定错误码。没有输出密钥、角色正文、文件正文或原始响应。此观测会改变流式交付时序，不能用于衡量界面延迟。
- Qwen Runtime 已正常关闭；DeepSeek 诊断进程正常退出，诊断前后源 `settings.json` 哈希一致。临时诊断数据留在本次创建的系统临时目录，不进入仓库或产品运行入口。

## 证据一：自然读取请求未必进入文件核心

实际 Router 结果：

| 当前输入 | 路由结果 |
| --- | --- |
| 那你帮我看看当前目录下的ab文件夹内容有什么 | `chat`，允许模型升级 |
| 那你先帮我看看ab文件里有什么内容 | `chat`，允许模型升级 |
| 你会不会觉得当前目录里的文件比较乱呀？ | `chat`，允许模型升级 |
| 可以呀，你打算怎么分，而且你还没看文件夹呢你怎么知道该怎么分 | `chat`，允许模型升级 |
| 可以，先看看 | `chat`，允许模型升级 |
| 读取 ab.txt | `file_task` |

源码：`apps/desktop/src/main/conversation/capability-intent-router.ts`。该 Router、`packages/coding-task-core` 及 `coding-task-service.ts` 在文件阶段对照点到本次 HEAD 之间没有差异。入口残留问题早于此次角色改造；这不证明执行核心不存在其他缺陷。

普通聊天请求当前发送 `tools: []`、`toolChoice: none`，模型只能在角色 JSON 中填写 `capabilityPlan`。Coordinator 只有取得合法正文及 `agent_task` 后才申请范围授权。现有代码已保护首次合法能力字段不被表现修复覆盖，不能把这个已处理问题重复当成根因。

## 证据二：真实 Qwen 把读取要求回答成聊天

本次按表中顺序调用同一适配器，均返回 HTTP 200、正常 SSE 终止及合法 JSON：

| 顺序 | 输入 | 实际结果 |
| --- | --- | --- |
| 1 | 你好呀 | 合法正文 53 字符，`capabilityPlan.kind=chat` |
| 2 | 你真可爱 | 合法正文 81 字符，`capabilityPlan.kind=chat` |
| 3 | 那你帮我看看当前目录下的ab文件夹内容有什么 | 合法正文 235 字符，`capabilityPlan.kind=chat`，未申请任务 |

第三项复现了“未进入文件任务”的错误选择。此诊断没有文件执行器，结合 Coordinator 入口可确定该结果不会触发 Core；不能描述成 Core 尝试读取后失败。前两项未复现截图中 Qwen 的格式错误。

## 证据三：真实 DeepSeek 返回空白，引发格式错误

另一组按表中顺序调用当前适配器：

| 顺序 | 输入 | 实际结果 |
| --- | --- | --- |
| 1 | 你好呀 | 合法正文 17 字符，`chat` |
| 2 | 你真可爱 | 合法正文 24 字符，`chat` |
| 3 | 那你先帮我看看ab文件里有什么内容 | 合法正文 88 字符，`chat`，未申请任务 |
| 4 | 你表现得开心一点 | 首次正文 54 字符、重试正文 32 字符，两次均只有空白；HTTP 200，SSE 正常 `stop`，没有可见正文增量 |

第四项实际异常为 `RESPONSE_FORMAT_UNSUPPORTED`，阶段 `chat_control`，对应产品中的“模型响应格式不兼容，请重试。”。现有一次空响应重试确实执行了，仍未恢复；不是没有配置 API Key，也不是该次动画渲染失败。

因果链：Provider 成功收到空白 → `decodeResponseContractText` 判断没有正文 → `normalizeResponseContractText` 抛出稳定格式错误 → Coordinator 未进入表现接纳或文件授权。

源码：`apps/desktop/src/main/providers/openai-provider.ts`、`packages/agent-core/src/response-contract.ts`、`apps/desktop/src/main/conversation/conversation-coordinator.ts`。

[DeepSeek JSON Output 官方说明](https://api-docs.deepseek.com/guides/json_mode/)明确记录该模式可能偶发空内容。这与本次实测相符；不据此声称已证明服务端内部原因，也不能用一次复现解释全部历史截图。当前聊天强制使用 `response_format: json_object`；正文与角色结构化输出耦合使此失败直接阻断交互。

## 证据四：角色执行存在三处通用规则冲突

| 冲突 | 当前源码事实 | 出处与影响 |
| --- | --- | --- |
| 运动入口不统一检查动画 | Director 的明确移动等待八秒后仍会位移；持续、间断及续行也存在直接运动入口 | `character-behavior-director.ts` 的 `tick`、模式设置和 `commitPendingMotion`；旧补充规格允许 idle 降级，现被用户否定 |
| 活动候选与心情竞争，时间条件可相互抵消 | Engine 按分数、当前状态加分及两秒保持选择；活动仍受心情强度与模型计划有效期限制 | `character-expression-engine.ts` 的 `chooseState`、`eligibleState`；选对动作不等于实际能播。9 月 6 日已有 Qwen 三秒计划、十五秒淡入且绑定 `chatting=true` 导致未播放的记录 |
| 普通无匹配会中断，明确失败提示未闭合 | Adapter 提示无匹配用空状态列表；Engine 接纳空计划或新心情时可停止旧播放；明确请求交给模型后，没有匹配结果或调度失败不一定产生最终提示 | Adapter、Engine 的 `applyDecision`、Director 的 `prepareUserPrompt/completeUserPrompt`；与用户本轮“普通保持、明确缺失提示”的区分冲突 |

完整播放接线存在：已发布 V3 描述与素材 → 公开候选 → 模型建议 → Main Director/Engine → `behavior-action` → IPC → CharacterPlayer → Pixi。不能仅因“没有切动画”推断 Renderer 漏接。

另一个待实际观察的时序边界：MotionService 在改变窗口位置后发布 moving 事实；同步预检没有等到 Renderer `started` 回报。因此“存在可播放候选”本身不能证明首帧与位移同步。

历史证据见[角色运行记录](2026-09-06-custom-state-autonomy.md)；旧行为依据见[移动与表现补充规格](../superpowers/specs/2026-09-06-character-motion-expression-followup.md)及[自定义状态规格](../superpowers/specs/2026-09-05-ai-pet-custom-state-autonomy-design.md)。

## OpenCode 对照与下一步范围

本地参考仓库：`D:/AgentLearning`，固定提交 `2a6be0a03b93a6734070e10a6c3b56863475f214`。`packages/opencode/src/session/prompt.ts` 将同一会话消息和工具定义交给模型；`session/tools.ts` 在执行处进入原权限服务。普通工具流程不以先取得本项目的角色 JSON 为前提。

本项目已有原生 Provider 工具协议、Coordinator 范围卡和有限 OpenCode Core，可复用这些接缝。当前 Provider 的“正文与工具互斥”及“角色响应契约与工具互斥”需要在新规格中明确处理，不能仅隐藏按钮后宣称单一入口完成。此前两项原生入口实验没有通过，其历史结论继续有效；不能把同一个实验换名直接上线。

建议调整授权前入口与角色决策职责，保留现有执行核心、权限、人设与资源、单一角色引擎和播放器。候选方案需要比较统一复杂输出与独立表现决策在可靠性、调用数量及等待时间上的取舍，再形成获批规格和最小 RED/GREEN 计划。

本次没有修复或通过新的功能验收。仍需定位 Qwen 格式错误、验证完整普通发送及同意续句、实施统一运动前置条件，并在修复后进行有限的真实双模型与窗口核对。

## 2026-09-08 实施后有限真实检查补充

新入口下两模型自然读取已通过隔离目录随机标记核对；这不代表角色决策通过。有限角色请求显示：Qwen能返回形状合法的JSON，但明确开心有requestKind=state而explicitPlayback=null，行走在pendingMovement=true且目录含行走动作时返回空计划；空目录负例返回了目录外ID并被Main拒绝，正文保留。开心未记录mood强度与分数，因此Engine落到idle的唯一原因尚不能确定。

DeepSeek的开心／行走均返回HTTP200正文并在独立表现阶段发生严格形状失败。代码证据：OpenAIProvider只发送response_format的json_object，未发送responseContract.jsonSchema；CharacterExpressionAdapter只给零散字段说明，没有完整JSON形状。完整Schema仅由LocalModelProvider另传给llama.cpp。这是模型看不到格式约定的具体缺口，不是Core文件执行问题。

[DeepSeek官方JSON模式文档](https://api-docs.deepseek.com/guides/json_mode/)要求在提示中说明期望JSON格式并提供示例；json_object本身只约束JSON有效性。修正范围是在原表现适配器补齐模型可见契约和明确选择规则，保持现有严格接纳与失败隔离。此处记录的是现状证据与修复方向，修复结果以本轮独立验收记录为准。

真实原生窗口观察到mode2自行位移；但透明窗口的Computer Use截图缓存／输入定位连续恢复失败，未完成聊天输入和停止恢复的原生观察。开发进程输出还捕获一次CHARACTER_PLAYBACK_UNAUTHORIZED；缺具体status及token对照，当前无法唯一归因，不放宽权限检查，也不将其写成无异常通过。

补齐完整表现格式后，DeepSeek／Qwen各一次明确开心与行走的真实请求全部通过程序检查：开心给出合法explicit目标并进入开心状态；行走给出moving候选且Engine准备对应动画。Qwen在idle分数高于moving的情况下仍由宿主活动优先规则选择行走。该证据不覆盖真实Renderer首帧与原生视觉。

另一个有界历史场景暴露语义差异：“你觉得 note.txt 里的记录需要整理吗？”时，Qwen先聊天、同意后才申请并实际读取随机标记；DeepSeek在讨论阶段提前发出正式申请。测试在范围确认前阻止后续，实际工具为零。需在原主提示和工具说明中明确工具不是聊天征求同意的方式，同时保持明确事实查询和上下文同意的原生申请能力，不新增关键词分流。具体复验结果见最终验收记录。

主提示与工具说明修正后，仅重验失败的 DeepSeek 场景一次：讨论阶段零范围、零工具；用户同意后申请正式范围，范围确认前零工具；确认后原 Core 一次读取并返回隔离目录的随机标记。该复验通过，测试进程与本地模型进程均已结束，未重复已通过的 Qwen 或角色代表场景。

技术 Electron E2E 随后在跨 Provider 诊断中再次捕获 `CHARACTER_PLAYBACK_UNAUTHORIZED`，仍缺反馈令牌与时序对照，不能将原生那次归为孤例或宣布已消失。单一入口、任务取消、历史披露和 MCP 禁用的必要代表用例已取得通过结果，具体分批结果与其他未通过门禁见独立验收记录。
