# AI Pet 角色工作室可靠性改进实施计划

> **面向智能代理执行者：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`，逐任务实施本计划。所有步骤使用复选框跟踪。

**目标：** 修复角色工作室预览残影和重启后素材目录未恢复的问题，并按已确认的层级交互补齐动作与扩展状态删除能力。

**架构：** 保留现有 Main、Preload、Renderer Store 与 Pixi 场景边界。Main 复用 `CharacterAssetService.listSources()` 提供只读素材目录，Store 原子加载草稿和素材，预览场景增加显式清空能力，状态与动作删除继续进入现有草稿自动保存链路。

**技术栈：** Electron 43、React 19、TypeScript、Zustand、PixiJS 8、Zod、Vitest、Testing Library、Playwright。

**设计规格：** [角色工作室可靠性改进设计](../specs/2026-07-30-character-workshop-reliability-design.md)

## 全局约束

- 只在现有 `AgentCoreExtension` 工作树中开发，不创建或切换其他分支。
- 保留现有角色草稿、素材目录和运行时清单格式，不增加数据迁移。
- 所有新增文档、结构性注释、测试名称和用户提示使用中文。
- 遵循最小修改原则，优先复用 `CharacterAssetService.listSources()`、现有修订号、自动保存和 `<dialog>` 样式。
- 核心状态不可删除；扩展状态可删除；所有状态均可新增动作。
- 空动作或空扩展状态直接删除，非空对象必须先确认。
- 删除配置不得删除源素材。
- 所有编辑继续在 500ms 后自动保存，切换和退出前继续强制刷新。
- 任何 Git 暂存或提交步骤都必须先取得用户明确授权。

---

## 文件结构

### 共享协议与 Main

- `apps/desktop/src/shared/ipc-channels.ts`：新增固定素材目录查询通道。
- `apps/desktop/src/shared/character-ipc.ts`：新增素材目录结果 Schema。
- `apps/desktop/src/shared/myself-api.ts`：公开只读 `listCharacterSources()`。
- `apps/desktop/src/main/characters/character-actions.ts`：复用素材服务列出角色素材。
- `apps/desktop/src/main/ipc/register-ipc.ts`：校验角色 ID 并注册查询处理器。
- `apps/desktop/src/preload/index.ts`：将固定 API 映射到固定 IPC 通道。

### Renderer

- `apps/desktop/src/renderer/src/characters/store/character-workshop-store.ts`：原子恢复草稿与素材，并实现动作与扩展状态删除。
- `apps/desktop/src/renderer/src/characters/player/pixi-character-player.ts`：提供同步清空场景能力。
- `apps/desktop/src/renderer/src/characters/workshop/DraftCharacterPreview.tsx`：在身份切换、空目标和失败时清空旧画面。
- `apps/desktop/src/renderer/src/characters/workshop/StateList.tsx`：渲染状态和动作行级加减号。
- `apps/desktop/src/renderer/src/characters/workshop/CharacterWorkshopView.tsx`：移除顶部旧按钮并编排删除确认。
- `apps/desktop/src/renderer/src/characters/workshop/character-workshop.css`：布局行级命令和危险按钮。

### 测试

- `apps/desktop/tests/character-ipc.test.ts`
- `apps/desktop/tests/character-workshop-store.test.ts`
- `apps/desktop/tests/pixi-character-player.test.ts`
- `apps/desktop/tests/draft-character-preview.test.tsx`
- `apps/desktop/tests/character-workshop-components.test.tsx`
- `apps/desktop/tests/character-workshop-state-list.dom.test.tsx`
- `tests/e2e/desktop.spec.ts`

---

### 任务 1：打通只读素材目录 IPC

**文件：**

- 修改：`apps/desktop/src/shared/ipc-channels.ts`
- 修改：`apps/desktop/src/shared/character-ipc.ts`
- 修改：`apps/desktop/src/shared/myself-api.ts`
- 修改：`apps/desktop/src/main/characters/character-actions.ts`
- 修改：`apps/desktop/src/main/ipc/register-ipc.ts`
- 修改：`apps/desktop/src/preload/index.ts`
- 测试：`apps/desktop/tests/character-ipc.test.ts`

**接口：**

- 产出：`MyselfApi.listCharacterSources(characterId: string): Promise<CharacterWorkshopSourceDto[]>`
- 产出：`CharacterActions.listCharacterSources(characterId: string): Promise<CharacterWorkshopSourceDto[]>`
- 依赖：`CharacterAssetService.listSources(characterId)`

- [ ] **步骤 1：在现有 CharacterActions 测试区写失败测试**

在 `character-ipc.test.ts` 的 `describe('CharacterActions 应用服务')` 中新增测试：

```ts
test('列出角色素材直接复用素材服务且不改变角色索引', async () => {
  const sources = [{
    assetId: '00000000-0000-4000-8000-000000000001',
    displayName: 'idle.png',
    mimeType: 'image/png' as const
  }];
  const storedSources = [{
    ...sources[0]!,
    byteLength: 4,
    sha256: '0'.repeat(64)
  }];
  const assets = {
    listSources: vi.fn(async () => storedSources)
  };
  const store = {
    list: vi.fn(async () => [])
  };
  const { CharacterActions } = await import(
    '../src/main/characters/character-actions'
  );
  const actions = new CharacterActions({
    store: store as never,
    assets: assets as never,
    packages: {} as never
  });

  await expect(actions.listCharacterSources('demo')).resolves.toEqual(sources);
  expect(assets.listSources).toHaveBeenCalledWith('demo');
  expect(store.list).not.toHaveBeenCalled();
});
```

- [ ] **步骤 2：运行 CharacterActions 测试并确认失败**

运行：

```powershell
pnpm.cmd --filter @myself/desktop test -- character-ipc.test.ts
```

预期：类型检查或测试因 `listCharacterSources`/`listSources` 尚不存在而失败。

- [ ] **步骤 3：扩展素材端口并实现应用服务方法**

在 `character-actions.ts` 中把素材端口改为：

```ts
type CharacterAssetPort = Pick<
  CharacterAssetService,
  'importSources' | 'listSources' | 'readSource'
