# 角色包 V2 与角色工作室编辑闭环 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将角色的新建、编辑、保存、编译、导入和导出统一为角色包 V2，并让现有播放器通过只读兼容投影继续稳定运行。

**Architecture:** 在 `@myself/character-runtime` 内建立 V2 Schema、V1 转换器、表现解析器和旧播放器投影四个纯函数边界。Main 继续复用现有草稿/发布事务与角色包隔离导入机制，仅在持久化边界保存 V2；Renderer 工作室按角色、皮肤、状态、动作四种选择编辑 V2，现有播放器仍只接收派生的 V1 形状运行视图。

**Tech Stack:** Electron 43、React 19、TypeScript 5.9、Zod 3、Zustand 5、PixiJS 8、Vitest 3、Testing Library、Playwright。

**设计规格：** [角色包 V2 与角色工作室编辑闭环设计](../specs/2026-08-01-character-package-v2-editor-design.md)

## Global Constraints

- 只在当前 `AgentCoreExtension` 工作树中开发，不切换或合并 `main`。
- V2 是新建、编辑、编译、导入和导出的唯一正式角色结构；磁盘和角色包不得新增第二份正式 V1 清单。
- 现有本地 V1 与导入的 V1 包自动转换，不显示升级按钮，不要求用户重新创建或重新导入素材。
- 保留现有 Electron、TypeScript、PixiJS、Zod、Zustand、角色存储事务和角色包安全边界，不引入新的运行时依赖。
- 本阶段不接入 Agent 状态推断、自主行为调度、长期记忆、文件任务提交点、目录藏身、截图、桌面感知或模型调用。
- MCP 继续在 Main、Agent 和 Renderer 保持禁用，不删除预留代码。
- 用户可声明普通中断约束；拖拽、安全确认、错误、真实任务结果、角色切换、窗口关闭和素材失效始终保留系统强制中断权。
- 角色包不得携带脚本、Shell、任意系统 Prompt、路径授权、MCP 配置或未知执行器；本阶段 `capabilityRef` 不接受任何值。
- 所有新文档、结构性注释、测试名称、错误说明和界面文案使用中文。
- 采用最小修改、TDD、不可变草稿更新、严格 Zod 解析和现有原子事务；不复制素材文件。
- 每个任务独立测试、独立审查、独立提交；单点排障超过 30 分钟时记录证据并切换可验证方案。

---

## 文件结构与职责

### 角色契约纯函数

- 新建 `packages/character-runtime/src/character-v2-schema.ts`：V2 草稿/清单、结构化人设、皮肤、状态、动作、条件与完整引用校验。
- 新建 `packages/character-runtime/src/character-v1-converter.ts`：V1 草稿/清单到 V2 的确定性无损转换。
- 新建 `packages/character-runtime/src/character-presentation-resolver.ts`：四级皮肤表现回退与来源解释。
- 新建 `packages/character-runtime/src/legacy-runtime-projection.ts`：V2 清单到现有播放器 `CharacterManifestV1` 的只读投影。
- 修改 `packages/character-runtime/src/index.ts`：只导出上述公共接口。
- 保留 `packages/character-runtime/src/character-schema.ts`：V1 解析与旧播放器 DTO，不再作为正式写入格式。

### Main、IPC 与角色包

- 修改 `apps/desktop/src/main/characters/character-migrations.ts`：识别 V1/V2，并返回带来源版本的 V2 转换结果。
- 修改 `apps/desktop/src/main/characters/character-store.ts`：只保存 V2；复用草稿/发布事务自动转换本地 V1；运行读取时生成兼容投影。
- 修改 `apps/desktop/src/main/characters/official-default-character.ts`：官方角色直接创建并发布 V2。
- 修改 `apps/desktop/src/main/characters/character-package-service.ts`：隔离目录内接受 V1/V2，写入前统一为 V2，导出只含 V2。
- 修改 `apps/desktop/src/main/characters/character-actions.ts`、`apps/desktop/src/shared/character-ipc.ts`、`apps/desktop/src/shared/myself-api.ts`、`apps/desktop/src/main/ipc/register-ipc.ts`：草稿和发布接口切换为 V2；运行快照保持兼容投影。

### Renderer 工作室

- 修改 `apps/desktop/src/renderer/src/characters/store/character-workshop-store.ts`：V2 选择模型、不可变实体编辑、引用检查、V2 编译发布。
- 新建 `apps/desktop/src/renderer/src/characters/workshop/CharacterIdentityInspector.tsx`：结构化人设表单。
- 新建 `apps/desktop/src/renderer/src/characters/workshop/SkinList.tsx`：皮肤新增、选择、设为默认、删除入口。
- 新建 `apps/desktop/src/renderer/src/characters/workshop/SkinInspector.tsx`：皮肤名称与说明编辑、回退来源说明。
- 新建 `apps/desktop/src/renderer/src/characters/workshop/StateInspector.tsx`：状态类别、语义、条件、共存/禁止和 Agent 可推断字段。
- 修改 `apps/desktop/src/renderer/src/characters/workshop/ActionInspector.tsx`：动作语义与调度约束；FPS、帧、锚点移到当前皮肤表现。
- 修改 `apps/desktop/src/renderer/src/characters/workshop/StateList.tsx`：自由状态标签与主/修饰状态标记。
- 修改 `apps/desktop/src/renderer/src/characters/workshop/DraftCharacterPreview.tsx`：按所选皮肤解析表现，空链清屏并显示回退来源。
- 修改 `apps/desktop/src/renderer/src/characters/workshop/CharacterWorkshopView.tsx`：编排四种选择和引用删除确认，不继续膨胀字段表单。
- 修改 `apps/desktop/src/renderer/src/characters/workshop/character-workshop.css`：在现有三栏中加入皮肤列表和实体属性布局。

### 测试

- 新建 `packages/character-runtime/tests/character-v2-schema.test.ts`。
- 新建 `packages/character-runtime/tests/character-v1-converter.test.ts`。
- 新建 `packages/character-runtime/tests/character-presentation-resolver.test.ts`。
- 新建 `packages/character-runtime/tests/legacy-runtime-projection.test.ts`。
- 修改 `apps/desktop/tests/character-store.test.ts`、`character-package-service.test.ts`、`official-default-character.test.ts`、`character-ipc.test.ts`。
- 修改 `apps/desktop/tests/character-workshop-store.test.ts`、`character-workshop-components.test.tsx`、`character-workshop-state-list.dom.test.tsx`、`draft-character-preview.test.tsx`。
- 修改 `tests/e2e/desktop.spec.ts`：覆盖重启持久化、皮肤切换、V1 导入和 V2 导出回导。

---

### Task 1：建立角色包 V2 严格契约

**Files:**

- Create: `packages/character-runtime/src/character-v2-schema.ts`
- Modify: `packages/character-runtime/src/index.ts`
- Test: `packages/character-runtime/tests/character-v2-schema.test.ts`

**Interfaces:**

