# 会话事件按窗口投影设计

> 后续范围更新：聊天展示恢复按[2026-09-13 当前会话持久化规格](2026-09-13-current-conversation-persistence-design.md)实施，取代本文将恢复排除在外的范围限制。新增快照仍仅向当前 chat 投递；任务事件的严格校验与按窗口裁剪继续有效。

> 文档状态：已批准（用户于 2026-08-15 确认执行）
>
> 日期：2026-08-15
>
> 设计编号：A3
>
> 总规格：[AI Pet 桌宠架构优化与恢复开发门设计](2026-08-15-ai-pet-desktop-architecture-optimization-design.md)
>
> 前置规格：[当前聊天窗口 Agent IPC 授权设计](2026-08-15-current-chat-agent-ipc-authorization-design.md)
>
> 适用范围：Main 会话事件投影、chat/pet 事件通道与 Preload 运行时解析

## 1. 目标

将权威 `TaskEvent` 运行时验证后按窗口职责裁剪：

- chat 接收完整公开事件。
- pet Renderer 只接收严格 phase 投影。
- settings 和 character workshop 不接收会话任务事件。
- Main 内部 `CharacterBehaviorService` 继续消费验证后的权威事件，以保持 pending action、carrying 和 phase 行为。

该设计防止确认票据、命令、预览、披露请求和会话正文扩散到不需要它们的 Renderer，同时保留角色动作反馈。

## 2. 当前事实

`apps/desktop/src/main/index.ts` 当前执行：

```text
TaskEvent
  → CharacterBehaviorService.handleTaskEvent
  → pet/chat/settings/workshop 全量广播
```

所有 Renderer 都装载同一 Preload，并在 `App.tsx` 中挂载 `onTaskEvent`。Preload 当前把 unknown payload 直接断言为 `TaskEvent`，没有运行时 Schema 验证。

Main 行为服务不是 Renderer 窗口。它需要可信事件中的：

- phase：驱动 listening、thinking、success、error、idle 与确认阶段。
- pending_action：阻止随机待机。
- character_carrying：更新 Main 权威运动快照。

因此 A3 裁剪窗口投影，但不把 Main 内部行为消费错误地当成跨窗口泄漏。

## 3. 非目标

- 不实现聊天 reload、显式销毁重建或应用重启后的展示恢复。
- 不引入 snapshot、revision、事件缓存、队列、持久化或重放。
- 不修改 `TaskEvent` Schema，不创建第二份 Desktop Schema。
- 不按窗口拆分 Preload 或 `MyselfApi`。
- 不迁移 `CharacterBehaviorService`、`ConversationCoordinator` 或 `AgentService` 权威。
- 不实施 Main 单一动作权威或删除 V1 兼容；这些属于后续独立规格。

## 4. 投影接口

新模块位于 `apps/desktop/src/main/conversation/conversation-event-projection.ts`：

```ts
import type { WebContents } from 'electron';
import type { TaskEvent } from '@myself/shared-types';

type TaskEventTarget = Pick<WebContents, 'isDestroyed' | 'send'>;

type ConversationEventProjectionOptions = Readonly<{
  getChatTarget(): TaskEventTarget | null;
  getPetTarget(): TaskEventTarget | null;
  applyCharacterBehavior(event: TaskEvent): void;
  reportDeliveryFailure?(target: 'chat' | 'pet'): void;
}>;

export class ConversationEventProjection {
  constructor(private readonly options: ConversationEventProjectionOptions) {}
  publish(rawEvent: unknown): TaskEvent;
}
```

`publish` 不保存状态。它先用现有 `taskEventSchema.parse` 验证，再执行 Main 行为与窗口投影，并返回验证后的事件。

## 5. 事件矩阵

| TaskEvent 类型 | Main 行为服务 | chat | pet Renderer | settings/workshop |
|---|---:|---:|---:|---:|
| `phase` | 完整验证事件 | 完整验证事件 | `{ type, phase }` | 不投递 |
| `message` | 完整验证事件 | 完整验证事件 | 不投递 | 不投递 |
| `pending_action` | 完整验证事件 | 完整验证事件 | 不投递 | 不投递 |
| `error` | 完整验证事件 | 完整验证事件 | 不投递 | 不投递 |
| `character_emotion` | 完整验证事件 | 完整验证事件 | 不投递 | 不投递 |
| `character_carrying` | 完整验证事件 | 完整验证事件 | 不投递；由 Main 运动事件反映 | 不投递 |
| `history_disclosure_required` | 完整验证事件 | 完整验证事件 | 不投递 | 不投递 |
| `conversation_reset` | 完整验证事件 | 完整验证事件 | 不投递 | 不投递 |

pet phase 投影只含 `type` 和 `phase`。它不得含：

- `actionId`、conversationId 或 requestId
- PowerShell 命令
- 文件正文、diff 或 content preview
- 历史披露票据和 Provider 名称
- 绝对路径、continuation 或 verified action
- message/error 文案

## 6. 投递顺序与失败隔离

每个事件按以下顺序处理：

```text
unknown
  → taskEventSchema.parse
  → Main CharacterBehaviorService
  → chat 完整公开事件
  → pet phase 投影（仅 phase）
```

无效事件在任何副作用前抛出，Main 行为和所有 Renderer 零调用。

目标可能在 `isDestroyed()` 检查与 `send` 之间销毁。单目标发送失败时：