>;
```

并增加：

```ts
listCharacterSources(characterId: string): Promise<ImportedSource[]> {
  return this.dependencies.assets.listSources(characterId);
}
```

- [ ] **步骤 4：为白名单 IPC 和 Preload 写失败测试**

在 `character-ipc.test.ts`：

1. 给 `characterServiceDouble()` 增加 `listCharacterSources`。
2. 新增成功与非法输入测试。
3. 验证 Preload 只发送角色 ID，不发送路径。

```ts
test('素材目录查询只接受角色标识并通过固定通道返回公开元数据', async () => {
  const { handlers, ipcMain } = createIpcMain();
  const service = characterServiceDouble();
  const sources = [{
    assetId: '00000000-0000-4000-8000-000000000001',
    displayName: 'idle.png',
    mimeType: 'image/png',
    byteLength: 4,
    sha256: '0'.repeat(64)
  }] as const;
  service.listCharacterSources.mockResolvedValue([...sources]);
  requireCharacterRegistration()(ipcMain, service, dialogDouble());

  await expect(handlers.get(channel('characterSourcesList'))?.({}, {
    characterId: 'demo'
  })).resolves.toEqual({ sources });
  await expect(handlers.get(channel('characterSourcesList'))?.({}, {
    characterId: '../outside'
  })).rejects.toMatchObject({ code: 'CHARACTER_INPUT_INVALID' });

  await exposedApi?.listCharacterSources('demo');
  expect(invoke).toHaveBeenCalledWith(
    ipcChannels.characterSourcesList,
    { characterId: 'demo' }
  );
});
```

- [ ] **步骤 5：运行 IPC 测试并确认失败**

运行：

```powershell
pnpm.cmd --filter @myself/desktop test -- character-ipc.test.ts
```

预期：固定通道、结果 Schema 和 API 尚不存在。

- [ ] **步骤 6：实现共享协议、Main 注册和 Preload 映射**

在 `ipc-channels.ts` 增加：

```ts
characterSourcesList: 'character:sources-list',
```

在 `character-ipc.ts` 增加：

```ts
export const characterWorkshopSourceSchema = characterSourceSchema.pick({
  assetId: true,
  displayName: true,
  mimeType: true
});

export type CharacterWorkshopSourceDto = z.output<
  typeof characterWorkshopSourceSchema
>;

export const characterSourcesResultSchema = z.object({
  sources: z.array(characterWorkshopSourceSchema)
}).strict();
```

在 `myself-api.ts` 增加：

```ts
listCharacterSources(characterId: string): Promise<CharacterWorkshopSourceDto[]>;
```

在 `CharacterIpcService` 增加同名方法，并在 `registerCharacterIpc()` 中注册：

```ts
replaceHandler(ipcMain, ipcChannels.characterSourcesList, async (_event, raw) => {
  const { characterId } = parseCharacterInput(characterIdInputSchema, raw);
  return characterOperation(characterSourcesResultSchema, async () => ({
    sources: await service.listCharacterSources(characterId)
  }));
});
```

`CharacterActions.listCharacterSources()` 必须从内部完整元数据映射出三个公开字段：

```ts
async listCharacterSources(
  characterId: string
): Promise<CharacterWorkshopSourceDto[]> {
  return (await this.dependencies.assets.listSources(characterId)).map(
    ({ assetId, displayName, mimeType }) => ({
      assetId,
      displayName,
      mimeType
    })
  );
}
```

在 Preload API 中增加：

```ts
listCharacterSources: async characterId => {
  const result = await ipcRenderer.invoke(
    ipcChannels.characterSourcesList,
    { characterId }
  );
  return result.sources;
},
```

- [ ] **步骤 7：运行精确测试**

运行：

```powershell
pnpm.cmd --filter @myself/desktop test -- character-ipc.test.ts
```

预期：两个测试文件全部通过。

- [ ] **步骤 8：取得用户 Git 写授权后提交**

```powershell
git add -- apps/desktop/src/shared/ipc-channels.ts apps/desktop/src/shared/character-ipc.ts apps/desktop/src/shared/myself-api.ts apps/desktop/src/main/characters/character-actions.ts apps/desktop/src/main/ipc/register-ipc.ts apps/desktop/src/preload/index.ts apps/desktop/tests/character-ipc.test.ts
git commit -m "feat：恢复角色素材目录查询"
```

---

### 任务 2：启动和角色切换时原子恢复草稿与素材

**文件：**

- 修改：`apps/desktop/src/renderer/src/characters/store/character-workshop-store.ts`
- 测试：`apps/desktop/tests/character-workshop-store.test.ts`

**接口：**

- 消费：`listCharacterSources(characterId)`
- 产出：`loadSelectedDraft()` 同时提交草稿、选择和 `availableSources`
- 保持：现有 `selectionRevision` 和 500ms 自动保存语义

- [ ] **步骤 1：扩展 Store 测试 API 替身**

在 `apiDouble()` 默认实现中增加：

```ts
listCharacterSources: vi.fn(async () => [])
```

并将 `CharacterWorkshopApi` 的 Pick 列表加入 `listCharacterSources`。在测试文件顶部导入 `CharacterWorkshopSourceDto`，新增稳定素材工厂：

```ts
function sourceDto(
  assetId: string,
  displayName: string
): CharacterWorkshopSourceDto {
  return {
    assetId,
    displayName,
    mimeType: 'image/png'
  };
}
```

- [ ] **步骤 2：写启动恢复和多次导入失败测试**

```ts
test('启动时原子恢复活动角色草稿与完整素材目录', async () => {
  const sources = [
    sourceDto('123e4567-e89b-42d3-a456-426614174000', 'idle.png'),
    sourceDto('123e4567-e89b-42d3-a456-426614174001', 'moving.png')
  ];
  const { api } = apiDouble({
    listCharacterSources: vi.fn(async () => sources)
  });
  const store = createCharacterWorkshopStore(api);

  await store.getState().load();

  expect(api.getCharacterDraft).toHaveBeenCalledWith('default');
  expect(api.listCharacterSources).toHaveBeenCalledWith('default');
  expect(store.getState()).toMatchObject({
    selectedCharacterId: 'default',
    availableSources: sources.map(({ assetId, displayName, mimeType }) => ({
      assetId,
      displayName,
      mimeType
    }))
  });
});