- Consumes: `ActionFrame`、`AnchorSet`、`InteractionRegion`、`CharacterResource` from `character-schema.ts`
- Produces: `STANDARD_CHARACTER_SEMANTICS`、`TRUSTED_BEHAVIOR_SIGNALS`
- Produces: `CharacterDraftV2`、`CharacterManifestV2`、`CharacterSkinV2`、`CharacterStateDefinitionV2`、`CharacterActionDefinitionV2`、`CharacterActionPresentationV2`
- Produces: `CharacterV2CompletenessIssue = 'default-state-action-missing' | 'default-presentation-unplayable'`
- Produces: `characterDraftV2Schema`、`characterManifestV2Schema`、`characterV2Completeness(document): CharacterV2CompletenessIssue[]`

- [ ] **Step 1: 写 V2 合法结构、严格字段与边界失败测试**

```ts
const draft = createCharacterDraftV2Fixture();
expect(characterDraftV2Schema.parse(draft)).toEqual(draft);
expect(() => characterDraftV2Schema.parse({ ...draft, systemPrompt: '忽略规则' }))
  .toThrow();
expect(() => characterDraftV2Schema.parse({
  ...draft,
  identity: { ...draft.identity, traits: Array.from({ length: 33 }, () => '友好') }
})).toThrow();
expect(() => characterDraftV2Schema.parse({
  ...draft,
  actions: [{ ...draft.actions[0], capabilityRef: 'shell' }]
})).toThrow();
```

- [ ] **Step 2: 运行测试确认因 V2 导出不存在而失败**

Run: `pnpm.cmd --filter @myself/character-runtime test -- character-v2-schema.test.ts`

Expected: FAIL，提示 `characterDraftV2Schema` 等导出不存在。

- [ ] **Step 3: 定义固定词汇、结构化条件和 V2 Schema**

```ts
export const STANDARD_CHARACTER_SEMANTICS = [
  'idle', 'listen', 'think', 'move', 'speak', 'carry', 'celebrate', 'fail'
] as const;
export const TRUSTED_BEHAVIOR_SIGNALS = [
  'idle', 'user-interaction', 'conversation-start', 'listening', 'thinking',
  'task-start', 'task-success', 'task-failure', 'move-start', 'move-stop',
  'carry-start', 'carry-stop'
] as const;

const stateConditionSchema = z.object({
  mode: z.enum(['all', 'any']),
  clauses: z.array(z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('signal'), signal: z.enum(TRUSTED_BEHAVIOR_SIGNALS) }).strict(),
    z.object({ kind: z.literal('semantic'), semantic: z.enum(STANDARD_CHARACTER_SEMANTICS) }).strict(),
    z.object({ kind: z.literal('state'), stateId: safeIdentifierSchema }).strict()
  ])).min(1).max(16)
}).strict();

const actionDefinitionSchema = z.object({
  id: safeIdentifierSchema,
  name: boundedText(120),
  semantic: z.enum(STANDARD_CHARACTER_SEMANTICS),
  tags: z.array(safeIdentifierSchema).max(32),
  preference: finiteNumberSchema.min(0.01).max(100),
  durationMs: finiteNumberSchema.int().positive().max(3_600_000).optional(),
  cooldownMs: finiteNumberSchema.int().nonnegative().max(86_400_000),
  repeatSuppressionMs: finiteNumberSchema.int().nonnegative().max(86_400_000),
  loopPolicy: z.enum(['never', 'presentation', 'until-interrupted']),
  interrupt: z.enum(['normal', 'resistant']),
  failureFallbackActionId: safeIdentifierSchema.optional(),
  interruptedFallbackActionId: safeIdentifierSchema.optional(),
  allowedPrimaryStateIds: z.array(safeIdentifierSchema).max(128),
  forbiddenPrimaryStateIds: z.array(safeIdentifierSchema).max(128),
  requiredModifierStateIds: z.array(safeIdentifierSchema).max(128),
  forbiddenModifierStateIds: z.array(safeIdentifierSchema).max(128),
  direction: z.enum(['left', 'right', 'any']),
  capabilityRef: z.never().optional()
}).strict();
```

实现 `superRefine`，逐项拒绝：顶层/各集合重复 ID、默认皮肤或默认状态悬空、状态动作引用悬空、状态条件引用悬空、共存/禁止引用冲突、动作回退悬空或成环、皮肤表现引用未知动作、语义回退跨语义或成环、发布清单资源引用缺失。草稿允许空帧；清单要求默认状态经默认皮肤回退后至少存在一项有帧表现。

- [ ] **Step 4: 添加引用完整性和循环测试并运行**

```ts
expect(() => characterDraftV2Schema.parse(withActionCycle(draft, 'wave', 'nod')))
  .toThrow(/动作回退.*循环/u);
expect(() => characterDraftV2Schema.parse(withUnknownStateReference(draft)))
  .toThrow(/状态引用/u);
expect(characterV2Completeness(withoutPlayableDefault(draft))).toEqual([
  'default-presentation-unplayable'
]);
```

Run: `pnpm.cmd --filter @myself/character-runtime test -- character-v2-schema.test.ts`

Expected: PASS。

- [ ] **Step 5: 导出公共类型并提交**

```powershell
git add packages/character-runtime/src/character-v2-schema.ts packages/character-runtime/src/index.ts packages/character-runtime/tests/character-v2-schema.test.ts
git commit -m "feat：定义角色包 V2 严格契约"
```

---

### Task 2：实现确定性的 V1 到 V2 转换

**Files:**

- Create: `packages/character-runtime/src/character-v1-converter.ts`
- Modify: `packages/character-runtime/src/index.ts`
- Test: `packages/character-runtime/tests/character-v1-converter.test.ts`

**Interfaces:**

- Consumes: `CharacterDraftV1`、`CharacterManifestV1`、`CharacterDraftV2`、`CharacterManifestV2`
- Produces: `convertCharacterDraftV1ToV2(input: CharacterDraftV1): CharacterV1ConversionResult<CharacterDraftV2>`
- Produces: `convertCharacterManifestV1ToV2(input: CharacterManifestV1): CharacterV1ConversionResult<CharacterManifestV2>`
- Produces: `CharacterV1ConversionMap = { stateIds: Record<string, string[]>; actionIds: Record<string, string[]> }`
- Produces: `CharacterV1ConversionResult<T> = { document: T; map: CharacterV1ConversionMap }`

- [ ] **Step 1: 写字段映射与素材不复制测试**

```ts
const result = convertCharacterManifestV1ToV2(createV1Manifest());
expect(result.document).toMatchObject({
  version: 2,
  defaultSkinId: 'default',
  defaultStateId: 'idle',
  actions: [expect.objectContaining({ id: 'idle-main', preference: 3 })]
});
expect(result.document.skins[0]?.presentations[0]?.frames[0]?.assetId)
  .toBe('idle-atlas');
expect(result.document.resources).toEqual(createV1Manifest().resources);
```

- [ ] **Step 2: 运行测试确认转换器不存在**

Run: `pnpm.cmd --filter @myself/character-runtime test -- character-v1-converter.test.ts`

