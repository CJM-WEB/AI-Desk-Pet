# 角色工作台 30 秒草稿与关闭提示实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把角色工作台的 500ms 重置式自动保存替换为固定 30 秒检查点，并在关闭工作台窗口且草稿未保存时提供右上角二选一提示。

**Architecture:** Renderer Store 继续作为草稿修订与保存单飞权威；首次变脏只建立一个 30 秒检查点。现有关闭请求增加原因，工作台窗口关闭先由 Renderer 判断并立即允许或拒绝；拒绝时由右上角常驻提示处理选择，放弃成功后再次走同一标准关闭请求。

**Tech Stack:** TypeScript、React、Zustand、Electron IPC、Vitest、Testing Library。

## Global Constraints

- 仅拦截角色工作台窗口右上角关闭按钮，不改变整个 AI Pet 的退出事务。
- 自动保存间隔固定为 `30_000ms`；持续编辑不重置首次检查点。
- 手动保存、角色切换、编译发布等现有显式保存边界保持立即执行。
- 不新增依赖、草稿文件、持久化字段或角色包 Schema。
- 文档、用户文案和结构性注释使用中文。

---

## 文件职责

- `character-workshop-store.ts`：30 秒检查点、关闭提示暂停状态、未保存判断和放弃草稿。
- `CharacterWorkshopView.tsx`：桥接带原因的关闭请求，组合右上角确认提示并处理两个动作。
- `TransientToastLayer.tsx`：为现有提示增加可选常驻与操作按钮，不包含工作台业务。
- `myself-api.ts` / `preload/index.ts`：把关闭原因传给 Renderer，并回传严格布尔决定。
- `character-workshop-close.ts`：只有窗口关闭请求获准时才隐藏；应用退出仍走原显式刷新。
- 对应测试文件：分别覆盖 Store 时序、Toast 通用行为、Renderer 选择、Preload 边界与 Main 隐藏裁决。

### Task 1：固定 30 秒草稿检查点

**Files:**
- Modify: `apps/desktop/src/renderer/src/characters/store/character-workshop-store.ts`
- Test: `apps/desktop/tests/character-workshop-store.test.ts`

**Interfaces:**
- Consumes: 现有 `flushDraft(): Promise<void>`、`draftRevision`、`savedRevision` 与保存单飞。
- Produces: `hasUnsavedDraft(): boolean`、固定 `DRAFT_CHECKPOINT_INTERVAL_MS = 30_000`，以及不重置的检查点调度。

- [ ] **Step 1: 写入失败测试**

增加或替换定时测试，核心断言如下：

```ts
store.getState().updateCurrentAction({ name: '第一次修改' });
await vi.advanceTimersByTimeAsync(29_999);
expect(saveCharacterDraft).not.toHaveBeenCalled();
store.getState().updateCurrentAction({ name: '持续修改' });
await vi.advanceTimersByTimeAsync(1);
expect(saveCharacterDraft).toHaveBeenCalledOnce();
expect(saveCharacterDraft.mock.calls[0]?.[1].actions[0]?.name).toBe('持续修改');
```

再覆盖在途保存出现新修订后不立即连写、结算后重新等待 30 秒，以及 `dispose()` 清理计时器。

- [ ] **Step 2: 运行 RED**

Run: `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/character-workshop-store.test.ts`

Expected: 旧实现会在 500ms 提前调用 `saveCharacterDraft`，固定检查点与不重置断言失败。

- [ ] **Step 3: 写入最小实现**

将重置式调度替换为单次检查点：

```ts
const DRAFT_CHECKPOINT_INTERVAL_MS = 30_000;

function scheduleSave(): void {
  if (saveTimer !== undefined || saveInFlight || closeConfirmationPending) return;
  if (draftRevision <= savedRevision) return;
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    void requestCheckpointSave().catch(() => undefined);
  }, DRAFT_CHECKPOINT_INTERVAL_MS);
}
```