test('导入新批次后重新读取完整素材目录而不是覆盖旧素材', async () => {
  const complete = [
    sourceDto('123e4567-e89b-42d3-a456-426614174000', 'idle.png'),
    sourceDto('123e4567-e89b-42d3-a456-426614174001', 'moving.png')
  ];
  const { api } = apiDouble({
    chooseCharacterSources: vi.fn(async () => ({
      kind: 'selected',
      sources: [complete[1]!]
    })),
    listCharacterSources: vi.fn()
      .mockResolvedValueOnce([complete[0]!])
      .mockResolvedValueOnce(complete)
  });
  const store = createCharacterWorkshopStore(api);
  await store.getState().load();

  await store.getState().importSources();

  expect(store.getState().availableSources).toHaveLength(2);
});
```

- [ ] **步骤 3：写乱序和失败保持测试**

覆盖：

- 草稿先返回、素材后返回时不提前切换工作区。
- 旧角色请求晚返回时不能覆盖较新选择。
- 素材目录读取失败时保留此前稳定角色、草稿和素材列表。

失败保持断言示例：

```ts
expect(store.getState()).toMatchObject({
  selectedCharacterId: 'default',
  draft: expect.objectContaining({ id: 'default' }),
  availableSources: previousSources
});
```

- [ ] **步骤 4：运行 Store 测试并确认失败**

运行：

```powershell
pnpm.cmd --filter @myself/desktop test -- character-workshop-store.test.ts
```

预期：Store 尚未调用 `listCharacterSources`，导入仍覆盖列表。

- [ ] **步骤 5：实现原子工作区提交**

将 `setDraft` 扩展为同时设置素材：

```ts
function setDraft(
  draft: CharacterDraftV1,
  sources: readonly CharacterWorkshopSourceDto[] = []
): void {
  const selection = initialSelection(draft);
  draftRevision += 1;
  savedRevision = draftRevision;
  set({
    selectedCharacterId: draft.id,
    draft: cloneDraft(draft),
    selectedStateId: selection.stateId,
    selectedActionId: selection.actionId,
    availableSources: sources.map(({ assetId, displayName, mimeType }) => ({
      assetId,
      displayName,
      mimeType
    })),
    draftStatus: 'idle',
    compileStatus: 'idle'
  });
}
```

将 `loadSelectedDraft` 改为：

```ts
const [loadedDraft, sources] = await Promise.all([
  api.getCharacterDraft(characterId),
  api.listCharacterSources(characterId)
]);
if (requestRevision !== selectionRevision) return;
setDraft(loadedDraft, sources);
```

角色切换开始时只设置 `busyAction: 'loading'`，不要提前把稳定的草稿和素材置空。创建角色可以使用空素材数组；复制和导入角色包通过 `loadSelectedDraft()` 恢复完整素材目录。

- [ ] **步骤 6：导入后刷新完整目录**

`importSources()` 在用户选择成功后调用：

```ts
const sources = await api.listCharacterSources(characterId);
set({
  availableSources: sources.map(({ assetId, displayName, mimeType }) => ({
    assetId,
    displayName,
    mimeType
  }))
});
```

取消导入时不查询、不修改列表。

- [ ] **步骤 7：运行 Store 精确测试**

运行：

```powershell
pnpm.cmd --filter @myself/desktop test -- character-workshop-store.test.ts
```

预期：全部通过，现有保存、切换和事件乱序测试不回归。

- [ ] **步骤 8：取得用户 Git 写授权后提交**

```powershell
git add -- apps/desktop/src/renderer/src/characters/store/character-workshop-store.ts apps/desktop/tests/character-workshop-store.test.ts
git commit -m "fix：重启恢复角色草稿与素材"
```

---

### 任务 3：显式清空预览场景并阻断旧画面

**文件：**

- 修改：`apps/desktop/src/renderer/src/characters/player/pixi-character-player.ts`
- 修改：`apps/desktop/src/renderer/src/characters/workshop/DraftCharacterPreview.tsx`
- 测试：`apps/desktop/tests/pixi-character-player.test.ts`
- 测试：`apps/desktop/tests/draft-character-preview.test.tsx`

**接口：**

- 产出：`PixiCharacterScene.clear(): void`
- 消费：`DraftCharacterPreview` 在选择身份变化、空目标和失败时调用 `clear()`

- [ ] **步骤 1：写 Pixi 清空失败测试**

在现有测试 Pixi 替身中复用 `TestApplication`，新增：

```ts
test('清空场景停止播放、移除精灵并立即重绘', async () => {
  // 复用现有 TestApplication、latestSprites 和动作装载步骤。
  await scene.loadAssets(new Map([['atlas', 'blob:atlas']]));
  scene.showAction(action, {
    direction: 'right',
    motionMode: 'animated',
    speed: 1,
    loop: true
  });
  const notify = vi.fn();
  scene.subscribeFrame(notify);
  const sprite = latestSprites[0]!;

  scene.clear();

  expect(applications[0]!.ticker.stop).toHaveBeenCalled();
  expect(applications[0]!.stage.removeChild).toHaveBeenCalledWith(sprite);
  expect(applications[0]!.render).toHaveBeenCalled();
  expect(scene.getCurrentFrame()).toBeNull();
  expect(scene.getHitSnapshot()).toBeNull();
  expect(notify).toHaveBeenCalled();
});
```

- [ ] **步骤 2：运行 Pixi 测试并确认失败**

```powershell
pnpm.cmd --filter @myself/desktop test -- pixi-character-player.test.ts
```

预期：`PixiCharacterScene.clear` 不存在。

- [ ] **步骤 3：实现最小清空接口**

在接口中增加：

```ts
clear(): void;
```

在 `BrowserPixiCharacterScene` 中实现：

```ts
clear(): void {
  if (this.destroyed) return;
  this.releaseAnimation();
  this.application.render();
  this.notifyFrameListeners();
}
```

清空只释放当前动画，不销毁 Application 和基础纹理；基础纹理由现有加载与销毁流程管理。

- [ ] **步骤 4：给预览场景替身增加 clear**

在 `draft-character-preview.test.tsx` 的 `sceneDouble()` 中增加：

```ts
clear: vi.fn()
```

同步更新所有显式构造 `PixiCharacterScene` 的测试替身。

- [ ] **步骤 5：写选择切换、空目标和乱序失败测试**

至少覆盖：

```ts
test('切换到无帧动作时立即清空旧场景且不再显示旧 bundle', async () => {
  const current = sceneDouble();
  pixiFactory.mockResolvedValue(current.scene);
  const props = previewProps();
  const view = render(<DraftCharacterPreview {...props} />);
  await screen.findByText('预览已就绪');
  const emptyAction = {
    ...idleAction,
    id: 'idle-empty',
    name: '空动作',
    frames: []
  };

  view.rerender(<DraftCharacterPreview
    {...props}
    actionId="idle-empty"
    draft={draftWith(emptyAction)}
  />);

  expect(current.scene.clear).toHaveBeenCalled();
  expect(screen.getByText('当前动作没有可预览帧')).toBeVisible();
});
```

另写：

- 角色身份变化时，在新素材 Promise 完成前已经调用 `clear()`。
- 旧角色加载晚返回时不会调用 `showAction()`。
- 新角色素材读取失败后保持清空。
- 同一动作只修改 `loop` 或锚点时不重复清空整个场景。

- [ ] **步骤 6：运行预览测试并确认失败**

```powershell
pnpm.cmd --filter @myself/desktop test -- draft-character-preview.test.tsx
```

预期：组件尚未在这些边界调用 `clear()`。

- [ ] **步骤 7：按选择身份控制清空**

在 `DraftCharacterPreview` 中增加稳定身份：

```ts
const selectionIdentity = JSON.stringify([
  props.characterId,
  props.draft?.id ?? null,
  props.stateId,
  props.actionId
]);
const previousSelectionIdentityRef = useRef<string | null>(null);
```

资源加载 Effect 开始时：

```ts
const identityChanged =
  previousSelectionIdentityRef.current !== selectionIdentity;