Expected: FAIL，提示转换函数未导出。

- [ ] **Step 3: 实现固定语义映射和保守默认值**

```ts
const V1_STATE_SEMANTICS = {
  idle: 'idle', listening: 'listen', thinking: 'think', moving: 'move',
  acting: 'speak', carrying: 'carry', success: 'celebrate', error: 'fail'
} as const;

function uniqueId(base: string, used: Set<string>): string {
  if (!used.has(base)) return base;
  let suffix = 2;
  while (used.has(`${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}
```

转换时按源数组顺序分配稳定后缀；动作定义进入顶层 `actions`，帧/FPS/锚点/区域进入 `default` 皮肤表现；V1 `loop` 转换为 `until-interrupted` 或 `never`，V1 `triggers` 转换为一层结构化进入条件；未知 `custom:` 状态使用 `semantic: { kind: 'custom', value: 原规范化 ID }`，不得按显示名猜测标准语义。返回 `{ document, map }`，同一输入重复调用结果必须深度相等。

- [ ] **Step 4: 写重复 ID、未知状态和确定性测试**

```ts
const first = convertCharacterDraftV1ToV2(createV1WithDuplicateActionIds());
const second = convertCharacterDraftV1ToV2(createV1WithDuplicateActionIds());
expect(first).toEqual(second);
expect(first.map.actionIds['wave']).toEqual(['wave', 'wave-2']);
expect(first.document.actions.map(action => action.id)).toEqual(['wave', 'wave-2']);
expect(first.document.states.find(state => state.id === 'custom:rain')?.semantic)
  .toEqual({ kind: 'custom', value: 'custom-rain' });
expect(convertCharacterDraftV1ToV2(createV1WithDuplicateStateIds()).map.stateIds.idle)
  .toEqual(['idle', 'idle-2']);
```

Run: `pnpm.cmd --filter @myself/character-runtime test -- character-v1-converter.test.ts`

Expected: PASS。

- [ ] **Step 5: 运行 runtime 全套并提交**

Run: `pnpm.cmd --filter @myself/character-runtime test`

Expected: PASS，现有 V1 Schema 和动作选择测试不变。

```powershell
git add packages/character-runtime/src/character-v1-converter.ts packages/character-runtime/src/index.ts packages/character-runtime/tests/character-v1-converter.test.ts
git commit -m "feat：自动转换 V1 角色数据为 V2"
```

---

### Task 3：实现皮肤表现解析与旧播放器投影

**Files:**

- Create: `packages/character-runtime/src/character-presentation-resolver.ts`
- Create: `packages/character-runtime/src/legacy-runtime-projection.ts`
- Modify: `packages/character-runtime/src/index.ts`
- Test: `packages/character-runtime/tests/character-presentation-resolver.test.ts`
- Test: `packages/character-runtime/tests/legacy-runtime-projection.test.ts`

**Interfaces:**

- Produces: `resolveCharacterPresentation(document, skinId, actionId): ResolvedCharacterPresentation | null`
- Produces: `ResolvedCharacterPresentation.source: 'skin-action' | 'skin-semantic' | 'default-action' | 'default-state'`
- Produces: `projectCharacterManifestV2ToLegacy(manifest): CharacterManifestV1`
- Consumes: Task 1 的 V2 类型和 Task 2 的标准语义映射规则

- [ ] **Step 1: 写四级回退、空链和不可变测试**

```ts
expect(resolveCharacterPresentation(manifest, 'winter', 'wave')?.source)
  .toBe('skin-action');
expect(resolveCharacterPresentation(withoutWinterWave(manifest), 'winter', 'wave')?.source)
  .toBe('skin-semantic');
expect(resolveCharacterPresentation(withoutWinterFallback(manifest), 'winter', 'wave')?.source)
  .toBe('default-action');
expect(resolveCharacterPresentation(withOnlyDefaultIdle(manifest), 'winter', 'wave')?.source)
  .toBe('default-state');
expect(resolveCharacterPresentation(withNoPlayableChain(manifest), 'winter', 'wave'))
  .toBeNull();
```

- [ ] **Step 2: 运行解析测试确认失败**

Run: `pnpm.cmd --filter @myself/character-runtime test -- character-presentation-resolver.test.ts`

Expected: FAIL，提示解析器未定义。

- [ ] **Step 3: 用固定顺序实现无副作用解析器**

```ts
export function resolveCharacterPresentation(
  document: CharacterDraftV2 | CharacterManifestV2,
  skinId: string,
  actionId: string
): ResolvedCharacterPresentation | null {
  const skin = document.skins.find(item => item.id === skinId);
  const defaultSkin = document.skins.find(item => item.id === document.defaultSkinId);
  const action = document.actions.find(item => item.id === actionId);
  if (!skin || !defaultSkin || !action) return null;
  return exact(skin, actionId, 'skin-action')
    ?? semanticFallback(skin, action.semantic, 'skin-semantic')
    ?? exact(defaultSkin, actionId, 'default-action')
    ?? defaultStatePresentation(document, defaultSkin);
}
```

- [ ] **Step 4: 写投影映射、未知状态与源数据不变测试**

```ts
const before = structuredClone(manifest);
const projected = projectCharacterManifestV2ToLegacy(manifest);
expect(projected.version).toBe(1);
expect(projected.states.find(state => state.id === 'listening')?.actions[0]?.weight)
  .toBe(2);
