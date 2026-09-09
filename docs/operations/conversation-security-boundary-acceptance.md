# 会话安全边界验收记录

> 日期：2026-08-15（Asia/Shanghai）
> 适用规格：A2 `docs/superpowers/specs/2026-08-15-current-chat-agent-ipc-authorization-design.md`、A3 `docs/superpowers/specs/2026-08-15-conversation-event-projection-design.md`

## 1. 验收结论与边界

- 环境：Microsoft Windows 11 专业版，版本 `10.0.26200`，Build `26200`；Node.js `v24.18.0`；pnpm `11.9.0`。
- 分支：`AgentCoreExtension`。
- 验收文档提交前的代码 HEAD：`7296a35c306720034d709dcb0d0eabf395c3ffc1`（`test(desktop): 强化 worker 活性契约`）。
- 代码提交范围：`8df6097..7296a35c306720034d709dcb0d0eabf395c3ffc1`；本记录是该代码范围完成后的日期化验收文档。
- 验收文档提交 `ffb7138` 仅新增本记录，没有修改代码，也没有在该文档提交后重新运行门禁；下述最终复验证据均归属于验收文档提交前的代码 HEAD `7296a35`。
- 自动化功能证据：A2 当前聊天窗口授权、A3 会话事件按窗口投影、既有角色行为与搬运关键链均取得本次通过证据。
- 总体状态：**验收文档提交前的代码 HEAD 自动化门通过，真实 Windows 人工项待确认**。初次独立 `@myself/desktop test` 及其一次定向诊断均因 Vitest worker 的 `onTaskUpdate` RPC 超时退出 1；该历史失败完整保留。Task 5 已定位同步 PowerShell 场景阻塞 worker 的根因，以异步 `execFile` 和永久两轮活性契约修复；修复后目标 36/36、Desktop full 86/86，以及代码 HEAD `7296a35` 上各一次 `verify:desktop`、`verify:behavior` 均退出 0，且未再出现该 worker RPC 错误。
- 人工边界：真实 Windows BrowserWindow 销毁重建、普通 hide/open、多窗口视觉隔离以及 pet 动作与搬运主观观察均未由用户执行，状态保持“待用户人工确认”。
- 非目标：本验收不声称 snapshot、revision、reload 恢复、事件缓存或重放已经实现。

## 2. 自动化命令与真实结果

以下命令按任务简报顺序执行。失败命令保留原始失败状态，没有提高 timeout、retry，也没有反复运行到绿色。

| 序号 | 命令 | 退出码 | 实际结果 | 失败、警告与耗时 |
| --- | --- | ---: | --- | --- |
| 1 | `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/agent-ipc-authorization.test.ts tests/agent-ipc.test.ts tests/conversation-event-projection.test.ts tests/preload-api.test.ts tests/window-security.test.ts tests/character-behavior-service.test.ts` | 0 | 6/6 个文件、125/125 项通过 | Vitest 1.15 秒；命令墙钟约 3 秒；无失败。 |
| 2 | `pnpm.cmd --filter @myself/desktop typecheck` | 0 | `tsc --noEmit` 通过 | 墙钟 10.78 秒。 |
| 3 | `pnpm.cmd --filter @myself/desktop test` | 1 | 86/86 个文件的断言通过；1736 项通过、14 项跳过；另有 1 个未处理错误 | `Error: [vitest-worker]: Timeout calling "onTaskUpdate"`；Vitest 95.27 秒。既有 stderr 包含角色失败降级稳定码及 JSDOM Canvas 未实现提示。 |
| 3a | `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/explorer-space-shell-tab-helper.test.ts` | 1 | 一次定向诊断：1/1 个文件、35/35 项断言通过；另有同一未处理错误 | 同一 `onTaskUpdate` 超时可复现；Vitest 67.83 秒。该结果不能替代序号 3 的失败。 |
| 4 | `pnpm.cmd test:security` | 0 | 1/1 个文件、20/20 项通过 | Vitest 1.33 秒；无失败。 |
| 5 | `pnpm.cmd test:integration` | 0 | 4/4 个文件、46/46 项通过 | Vitest 4.81 秒；无失败。 |
| 6 | `pnpm.cmd --filter @myself/desktop build` | 0 | Main、Preload、Renderer 构建及 Preload 外部依赖校验通过 | 构建约 5.71 秒；`lucide-react` 的两条 `"use client"` 指令被忽略警告保留。 |
| 7 | `pnpm.cmd exec playwright test --config tests/playwright.config.ts tests/e2e/desktop.spec.ts --grep "只有当前聊天窗口\|会话任务事件只向 chat\|自主行为\|搬运"` | 0 | 5/5 项通过 | 47.4 秒；Node 报告 `NO_COLOR` 因 `FORCE_COLOR` 被忽略。 |
| 8 | `pnpm.cmd verify:desktop` | 0 | workspace typecheck 通过；unit 109/109 文件、2173 项通过、14 项跳过；security 20/20；integration 46/46；Desktop E2E 61/61 | E2E 约 3.3 分钟；完整链实际到达末尾。保留既有角色失败降级 stderr、JSDOM Canvas 提示、两条 build 警告与 `NO_COLOR` 警告。 |
| 9 | `pnpm.cmd verify:behavior` | 0 | character-runtime 13/13 文件、221/221；agent-core 2/2 文件、49/49；Desktop typecheck 通过；Desktop 86/86 文件、1736 项通过、14 项跳过；security 20/20；integration 46/46；Desktop E2E 61/61 | E2E 约 3.3 分钟；完整链实际到达末尾。保留与序号 8 同类的既有 stderr/build/环境警告。 |