previousSelectionIdentityRef.current = selectionIdentity;
if (identityChanged || !target.action) {
  scene.clear();
}
```

加载失败分支也调用 `scene.clear()`。同一动作属性更新继续走现有 `showAction()`，不因对象引用变化无条件清空。

- [ ] **步骤 8：运行两个精确测试文件**

```powershell
pnpm.cmd --filter @myself/desktop test -- pixi-character-player.test.ts draft-character-preview.test.tsx
```

预期：全部通过。

- [ ] **步骤 9：取得用户 Git 写授权后提交**

```powershell
git add -- apps/desktop/src/renderer/src/characters/player/pixi-character-player.ts apps/desktop/src/renderer/src/characters/workshop/DraftCharacterPreview.tsx apps/desktop/tests/pixi-character-player.test.ts apps/desktop/tests/draft-character-preview.test.tsx
git commit -m "fix：切换时清空旧角色预览"
```

---

### 任务 4：实现动作与扩展状态删除领域操作

**文件：**

- 修改：`apps/desktop/src/renderer/src/characters/store/character-workshop-store.ts`
- 测试：`apps/desktop/tests/character-workshop-store.test.ts`

**接口：**

- 产出：`addAction(stateId: CharacterStateId): void`
- 产出：`removeAction(stateId: CharacterStateId, actionId: string): void`
- 产出：`removeExtensionState(stateId: CharacterStateId): void`
- 保持：删除只修改草稿，不修改 `availableSources`

- [ ] **步骤 1：写状态目标新增动作失败测试**

```ts
test('可直接向指定状态添加动作并选中新动作', async () => {
  const { api } = apiDouble();
  const store = createCharacterWorkshopStore(api);
  await store.getState().load();

  store.getState().addAction('moving');

  expect(store.getState()).toMatchObject({
    selectedStateId: 'moving',
    selectedActionId: 'moving-action-1',
    draftStatus: 'dirty'
  });
});
```

- [ ] **步骤 2：写删除动作失败测试**

覆盖：

- 删除当前动作后优先选择原索引处的下一个动作。
- 删除最后一个动作后选择前一个动作。
- 删除唯一动作后 `selectedActionId` 为 `null`。
- 删除非当前动作时保持当前选中动作。
- 删除后 `availableSources` 不变。
- 500ms 后调用 `saveCharacterDraft`。

```ts
test('删除唯一动作进入自动保存但保留源素材', async () => {
  vi.useFakeTimers();
  const { api } = apiDouble({
    listCharacterSources: vi.fn(async () => [
      sourceDto('123e4567-e89b-42d3-a456-426614174000', 'idle.png')
    ])
  });
  const store = createCharacterWorkshopStore(api);
  await store.getState().load();

  store.getState().removeAction('idle', 'idle-main');

  expect(store.getState()).toMatchObject({
    selectedStateId: 'idle',
    selectedActionId: null,
    draftStatus: 'dirty',
    availableSources: expect.arrayContaining([
      expect.objectContaining({ displayName: 'idle.png' })
    ])
  });
  await vi.advanceTimersByTimeAsync(500);
  expect(api.saveCharacterDraft).toHaveBeenCalled();
});
```

- [ ] **步骤 3：写删除扩展状态失败测试**

覆盖：

- 核心状态传入删除方法时不发生变化。
- 扩展状态删除后回退到第一个核心状态及其首个动作。
- 删除非当前扩展状态时保持有效选择。
- 素材目录保持不变。

- [ ] **步骤 4：运行 Store 测试并确认失败**

```powershell
pnpm.cmd --filter @myself/desktop test -- character-workshop-store.test.ts
```

预期：删除方法尚不存在，`addAction` 也不能显式接收状态 ID。

- [ ] **步骤 5：实现显式状态目标新增动作**

把 `addAction()` 改为：

```ts
addAction(stateId) {
  const current = get();
  if (!current.draft) return;
  const nextDraft = cloneDraft(current.draft);
  const state = nextDraft.states.find(candidate => candidate.id === stateId);
  if (!state) return;
  const base = `${String(state.id).replace(/[^a-z0-9]+/gu, '-')}-action`;
  let index = state.actions.length + 1;
  let id = `${base}-${index}`;
  while (state.actions.some(action => action.id === id)) {
    id = `${base}-${++index}`;
  }
  const newAction: DraftActionClip = {
    id,
    name: `动作 ${index}`,
    fps: 8,
    loop: true,
    weight: 1,
    direction: 'any',
    anchors: { ground: { x: 0.5, y: 1 } },
    frames: []
  };
  state.actions.push(newAction);
  draftRevision += 1;
  set({
    draft: nextDraft,
    selectedStateId: stateId,
    selectedActionId: newAction.id,
    draftStatus: 'dirty'
  });
  scheduleSave();
}
```

- [ ] **步骤 6：实现删除动作与选择回退**

```ts
removeAction(stateId, actionId) {
  const current = get();
  if (!current.draft) return;
  const nextDraft = cloneDraft(current.draft);
  const state = nextDraft.states.find(candidate => candidate.id === stateId);
  const index = state?.actions.findIndex(action => action.id === actionId) ?? -1;
  if (!state || index < 0) return;
  state.actions.splice(index, 1);

  const deletingCurrent = current.selectedStateId === stateId
    && current.selectedActionId === actionId;
  const fallback = state.actions[index] ?? state.actions[index - 1] ?? null;
  draftRevision += 1;
  set({
    draft: nextDraft,
    selectedActionId: deletingCurrent
      ? fallback?.id ?? null
      : current.selectedActionId,
    draftStatus: 'dirty'
  });
  scheduleSave();
}
```

- [ ] **步骤 7：实现扩展状态删除与核心状态防御**

```ts
removeExtensionState(stateId) {
  const current = get();
  if (!current.draft) return;
  const target = current.draft.states.find(state => state.id === stateId);
  if (!target || target.kind !== 'extension') return;
  const nextDraft = cloneDraft(current.draft);
  nextDraft.states = nextDraft.states.filter(state => state.id !== stateId);
  const fallback = nextDraft.states.find(state => state.kind === 'core') ?? null;
  draftRevision += 1;
  set({
    draft: nextDraft,
    selectedStateId: current.selectedStateId === stateId
      ? fallback?.id ?? null
      : current.selectedStateId,
    selectedActionId: current.selectedStateId === stateId
      ? fallback?.actions[0]?.id ?? null
      : current.selectedActionId,
    draftStatus: 'dirty'
  });
  scheduleSave();
}
```

- [ ] **步骤 8：运行 Store 测试**

```powershell
pnpm.cmd --filter @myself/desktop test -- character-workshop-store.test.ts
```

预期：新增、删除、自动保存和既有切换测试全部通过。

- [ ] **步骤 9：取得用户 Git 写授权后提交**

```powershell
git add -- apps/desktop/src/renderer/src/characters/store/character-workshop-store.ts apps/desktop/tests/character-workshop-store.test.ts
git commit -m "feat：支持删除角色动作与扩展状态"
```

---

### 任务 5：重排状态与动作按钮并增加删除确认

**文件：**

- 修改：`apps/desktop/src/renderer/src/characters/workshop/StateList.tsx`
- 修改：`apps/desktop/src/renderer/src/characters/workshop/CharacterWorkshopView.tsx`
- 修改：`apps/desktop/src/renderer/src/characters/workshop/character-workshop.css`
- 测试：`apps/desktop/tests/character-workshop-components.test.tsx`
- 测试：`apps/desktop/tests/draft-character-preview.test.tsx`
- 创建：`apps/desktop/tests/character-workshop-state-list.dom.test.tsx`

**接口：**

- 消费：`addAction(stateId)`
- 消费：`removeAction(stateId, actionId)`
- 消费：`removeExtensionState(stateId)`
- 产出：标题、状态和动作行级加减按钮

- [ ] **步骤 1：更新测试状态替身接口**

所有显式构造 `CharacterWorkshopState` 的测试替身增加：

```ts
removeAction: vi.fn(),
removeExtensionState: vi.fn(),
```

并将 `addAction` 替身改为接收状态 ID。

- [ ] **步骤 2：写工具栏和行级命令失败测试**

在 `character-workshop-components.test.tsx` 新增：

```ts
test('新增入口位于状态与动作层级且顶部旧按钮已移除', () => {
  const markup = renderToStaticMarkup(
    <CharacterWorkshopWorkspace state={state()} />
  );
  const toolbar = markup.match(
    /<nav class="workshop-toolbar"[\s\S]*?<\/nav>/u
  )?.[0] ?? '';

  expect(toolbar).not.toContain('添加动作');
  expect(toolbar).not.toContain('扩展状态');
  expect(markup).toContain('aria-label="添加扩展状态"');
  expect(markup).toContain('aria-label="向“待机”添加动作"');
  expect(markup).toContain('aria-label="删除动作“轻呼吸”"');
});

