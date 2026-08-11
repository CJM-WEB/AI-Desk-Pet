# 默认聊天与设置浮层提示验收

## 验收范围

本文档验收 Electron 桌面端的默认聊天、明确文件任务安全链和设置浮层提示。自动化只连接本地脚本化 Provider，不访问真实 DeepSeek、其他外部 Provider 或公网。

## 自动证据

| 验收项 | 自动证据 | 通过标准 |
| --- | --- | --- |
| 连续聊天 | Electron E2E `默认聊天与设置浮层提示` | 连续发送“你好”、“聊天呀”、“我想和你聊天”，三条不同自然文本逐条可见，无旧固定澄清 |
| Markdown | 同一 Electron E2E | 标题、列表和代码块正文在可见消息中保留 |
| 模糊与知识讨论 | 同一 Electron E2E；`tests/security/permission-boundary.test.ts`；`tests/integration/desktop-agent.test.ts` | “帮我整理一下”和“如何更安全地删除文件”均走无工具聊天；不读取授权根、隐私或文件工具设置，不创建 File Agent 或 PathPolicy |
| 明确文件 | 同一 Electron E2E；既有文件确认、取消、跨 Provider 与路径边界 E2E | “列出当前文件夹”在无授权时只显示安全引导；授权后进入既有文件链，披露、确认、取消和路径边界继续回归 |
| Provider 边界与摘要 | `tests/integration/provider-server.test.ts` 与同一 Electron E2E | 非 POST、错误端点或错误授权在读取正文前即时拒绝；内存摘要只含 method、model、消息角色计数和 tools 计数，检查失败只保留稳定错误，不保留正文、密钥、路径、工具名或 Provider 原始正文 |
| 日志去标识化 | 同一 Electron E2E | API Key、授权根、全部用户输入、全部脚本回复和文件请求/回复均作为日志哨兵；渲染器原始诊断与 Electron 捕获日志均不得出现这些值 |
| Toast | 同一 Electron E2E；`apps/desktop/tests/settings-toast.dom.test.tsx` | 连接测试提示为 fixed 浮层且不改变主体几何位置；Electron 在 5 秒上界内观察自动消失，另一条立即手动关闭；2999/3000ms 精确边界由 fake timer 单测承担 |
| 完整门禁 | Task 6 报告的“完整非网站门禁”表 | 七个包 typecheck、unit、security、integration、desktop E2E、behavior 验证和两项 diff 证据按规定顺序退出 0 |

## 用户人工验收

以下项目需要在不记录密钥和聊天正文的前提下人工确认：

1. 使用用户自己的 DeepSeek 配置，评估多轮连续聊天的自然度和语气一致性。
2. 观察真实 Markdown、长代码块和换行在聊天窗口中的观感。
3. 在宽、窄设置窗口中检查 Toast 位置、遮挡和文本换行。
4. 检查 Toast 在 hover 和关闭按钮 focus 时暂停，移出或失焦后从剩余时间恢复。
5. 检查 Toast 关闭按钮可立即关闭，不抢占当前焦点。

## 明确后续项

本地长期记忆属于下一规格；截图、剪贴板和主动性也不在本次范围。这些能力当前仍禁用，本验收不声称已实现。

## 网站边界

本任务不修改、构建、启动或验证 `apps/website`，也不运行根 `pnpm typecheck`。最终以 `git diff --name-only -- apps/website` 零输出作为网站零修改证据。
