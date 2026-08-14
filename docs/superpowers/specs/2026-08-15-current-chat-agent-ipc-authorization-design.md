# 当前聊天窗口 Agent IPC 授权设计

> 文档状态：已批准（用户于 2026-08-15 确认执行）
>
> 日期：2026-08-15
>
> 设计编号：A2
>
> 总规格：[AI Pet 桌宠架构优化与恢复开发门设计](2026-08-15-ai-pet-desktop-architecture-optimization-design.md)
>
> 适用范围：`apps/desktop` 的 Agent mutating IPC 与聊天窗口生命周期

## 1. 目标

每次 Agent mutating IPC 调用都由 Electron Main 动态确认调用者是当前有效聊天窗口。pet、settings、character workshop、已销毁 chat 和已被替换的旧 chat 即使知道 `actionId` 或披露请求标识，也不能提交、取消、确认、披露或重置会话。

本设计关闭跨窗口权限扩大，不改变文件工具、PowerShell、Provider、会话状态机或确认对象的现有权威边界。

## 2. 当前事实

当前 `registerAgentIpc` 注册以下六个入口，但 handler 没有使用 `IpcMainInvokeEvent.sender`：

- `chatSubmit`
- `chatCancel`
- `actionConfirm`
- `actionCancel`
- `conversationDisclosureResolve`
- `conversationReset`

`apps/desktop/src/main/index.ts` 中的 `chat` 是可替换的闭包变量。`ensureChatWindow` 仅在原 `BrowserWindow` 已销毁时创建新窗口；正常 close 被 `hideOnClose` 拦截并转为 hide，随后 open 继续复用同一个窗口和 sender。因此：

- 普通 close → open 是同一聊天窗口，不产生“旧 sender”。
- 只有原 `BrowserWindow` 已销毁并由新窗口替换后，原 WebContents 才是旧 sender，必须立即失效。

所有窗口继续使用现有 `lockNavigation`：阻止 `will-navigate` 并拒绝新窗口。A2 复用这条导航边界，不建立第二套 URL 或 origin 策略。

## 3. 非目标

- 不按窗口拆分 Preload 或 `MyselfApi`。
- 不给角色、设置、桌宠交互或普通窗口命令套用聊天授权器。
- 不创建拥有所有窗口规则的通用授权框架。
- 不修改参数 Schema、Agent service、确认对象、generation、TTL 或 verified action。
- 不处理 chat reload 的展示恢复，不引入 snapshot、revision、事件缓存或重放。
- 不承诺抵御当前聊天 Renderer 本身被完全攻陷；该 Renderer 正是本阶段允许调用 Agent IPC 的主体。

## 4. 授权接口

新模块位于 `apps/desktop/src/main/ipc/agent-ipc-authorization.ts`：

```ts
import type { IpcMainInvokeEvent, WebContents } from 'electron';

export class AgentIpcAuthorization {
  constructor(
    private readonly getCurrentChatWebContents: () => WebContents | null
  ) {}

  assertCurrentChatSender(
    event: Pick<IpcMainInvokeEvent, 'sender'>
  ): void;
}
```

失败错误码固定为：

```text
AGENT_IPC_SENDER_INVALID
```

授权器在每次调用时读取当前值，不保存窗口标识。只有以下条件全部成立才返回：

1. 当前聊天 WebContents 已注册。
2. 当前聊天 WebContents 未销毁。
3. `event.sender` 与当前聊天 WebContents 是同一对象。

其余情况均抛出固定错误。错误和日志不得包含 `actionId`、requestId、命令、正文、路径、Provider 信息或窗口 URL。

## 5. Main 动态身份来源

Main 只维护一个动态 getter，供 A2 和后续 A3 复用：

```ts
const getCurrentChatWebContents = (): WebContents | null => {
  if (chat.isDestroyed() || chat.webContents.isDestroyed()) return null;
  return chat.webContents;
};
```

窗口替换时只修改现有 `chat` 变量。下一次授权调用自然读取新 WebContents，不需要注册、撤销或同步一份平行身份表。

## 6. IPC 接入规则

`registerAgentIpc` 的第三参数是必需依赖：

```ts
export function registerAgentIpc(
  ipcMain: IpcMain,
  service: AgentIpcService,
  authorization: Pick<AgentIpcAuthorization, 'assertCurrentChatSender'>
): void;
```

六个 handler 的执行顺序统一为：

```text
IpcMainInvokeEvent
  → assertCurrentChatSender
  → 严格参数 Schema
  → ConversationCoordinator / AgentService
```

授权必须先于 Zod 解析、`hasReportedFailure` 和所有 service 调用。非法 sender 即使携带畸形或敏感 payload，也只得到固定授权错误；业务模块调用次数为零。

## 7. 竞态与失败边界

- getter 返回 null、BrowserWindow 已销毁或 WebContents 已销毁时失败关闭。
- getter 读取与 service 调用之间若窗口随后销毁，会话既有 generation、取消和关闭机制继续裁决迟到结果；授权器不复制会话生命周期。
- 旧窗口替换测试通过可变 getter 证明，不增加测试专用 IPC。
- `render-process-gone` 后是否重建 chat 不属于 A2；如果未来引入重建，新的 BrowserWindow 必须更新现有 `chat` 引用后才获得权限。
- 当前导航策略完全阻止 Renderer 导航。如果以后允许受控导航，必须另立规格，把允许的 origin 与 frame 身份纳入授权，不可静默放宽本接口。
- 正常隐藏和再次显示不改变 sender，也不应使当前聊天窗口失效。

## 8. 自动验收

RED 矩阵必须覆盖：

- 当前 chat 成功。
- 未注册 chat 拒绝。
- 已销毁 chat 拒绝。
- pet、settings、workshop 拒绝。
- BrowserWindow 替换后旧 sender 立即拒绝，新 sender 立即成功。
- 六个 Agent mutating handler 对非法 sender 全部失败且 service、`hasReportedFailure` 零调用。
- 授权错误优先于敏感 payload 的 Schema 错误。
- 已知真实 `actionId` 从非 chat 窗口提交时仍被拒绝，聊天确认卡和本地文件保持不变。

## 9. 人工验收

- 在真实 Windows 多窗口环境确认 pet、settings 和角色工作室不能调用 Agent mutating IPC。
- 销毁并重建聊天 BrowserWindow 后，旧 WebContents 调用失效，新聊天窗口正常工作。
- 普通关闭聊天气泡只隐藏窗口；再次打开后同一窗口仍可正常提交。

没有实际执行 BrowserWindow 销毁替换时，该项记录为“待用户人工确认”，不能用普通 hide/open 冒充通过。

## 10. A2 与 A3 的依赖

A2 必须先于 [A3 会话事件投影](2026-08-15-conversation-event-projection-design.md) 完成。原因是 A3 上线前完整 `TaskEvent` 仍可能被非 chat 窗口读取，A2 必须先保证被读取的票据不可执行。A3 完成后仍保留“chat 获取真实 actionId、非 chat 尝试调用”的测试，证明授权防线不依赖票据不可见。

## 11. 完成定义

- 授权器动态读取当前 chat，无身份缓存。
- 六个 handler 均先授权后解析。
- 两参数 `registerAgentIpc` 旧入口归零。
- 非法 sender 的业务调用次数为零。
- A2 定向测试、Desktop typecheck、安全、集成和相关 Electron E2E 通过。
- 网站、CloudBase、扫描器与 cloudbase 业务文件零差异。