test('核心状态没有状态减号而扩展状态具有加号和减号', () => {
  const extensionDraft: CharacterDraftV1 = {
    ...currentDraft,
    states: [
      ...currentDraft.states,
      {
        id: 'custom:wave',
        kind: 'extension',
        triggers: { events: [], keywords: [], emotions: [] },
        actions: []
      }
    ]
  };
  const markup = renderToStaticMarkup(
    <CharacterWorkshopWorkspace state={state({ draft: extensionDraft })} />
  );

  expect(markup).not.toContain('aria-label="删除核心状态“待机”"');
  expect(markup).toContain('aria-label="向“wave”添加动作"');
  expect(markup).toContain('aria-label="删除扩展状态“wave”"');
});
```

- [ ] **步骤 3：创建专用 jsdom 删除交互失败测试**

创建 `character-workshop-state-list.dom.test.tsx`，使用 Testing Library 渲染 `CharacterWorkshopWorkspace`，并覆盖：

- 点击无帧动作减号立即调用 `removeAction`。
- 点击有帧动作减号打开确认对话框，取消无副作用，确认后调用删除。
- 空扩展状态直接删除。
- 非空扩展状态确认框显示状态名称和动作数量。

测试文件先将真实预览替换为无副作用占位组件，再建立完整状态替身：

```tsx
// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { CharacterDraftV1 } from '@myself/character-runtime';
import {
  CharacterWorkshopWorkspace
} from '../src/renderer/src/characters/workshop/CharacterWorkshopView';
import type {
  CharacterWorkshopState
} from '../src/renderer/src/characters/store/character-workshop-store';