expect(projected.states.some(state => state.id === 'custom:rain')).toBe(true);
expect(manifest).toEqual(before);
characterManifestV1Schema.parse(projected);
```

- [ ] **Step 5: 实现固定运行态映射并运行测试**

```ts
const LEGACY_STATE_BY_SEMANTIC = {
  idle: 'idle', listen: 'listening', think: 'thinking', move: 'moving',
  speak: 'acting', carry: 'carrying', celebrate: 'success', fail: 'error'
} as const;
```

每个 V2 状态按语义投到上述核心状态；自定义状态投到规范化 `custom:<id>` 并从受信条件恢复点击/闲置触发器。动作只使用默认皮肤解析结果，`preference` 映射为 `weight`，`loopPolicy !== 'never'` 映射为 legacy `loop: true`；默认状态最终还要投到 legacy `idle`，保证旧 Schema 和现有 fallback 成立。多个 V2 状态映射同一核心状态时按原顺序合并动作且确定性重命名冲突动作 ID。

Run: `pnpm.cmd --filter @myself/character-runtime test -- character-presentation-resolver.test.ts legacy-runtime-projection.test.ts`

Expected: PASS。

- [ ] **Step 6: 提交纯函数兼容层**

```powershell
git add packages/character-runtime/src/character-presentation-resolver.ts packages/character-runtime/src/legacy-runtime-projection.ts packages/character-runtime/src/index.ts packages/character-runtime/tests/character-presentation-resolver.test.ts packages/character-runtime/tests/legacy-runtime-projection.test.ts
git commit -m "feat：解析皮肤表现并投影旧播放器视图"
```

---

### Task 4：让角色存储原子落盘 V2 并自动转换本地 V1

**Files:**

- Modify: `apps/desktop/src/main/characters/character-migrations.ts`
- Modify: `apps/desktop/src/main/characters/character-store.ts`
- Modify: `apps/desktop/src/main/characters/official-default-character.ts`
- Test: `apps/desktop/tests/character-store.test.ts`
- Test: `apps/desktop/tests/official-default-character.test.ts`

**Interfaces:**

- Produces: `migrateCharacterDocument(raw): { document: CharacterDraftV2; sourceVersion: 1 | 2 }`
- Produces: `migrateCharacterManifest(raw): { document: CharacterManifestV2; sourceVersion: 1 | 2 }`
- Changes: `CharacterStore.saveDraft/getDraft` 使用 `CharacterDraftV2`
- Changes: `CharacterStore.publishCompiled` 使用 `CharacterManifestV2`
- Produces: `CharacterStore.getPublishedManifest(characterId): Promise<CharacterManifestV2>`，仅供 V2 导出和管理界面使用
- Preserves: `CharacterStore.getRuntimeManifest/getActive` 返回 `CharacterManifestV1` 兼容投影
- Produces: `CharacterSummary.missingRequirements: CharacterV2CompletenessIssue[]`
- Produces: `CharacterSummary.migrationErrorCode?: 'CHARACTER_MIGRATION_FAILED'` 与 `migrationRecoveryAvailable: boolean`

- [ ] **Step 1: 将迁移测试改为 V1/V2 均返回 V2**

```ts
expect(migrateCharacterDocument(createDraftV1())).toMatchObject({
  sourceVersion: 1,
  document: { version: 2, defaultSkinId: 'default' }
});
expect(migrateCharacterDocument(createDraftV2())).toEqual({
  sourceVersion: 2,
  document: createDraftV2()
});
expect(() => migrateCharacterDocument({ version: 3 })).toThrow('CHARACTER_VERSION_UNSUPPORTED');
```

- [ ] **Step 2: 运行存储测试确认类型和预期失败**

Run: `pnpm.cmd --filter @myself/desktop test -- character-store.test.ts official-default-character.test.ts`

Expected: FAIL，旧迁移器只返回 V1 且拒绝 V2。

- [ ] **Step 3: 切换公开存储类型、创建模板和完整性摘要**

```ts
const draft: CharacterDraftV2 = characterDraftV2Schema.parse({
  version: 2,
  id: input.id,
  name,
  identity: emptyCharacterIdentity(),
  defaultSkinId: 'default',
  defaultStateId: 'idle',
  skins: [{ id: 'default', name: '默认皮肤', description: '', presentations: [], semanticFallbacks: [] }],
  states: [{
    id: 'idle', name: '待机', kind: 'primary',
    semantic: { kind: 'standard', value: 'idle' }, tags: [], intensity: 0.5,
    durationMs: 3000, coexistStateIds: [], forbiddenStateIds: [],
    enterConditions: [], exitConditions: [], agentInferable: true, actionIds: []
  }],
  actions: []
});
```

用 `characterV2Completeness` 替换 `missingCoreStates`；索引仍保持版本 1 和现有目录格式，只新增条目字段 `draftVersion: 2`、可选 `compiledVersion: 2` 与可选 `migrationErrorCode`，避免无关索引迁移。

- [ ] **Step 4: 复用草稿事务实现首次读取自动转换与恢复点**

在 `getDraft` 的串行队列内：恢复未完成草稿事务；读取原 JSON；若来源为 V1，则用现有 `draft.next.json`、`draft.backup.json`、`draft-transaction.json` 顺序安装 V2，并保留 `draft.backup.json` 作为最近 V1 恢复点；若转换或索引提交失败，执行现有 `rollbackDraftTransaction`。不得新建另一套迁移锁或复制 `source/`。

```ts
private async ensureDraftV2(characterId: string, index: CharacterIndex): Promise<CharacterDraftV2> {
  const migrated = migrateCharacterDocument(JSON.parse(await readFile(this.draftFile(characterId), 'utf8')));
  if (migrated.sourceVersion === 2) return migrated.document;
  await this.installDraftTransaction(characterId, index, migrated.document, { keepBackup: true });
  return migrated.document;
}
```

`readRuntime()` 先用 `migrateCharacterManifest()` 识别磁盘清单：V2 直接投影；V1 则读取清单声明的现有资源字节，复用发布事务的 next/backup/marker 流程安装 V2，保留一次 `compiled.backup` 恢复点，再调用 `projectCharacterManifestV2ToLegacy()`。新增 `getPublishedManifest()` 直接返回经上述迁移后的 V2 清单，禁止 package service 从 legacy 投影反推正式数据。`list()` 遇到转换失败时不删除目录，返回 `completeness: 'broken'`、稳定迁移错误码和恢复可用标记；下一次 `getDraft()` 或 `getPublishedManifest()` 即为可重复的重试入口。

- [ ] **Step 5: 写故障注入与重启恢复测试并运行**

```ts
await seedRawV1Draft(characterDirectory, createDraftV1());
const converted = await store.getDraft('demo');
expect(converted.version).toBe(2);
expect(await readJson(join(characterDirectory, 'draft', 'draft.backup.json')))
  .toMatchObject({ version: 1 });
expect(await readJson(join(characterDirectory, 'draft', 'draft.json')))
  .toMatchObject({ version: 2 });

await seedRawV1Compiled(characterDirectory, createManifestV1(), legacyAssets);
expect((await store.getRuntimeManifest('demo')).version).toBe(1);
expect(await store.getPublishedManifest('demo')).toMatchObject({ version: 2 });
expect(await readJson(join(characterDirectory, 'compiled.backup', 'manifest.json')))
  .toMatchObject({ version: 1 });