- 捕获该目标的发送异常。
- 只报告 `chat` 或 `pet` 枚举及固定错误码。
- 不记录事件或原始异常正文。
- 一个目标失败不阻止另一个目标。
- 不重试、不缓存、不重放。

## 7. Main 装配

A3 复用 A2 的 `getCurrentChatWebContents`。pet target 动态检查 BrowserWindow 与 WebContents 是否销毁。settings 与 workshop 不注入投影器，因此结构上不存在投递路径。

现有 `emitConversationEvent` 改为：

```ts
const emitConversationEvent = (event: TaskEvent): void => {
  const validated = conversationEventProjection.publish(event);
  if (validated.type === 'error') reportedSubmitErrorCode = validated.code;
};
```

旧四窗口广播循环在新投影通过测试后同批删除，不保留 feature flag 或 fallback。

## 8. Preload 运行时边界

`onTaskEvent` 的公开类型保持不变，但收到的 IPC payload 按 unknown 处理：

```ts
const handler = (_event: Electron.IpcRendererEvent, payload: unknown): void => {
  const parsed = taskEventSchema.safeParse(payload);
  if (parsed.success) listener(parsed.data);
};
```

畸形事件不进入 Renderer listener，不输出原 payload。退订继续移除同一个固定 handler。

## 9. 自动验收

- chat 接收八种合法 `TaskEvent` 的完整验证值。
- pet 对全部 phase 只接收严格 `{ type, phase }`。
- pet 不接收 message、pending action、error 文案、emotion、carrying、披露请求或 reset。
- settings/workshop 对会话任务事件零接收。
- 无效事件不进入 Main 行为或任一 Renderer。
- chat/pet 一个目标销毁或发送失败不阻断另一个目标。
- Preload 丢弃畸形事件，合法事件只通知一次，退订有效。
- 现有角色 behavior E2E 仍观察到 listening、thinking、success、error 与 carrying 动作。
- A2 的已知 actionId 跨窗口拒绝 E2E 保持通过。

### 9.1 Vitest worker 活性例外与修复设计

2026-08-15 的 A3 任务 4 实测显示，`apps/desktop/tests/explorer-space-shell-tab-helper.test.ts` 在单个 Vitest worker 内对每个固定场景调用一次 `spawnSync` PowerShell。该文件的 35 项测试共启动约 36 次固定场景，且每次都会让 fixture 重新 `Add-Type` 编译；当同步调用累计阻塞 worker 超过 Vitest/birpc 的 60 秒 RPC 期限时，即使 35/35 断言已经通过，进程仍以退出码 1 结束，并报告 `[vitest-worker]: Timeout calling "onTaskUpdate"`。该问题不是 A3 引入，调整 `maxWorkers` 也不能让被阻塞的同一 worker 恢复处理 RPC。

批准的最小修复仅限该测试文件：

- 将固定场景运行器从同步 `spawnSync` 改为异步 `execFile` 或 `spawn`，并将调用方改为等待 `Promise<SelfTestResult>`。
- 每个场景仍独立启动一个 PowerShell 进程；保持 `windowsHide`、5 秒子进程期限、退出码检查、stderr 检查、单行 JSON 解析及既有场景断言。不得合并 fixture 编译、缓存结果或改变 PowerShell/C# fixture。
- 新增永久活性契约：先调用真实固定场景并跟踪其 Promise 是否 settled，随后连续等待两轮 `setImmediate` 事件循环；每轮观察时场景都必须仍未 settled，最后再等待场景成功。直接调用 `spawnSync` 会在返回前阻塞 worker，将 `spawnSync` 延迟到一轮 `setImmediate` 内也会在测试的第一轮观察前完成；两种同步实现都必须使 RED 失败，只有真异步子进程等待才满足契约。
- 不修改生产 Helper、fixture、Vitest timeout、retry 或 `maxWorkers`，也不将本问题归因于 A3。不得用提高阈值、重试或并行配置掩盖阻塞。

修复后的门禁顺序为：活性契约与原 35 项场景先通过，再分别运行 Desktop typecheck、Desktop 全量测试、`verify:desktop` 与 `verify:behavior`。任一 GREEN 验证失败时保留首次失败输出并停止诊断；不得反复重跑绿色命令来掩盖失败。临时 worker 诊断仅可用于定位，GREEN 前必须删除；永久保留的仅是活性契约和原有场景断言。

## 10. 人工验收

- 真实 Windows 多窗口中，确认卡和披露卡只在 chat 出现。
- pet 动作继续响应 listening、thinking、success、error 与文件搬运。
- settings 和角色工作室不出现会话消息、错误或确认内容。

未实际观察时记录为“待用户人工确认”。

## 11. 完成定义

- `taskEventSchema` 是唯一运行时 TaskEvent Schema owner。
- Main 的 taskEvent 窗口投递只有 `ConversationEventProjection` 一个 owner。
- 旧 pet/chat/settings/workshop 全量广播循环归零。
- Preload 不再把 unknown 直接断言为 `TaskEvent`。
- A3 定向测试、Desktop typecheck、安全、集成、行为与 Electron E2E 通过。
- Vitest worker 活性契约、原 35 项资源管理器固定场景、Desktop 全量测试、`verify:desktop` 与 `verify:behavior` 均在一次最终验证中通过。
- A3 没有引入 snapshot、revision 或第二套会话状态。
- 网站、CloudBase、扫描器与 cloudbase 业务文件零差异。