vi.mock(
  '../src/renderer/src/characters/workshop/DraftCharacterPreview',
  () => ({ DraftCharacterPreview: () => <div aria-label="预览占位" /> })
);

afterEach(cleanup);

const configuredDraft: CharacterDraftV1 = {
  version: 1,
  id: 'nova',
  name: 'Nova',
  states: [{
    id: 'idle',
    kind: 'core',
    actions: [{
      id: 'idle-main',
      name: '轻呼吸',
      fps: 8,
      loop: true,
      weight: 1,
      direction: 'any',
      anchors: { ground: { x: 0.5, y: 1 } },
      frames: [{
        id: 'frame-1',
        assetId: '123e4567-e89b-42d3-a456-426614174000',
        x: 0,
        y: 0,
        width: 32,
        height: 32
      }]
    }, {
      id: 'idle-empty',
      name: '空动作',
      fps: 8,
      loop: true,
      weight: 1,
      direction: 'any',
      anchors: { ground: { x: 0.5, y: 1 } },
      frames: []
    }]
  }, {
    id: 'custom:wave',
    kind: 'extension',
    triggers: { events: [], keywords: [], emotions: [] },
    actions: []
  }]
};

function stateDouble(): CharacterWorkshopState {
  return {
    characters: [{
      id: 'nova',
      name: 'Nova',
      thumbnailAssetId: null,
      active: true,
      completeness: 'complete',
      missingCoreStates: []
    }],
    selectedCharacterId: 'nova',
    draft: structuredClone(configuredDraft),
    selectedStateId: 'idle',
    selectedActionId: 'idle-main',
    draftStatus: 'saved',
    compileStatus: 'idle',
    loadStatus: 'ready',
    busyAction: null,
    toastQueue: [],
    availableSources: [],
    load: vi.fn(async () => undefined),
    mount: vi.fn(() => () => undefined),
    selectCharacter: vi.fn(async () => undefined),
    selectState: vi.fn(),
    selectAction: vi.fn(),
    createCharacter: vi.fn(async () => undefined),
    duplicateCharacter: vi.fn(async () => undefined),
    deleteCharacter: vi.fn(async () => undefined),
    activateCharacter: vi.fn(async () => undefined),
    importCharacterPackage: vi.fn(async () => undefined),
    exportCharacterPackage: vi.fn(async () => undefined),
    importSources: vi.fn(async () => undefined),
    addAction: vi.fn(),
    removeAction: vi.fn(),
    addExtensionState: vi.fn(),
    removeExtensionState: vi.fn(),
    applySpriteSheet: vi.fn(async () => undefined),
    compileAndPublish: vi.fn(async () => undefined),
    publishCharacter: vi.fn(async () => undefined),
    updateCurrentAction: vi.fn(),
    flushDraft: vi.fn(async () => undefined),
    dismissToast: vi.fn(),
    dispose: vi.fn()
  };
}

