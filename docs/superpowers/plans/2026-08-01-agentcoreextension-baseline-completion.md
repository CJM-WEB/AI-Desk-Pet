# AgentCoreExtension 基线收尾 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成 MCP Renderer 隐藏、消除用户拖拽与自动运动的窗口写竞争，并让预置服务商能够立即使用尚未进入静态目录的新模型 ID。

**Architecture:** 复用已提交的 `desktopRuntimeCapabilities.mcp = false` 作为 Main 与 Renderer 的唯一产品策略；在 `CharacterMotionService.tick()` 中明确让用户拖拽独占窗口位置；为预置模型档案增加可选的保守能力覆盖，使未知模型 ID 可以通过既有提供商协议和 Base URL 使用。所有修改均建立在现有类型、存储、Provider Registry 和测试框架上。

**Tech Stack:** Electron 43、React 19、TypeScript 5.9、Zod 3、Vitest 3、pnpm 11、Windows 10/11。

## Global Constraints

- 目标分支固定为 `AgentCoreExtension`，不合并到 `main`。
- MCP 相关组件、IPC、Preload、配置和密钥源码全部保留，不删除持久化数据。
- 用户拖拽期间只有 `PetWindowInteractionController` 可以调用窗口 `setPosition()`。
- 未知模型默认只声明 `chat` 能力，不凭名称推断工具、视觉或长上下文能力。
- 不新增运行时依赖，不重构无关设置页、角色运动或 Provider 请求实现。
- 文档、用户文案和结构性注释使用中文。
- 每个任务遵循先失败测试、最小实现、局部验证、独立提交。

---

### Task 1: Renderer 统一遵守 MCP 禁用策略

**Files:**
- Modify: `apps/desktop/tests/multi-provider-settings.test.tsx:250`
- Modify: `apps/desktop/tests/renderer-components.test.tsx:89`
- Modify: `apps/desktop/src/renderer/src/settings/SettingsView.tsx:1-150`

**Interfaces:**
- Consumes: `desktopRuntimeCapabilities.mcp: false` from `apps/desktop/src/shared/desktop-runtime-capabilities.ts`.
- Produces: `availableSettingsTabs(): readonly SettingsTab[]` and `resolveSettingsTab(tab: SettingsTab): SettingsTab` for a single tested Renderer policy.

- [ ] **Step 1: Write the failing navigation and fallback tests**

In `apps/desktop/tests/multi-provider-settings.test.tsx`, import the two helpers and replace the four-tab assertion with:

```tsx
import {
  availableSettingsTabs,
  resolveSettingsTab,
  SettingsWorkspace
} from '../src/renderer/src/settings/SettingsView';

test('MCP 禁用时设置导航不公开工具页且旧 tools 状态回退到模型档案', () => {
  expect(availableSettingsTabs()).toEqual(['models', 'privacy', 'local']);
  expect(resolveSettingsTab('tools')).toBe('models');

  const markup = renderToStaticMarkup(
    <SettingsWorkspace
      dashboard={dashboard}
      activeTab="tools"
      busy={false}
      notice={null}
      onTabChange={vi.fn()}
      onClose={vi.fn()}
      providerActions={{
        onSave: vi.fn(),
        onTest: vi.fn(),
        onRouteSave: vi.fn(),
        onDelete: vi.fn()
      }}
      mcpActions={{
        launchSummary: null,
        onCancelLaunch: vi.fn(),
        onUpsert: vi.fn(),
        onConfirmLaunch: vi.fn(),
        onTest: vi.fn(),
        onToggleServer: vi.fn(),
        onToggleTool: vi.fn(),
        onAuthorizeReadOnly: vi.fn(),
        onRevokeReadOnly: vi.fn(),
        onDelete: vi.fn()
      }}
      privacyActions={{
        incognito: false,
        onSave: vi.fn(),
        onIncognitoChange: vi.fn(),
        onChooseRoot: vi.fn(),
        onRevokeRoot: vi.fn()
      }}
      onClear={vi.fn()}
      onOpenCharacterWorkshop={vi.fn()}
    />
  );

  expect(markup).toContain('模型档案');
  expect(markup).not.toContain('MCP 服务');
});
```

Update `apps/desktop/tests/renderer-components.test.tsx` so its settings navigation assertion expects `模型`、`隐私`、`本地数据` and explicitly rejects the navigation label `工具` through `availableSettingsTabs()` instead of searching all page copy.

- [ ] **Step 2: Run the focused tests and verify failure**

Run:

```powershell
pnpm --filter @myself/desktop test -- multi-provider-settings.test.tsx renderer-components.test.tsx
```

Expected: FAIL because `availableSettingsTabs` and `resolveSettingsTab` are not exported and the current tab list still includes `tools`.