自动请求只消费到点捕获的一次修订；保存结算仍脏时重新调用 `scheduleSave()`。`flushDraft()` 保持显式目标的立即单飞语义。

- [ ] **Step 4: 运行 GREEN**

Run: `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/character-workshop-store.test.ts`

Expected: 文件内全部测试通过，旧 500ms 业务断言已被 30 秒语义替换。

- [ ] **Step 5: 提交**

```powershell
git add -- apps/desktop/src/renderer/src/characters/store/character-workshop-store.ts apps/desktop/tests/character-workshop-store.test.ts
git commit -m "feat: 将角色草稿改为三十秒检查点"
```

### Task 2：右上角关闭确认与通用提示操作

**Files:**
- Modify: `apps/desktop/src/renderer/src/components/TransientToastLayer.tsx`
- Modify: `apps/desktop/src/renderer/src/styles.css`
- Modify: `apps/desktop/src/renderer/src/characters/store/character-workshop-store.ts`
- Modify: `apps/desktop/src/renderer/src/characters/workshop/CharacterWorkshopView.tsx`
- Test: `apps/desktop/tests/transient-toast-layer.dom.test.tsx`
- Test: `apps/desktop/tests/character-workshop-close-renderer.test.tsx`
- Test: `apps/desktop/tests/character-workshop-store.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `hasUnsavedDraft()` 与检查点暂停能力。
- Produces: `prepareWindowClose(): Promise<boolean>`、`resumeAfterClosePrompt(): void`、`discardUnsavedDraft(): Promise<void>`；Toast 的可选 `persistent`、`dismissible`、`actions` 与 `onAction`。

- [ ] **Step 1: 写入 Toast RED**

```tsx
render(<TransientToastLayer
  queue={[{
    id: 'close', tone: 'warning', text: '草稿尚未保存，确定要关闭工作台吗？',
    persistent: true, dismissible: false,
    actions: [{ id: 'continue', label: '继续编辑' }, { id: 'close', label: '仍然关闭' }]
  }]}
  onAction={onAction}
  onDismiss={onDismiss}
  durationMs={() => 6000}
  ariaLabel="工作台提示"
/>)
```

断言推进任意计时不自动关闭、没有 `×`、两个按钮可点击且回传精确 ID；既有普通提示自动关闭与暂停测试继续通过。

- [ ] **Step 2: 写入 Store 与 Renderer RED**

断言未保存关闭会暂停检查点并返回 `false`；继续编辑恢复计时；放弃会重新读取当前角色的磁盘草稿。Renderer 收到 `window_close` 时显示上述提示，点击“仍然关闭”完成放弃后调用 `window.close()`；`app_quit` 只调用显式 `flushDraft()`，不显示提示。

- [ ] **Step 3: 运行 RED**

Run: `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/transient-toast-layer.dom.test.tsx tests/character-workshop-store.test.ts tests/character-workshop-close-renderer.test.tsx`

Expected: 现有 Toast 不认识操作项，Store 没有关闭方法，Renderer 仍直接刷新草稿。

- [ ] **Step 4: 写入最小实现**

扩展 Toast 的纯展示契约，并在 View 中组合唯一常驻提示：

```ts
type TransientToastAction = Readonly<{ id: string; label: string; tone?: 'default' | 'danger' }>;
type TransientToast = Readonly<{
  id: string;
  tone: ToastTone;
  text: string;
  persistent?: boolean;
  dismissible?: boolean;
  actions?: readonly TransientToastAction[];
}>;
```

Store 在关闭预检开始时清理检查点，等待现有保存后返回当前未保存事实；放弃成功通过现有 `getCharacterDraft()` 恢复草稿。View 对第一次未保存关闭立即返回 `false` 并显示提示，不让 Main 等待用户；放弃完成后再次调用 `window.close()`。

- [ ] **Step 5: 运行 GREEN**

Run: `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/transient-toast-layer.dom.test.tsx tests/character-workshop-store.test.ts tests/character-workshop-close-renderer.test.tsx`

Expected: 三个文件全部通过。

- [ ] **Step 6: 提交**

```powershell
git add -- apps/desktop/src/renderer/src/components/TransientToastLayer.tsx apps/desktop/src/renderer/src/styles.css apps/desktop/src/renderer/src/characters/store/character-workshop-store.ts apps/desktop/src/renderer/src/characters/workshop/CharacterWorkshopView.tsx apps/desktop/tests/transient-toast-layer.dom.test.tsx apps/desktop/tests/character-workshop-store.test.ts apps/desktop/tests/character-workshop-close-renderer.test.tsx
git commit -m "feat: 提示未保存草稿后再关闭工作台"
```

### Task 3：收紧跨进程关闭裁决并完成回归

**Files:**
- Modify: `apps/desktop/src/shared/myself-api.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/main/windows/character-workshop-close.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Test: `apps/desktop/tests/character-workshop-close-preload.test.ts`
- Test: `apps/desktop/tests/character-workshop-close.test.ts`
- Test: `apps/desktop/tests/preload-api.test.ts`
- Modify: `docs/operations/character-workshop-acceptance.md`