function renderWorkspace(state: CharacterWorkshopState) {
  render(
    <CharacterWorkshopWorkspace
      state={state}
      api={{ readCharacterSource: vi.fn(async () => new Uint8Array()) }}
    />
  );
}
```

直接删除和确认删除测试使用：

```tsx
test('空动作直接删除而有帧动作必须确认', () => {
  const state = stateDouble();
  renderWorkspace(state);

  fireEvent.click(screen.getByRole('button', {
    name: '删除动作“空动作”'
  }));
  expect(state.removeAction).toHaveBeenCalledWith('idle', 'idle-empty');

  fireEvent.click(screen.getByRole('button', {
    name: '删除动作“轻呼吸”'
  }));
  expect(state.removeAction).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('dialog')).toHaveTextContent('1 帧');

  fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
  expect(state.removeAction).toHaveBeenLastCalledWith('idle', 'idle-main');
});

test('空扩展状态直接删除', () => {
  const state = stateDouble();
  renderWorkspace(state);
  fireEvent.click(screen.getByRole('button', {
    name: '删除扩展状态“wave”'
  }));
  expect(state.removeExtensionState).toHaveBeenCalledWith('custom:wave');
});

test('包含动作的扩展状态必须确认', () => {
  const state = stateDouble();
  const extension = state.draft?.states.find(
    candidate => candidate.id === 'custom:wave'
  );
  const idleAction = state.draft?.states[0]?.actions[0];
  if (!extension || !idleAction) throw new Error('测试草稿不完整');
  extension.actions = [{ ...structuredClone(idleAction), id: 'wave-main' }];
  renderWorkspace(state);

  fireEvent.click(screen.getByRole('button', {
    name: '删除扩展状态“wave”'
  }));
  expect(state.removeExtensionState).not.toHaveBeenCalled();
  expect(screen.getByRole('dialog')).toHaveTextContent('1 个动作');

  fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
  expect(state.removeExtensionState).toHaveBeenCalledWith('custom:wave');
});
```

- [ ] **步骤 4：运行组件测试并确认失败**

```powershell
pnpm.cmd --filter @myself/desktop test -- character-workshop-components.test.tsx character-workshop-state-list.dom.test.tsx draft-character-preview.test.tsx
```

预期：旧顶部按钮仍存在，行级命令和删除对话框尚不存在。

- [ ] **步骤 5：扩展 StateList 属性**

```ts
export interface StateListProps {
  states: CharacterDraftStateDefinition[];
  selectedStateId: CharacterStateId | null;
  selectedActionId: string | null;
  disabled: boolean;
  onSelectState(stateId: CharacterStateId): void;
  onSelectAction(actionId: string): void;
  onAddAction(stateId: CharacterStateId): void;
  onRequestDeleteState(state: CharacterDraftStateDefinition): void;
  onRequestDeleteAction(
    stateId: CharacterStateId,
    action: DraftActionClip
  ): void;
}
```

状态行和动作行使用“选择按钮 + 命令组”并列结构，避免在 `<button>` 内嵌套按钮。状态加号始终存在，状态减号只在 `state.kind === 'extension'` 时存在。

- [ ] **步骤 6：移动新增入口**

在 `CharacterWorkshopView.tsx`：

- 从工具栏删除两个旧按钮。
- 在“状态与动作”的 `.section-heading` 中增加：

```tsx
<button
  type="button"
  aria-label="添加扩展状态"
  title="添加扩展状态"
  disabled={busy || !state.draft}
  onClick={() => setExtensionOpen(true)}
>
  <Plus size={16} />
</button>
```

- 给 `StateList` 传入 `state.addAction` 和删除请求处理器。

- [ ] **步骤 7：实现确认状态与统一对话框**

在工作区组件中增加：

```ts
type PendingConfigurationDelete =
  | {
      kind: 'action';
      stateId: CharacterStateId;
      action: DraftActionClip;
    }
  | {
      kind: 'state';
      state: CharacterDraftStateDefinition;
    };
```

处理规则：

```ts
function requestDeleteAction(
  stateId: CharacterStateId,
  action: DraftActionClip
): void {
  if (action.frames.length === 0) {
    state.removeAction(stateId, action.id);
    return;
  }
  setPendingConfigurationDelete({ kind: 'action', stateId, action });
}