```

再覆盖 `draft.next` 写失败、备份改名失败、索引写失败与重启恢复，断言活动角色指针和 V1 原文保持可恢复。

Run: `pnpm.cmd --filter @myself/desktop test -- character-store.test.ts`

Expected: PASS。

- [ ] **Step 6: 官方默认角色改为直接发布 V2，运行并提交**

官方动作语义按 Task 3 映射，所有表现写入默认皮肤；`getRuntimeManifest()` 断言仍为 V1 兼容视图。

Run: `pnpm.cmd --filter @myself/desktop test -- official-default-character.test.ts character-store.test.ts`

Expected: PASS。

```powershell
git add apps/desktop/src/main/characters/character-migrations.ts apps/desktop/src/main/characters/character-store.ts apps/desktop/src/main/characters/official-default-character.ts apps/desktop/tests/character-store.test.ts apps/desktop/tests/official-default-character.test.ts
git commit -m "feat：原子迁移并持久化 V2 角色"
```

---

### Task 5：打通 V2 IPC、编译发布和安全角色包

**Files:**

- Modify: `apps/desktop/src/shared/character-ipc.ts`
- Modify: `apps/desktop/src/shared/myself-api.ts`
- Modify: `apps/desktop/src/main/ipc/register-ipc.ts`
- Modify: `apps/desktop/src/main/characters/character-actions.ts`
- Modify: `apps/desktop/src/main/characters/character-package-service.ts`
- Test: `apps/desktop/tests/character-ipc.test.ts`
- Test: `apps/desktop/tests/character-package-service.test.ts`

**Interfaces:**

- Consumes: Task 4 的 V2 Store；Task 3 的 legacy 投影由 Store 内部使用
- Changes: `createCharacter/duplicateCharacter/getCharacterDraft/saveCharacterDraft` 返回或接收 `CharacterDraftV2`
- Changes: `CharacterPublishInput.manifest` 为 `CharacterManifestV2`
- Preserves: `CharacterRuntimeSnapshot.manifest` 为 `CharacterManifestV1`
- Produces: `CharacterPackageService.exportCharacterRecovery(characterId, destination): Promise<void>`，由现有导出流程在迁移失败时内部调用，只导出原始草稿与已验证素材
- Changes: `CharacterExportResult` 增加 `{ kind: 'recovery-exported' }`，不增加新的 IPC 通道

- [ ] **Step 1: 写 IPC 边界测试**

```ts
await expect(handlers.get(channel('characterDraftSave'))?.({}, {
  characterId: 'demo', draft: createDraftV2()
})).resolves.toEqual({ ok: true });
await expect(handlers.get(channel('characterDraftSave'))?.({}, {
  characterId: 'demo', draft: createDraftV1()
})).rejects.toMatchObject({ code: 'CHARACTER_INPUT_INVALID' });
expect(characterRuntimeSnapshotSchema.parse({
  activeCharacterId: 'demo', manifest: createLegacyManifestV1()
})).toBeTruthy();
```

- [ ] **Step 2: 运行 IPC 测试确认旧 Schema 仍接受 V1 草稿**

Run: `pnpm.cmd --filter @myself/desktop test -- character-ipc.test.ts`

Expected: FAIL，V2 草稿/清单未被共享协议接受。

- [ ] **Step 3: 将编辑与发布协议切为 V2，保留运行快照 V1**

```ts
export const characterDraftSaveInputSchema = z.object({
  characterId: characterIdSchema,
  draft: characterDraftV2Schema
}).strict();
export const characterPublishInputSchema = z.object({
  characterId: characterIdSchema,
  manifest: characterManifestV2Schema,
  resources: z.array(characterPublishResourceSchema).max(2_000)
}).strict();
export const characterRuntimeSnapshotSchema = z.object({
  activeCharacterId: characterIdSchema,
  manifest: characterManifestV1Schema
}).strict();
```

同步更新 Main/Preload 类型；恢复导出复用现有 `characterExport` 通道，返回 `recovery-exported` 供 Renderer 显示明确文案，不增加 IPC 通道。

- [ ] **Step 4: 写 V1 导入转 V2、V2 回导与恶意包测试**

```ts
const importedV1Id = await packages.importCharacter(v1PackagePath);
expect(await store.getDraft(importedV1Id)).toMatchObject({ version: 2 });
await packages.exportCharacter(importedV1Id, exportedPath);
expect(await readArchiveJson(exportedPath, 'draft/draft.json')).toMatchObject({ version: 2 });
expect(await readArchiveJson(exportedPath, 'compiled/manifest.json')).toMatchObject({ version: 2 });
await expect(packages.importCharacter(packageWithUnknownV2Field))
  .rejects.toThrow('CHARACTER_PACKAGE_INVALID');
await expect(packages.importCharacter(packageWithCapabilityRef))
  .rejects.toThrow('CHARACTER_PACKAGE_INVALID');
```

- [ ] **Step 5: 在现有隔离导入阶段统一 V1/V2**

`validateExtractedPackage()` 先按 `version` 选择严格解析器；V1 的 draft 与 manifest 均在 staging 内转换为 V2并交叉校验资源引用和来源版本，V2 直接严格解析。正式创建、复制素材、保存与发布仍沿用现有 `importTransactionId` 回滚链；导出通过 `getDraft()` 与 `getPublishedManifest()` 读取 V2，不调用 legacy 投影。

```ts
const draftResult = migrateCharacterDocument(await readJson(draftPath));
const manifestResult = migrateCharacterManifest(await readJson(manifestPath));
return {
  draft: draftResult.document,
  manifest: manifestResult.document,
  sourceVersion: draftResult.sourceVersion
};
```

当角色摘要标记迁移失败时，工作室显示“重试读取”和“导出恢复包”。重试读取复用 `getDraft()`，不新增 Main 写入口；现有导出流程自动转入 `exportCharacterRecovery()` 并返回 `recovery-exported`。恢复归档仅允许 `recovery/original-draft.json`、`source/catalog.json` 和已通过目录边界/哈希校验的源素材，不能将内部绝对路径、事务标记或未知文件写入归档。

- [ ] **Step 6: 运行 IPC、角色包、安全测试并提交**

Run: `pnpm.cmd --filter @myself/desktop test -- character-ipc.test.ts character-package-service.test.ts`

Run: `pnpm.cmd test:security`

Expected: PASS；路径逃逸、符号链接、大小限制、脚本条目与未知字段测试继续通过。

```powershell
git add apps/desktop/src/shared/character-ipc.ts apps/desktop/src/shared/myself-api.ts apps/desktop/src/main/ipc/register-ipc.ts apps/desktop/src/main/characters/character-actions.ts apps/desktop/src/main/characters/character-package-service.ts apps/desktop/tests/character-ipc.test.ts apps/desktop/tests/character-package-service.test.ts
git commit -m "feat：贯通 V2 角色 IPC 与安全角色包"
```

---

### Task 6：建立工作室 V2 选择与不可变编辑模型

**Files:**

- Modify: `apps/desktop/src/renderer/src/characters/store/character-workshop-store.ts`
- Test: `apps/desktop/tests/character-workshop-store.test.ts`

**Interfaces:**

- Produces: `selectedEntity: { kind: 'identity' } | { kind: 'skin'; skinId: string } | { kind: 'state'; stateId: string } | { kind: 'action'; actionId: string }`
- Produces: `selectedSkinId: string | null`
- Produces: `updateIdentity(patch: Partial<CharacterIdentityV2>): void`
- Produces: `addSkin(name: string): void`、`duplicateSkin(skinId: string, name: string): void`、`updateSkin(skinId: string, patch: Partial<CharacterSkinV2>): void`、`setDefaultSkin(skinId: string): void`、`requestRemoveSkin(skinId: string): CharacterReferenceImpact`
- Produces: `addState(input: { name: string; kind: 'primary' | 'modifier'; semantic: CharacterStateSemanticV2 }): void`、`updateState(stateId: string, patch: Partial<CharacterStateDefinitionV2>): void`、`requestRemoveState(stateId: string): CharacterReferenceImpact`
- Produces: `addAction(stateId: string, name: string): void`、`updateAction(actionId: string, patch: Partial<CharacterActionDefinitionV2>): void`、`requestRemoveAction(actionId: string): CharacterReferenceImpact`
- Produces: `CharacterReferenceImpact = { safeReferencePaths: string[]; blockingReferencePaths: string[] }`

- [ ] **Step 1: 将测试夹具切换到 V2，并写选择/自动保存测试**

```ts
await store.getState().selectCharacter('demo');
store.getState().selectSkin('winter');
expect(store.getState()).toMatchObject({
  selectedSkinId: 'winter',
  selectedEntity: { kind: 'skin', skinId: 'winter' }
});
store.getState().updateIdentity({ summary: '一只谨慎的桌面伙伴' });
await vi.advanceTimersByTimeAsync(500);
expect(api.saveCharacterDraft).toHaveBeenCalledWith(
  'demo', expect.objectContaining({ version: 2 })
);
```

- [ ] **Step 2: 运行 Store 测试确认 V1 嵌套状态结构不匹配**

Run: `pnpm.cmd --filter @myself/desktop test -- character-workshop-store.test.ts`

Expected: FAIL，Store 尚无皮肤/实体选择和 V2 编辑方法。

- [ ] **Step 3: 实现统一不可变更新入口和选择屏障**

```ts
function updateDraft(
  mutate: (draft: CharacterDraftV2) => void
): void {
  const current = get();
  if (!current.draft) return;
  const next = structuredClone(current.draft);
  mutate(next);
  draftRevision += 1;
  set({ draft: next, draftStatus: 'dirty' });
  scheduleSave();
}
```

角色切换前继续 `flushDraft()`；皮肤/状态/动作切换不跨角色读取，更新 `selectedEntity` 后由纯选择器计算当前对象。初始选择使用 `defaultSkinId`、`defaultStateId` 和默认状态首个动作。

- [ ] **Step 4: 实现实体新增、编辑和引用影响分析**

```ts
function inspectActionRemoval(draft: CharacterDraftV2, actionId: string): CharacterReferenceImpact {
  return {
    safeReferencePaths: draft.states.flatMap((state, index) =>
      state.actionIds.includes(actionId) ? [`states.${index}.actionIds`] : []),
    blockingReferencePaths: draft.actions.flatMap((action, index) => [
      ...(action.failureFallbackActionId === actionId
        ? [`actions.${index}.failureFallbackActionId`] : []),
      ...(action.interruptedFallbackActionId === actionId
        ? [`actions.${index}.interruptedFallbackActionId`] : [])
    ])
  };
}
```

空皮肤可直接移除；含表现的皮肤需要确认。安全引用在确认后同步清理；默认皮肤、默认状态、动作回退等会改变语义的引用列为阻塞项，必须先重选。删除不触碰 `availableSources` 或源素材目录。

- [ ] **Step 5: 写删除引用、保存失败与切换竞态测试**

```ts
expect(store.getState().requestRemoveAction('wave')).toMatchObject({
  blockingReferencePaths: ['actions.1.failureFallbackActionId']
});
expect(store.getState().draft?.actions).toHaveLength(2);
api.saveCharacterDraft.mockRejectedValueOnce(new Error('CHARACTER_DRAFT_SAVE_FAILED'));
store.getState().updateSkin('winter', { name: '冬装' });
await store.getState().flushDraft();
expect(store.getState()).toMatchObject({ draftStatus: 'error' });
expect(store.getState().draft?.skins.find(skin => skin.id === 'winter')?.name)
  .toBe('冬装');