- [ ] **Step 3: Implement the shared Renderer policy**

In `SettingsView.tsx`, keep the `McpSettings` component and callback types, import the capability policy, and derive visible tabs:

```tsx
import { desktopRuntimeCapabilities } from '../../../shared/desktop-runtime-capabilities';

const tabs = [
  ['models', '模型', Bot],
  ['tools', '工具', Wrench],
  ['privacy', '隐私', ShieldCheck],
  ['local', '本地数据', Database]
] as const;

export function availableSettingsTabs(): readonly SettingsTab[] {
  return tabs
    .filter(([id]) => id !== 'tools' || desktopRuntimeCapabilities.mcp)
    .map(([id]) => id);
}

export function resolveSettingsTab(tab: SettingsTab): SettingsTab {
  return tab === 'tools' && !desktopRuntimeCapabilities.mcp ? 'models' : tab;
}
```

Inside `SettingsWorkspace`, calculate `const activeTab = resolveSettingsTab(props.activeTab)`, filter `tabs` with `availableSettingsTabs()`, use `activeTab` for `aria-current` and panel rendering, and keep the `McpSettings` branch guarded by both `activeTab === 'tools'` and `desktopRuntimeCapabilities.mcp`.

Inside `SettingsView`, pass all tab changes through `resolveSettingsTab` so stale or restored `tools` state cannot render a blank pane.

- [ ] **Step 4: Run focused and type checks**

Run:

```powershell
pnpm --filter @myself/desktop test -- multi-provider-settings.test.tsx renderer-components.test.tsx
pnpm --filter @myself/desktop typecheck
```

Expected: PASS. The source still contains `McpSettings`, but rendered navigation and fallback cannot expose it while the capability is false.

- [ ] **Step 5: Commit Task 1**

```powershell
git add apps/desktop/src/renderer/src/settings/SettingsView.tsx apps/desktop/tests/multi-provider-settings.test.tsx apps/desktop/tests/renderer-components.test.tsx
git commit -m "feat：隐藏桌面端 MCP 设置入口"
```

### Task 2: 用户拖拽独占窗口位置写入

**Files:**
- Modify: `apps/desktop/tests/character-motion-controller.test.ts:367-430`
- Modify: `apps/desktop/src/main/characters/character-motion-service.ts:131-160`

**Interfaces:**
- Consumes: existing `beginUserMove()`, `handleWindowMoved()`, `endUserMove()` lifecycle.
- Produces: `tick()` guarantees zero programmatic `setPosition()` calls while `userMoving === true` and continuously adopts native window bounds as the new target.

- [ ] **Step 1: Write the failing interleaving test**

Add this test beside the existing user-move tests:

```ts
test('用户拖拽期间 tick 不写窗口且采用拖拽中的真实位置', () => {
  let now = 0;
  let bounds = { x: 0, y: 0, width: 180, height: 220 };
  const setPosition = vi.fn((x: number, y: number) => {
    bounds = { ...bounds, x, y };
  });
  const service = new CharacterMotionService({
    window: { getBounds: () => bounds, setPosition },
    getWorkAreas: () => [{ x: 0, y: 0, width: 800, height: 600 }],
    now: () => now
  });

  service.moveTo({ x: 0, y: 0 }, 100);
  service.beginUserMove();
  bounds = { ...bounds, x: 48, y: 64 };
  now = 16;
  const dragging = service.tick();

  expect(setPosition).not.toHaveBeenCalled();
  expect(dragging.position).toEqual({ x: 48, y: 64 });
  expect(dragging.target).toEqual({ x: 48, y: 64 });

  bounds = { ...bounds, x: 96, y: 112 };
  service.endUserMove();
  now = 32;
  const released = service.tick();
  expect(setPosition).not.toHaveBeenCalled();
  expect(released.position).toEqual({ x: 96, y: 112 });
});
```

- [ ] **Step 2: Verify the test exposes the race**

Run:

```powershell
pnpm --filter @myself/desktop test -- character-motion-controller.test.ts
```

Expected: FAIL because current `tick()` can call `setPosition()` using the old automatic target during `userMoving`.

- [ ] **Step 3: Add the minimal early return in `tick()`**

Immediately after reading `now` and `bounds`, add a user-owned branch. Keep all snapshot fields consistent with the existing snapshot type and notify subscribers exactly once:

```ts
if (this.userMoving) {
  const position = { x: bounds.x, y: bounds.y };
  this.target = position;
  this.lastTickMs = now;
  this.latestSnapshot = {
    revision: ++this.revision,
    timestampMs: now,
    position,
    target: { ...position },
    direction: this.direction,
    moving: false,
    carrying: this.carrying
  };
  for (const listener of [...this.listeners]) listener(this.latestSnapshot);
  return structuredClone(this.latestSnapshot);
}
```

