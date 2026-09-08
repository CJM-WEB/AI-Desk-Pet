# 单一发送入口与独立表现验收记录

日期：2026-09-08。环境：Windows、pnpm workspace，开发构建；未打包、未推送。实施起点为 `0ec6ca57d14dada8fe5088e1146e349b07fa5f4c`；收尾起点为 `ea342c55b301aac1ef15d78418c8a3f21fe84357`，以下结果对应其后的本地工作区修改。适用[规格](../superpowers/specs/2026-09-08-single-send-expression-isolation-design.md)；计划不是验收证据。

## 本轮实现与退役

单一发送和 Enter 使用同一主请求。主请求只提供严格空参数的原生任务申请；Main 展示范围卡，原 Core 在确认后执行。普通正文先完成，再顺序请求独立表现；表现失败保留正文，取消整轮则丢弃迟到结果。自主模式与明确移动复用同一表现引擎、播放令牌和首帧门控。

收尾补齐云模型实际收到的完整表现 JSON Schema（直接复用正式 Schema），明确状态／动作填写 explicitPlayback，准备移动时按描述匹配 moving。主提示及工具说明明确“正式任务申请”不能替代聊天征求同意；文件名与建议讨论本身不启动任务，实际内容查询或同意查看才申请。这些修改没有增加关键词路由或第二个分类器，没有放宽 Main 授权。

删除旧 character_chat 联合协议、正文截断恢复、联合 JSON 流式投影、旧 DeepSeek 空白重试和 capabilityPlan 模型 Schema。内部 chat/agent_task 结果类型保留。精确删除文件：

- apps/desktop/src/main/providers/structured-text-stream.ts
- apps/desktop/src/main/providers/top-level-text-projector.ts
- apps/desktop/tests/provider-text-projector-consistency.test.ts
- packages/agent-core/tests/capability-control-plan.test.ts

上述均为替代后死代码或专用测试；未删除用户数据。旧修复矩阵迁移为严格独立表现、目录配对、字节预算和真实首帧门控测试。权限、进程取消、真实文件读写、任务 Core 流式与 MCP 禁用保持。

## 真实模型与程序证据

| 场景 | DeepSeek | 内置 Qwen |
| --- | --- | --- |
| 同一 submit 入口问候与自然读取隔离随机标记 | 程序通过，1 次真实 read | 程序通过，1 次真实 read；取消恢复、云路由隔离检查通过 |
| 讨论文件是否需要整理→同意→读取 | 初次讨论过早申请且被探针阻止，零工具；提示修复后单次复验通过，确认前零工具、Core 1 次 read | 首次通过，讨论零范围／零工具、确认前零工具、Core 1 次 read |
| 真实公开角色描述，明确开心 | 修复后严格表现合法，明确 state-2，Engine 产生对应播放 | 修复后严格表现合法，明确 state-2/state-2-action，Engine 产生对应播放 |
| 真实公开角色描述，明确行走 | moving 候选合法，Engine 准备 state/state-action-2 | moving 候选合法；即使 idle 分数更高，Engine 仍准备 moving 动作 |

修复后的开心／行走各模型各一次，共 8 次 HTTP，无重试；不是旧 44 项矩阵。真实模型返回的 mood、plan、explicit 经过正式 Adapter 和 Engine，未手填模型结果。四次代表耗时为 3523、2796、5028、6380 毫秒。行走准备时仍 moving=false，不伪造 Renderer started 回报。

详细原始过程（会话私有工作记录）位于 .superpowers/sdd/2026-09-08-single-send-expression-isolation/ 的 real-checks.md、task-5-role-model-checks.md、task-5-discussion-core-checks.md。其初始失败和修复后复验分别保留；不把一次成功写成所有偶发问题清零。空角色目录曾出现可选 CONTROL_SCHEMA_INVALID，正文与范围链仍正常；没有证据证明该类偶发失败全部消失。

## 自动化门禁

所有日志在上述工作记录目录。以下是已运行事实，未把受限运行标成完整 verify:desktop 通过。

| 命令或检查 | 实际结果 |
| --- | --- |
| pnpm.cmd typecheck | 全 workspace 通过；task-5-typecheck.log。后续桌面修正另以 pnpm.cmd --filter @myself/desktop typecheck 通过；task-5-final-desktop-typecheck.log |
| pnpm.cmd --filter @myself/coding-task-core test | 12 文件，108 通过、1 跳过；task-5-core.log |
| pnpm.cmd test:security | 16 通过；task-5-security.log |
| pnpm.cmd test:integration | 首轮 52 通过、2 超时；两个失败点串行复验均通过，未改超时阈值；task-5-integration.log、task-5-integration-failures-recheck.log |
| pnpm.cmd test:unit | 广跑 2794 通过、60 失败；下文分别说明迁移与旧问题，不能标成通过；task-5-unit.log |
| pnpm.cmd --filter @myself/desktop build | 构建与 preload／MCP／本地模型边界脚本退出 0；task-5-build.log |
| 技术 Electron E2E 首跑 | 精确排除 Win32 系统鼠标注入，达到 3 个失败上限后停止：55 通过、3 失败、22 未运行，运行器另报 1 个非测试错误；task-5-e2e.log |
| Core UI 失败点定向复验 | 两项取消后流程夹具补齐独立活动匹配，2 通过，退出 0；task-5-e2e-core-recheck.log |
| 剩余五项入口代表 | 三轮聊天、模糊请求、MCP 首次通过；挂起 reset 单次通过。跨 Provider 先因默认间断活动消费固定响应而失败，沿已有夹具配置静止模式后单次通过；日志见下文。不能据此宣称首跑未运行的其他 17 项通过 |