序号 3 与 3a 是修复前的真实失败，不能由后续结果改写。Task 5 的根因、RED/GREEN 与修复后验证见下一节。

### 2.1 Task 5 worker 活性修复证据

- 根因：`explorer-space-shell-tab-helper.test.ts` 的固定场景运行器使用同步 `spawnSync` PowerShell；35 项场景累计阻塞单个 Vitest worker 超过 birpc 的 60 秒期限，使断言全部通过后仍发生 `onTaskUpdate` RPC 超时。该问题不是 A3 投影生产逻辑引入。
- 最小实现：提交 `9d3ea92` 仅把目标测试运行器替换为异步 `execFile`，保留每场景独立 PowerShell、`windowsHide: true`、5000ms 子进程期限、退出码、严格 stderr、stdout 单行 JSON 与解析契约；没有修改生产 Helper、PowerShell/C# fixture、Vitest timeout、retry 或 `maxWorkers`。
- 初始稳定 RED：新增活性契约在同步运行器上退出 1，36 项中 1 项失败、原 35 项通过；期望 `event-loop`、实际 `scenario-finished`，不是以 worker RPC 超时作为 RED。
- 复审 mutation RED：先调度 `setImmediate` 再执行真实 `spawnSync` 的同步变体仍稳定退出 1，1 项失败、35 项跳过；第一轮即观察到 `scenarioSettled === true`。提交 `7296a35` 将永久契约强化为真实场景 Promise 在连续两轮 `setImmediate` 中都不得 settled。
- GREEN：复审后的目标文件仅运行一次，退出 0，36/36 通过，活性契约 783ms，Vitest 25.43 秒；无 unhandled error、无 `onTaskUpdate`。
- Task 5 Desktop full：退出 0，86/86 个文件通过，1737 项通过、14 项跳过；目标文件 36/36，通过时无 worker RPC 超时。

### 2.2 验收文档提交前的代码 HEAD 最终复验

以下两条命令在 `7296a35c306720034d709dcb0d0eabf395c3ffc1` 上各仅运行一次，失败不重跑：

| 命令 | 退出码 | 当前真实结果 | 警告与耗时 |
| --- | ---: | --- | --- |
| `pnpm.cmd verify:desktop` | 0 | workspace typecheck 通过；unit 109/109 文件、2174 项通过、14 项跳过；helper 36/36；security 20/20；integration 46/46；build 通过；Electron E2E 61/61 | unit 38.70 秒，E2E 3.2 分钟；无 `onTaskUpdate`。保留角色失败路径 stderr、JSDOM Canvas、两条 `use client` 与 `NO_COLOR` 警告。 |
| `pnpm.cmd verify:behavior` | 0 | character-runtime 221/221；agent-core 49/49；Desktop typecheck 通过；Desktop 86/86 文件、1737 项通过、14 项跳过；helper 36/36；security 20/20；integration 46/46；build 通过；Electron E2E 61/61 | Desktop 41.97 秒，E2E 3.2 分钟；无 `onTaskUpdate`。保留同类既有 stderr/build/环境警告。 |

这两次新鲜完整门证明验收文档提交前的代码 HEAD `7296a35` 满足自动化完成定义；修复前两次退出 1 仍作为根因时间线保留。`ffb7138` 只新增本验收文档，未据此声称重新运行门禁。

## 3. A2 当前聊天窗口授权证据