```

Run: `pnpm.cmd --filter @myself/desktop test -- character-workshop-store.test.ts`

Expected: PASS。

- [ ] **Step 6: 提交工作室领域状态**

```powershell
git add apps/desktop/src/renderer/src/characters/store/character-workshop-store.ts apps/desktop/tests/character-workshop-store.test.ts
git commit -m "feat：建立工作室 V2 编辑状态"
```

---

### Task 7：实现 V2 编译并保持播放器行为不变

**Files:**

- Modify: `apps/desktop/src/renderer/src/characters/store/character-workshop-store.ts`
- Test: `apps/desktop/tests/character-workshop-store.test.ts`
- Test: `apps/desktop/tests/character-player.test.tsx`
- Test: `apps/desktop/tests/character-motion-controller.test.ts`
- Test: `apps/desktop/tests/extension-trigger-controller.test.ts`

**Interfaces:**

- Consumes: 当前皮肤的 `CharacterActionPresentationV2` 与现有 `compileAtlas()`
- Produces: `compileAndPublish(): Promise<void>` 发布 `CharacterManifestV2`
- Preserves: Player、motion controller、extension trigger controller 接收 `CharacterManifestV1`

- [ ] **Step 1: 写按皮肤表现编译和默认链阻止发布测试**

```ts
await store.getState().compileAndPublish();
expect(api.publishCharacter).toHaveBeenCalledWith(expect.objectContaining({
  manifest: expect.objectContaining({
    version: 2,
    defaultSkinId: 'winter',
    skins: expect.arrayContaining([
      expect.objectContaining({ id: 'winter', presentations: expect.any(Array) })
    ])
  })
}));