定向 RED/GREEN：退役联合协议的运行期防御测试先失败；DeepSeek 实际 HTTP messages 缺完整 Schema 先失败；主请求未区分正式申请与聊天征求同意先失败。分别在 task-5-red.log、task-5-schema-red.log、task-5-discussion-red.log 保留。对应定向 270、170、176 项通过，后两组包含本地请求预算。其他旧角色夹具迁移后 10 项通过，V3 切换的旧无动画位移断言迁移后 1 项通过。

广跑失败分类：

- 本轮旧联合协议／修复矩阵与无动画运动断言已迁移，独立角色 10 项和切换 1 项定向通过，不重跑全套矩阵。
- 几何／位置测试仍传 V2 清单，当前正式几何只接纳 V3，产生 PET_GEOMETRY_MANIFEST_INVALID；编辑器仍期待旧动作语义、carry 与提交帧 UI；IPC 测试仍期待已退役 behavior-authority。相关测试、实现与 V2/V3 清单契约相对本轮起点无差异，属于已有不一致，本轮未修改。
- 其他失败点串行复验 8 项通过，仍有 2 项角色包测试期待旧 runtime name“演示角色”，当前 V3 runtime 不返回该字段。相关包服务／测试相对本轮起点无差异，未改用户角色数据或导入行为。
- 并发执行时出现超时，串行失败点通过只证明该次复验；不据此断定超时根因。测试运行器退出码、失败计数和跳过范围均保留。
- E2E 双皮肤测试的 expectWinterRuntime 仍按旧运行时字段取数组，读取 undefined[0] 失败；该测试块及相关 V3 契约／角色服务相对本轮起点无改动。本轮不扩展修复角色导入业务。

E2E 首跑只执行一次：`node node_modules/@playwright/test/cli.js test --config tests/playwright.config.ts --grep-invert 'Win32 系统光标连续拖拽三轮时 Main 全程持有 owner 且尺寸恒定' --max-failures=3`。两项 Core UI 定向复验只执行一次：`node node_modules/@playwright/test/cli.js test --config tests/playwright.config.ts --grep '重复操作卡仅继续一次|停止运行中的 SSE'`。未将分批结果合并为完整套件通过。

剩余入口筛选记录（每行命令执行一次，均使用相同 Playwright 配置）：

- `--grep '无授权范围时连续三轮普通聊天|模糊请求按默认聊天回复|Chat 与 Agent 跨 Provider|模型挂起时新建对话|MCP 正式链'`：3 通过、1 失败。reset 实际名称含“模型响应挂起”，该正则没有匹配它；task-5-e2e-entry-recheck.log。
- `--grep 'Chat 与 Agent 跨 Provider|模型响应挂起时新建对话'`：reset 通过、跨 Provider 仍失败；task-5-e2e-disclosure-reset.log。跨 Provider 仅补两次活动响应不足，因为新对话后仍可能触发额外活动。
- `--grep 'Chat 与 Agent 跨 Provider'` 的四次有界诊断：task-5-e2e-disclosure-diagnostic.log、-2.log、-3.log、-4.log。第一次诊断访问了摘要中不存在的字段而失败，不计业务结果；后续摘要证明无工具请求会插入固定主响应序列。未记录私有正文或密钥，临时观测代码已移除。
- 同一单项筛选在已有 SettingsStore 夹具设 movementMode=0 后通过，1 项、退出 0；task-5-e2e-disclosure-green.log。只隔离本用例的后台活动，保留真实 Core、范围与三段跨 Provider 披露检查；没有新增响应分流框架。

首帧与剩余心情的程序代表：`node node_modules/vitest/vitest.mjs run --config tests/vitest.config.ts tests/integration/desktop-agent.test.ts -t '自定义心情表现与真实窗口运动独立且旧播放令牌失效'`，1 通过、37 跳过；task-5-motion-green.log。使用真实 Motion／CharacterService，在接纳当前播放令牌的首帧后才位移，动作结束按剩余心情恢复，过期片段不重播；没有实际原生窗口视觉证据。

## 原生观察、清理与未覆盖

原生透明窗口两次定位未能可靠打开聊天并发送明确指令；未成功观察真实 Renderer 首帧、窗口位移和停止后的心情恢复，均为“待用户人工确认”。开发输出曾有一次 CHARACTER_PLAYBACK_UNAUTHORIZED，跨 Provider 技术诊断 -3 也再次捕获此错误码；已有只读诊断没有确认归因，本轮不盲改、不放宽授权，也不宣称异常清零。技术 E2E 与 Engine 证据不代替人工观察。

真实模型检查结束后 Electron=0、llama-server=0，源设置哈希未变，各成功会话临时根完成清理。首次启动留下 %TEMP%/ai-pet-role-model-check-0m38lX，仅 Local State 和 settings.json 副本；自动审批以 blocked by policy 拒绝递归及精确文件清理，已停止尝试，本轮未触碰此目录。不能宣称所有临时文件均清除。

不在本次范围：原生 Win32 鼠标注入拖拽用例、干净环境安装卸载、生产部署、网站、CloudBase、扫描器、锁文件与依赖变更。MCP 仍禁用。

## 开发体验步骤

在仓库根目录运行 pnpm.cmd --filter @myself/desktop dev，沿用已有模型配置和角色。聊天窗口只有一个发送入口。可依次体验普通问候、“note.txt里面写了什么”、讨论是否需要整理后同意查看；真实文件操作仍须确认准确目录和命令范围。角色可体验“表现得开心一点”“向左一点”“停下”，核对首帧后才位移、停止后按剩余心情择态；无匹配素材应保持位置并提示配置。上述人工观察尚待用户确认。