| 验收点 | 状态 | 本次证据 |
| --- | --- | --- |
| 授权器每次动态读取当前 chat，不缓存空身份或旧身份 | 自动化通过 | 定向门中的 `agent-ipc-authorization.test.ts` 6/6 项通过，覆盖未注册、已销毁、窗口替换以及 pet/settings/workshop 非当前 sender。 |
| 六个 Agent mutating 通道先授权，再解析参数和进入 service | 自动化通过 | 定向门中的 `agent-ipc.test.ts` 25/25 项通过；非法 sender 的六通道矩阵、授权优先于敏感负载解析、service 与 `hasReportedFailure` 零调用均在该文件断言。 |
| 所有生产 `registerAgentIpc` 调用使用三参数动态授权 | 自动化通过 | 只读检索仅发现 1 个生产调用：`registerAgentIpc(ipcMain, conversationIpcService, agentIpcAuthorization)`；两参数旧调用只出现在否定静态断言文本中。 |
| 非 chat 窗口即使知道真实有效 `actionId` 也不能确认文件动作 | 自动化通过 | 关键 Electron E2E 中“只有当前聊天窗口能使用已知 actionId 确认文件动作”通过；该用例从 chat 获取真实票据，再由 pet、settings、workshop 调用并断言拒绝、确认卡保留、文件在 chat 确认前不创建。 |
| BrowserWindow 销毁并重建后的旧 WebContents 真实失效 | 待用户人工确认 | 自动化覆盖可变 getter 与 sender 替换语义；本次未进行真实 BrowserWindow 销毁重建人工观察。 |
| 普通关闭仅 hide，再次 open 后同一 chat 可继续提交 | 待用户人工确认 | 本次没有由用户执行真实 hide/open 人工验收，不能用自动化代替主观窗口观察。 |

## 4. A3 会话事件投影证据

| 验收点 | 状态 | 本次证据 |
| --- | --- | --- |
| `taskEventSchema` 是唯一运行时 Schema owner | 自动化通过 | 唯一定义位于 `packages/shared-types/src/contracts.ts`；Main 投影器使用 `parse`，Preload 使用同一 Schema 的 `safeParse`，未发现第二份定义。 |
| chat 接收八类合法完整事件 | 自动化通过 | `conversation-event-projection.test.ts` 的完整事件矩阵通过；关键 E2E 进一步观察到 chat 的 message、pending action 与 phase。 |
| pet Renderer 只接收严格 `{ type, phase }` | 自动化通过 | 投影单元测试与关键 E2E 均通过；E2E 对 pet 的所有会话事件键集合执行严格断言。 |
| settings 与 character workshop 不接收会话任务事件 | 自动化通过 | 关键 E2E 对两个窗口的事件数组断言严格为空，并检查非 chat 观察值不含票据、命令、预览、披露标识、正文哨兵或绝对授权路径。 |
| 无效事件在副作用前丢弃 | 自动化通过 | 投影单测验证 Main 行为与 chat/pet 零调用；`preload-api.test.ts` 验证未知类型、额外字段及缺字段事件静默丢弃，合法事件只通知一次且退订有效。 |
| chat/pet 单目标失败互不阻断 | 自动化通过 | 投影单测验证发送失败按目标隔离，失败报告只接收 `chat` 或 `pet` 枚举。 |
| Main 行为与 carrying 保持 | 自动化通过 | `character-behavior-service.test.ts` 45/45 项通过；关键 E2E 的自主行为两项与回收站搬运一项通过，完整 `verify:behavior` 也通过。 |
| snapshot、revision、reload 恢复 | 不在本次范围 | A3 明确无状态、不缓存、不重放；本记录不声称这些能力存在。 |

## 5. 旧路径、范围与格式检查

| 命令 | 退出码 | 实际输出与裁决 |
| --- | ---: | --- |
| `rg -n "ipcChannels\.taskEvent" apps/desktop/src/main` | 0 | 仅 1 个命中：`conversation-event-projection.ts` 内的 `target.send`；Main 的会话事件窗口发送 owner 只有 `ConversationEventProjection`。 |
| `rg -n "characterWorkshopWindows\.getCurrent\(\).*taskEvent\|\[pet, chat, settings" apps/desktop/src/main/index.ts` | 0 | 命中第 682 行的宽窗口数组；上下文第 683 行明确为 `ipcChannels.characterEvent`，是合法角色事件广播，不是旧 `taskEvent` 广播。 |
| `rg -n "registerAgentIpc\(" apps/desktop/src apps/desktop/tests tests` | 0 | 9 个文本命中；生产只有 1 个三参数调用，另有函数声明、测试夹具及否定静态断言。未发现生产两参数调用。 |
| `git diff --check 8df6097..HEAD` | 0 | 执行时 `HEAD=7296a35`；无输出，代码提交范围无空白格式错误。 |
| `git diff --name-only 8df6097..HEAD -- apps/website tests/e2e/website.spec.ts tests/playwright.website.config.ts apps/cloudbase-api apps/package-scanner cloudbase` | 0 | 执行时 `HEAD=7296a35`；无输出，受保护网站、CloudBase、scanner 与相关网站 E2E/配置路径在代码提交范围内零差异。 |