Do not change `PetWindowInteractionController.updateDrag()`; it remains the sole writer during drag.

- [ ] **Step 4: Run motion and interaction regressions**

Run:

```powershell
pnpm --filter @myself/desktop test -- character-motion-controller.test.ts pet-window-interaction-controller.test.ts pet-position.test.ts
pnpm --filter @myself/desktop typecheck
```

Expected: PASS, including negative-coordinate display and single-axis clamping tests.

- [ ] **Step 5: Commit Task 2**

```powershell
git add apps/desktop/src/main/characters/character-motion-service.ts apps/desktop/tests/character-motion-controller.test.ts
git commit -m "fix：拖拽期间暂停角色自动窗口写入"
```

### Task 3: 允许预置提供商使用手动模型 ID

**Files:**
- Modify: `packages/shared-types/src/contracts.ts:78-117`
- Modify: `packages/shared-types/tests/contracts.test.ts`
- Modify: `packages/agent-core/src/model-router.ts:94-125`
- Modify: `packages/agent-core/tests/model-router.test.ts:231-270`
- Modify: `apps/desktop/src/main/providers/provider-registry.ts:35-70`
- Modify: `apps/desktop/src/main/storage/settings-store.ts:160-190`
- Modify: `apps/desktop/src/renderer/src/settings/ProviderSettings.tsx:31-180`
- Modify: `apps/desktop/tests/provider-contract.test.ts:870-888`
- Modify: `apps/desktop/tests/multi-provider-settings.test.tsx`

**Interfaces:**
- Consumes: preset provider protocol and base URL from `ProviderCatalogEntry`.
- Produces: preset `ProviderProfileV2` may carry `capabilities?: ModelCapability[]`; an unknown `modelId` uses those explicit capabilities or conservative `['chat']`.

- [ ] **Step 1: Write failing shared-contract tests**

Add a test proving a preset profile can store an unknown model with conservative explicit capability:

```ts
expect(providerProfileV2Schema.parse({
  id: 'openai-new',
  displayName: 'OpenAI 新模型',
  mode: 'preset',
  providerId: 'openai',
  modelId: 'new-model-id',
  capabilities: ['chat'],
  hasStoredSecret: true
})).toMatchObject({
  modelId: 'new-model-id',
  capabilities: ['chat']
});
```

- [ ] **Step 2: Run the contract test and verify failure**

Run:

```powershell
pnpm --filter @myself/shared-types test -- contracts.test.ts
```

Expected: FAIL because the strict preset schema rejects `capabilities`.

- [ ] **Step 3: Extend only the preset profile schema**

Define one reusable capability array schema and add it to both public and stored preset branches:

```ts
const declaredModelCapabilitiesSchema = z.array(z.enum([
  'chat',
  'tools',
  'vision',
  'streaming',
  'longContext'
])).min(1).optional();

providerProfileV2BaseSchema.extend({
  mode: z.literal('preset'),
  providerId: z.string().min(1),
  capabilities: declaredModelCapabilitiesSchema
}).strict();
```

Use the same schema in `storedProviderProfileV2Schema`; remove the duplicated capability enum from the custom branches.

- [ ] **Step 4: Write failing router and provider tests**

Change the old “unknown preset model must fail” expectations so they assert:

```ts
const unknownPreset: ProviderProfileV2 = {
  id: 'alpha-new',
  displayName: 'Alpha New',
  mode: 'preset',
  providerId: 'alpha',
  modelId: 'alpha-new-model',
  capabilities: ['chat'],
  hasStoredSecret: true
};

expect(() => new ModelRouter({
  profiles: [unknownPreset],
  route: 路由({ primaryProfileId: 'alpha-new' }),
  catalog: 目录
}).select('chat', 空披露)).not.toThrow();
```

In `provider-contract.test.ts`, assert `ProviderRegistry.create()` accepts the unknown model ID when the provider exists, while an unknown `providerId` remains rejected.

- [ ] **Step 5: Run focused tests and verify failure**

Run:

```powershell
pnpm --filter @myself/agent-core test -- model-router.test.ts
pnpm --filter @myself/desktop test -- provider-contract.test.ts
```

Expected: FAIL with `MODEL_MODEL_NOT_FOUND` or `PROVIDER_MODEL_NOT_FOUND`.

- [ ] **Step 6: Implement conservative unknown-model routing**

In `ModelRouter.resolveProfile()`, retain provider lookup but resolve capabilities as:

```ts
const model = provider.models.find(entry => entry.modelId === profile.modelId);
const capabilities = model?.capabilities ?? profile.capabilities ?? ['chat'];
return {
  profile,
  capabilities: new Set(capabilities),
  disclosureTarget: {
    profileId: profile.id,
    providerIdentity: `provider:${profile.providerId}`
  }
};
```