function requestDeleteState(stateDefinition: CharacterDraftStateDefinition): void {
  if (stateDefinition.actions.length === 0) {
    state.removeExtensionState(stateDefinition.id);
    return;
  }
  setPendingConfigurationDelete({ kind: 'state', state: stateDefinition });
}
```

确认对话框复用现有 `dialog-actions`、`danger-command` 和 Escape 取消逻辑。

- [ ] **步骤 8：增加最小 CSS**

在 `character-workshop.css` 增加：

- `.section-heading-command`
- `.state-row`
- `.action-row`
- `.state-row-commands`
- `.action-row-commands`

选择按钮占据剩余宽度，命令按钮固定 30px；危险减号 hover 使用现有 `--workshop-danger`。不改变三栏宽度。

- [ ] **步骤 9：运行组件和预览测试**

```powershell
pnpm.cmd --filter @myself/desktop test -- character-workshop-components.test.tsx character-workshop-state-list.dom.test.tsx draft-character-preview.test.tsx
```

预期：按钮层级、确认规则、无障碍标签和现有预览工作区测试全部通过。

- [ ] **步骤 10：取得用户 Git 写授权后提交**

```powershell
git add -- apps/desktop/src/renderer/src/characters/workshop/StateList.tsx apps/desktop/src/renderer/src/characters/workshop/CharacterWorkshopView.tsx apps/desktop/src/renderer/src/characters/workshop/character-workshop.css apps/desktop/tests/character-workshop-components.test.tsx apps/desktop/tests/character-workshop-state-list.dom.test.tsx apps/desktop/tests/draft-character-preview.test.tsx
git commit -m "feat：重排状态动作增删入口"
```

---

### 任务 6：补齐真实重启验收并执行完整回归

**文件：**

- 修改：`tests/e2e/desktop.spec.ts`
- 修改：`docs/operations/character-workshop-acceptance.md`

**接口：**

- 消费：行级新增动作按钮的中文无障碍名称。
- 验证：新进程从同一角色数据快照恢复草稿、素材和预览。

- [ ] **步骤 1：更新 E2E 旧按钮选择器**

将现有角色工作室闭环中的顶部按钮选择器替换为层级按钮：

```ts
await workshop.getByRole('button', {
  name: '向“待机”添加动作'
}).click();

await workshop.getByRole('button', {
  name: '向“搬运”添加动作'
}).click();

await workshop.getByRole('button', {
  name: '添加扩展状态'
}).click();

await workshop.getByRole('button', {
  name: '向“wave”添加动作'
}).click();
```

- [ ] **步骤 2：增强重启恢复断言**

在现有新进程恢复阶段，选择 E2E 角色后验证：

```ts
await expect(workshop.getByLabel('已导入素材')).toContainText('idle.png');
await expect(workshop.getByLabel('已导入素材')).toContainText('carrying.png');
await expect(workshop.getByLabel('已导入素材')).toContainText('acting.png');
await expect(workshop.getByLabel('帧率')).toHaveValue('9');
await expect(workshop.locator('[data-preview-status]'))
  .toHaveAttribute('data-preview-status', 'ready');
```

再切换到一个没有动作的状态，断言：

```ts
await expect(workshop.locator('[data-preview-status]'))
  .toHaveAttribute('data-preview-status', 'empty');
```

同时通过 Pixi 场景测试保证旧画面已清空，E2E 不依赖像素截图判断。

- [ ] **步骤 3：补充删除闭环**

在 E2E 角色中新增一个空动作并直接删除，断言动作从列表消失。对已有 4 帧动作点击减号，断言确认对话框显示帧数，取消后动作仍存在。E2E 不实际删除已配置动作，避免破坏后续发布断言。

- [ ] **步骤 4：运行桌面端类型检查**

```powershell
pnpm.cmd --filter @myself/desktop typecheck
```

预期：通过。

- [ ] **步骤 5：运行角色工作室精确单元测试**

```powershell
pnpm.cmd --filter @myself/desktop test -- character-ipc.test.ts character-workshop-store.test.ts pixi-character-player.test.ts draft-character-preview.test.tsx character-workshop-components.test.tsx character-workshop-state-list.dom.test.tsx
```

预期：全部通过。

- [ ] **步骤 6：运行桌面端完整单元测试**

```powershell
pnpm.cmd --filter @myself/desktop test
```

预期：全部通过。

- [ ] **步骤 7：运行安全与集成测试**

```powershell
pnpm.cmd test:security
pnpm.cmd test:integration
```

预期：全部通过。

- [ ] **步骤 8：运行角色工作室 Electron E2E**

```powershell
pnpm.cmd test:e2e:desktop -- --grep "真实角色工作室闭环"
```

预期：创建、配置、编译、启用、完整退出、新进程恢复、素材目录恢复和删除确认全部通过。

- [ ] **步骤 9：运行最终差异检查**

```powershell
git diff --check
git status --short
```

预期：无空白错误，只有本计划涉及的文件发生变化。

- [ ] **步骤 10：更新中文验收记录**

若 E2E 命令和结果与 `docs/operations/character-workshop-acceptance.md` 现有记录不同，追加本次验证结果；不得改写与本轮无关的历史验收内容。

- [ ] **步骤 11：取得用户 Git 写授权后提交**

```powershell
git add -- tests/e2e/desktop.spec.ts docs/operations/character-workshop-acceptance.md
git commit -m "test：覆盖角色工作室重启恢复"
```

- [ ] **步骤 12：使用完成前验证技能复核**

调用 `superpowers:verification-before-completion`，重新检查最新测试输出、工作树状态和提交范围。未获得新鲜验证证据前不得声称完成。