网站和云端的结论只限于“受保护路径差异为零”。本次没有运行 `verify:website` 或 `verify:cloudbase`，不得据此声称网站、CloudBase 或 scanner 门禁通过。

## 6. 已知非阻断输出与关注项

- 已关闭的历史关注项：修复前独立 Desktop 全量测试及一次定向诊断均出现可复现的 `vitest-worker` `onTaskUpdate` RPC 超时；Task 5 已用稳定 RED、复审 mutation RED、36/36 GREEN、Desktop full 86/86 及当前两条完整门关闭该自动化缺口。历史退出 1 未被删除或改写。
- 既有测试 stderr：角色播放器失败降级用例输出 `CHARACTER_OPERATION_FAILED`、`CHARACTER_RESOURCE_INTEGRITY_FAILED`；对应测试断言通过。
- 既有 JSDOM stderr：`HTMLCanvasElement.getContext()` 未实现；对应工作室 Renderer 用例通过。
- 构建警告：第三方 `lucide-react` 的两个模块级 `"use client"` 指令在打包时被忽略；构建退出 0。
- 环境警告：Playwright 子进程提示 `NO_COLOR` 因 `FORCE_COLOR` 被忽略；E2E 退出 0。

## 7. 待用户人工确认

以下项目均为**待用户人工确认**，本记录不将其写为通过：

- [ ] 在真实 Windows 多窗口中销毁并重建 chat BrowserWindow，确认旧 WebContents 立即失效、新窗口可继续使用 Agent IPC。
- [ ] 普通关闭 chat 触发 hide 后再次 open，确认同一聊天窗口可继续提交，且未被误判为旧 sender。
- [ ] 同时打开 pet、chat、settings、角色工作室，视觉确认消息、错误、确认卡和披露卡只出现在 chat。
- [ ] 视觉确认 pet 对 listening、thinking、success、error 的动作反馈保持正常。
- [ ] 在专用测试目录完成一次真实文件搬运，视觉确认 carrying 动作与提交时机，并核对真实 Windows 结果。
- [ ] 人工确认销毁、隐藏、重新打开和应用退出后的窗口层级、焦点与清理表现。

没有上述人工证据前，不能把真实 Windows 多窗口行为或主观动画表现写为已验收。

## 8. 2026-08-20 减法 Task 6 最终门禁（A3）

A3 已删除完整 variant 的重复投影测试样本，并将“已知 `actionId`”非 chat 拒绝合并到会话事件投影 Electron 场景；旧场景名和 owner 均已移除。旧 owner 扫描在 `apps/desktop/src`、`apps/desktop/tests` 和 `tests/e2e` 内无输出（`rg` 退出码 1，表示零命中）。

本次 `pnpm.cmd --filter @myself/desktop typecheck`、`pnpm.cmd --filter @myself/desktop test`（85 个文件、1741 项通过、14 项跳过）、`pnpm.cmd test:security`（20/20）和 `pnpm.cmd test:integration`（46/46）均退出 0。`pnpm.cmd verify:behavior` 与 `pnpm.cmd verify:characters` 均退出 0，分别覆盖 Electron E2E 60/60；其中合并后的“会话任务事件只向 chat 完整投递、向 pet 只投递 phase 且非 chat 不能执行票据”通过。

`pnpm.cmd verify:desktop` 一次退出 1：此前各子链通过，但 Electron E2E 的“默认聊天与设置浮层提示”在关闭设置时报告页面或上下文已关闭，最终 59/60。该历史失败保留；一次构建后定向复现为 1/1（11.3 秒），且 `verify:behavior`、`verify:characters` 的完整 Electron E2E 均为 60/60。主裁决据此采用等价证据放行。只读诊断显示减法未触及窗口 owner、Electron fixture 或失败场景主体；页面/上下文关闭的细根因尚未证实。A3 自动化完成，B2/B3 只能在按本减法规格重写计划并再次审查删除门后进入。受保护路径差异和 `git diff --check 875048c..HEAD` 均为零；真实 Windows 多窗口视觉、销毁重建和 hide/open 人工项仍待用户确认。