In `ProviderRegistry.resolveProfile()`, delete only the model-membership rejection; continue rejecting an unknown provider and continue using the catalog provider's protocol and Base URL.

In `settings-store.ts`, make `profileCapabilities()` use catalog capabilities first, then `profile.capabilities`, then `['chat']`; do not infer `tools` or `vision` from the model name.

- [ ] **Step 7: Replace the preset model select with an input plus datalist**

In `ProviderSettings.tsx`, preserve current suggestions while allowing a typed ID:

```tsx
const selectedModel = selectedProvider?.models.find(item => item.modelId === modelId);
const capabilities = selectedModel?.capabilities ?? ['chat'];

<input
  list="preset-model-options"
  value={modelId}
  disabled={customMode || props.busy}
  onChange={event => setModelId(event.target.value.trim())}
/>
<datalist id="preset-model-options">
  {selectedProvider?.models.map(model => (
    <option key={model.modelId} value={model.modelId}>{model.displayName}</option>
  ))}
</datalist>
<small>列表没有新模型时，可直接输入服务商公布的模型 ID；未知模型默认仅启用聊天。</small>
```

Remove the current `?? selectedProvider?.models[0]` fallback from `selectedModel`. When `modelId` matches the catalog, continue showing catalog capability badges. When it does not match, display a single `chat` badge and save `capabilities: ['chat']` in the preset profile.

- [ ] **Step 8: Test Renderer submission and conservative copy**

Add a DOM-level test that changes the preset model input to `provider-new-model`, submits the form, and expects:

```ts
expect(onSave).toHaveBeenCalledWith(expect.objectContaining({
  profile: expect.objectContaining({
    mode: 'preset',
    modelId: 'provider-new-model',
    capabilities: ['chat']
  })
}));
```

Also assert the rendered helper contains `可直接输入服务商公布的模型 ID`.

- [ ] **Step 9: Run all model/settings checks**

Run:

```powershell
pnpm --filter @myself/shared-types test
pnpm --filter @myself/agent-core test
pnpm --filter @myself/desktop test -- provider-contract.test.ts multi-provider-settings.test.ts multi-provider-settings.test.tsx settings-store.test.ts
pnpm typecheck
```

Expected: PASS. A newly released model is usable for chat without waiting for an application release; tool and vision routing remain disabled until capabilities are verified or explicitly configured by a later model-discovery implementation.

- [ ] **Step 10: Commit Task 3**

```powershell
git add packages/shared-types/src/contracts.ts packages/shared-types/tests/contracts.test.ts packages/agent-core/src/model-router.ts packages/agent-core/tests/model-router.test.ts apps/desktop/src/main/providers/provider-registry.ts apps/desktop/src/main/storage/settings-store.ts apps/desktop/src/renderer/src/settings/ProviderSettings.tsx apps/desktop/tests/provider-contract.test.ts apps/desktop/tests/multi-provider-settings.test.tsx
git commit -m "feat：允许预置服务商使用手动模型 ID"
```

### Task 4: 基线回归与 Windows 验收交接

**Files:**
- Verify only: no source changes expected.

**Interfaces:**
- Consumes: Tasks 1–3 commits.
- Produces: a clean verification result and a precise user acceptance checklist; this task does not create an artificial evidence file.

- [ ] **Step 1: Run the full automated baseline**

```powershell
pnpm typecheck
pnpm test:unit
pnpm test:security
pnpm test:integration
pnpm test:e2e:desktop
```

Expected: all commands exit 0. If a failure is unrelated and pre-existing, record the exact test and stop before claiming completion; do not weaken assertions globally.

- [ ] **Step 2: Inspect the final diff and commit boundaries**

```powershell
git status --short
git log -4 --oneline
git diff HEAD~3..HEAD --check
```

Expected: no uncommitted files, three focused commits, no whitespace errors.

- [ ] **Step 3: Hand off the Windows acceptance checklist**

Ask the user to verify these concrete behaviors:

1. 设置页只有“模型、隐私、本地数据”，不存在“工具”标签。
2. 通过旧状态进入 `tools` 时显示“模型档案”，不是空白页。
3. 桌宠位于左上角、右上角、左下角和右下角时都能向屏幕内部拖动。
4. 负坐标副屏和不同缩放显示器之间拖动不跳回旧目标。
5. 预置服务商的模型输入框可以输入目录外模型 ID，保存和聊天连接测试正常。
6. 未验证的新模型不会自动获得工具或视觉能力。

No commit is created in this task unless verification reveals a real defect and a new failing test is added for that defect.