**Interfaces:**
- Consumes: Task 2 的 `(reason: 'window_close' | 'app_quit') => Promise<boolean>` Renderer 决定。
- Produces: sender/token 校验不变、严格原因解析、`window_close` 只有 `true` 才隐藏、`app_quit` 继续执行原显式刷新。

- [ ] **Step 1: 写入跨进程 RED**

Preload 测试断言非法原因不调用 listener；合法请求把原因传入并将 listener 返回的布尔值写入 ACK。Main 测试把旧“失败也隐藏”改为：

```ts
ipc.emit(acknowledgementChannel, window.webContents, { token: 'close-token', ok: false });
await Promise.resolve();
expect(window.hide).not.toHaveBeenCalled();
```

同时断言 `bindWindow` 发送 `window_close`，公开 `flush()` 发送 `app_quit`。

- [ ] **Step 2: 运行 RED**

Run: `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/character-workshop-close-preload.test.ts tests/character-workshop-close.test.ts tests/preload-api.test.ts`

Expected: 旧负载没有原因、忽略 listener 布尔返回，Main 在 `false` 后仍隐藏。

- [ ] **Step 3: 写入最小实现**

把关闭原因加入请求负载，Preload 只接受两个固定枚举并回传 listener 的布尔决定。Main 内部请求复用原 sender/token/timeout 单飞；`bindWindow` 仅在 `allowed === true` 时调用 `hide()`，`flush()` 保持应用退出刷新用途。

- [ ] **Step 4: 运行自动化门禁**

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/character-workshop-store.test.ts tests/transient-toast-layer.dom.test.tsx tests/character-workshop-close-renderer.test.tsx tests/character-workshop-close-preload.test.ts tests/character-workshop-close.test.ts tests/preload-api.test.ts
pnpm.cmd --filter @myself/desktop typecheck
pnpm.cmd verify:characters
git diff --check
```

Expected: 定向测试、类型检查与角色门禁退出 0；人工窗口体验由用户验收，不在自动化结果中伪造通过。

- [ ] **Step 5: 更新验收事实并提交**

只记录本轮实际执行的命令、结果和“真实窗口待用户验收”，然后执行：

```powershell
git add -- apps/desktop/src/shared/myself-api.ts apps/desktop/src/preload/index.ts apps/desktop/src/main/windows/character-workshop-close.ts apps/desktop/src/main/index.ts apps/desktop/tests/character-workshop-close-preload.test.ts apps/desktop/tests/character-workshop-close.test.ts apps/desktop/tests/preload-api.test.ts docs/operations/character-workshop-acceptance.md docs/superpowers/specs/2026-09-01-character-workshop-draft-autosave-design.md docs/superpowers/plans/2026-09-01-character-workshop-draft-autosave.md
git commit -m "feat: 完成工作台草稿关闭裁决"
```