store.setState({ draft: withoutPlayableDefault(store.getState().draft!) });
await store.getState().compileAndPublish();
expect(api.publishCharacter).toHaveBeenCalledTimes(1);
expect(store.getState().compileStatus).toBe('error');
```

- [ ] **Step 2: 运行 Store 编译测试确认仍生成 V1**

Run: `pnpm.cmd --filter @myself/desktop test -- character-workshop-store.test.ts`

Expected: FAIL，`compileAndPublish` 的清单版本仍为 1。

- [ ] **Step 3: 按皮肤—表现遍历复用 atlas 编译器**

对每个 `skin.presentations` 的非空帧集合调用现有 `compileAction`，把编译后的帧写回对应表现；资源仍按哈希和内部安全文件名进入 `resources`。空增量覆盖可以保留在草稿，但不进入发布清单。发布前调用 `characterManifestV2Schema.parse()`，默认回退链不可播放时抛出稳定码 `CHARACTER_DEFAULT_PRESENTATION_UNAVAILABLE`。

```ts
const manifest = characterManifestV2Schema.parse({
  ...latest,
  thumbnailAssetId: compiledResources[0]!.assetId,
  compilerVersion: 'character-atlas-compiler-v2',
  resources: manifestResources,
  skins: compiledSkins
});
await api.publishCharacter({ characterId: latest.id, manifest, resources });
```

- [ ] **Step 4: 运行播放器回归测试，确认投影边界外零修改**

Run: `pnpm.cmd --filter @myself/desktop test -- character-player.test.tsx character-motion-controller.test.ts extension-trigger-controller.test.ts pixi-character-player.test.ts`

Expected: PASS；动作选择、拖拽和指针触发行为不变。

- [ ] **Step 5: 运行 Store 测试并提交**

Run: `pnpm.cmd --filter @myself/desktop test -- character-workshop-store.test.ts`

Expected: PASS。

```powershell
git add apps/desktop/src/renderer/src/characters/store/character-workshop-store.ts apps/desktop/tests/character-workshop-store.test.ts apps/desktop/tests/character-player.test.tsx apps/desktop/tests/character-motion-controller.test.ts apps/desktop/tests/extension-trigger-controller.test.ts
git commit -m "feat：编译并发布 V2 角色表现"
```

---

### Task 8：构建三栏 V2 角色工作室界面

**Files:**

- Create: `apps/desktop/src/renderer/src/characters/workshop/CharacterIdentityInspector.tsx`
- Create: `apps/desktop/src/renderer/src/characters/workshop/SkinList.tsx`
- Create: `apps/desktop/src/renderer/src/characters/workshop/SkinInspector.tsx`
- Create: `apps/desktop/src/renderer/src/characters/workshop/StateInspector.tsx`
- Modify: `apps/desktop/src/renderer/src/characters/workshop/ActionInspector.tsx`
- Modify: `apps/desktop/src/renderer/src/characters/workshop/StateList.tsx`
- Modify: `apps/desktop/src/renderer/src/characters/workshop/CharacterWorkshopView.tsx`
- Modify: `apps/desktop/src/renderer/src/characters/workshop/character-workshop.css`
- Test: `apps/desktop/tests/character-workshop-components.test.tsx`
- Test: `apps/desktop/tests/character-workshop-state-list.dom.test.tsx`

**Interfaces:**

- Consumes: Task 6 的 `selectedEntity`、V2 编辑方法和 `CharacterReferenceImpact`
- Produces: 角色人设、皮肤、状态、动作四类结构化 Inspector
- Preserves: 现有三栏、顶部素材导入/保存/发布、状态行加号和动作行减号交互

- [ ] **Step 1: 写左栏皮肤与自由状态 DOM 测试**

```tsx
render(<SkinList
  skins={draft.skins}
  defaultSkinId="default"
  selectedSkinId="winter"
  disabled={false}
  onAdd={onAdd}
  onSelect={onSelect}
  onSetDefault={onSetDefault}
  onRequestDelete={onDelete}
/>);
expect(screen.getByRole('heading', { name: '角色与皮肤' })).toBeVisible();
expect(screen.getByRole('button', { name: '新增皮肤' })).toBeEnabled();
expect(screen.queryByRole('button', { name: '删除皮肤“默认皮肤”' })).toBeNull();
expect(screen.getByRole('button', { name: '删除皮肤“冬装”' })).toBeEnabled();
```

- [ ] **Step 2: 运行组件测试确认组件和 V2 Props 不存在**

Run: `pnpm.cmd --filter @myself/desktop test -- character-workshop-components.test.tsx character-workshop-state-list.dom.test.tsx`

Expected: FAIL。

- [ ] **Step 3: 实现皮肤列表和四类 Inspector**

`CharacterIdentityInspector` 使用受控输入和可增删标签行，严格遵守 Task 1 数量/长度。`StateInspector` 只用 select、checkbox 和有界数字输入编辑合法引用；条件仅能从 `TRUSTED_BEHAVIOR_SIGNALS`、标准语义和当前状态选择。`ActionInspector` 编辑语义、偏好、冷却、重复抑制、中断、方向和回退引用，不再直接拥有 FPS/帧字段。`SkinInspector` 编辑当前皮肤元数据并明确当前表现是否来自增量覆盖。

```tsx
switch (state.selectedEntity.kind) {
  case 'identity':
    return <CharacterIdentityInspector identity={draft.identity} onChange={state.updateIdentity} />;
  case 'skin':
    return <SkinInspector skin={selectedSkin} onChange={patch => state.updateSkin(selectedSkin.id, patch)} />;
  case 'state':
    return <StateInspector state={selectedState} allStates={draft.states} onChange={state.updateState} />;
  case 'action':
    return <ActionInspector action={selectedAction} actions={draft.actions} states={draft.states} onChange={state.updateAction} />;
}
```

- [ ] **Step 4: 重组工作室编排与删除对话框**

左栏上半区标题改为“角色与皮肤”，角色行下渲染 `SkinList`；下半区保留“状态与动作”。状态行显示“主状态/修饰状态”，所有非默认状态均可请求删除。删除对话框逐行显示 `safeReferencePaths` 和 `blockingReferencePaths`；有阻塞引用时确认按钮禁用并提示先重选，不自动猜测替代项。

迁移失败角色仍保留在角色列表：右栏显示稳定恢复说明，并提供“重试读取”和“导出恢复包”两个按钮。恢复说明只显示错误码对应的中文文案，不显示绝对路径或原始异常堆栈。

- [ ] **Step 5: 补人设限制、引用选择与删除确认测试并运行**

```tsx
expect(screen.queryByLabelText(/系统 Prompt|JSON|脚本/u)).toBeNull();
await user.selectOptions(screen.getByLabelText('动作失败回退'), 'idle-main');
expect(onChange).toHaveBeenCalledWith({ failureFallbackActionId: 'idle-main' });
expect(screen.getByText('actions.1.failureFallbackActionId')).toBeVisible();
expect(screen.getByRole('button', { name: '确认删除' })).toBeDisabled();
```

Run: `pnpm.cmd --filter @myself/desktop test -- character-workshop-components.test.tsx character-workshop-state-list.dom.test.tsx character-workshop-close-renderer.test.tsx`

Expected: PASS。

- [ ] **Step 6: 提交三栏界面**

```powershell
git add apps/desktop/src/renderer/src/characters/workshop/CharacterIdentityInspector.tsx apps/desktop/src/renderer/src/characters/workshop/SkinList.tsx apps/desktop/src/renderer/src/characters/workshop/SkinInspector.tsx apps/desktop/src/renderer/src/characters/workshop/StateInspector.tsx apps/desktop/src/renderer/src/characters/workshop/ActionInspector.tsx apps/desktop/src/renderer/src/characters/workshop/StateList.tsx apps/desktop/src/renderer/src/characters/workshop/CharacterWorkshopView.tsx apps/desktop/src/renderer/src/characters/workshop/character-workshop.css apps/desktop/tests/character-workshop-components.test.tsx apps/desktop/tests/character-workshop-state-list.dom.test.tsx
git commit -m "feat：完成 V2 角色工作室结构化编辑"
```

---

### Task 9：让预览按皮肤即时刷新并可解释回退

**Files:**

- Modify: `apps/desktop/src/renderer/src/characters/workshop/DraftCharacterPreview.tsx`
- Modify: `apps/desktop/src/renderer/src/characters/workshop/CharacterWorkshopView.tsx`
- Modify: `apps/desktop/src/renderer/src/characters/workshop/character-workshop.css`
- Test: `apps/desktop/tests/draft-character-preview.test.tsx`

**Interfaces:**

- Consumes: `resolveCharacterPresentation(draft, selectedSkinId, selectedActionId)`
- Produces: `DraftCharacterPreviewProps.selectedSkinId: string | null`
- Produces: 可访问状态文案“当前皮肤精确表现 / 当前皮肤语义回退 / 默认皮肤动作 / 默认状态回退 / 无可播放表现”

- [ ] **Step 1: 写皮肤切换重建、回退来源和空链清屏测试**

```tsx
const view = renderPreview({ draft, selectedSkinId: 'default', selectedActionId: 'wave' });
await waitFor(() => expect(player.load).toHaveBeenCalledTimes(1));
view.rerender(element({ draft, selectedSkinId: 'winter', selectedActionId: 'wave' }));
await waitFor(() => expect(player.destroy).toHaveBeenCalledTimes(1));
expect(player.load).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'winter-wave' }));
expect(screen.getByText('当前使用：当前皮肤语义回退')).toBeVisible();
view.rerender(element({ draft: withoutPlayableChain(draft), selectedSkinId: 'winter' }));
expect(player.clear).toHaveBeenCalled();
expect(screen.getByText('无可播放表现')).toBeVisible();
```

- [ ] **Step 2: 运行预览测试确认缺少皮肤身份**

Run: `pnpm.cmd --filter @myself/desktop test -- draft-character-preview.test.tsx`

Expected: FAIL，预览 Props 和身份键未包含皮肤。

- [ ] **Step 3: 将表现解析结果作为候选播放器唯一输入**

把候选身份键扩展为 `[characterId, draftId, skinId, stateId, actionId, presentationSource]`。每次身份变化先销毁旧候选，再加载新资源；解析结果为 `null`、读取失败或播放器加载失败时调用现有同步清屏并显示错误，绝不保留旧画面。时间轴的写入目标始终是当前所选皮肤的精确 `presentations[actionId]`；当前来自回退且用户编辑帧时，显式创建当前皮肤增量覆盖后再写入。

```ts
const resolved = draft && selectedSkinId && selectedActionId
  ? resolveCharacterPresentation(draft, selectedSkinId, selectedActionId)
  : null;
const previewIdentity = JSON.stringify([
  draft?.id, selectedSkinId, selectedStateId, selectedActionId, resolved?.source
]);
```

- [ ] **Step 4: 运行预览与工作室组件测试并提交**

Run: `pnpm.cmd --filter @myself/desktop test -- draft-character-preview.test.tsx character-workshop-components.test.tsx`

Expected: PASS。

```powershell
git add apps/desktop/src/renderer/src/characters/workshop/DraftCharacterPreview.tsx apps/desktop/src/renderer/src/characters/workshop/CharacterWorkshopView.tsx apps/desktop/src/renderer/src/characters/workshop/character-workshop.css apps/desktop/tests/draft-character-preview.test.tsx
git commit -m "fix：按皮肤刷新预览并解释回退来源"
```

---

### Task 10：端到端持久化验收与全量回归

**Files:**

- Modify: `tests/e2e/desktop.spec.ts`
- Modify: `apps/desktop/tests/character-workshop-close-renderer.test.tsx`
- Modify: `docs/superpowers/specs/2026-08-01-character-package-v2-editor-design.md`（仅当实现产生已验证的接口名称勘误）

**Interfaces:**

- Consumes: Tasks 1–9 的完整 V2 垂直链路
- Produces: 自动化验收证据和 Windows 手工验收清单

- [ ] **Step 1: 写重启恢复与导出回导 E2E**

```ts
test('V2 人设、皮肤和表现重启后保留且导出回导等价', async ({ page }) => {
  await openCharacterWorkshop(page);
  await editIdentitySummary(page, '喜欢整理桌面的伙伴');
  await addSkin(page, '冬装');
  await importFramesIntoSelectedSkin(page, fixturePng);
  await publishCharacter(page);
  await restartDesktopApp();
  await expect(page.getByDisplayValue('喜欢整理桌面的伙伴')).toBeVisible();
  await expect(page.getByRole('button', { name: '冬装' })).toBeVisible();
  await exportAndReimportSelectedCharacter(page);
  await expect(page.getByText('当前使用：当前皮肤精确表现')).toBeVisible();
});
```

在现有 E2E helper 结构中实现这组操作，资源使用仓库现有 PNG fixture，不访问用户真实目录。

- [ ] **Step 2: 运行 E2E 确认测试先失败**

Run: `pnpm.cmd test:e2e:desktop`

Expected: 新场景在 V2 界面或持久化断言处 FAIL；既有场景保持通过。

- [ ] **Step 3: 只修复端到端暴露的接口接线缺口**

允许修改的缺口限于 Tasks 1–9 已定义接口，例如漏传 `selectedSkinId`、关闭前漏 `flushDraft()`、摘要字段仍使用 `missingCoreStates`。不得在此任务新增行为引擎、文件交互或新的 V2 字段。

- [ ] **Step 4: 运行分层回归门**

Run: `pnpm.cmd typecheck`

Expected: PASS。

Run: `pnpm.cmd test:unit`

Expected: PASS。

Run: `pnpm.cmd test:security`

Expected: PASS。

Run: `pnpm.cmd test:integration`

Expected: PASS。

Run: `pnpm.cmd verify:characters`

Expected: PASS，包含 Electron build 与桌面 E2E。

- [ ] **Step 5: 执行 Windows 手工验收**

按以下固定顺序记录结果：新建角色即为 V2；导入 V1 自动显示为 V2；编辑人设；新增/切换/设默认/删除皮肤；新增主状态与修饰状态；新增/删除动作；引用阻塞提示；切换角色/皮肤/状态/动作预览无残影；关闭重开字段与素材仍在；发布后桌宠显示默认皮肤；V2 导出再导入字段等价；拖拽到左上角仍可继续拖动；MCP 入口仍不可用。

- [ ] **Step 6: 提交验收测试**

```powershell
git add tests/e2e/desktop.spec.ts apps/desktop/tests/character-workshop-close-renderer.test.tsx
git commit -m "test：覆盖 V2 角色编辑持久化闭环"
```

---

## 最终审查门

- 逐节对照设计规格第 3–12 节；每项都能对应 Task 1–10 的实现或明确的本阶段排除项。
- 搜索 V2 正式写入链中的 `CharacterDraftV1`、`CharacterManifestV1`：只允许存在于 V1 解析、转换器、legacy 投影与播放器输入边界。
- 搜索 `missingCoreStates`：工作室、IPC 和 Store 摘要不得残留；旧测试夹具应全部切换到 `missingRequirements`。
- 搜索 `version: 1`：新建、保存、编译、导出不得产生 V1；仅 V1 fixture、V1 Schema 和 legacy 投影允许保留。
- 搜索 `systemPrompt`、`script`、`shell`、`mcp`、`capabilityRef`：Schema 测试必须证明角色包不能声明这些执行能力。
- 检查所有删除操作：只删除配置引用，不删除源素材；角色删除仍沿用既有确认和回滚机制。
- 检查类型一致性：`saveDraft/publishCompiled` 为 V2，`getRuntimeManifest/getActive/CharacterRuntimeSnapshot` 为 legacy V1 投影。
- 运行 `git diff --check`，确认没有尾随空格、冲突标记或行尾异常。
- 运行 `pnpm.cmd verify:desktop` 作为提交后的最终整体验证；只有命令退出码为 0 才可报告阶段完成。
