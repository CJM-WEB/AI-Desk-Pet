# AI 桌宠角色工作室实施计划

> **供智能执行代理使用：** 实施本计划时必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`，按任务逐项执行并在每项结束后复核。所有步骤使用 `- [ ]` 跟踪状态。

**目标：** 在现有 Windows Electron 桌宠中交付可立即使用的无骨骼序列帧角色系统、独立角色工作室、安全角色存储、交互锚点和可选角色包分享能力。

**架构：** `@myself/character-runtime` 负责角色协议、状态仲裁、动作选择和降级；新增 `@myself/character-assets` 负责纯数据切帧、纹理图集规划和角色包校验；Electron Main 负责角色存储、导入导出、安全 IPC 和窗口；Renderer 负责工作室、图像解码、纹理图集生成以及 PixiJS 播放。真实桌面位移与文件任务结果继续由可信业务层决定，序列帧只负责视觉表现。

**技术栈：** TypeScript 5.9、Electron 43、React 19、Zod 3、Zustand 5、Vitest 3、Playwright 1.61、PixiJS 8、Canvas、`createImageBitmap`、pnpm workspace。

**设计规格：** [AI 桌宠角色工作室与序列帧角色系统设计](../specs/2026-07-27-ai-pet-character-workshop-design.md)

## 全局约束

- 目标平台保持 Windows 10/11 x64。
- 所有新增文档、代码注释、测试名称和用户可见文案使用中文。
- 不提供图片、序列帧或视频生成能力。
- 不引入 Live2D、Spine、骨骼绑定或可执行角色脚本。
- 角色素材一致性由用户负责，系统只进行技术校验。
- 用户导入一个有效待机动作后即可启用角色。
- 目标状态缺少动作时使用当前角色的待机动作，不借用其他角色素材。
- 系统核心状态固定不可删除，用户扩展状态可创建、编辑和删除。
- 角色包导出仅用于分享、备份和迁移，不是使用角色的前置条件。
- Renderer 不获得任意路径读写能力，所有持久化和角色包处理由 Main 完成。
- 编译失败必须保留草稿和上一个可运行版本。
- 角色包和图片均视为不可信输入，拒绝路径穿越、符号链接、脚本和超限资源。
- 实施期间只允许 Git 只读命令，不执行暂存、提交、分支、合并或推送。
- 每个任务先写失败测试，再写最小实现，最后运行该任务列出的验证命令。

---

## 文件结构

### 新增 package

```text
packages/character-assets/
├─ package.json
├─ tsconfig.json
├─ vitest.config.ts
├─ src/
│  ├─ index.ts
│  ├─ frame-import.ts
│  ├─ atlas-layout.ts
│  ├─ package-policy.ts
│  └─ resource-limits.ts
└─ tests/
   ├─ frame-import.test.ts
   ├─ atlas-layout.test.ts
   └─ package-policy.test.ts
```

该 package 只处理纯数据和安全策略，不访问 Electron、DOM 或磁盘。

### 扩展角色运行时

```text
packages/character-runtime/src/
├─ character-schema.ts
├─ action-selector.ts
├─ state-arbiter.ts
└─ state-machine.ts
```

- `character-schema.ts`：角色清单、状态、动作、帧和锚点的 Zod 契约。
- `action-selector.ts`：动作筛选、权重、冷却和待机降级。
- `state-arbiter.ts`：核心状态与扩展状态优先级、触发和中断。
- `state-machine.ts`：保留现有任务阶段映射并扩展核心状态。

### Electron Main 角色模块

```text
apps/desktop/src/main/characters/
├─ character-store.ts
├─ character-asset-service.ts
├─ character-package-service.ts
├─ character-actions.ts
└─ character-errors.ts
```

- `character-store.ts`：角色索引、草稿、运行版本和当前角色的原子持久化。
- `character-asset-service.ts`：系统文件选择、源素材接收、资源读取和编译产物保存。
- `character-package-service.ts`：角色包导入导出、隔离解包和安全校验。
- `character-actions.ts`：供 IPC 调用的应用服务。
- `character-errors.ts`：稳定错误码和用户可见错误映射。

### Renderer 角色工作室与播放器

```text
apps/desktop/src/renderer/src/characters/
├─ store/character-workshop-store.ts
├─ import/image-decoder.ts
├─ import/atlas-compiler.ts
├─ player/CharacterPlayer.tsx
├─ player/pixi-character-player.ts
├─ player/character-resource-cache.ts
├─ workshop/CharacterWorkshopView.tsx
├─ workshop/CharacterList.tsx
├─ workshop/StateList.tsx
├─ workshop/ActionTimeline.tsx
├─ workshop/AnchorEditor.tsx
├─ workshop/ActionInspector.tsx
├─ workshop/IncompleteCharacterDialog.tsx
└─ workshop/character-workshop.css
```

每个组件只负责一个编辑区域；工作室页面只负责组合，不在单文件中混合图片编译、IPC、状态仲裁和渲染器生命周期。

---

## 阶段一：角色协议与运行时

### 任务 1：定义版本化角色协议

**文件：**

- 新建：`packages/character-runtime/src/character-schema.ts`
- 修改：`packages/character-runtime/src/index.ts`
- 新建测试：`packages/character-runtime/tests/character-schema.test.ts`

**接口：**

- 产出：`CORE_CHARACTER_STATES`
- 产出：`CharacterStateId`
- 产出：`CharacterManifestV1`
- 产出：`CharacterDraftV1`
- 产出：`characterManifestV1Schema`
- 产出：`characterDraftV1Schema`
- 产出：`ActionClip`
- 产出：`AnchorSet`
- 产出：`createExtensionStateId(name: string): CharacterStateId`

- [ ] **步骤 1：先写角色清单失败测试**

```ts
import { describe, expect, test } from 'vitest';
import {
  characterManifestV1Schema,
  createExtensionStateId
} from '../src/character-schema';

describe('角色清单协议', () => {
  test('接受核心状态、扩展状态、动作帧和归一化锚点', () => {
    const manifest = characterManifestV1Schema.parse({
      version: 1,
      id: 'character-demo',
      name: '演示角色',
      thumbnailAssetId: 'thumb-1',
      states: [{
        id: 'idle',
        kind: 'core',
        actions: [{
          id: 'idle-breathe',
          name: '呼吸',
          fps: 12,
          loop: true,
          weight: 1,
          frames: [{ assetId: 'atlas-1', x: 0, y: 0, width: 256, height: 256 }],
          anchors: { ground: { x: 0.5, y: 1 } }
        }]
      }, {
        id: createExtensionStateId('跳舞'),
        kind: 'extension',
        actions: []
      }]
    });

    expect(manifest.states[0]?.id).toBe('idle');
  });

  test('拒绝删除待机语义、越界锚点和未知字段', () => {
    expect(() => characterManifestV1Schema.parse({
      version: 1,
      id: 'broken',
      name: '损坏角色',
      thumbnailAssetId: 'thumb',
      states: [],
      script: 'run.exe'
    })).toThrow();
  });
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：

```powershell
pnpm --filter @myself/character-runtime test -- character-schema.test.ts
```

预期：失败，提示 `character-schema` 模块不存在。

- [ ] **步骤 3：实现精确协议**

在 `character-schema.ts` 中定义：

```ts
export const CORE_CHARACTER_STATES = [
  'idle',
  'listening',
  'thinking',
  'moving',
  'acting',
  'carrying',
  'success',
  'error'
] as const;

export type CoreCharacterState = typeof CORE_CHARACTER_STATES[number];
export type ExtensionStateId = `custom:${string}`;
export type CharacterStateId = CoreCharacterState | ExtensionStateId;

export type AnchorPoint = { x: number; y: number };
export type AnchorSet = {
  ground: AnchorPoint;
  focus?: AnchorPoint;
  carry?: AnchorPoint;
  mouth?: AnchorPoint;
  seat?: AnchorPoint;
};

export type InteractionRegion = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type ActionFrame = {
  assetId: string;
  x: number;
  y: number;
  width: number;
  height: number;
  durationMs?: number;
  anchors?: Partial<AnchorSet>;
};

export type ActionClip = {
  id: string;
  name: string;
  fps: number;
  loop: boolean;
  weight: number;
  direction?: 'left' | 'right' | 'any';
  frames: ActionFrame[];
  anchors: AnchorSet;
  regions?: {
    click?: InteractionRegion;
    drag?: InteractionRegion;
    collision?: InteractionRegion;
  };
};

export type CharacterStateDefinition = {
  id: CharacterStateId;
  kind: 'core' | 'extension';
  actions: ActionClip[];
};

export type CharacterDraftV1 = {
  version: 1;
  id: string;
  name: string;
  thumbnailAssetId?: string;
  states: CharacterStateDefinition[];
};

export type CharacterManifestV1 = CharacterDraftV1 & {
  thumbnailAssetId: string;
};
```

Zod 规则必须包含：

- `version` 固定为 `1`。
- 标识符长度为 1 至 120。
- `fps` 为 1 至 60。
- `weight` 为大于 0 且不超过 100 的有限数。
- 锚点坐标限制为 0 至 1。
- 点击、拖动和碰撞区域的坐标及宽高限制为 0 至 1，且区域不能越过逻辑画布。
- 帧矩形使用非负整数，宽高至少为 1。
- `characterDraftV1Schema` 允许新角色暂时没有动作。
- `characterManifestV1Schema` 必须包含 `idle`，且 `idle` 至少有一个动作。
- 所有对象使用 `.strict()`。
- 扩展状态标识由 `custom:` 前缀和规范化名称组成。

- [ ] **步骤 4：导出协议并运行测试**

在 `src/index.ts` 增加：

```ts
export * from './character-schema';
```

运行：

```powershell
pnpm --filter @myself/character-runtime test
pnpm --filter @myself/character-runtime typecheck
```

预期：角色运行时全部测试通过。

- [ ] **步骤 5：只读检查本任务差异**

```powershell
git diff -- packages/character-runtime
```

确认只包含角色协议、导出和对应测试。

### 任务 2：实现动作选择与待机降级

**文件：**

- 新建：`packages/character-runtime/src/action-selector.ts`
- 修改：`packages/character-runtime/src/index.ts`
- 新建测试：`packages/character-runtime/tests/action-selector.test.ts`

**接口：**

- 消费：`CharacterManifestV1`、`CharacterStateId`、`ActionClip`
- 产出：`selectCharacterAction(input: ActionSelectionInput): ActionSelectionResult`
- 产出：`ActionSelectionReason = 'matched' | 'idle_fallback'`

- [ ] **步骤 1：写动作选择失败测试**

```ts
test('目标状态缺失时只回退到当前角色待机动作', () => {
  const result = selectCharacterAction({
    manifest,
    stateId: 'carrying',
    direction: 'right',
    recentActionIds: [],
    random: () => 0
  });

  expect(result.reason).toBe('idle_fallback');
  expect(result.stateId).toBe('idle');
  expect(result.action.id).toBe('idle-breathe');
});

test('按方向筛选并避免连续选择冷却中的动作', () => {
  const result = selectCharacterAction({
    manifest: manifestWithMovingVariants,
    stateId: 'moving',
    direction: 'left',
    recentActionIds: ['move-left-a'],
    random: () => 0
  });

  expect(result.action.id).toBe('move-left-b');
});
```

- [ ] **步骤 2：运行测试确认失败**

```powershell
pnpm --filter @myself/character-runtime test -- action-selector.test.ts
```

预期：失败，提示 `selectCharacterAction` 不存在。

- [ ] **步骤 3：实现纯函数选择器**

```ts
export type ActionSelectionInput = {
  manifest: CharacterManifestV1;
  stateId: CharacterStateId;
  direction?: 'left' | 'right';
  recentActionIds: readonly string[];
  random: () => number;
};

export type ActionSelectionResult = {
  stateId: CharacterStateId;
  action: ActionClip;
  reason: 'matched' | 'idle_fallback';
};
```

选择顺序必须为：

1. 查找目标状态。
2. 筛选具有帧且方向匹配的动作。
3. 排除冷却动作；如果排除后为空，恢复全部候选。
4. 按 `weight` 使用注入的 `random()` 选择。
5. 无候选时只查找当前清单中的 `idle`。
6. `idle` 也无候选时抛出 `CHARACTER_IDLE_UNAVAILABLE`。

- [ ] **步骤 4：运行运行时测试**

```powershell
pnpm --filter @myself/character-runtime test
pnpm --filter @myself/character-runtime typecheck
```

预期：全部通过。

- [ ] **步骤 5：只读检查差异**

```powershell
git diff -- packages/character-runtime/src/action-selector.ts packages/character-runtime/tests/action-selector.test.ts
```

### 任务 3：实现核心状态与扩展状态仲裁

**文件：**

- 新建：`packages/character-runtime/src/state-arbiter.ts`
- 修改：`packages/character-runtime/src/state-machine.ts`
- 修改：`packages/character-runtime/src/index.ts`
- 修改测试：`packages/character-runtime/tests/state-machine.test.ts`
- 新建测试：`packages/character-runtime/tests/state-arbiter.test.ts`

**接口：**

- 消费：现有 `TaskPhase`
- 产出：`CharacterStateRequest`
- 产出：`CharacterStateSnapshot`
- 产出：`reduceCharacterState(snapshot, request): CharacterStateSnapshot`
- 保留：`characterStateFor(phase: TaskPhase)`

- [ ] **步骤 1：写优先级与中断失败测试**

```ts
test('核心任务状态会中断扩展状态且任务结束后回到待机', () => {
  const dancing = reduceCharacterState(
    { stateId: 'idle', source: 'system' },
    { type: 'extension', stateId: 'custom:跳舞' }
  );
  const thinking = reduceCharacterState(
    dancing,
    { type: 'task', phase: 'thinking' }
  );
  const completed = reduceCharacterState(
    thinking,
    { type: 'task', phase: 'cancelled' }
  );

  expect(dancing.stateId).toBe('custom:跳舞');
  expect(thinking.stateId).toBe('thinking');
  expect(completed.stateId).toBe('idle');
});
```

- [ ] **步骤 2：运行测试确认失败**

```powershell
pnpm --filter @myself/character-runtime test -- state-arbiter.test.ts
```

预期：失败，提示仲裁接口不存在。

- [ ] **步骤 3：实现状态请求联合类型**

```ts
export type CharacterStateRequest =
  | { type: 'task'; phase: TaskPhase }
  | { type: 'movement'; carrying: boolean }
  | { type: 'extension'; stateId: ExtensionStateId }
  | { type: 'extension_complete' }
  | { type: 'reset' };

export type CharacterStateSnapshot = {
  stateId: CharacterStateId;
  source: 'system' | 'extension';
};
```

规则：

- `thinking`、`acting`、`carrying`、`success` 和 `error` 高于扩展状态。
- 移动命令根据 `carrying` 选择 `moving` 或 `carrying`。
- 核心状态结束后进入 `idle`。
- 扩展状态完成后进入 `idle`。
- 不恢复此前被中断的扩展状态。

- [ ] **步骤 4：保持旧任务映射兼容**

现有 `characterStateFor` 的返回类型扩展为核心角色状态；`awaiting_confirmation` 继续映射到 `listening`，`cancelled` 继续映射到 `idle`。

- [ ] **步骤 5：运行角色运行时完整验证**

```powershell
pnpm --filter @myself/character-runtime test
pnpm --filter @myself/character-runtime typecheck
```

预期：全部通过，旧状态测试无回归。

---

## 阶段二：资源导入、存储与角色包安全

### 任务 4：建立纯数据帧导入与纹理图集规划 package

**文件：**

- 新建：`packages/character-assets/package.json`
- 新建：`packages/character-assets/tsconfig.json`
- 新建：`packages/character-assets/vitest.config.ts`
- 新建：`packages/character-assets/src/index.ts`
- 新建：`packages/character-assets/src/frame-import.ts`
- 新建：`packages/character-assets/src/atlas-layout.ts`
- 新建：`packages/character-assets/src/resource-limits.ts`
- 新建测试：`packages/character-assets/tests/frame-import.test.ts`
- 新建测试：`packages/character-assets/tests/atlas-layout.test.ts`
- 修改：`pnpm-lock.yaml`
- 修改：根 `package.json`
- 修改：根 `vitest.config.ts`

**接口：**

- 产出：`planSpriteSheetFrames(input): FrameRect[]`
- 产出：`sortFrameFiles(names: readonly string[]): string[]`
- 产出：`planAtlas(input): AtlasPlan`
- 产出：`CHARACTER_RESOURCE_LIMITS`

纯数据类型固定为：

```ts
export type FrameRect = {
  x: number;
  y: number;
  width: number;
  height: number;
};

export type SpriteSheetPlanInput = {
  imageWidth: number;
  imageHeight: number;
  rows: number;
  columns: number;
  frameCount: number;
  order: 'row-major' | 'column-major';
};

export type AtlasPlan = {
  width: number;
  height: number;
  placements: Array<{ frameId: string; rect: FrameRect }>;
};
```

- [ ] **步骤 1：创建 package 骨架并加入测试项目**

`package.json` 使用：

```json
{
  "name": "@myself/character-assets",
  "private": true,
  "type": "module",
  "exports": "./src/index.ts",
  "scripts": {
    "test": "vitest run --config vitest.config.ts",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@myself/character-runtime": "workspace:*"
  }
}
```

`vitest.config.ts` 使用：

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  root: import.meta.dirname,
  test: {
    name: 'character-assets',
    include: ['tests/**/*.test.ts']
  }
});
```

根 `test:unit` 增加 `--project character-assets`，根 `vitest.config.ts` 的 `projects` 增加 `packages/character-assets/vitest.config.ts`。

- [ ] **步骤 2：写精灵图切分和自然排序失败测试**

```ts
test('按水平优先切分并忽略末尾空白格', () => {
  expect(planSpriteSheetFrames({
    imageWidth: 512,
    imageHeight: 256,
    rows: 2,
    columns: 4,
    frameCount: 6,
    order: 'row-major'
  })).toHaveLength(6);
});

test('独立帧按数字自然顺序排列', () => {
  expect(sortFrameFiles(['frame10.png', 'frame2.png', 'frame1.png']))
    .toEqual(['frame1.png', 'frame2.png', 'frame10.png']);
});
```

- [ ] **步骤 3：运行新 package 测试确认失败**

```powershell
pnpm --filter @myself/character-assets test
```

预期：失败，提示实现函数不存在。

- [ ] **步骤 4：实现切帧和图集规划**

资源上限集中为：

```ts
export const CHARACTER_RESOURCE_LIMITS = {
  maxSourceFilesPerImport: 500,
  maxSourceBytesPerFile: 32 * 1024 * 1024,
  maxTotalSourceBytesPerCharacter: 512 * 1024 * 1024,
  maxFrameDimension: 4096,
  maxFramesPerAction: 500,
  maxStatesPerCharacter: 100,
  maxActionsPerState: 100
} as const;
```

`planSpriteSheetFrames` 必须拒绝无法整除的网格、超限帧和无效读取顺序。`planAtlas` 只计算矩形布局，不做图片解码。

- [ ] **步骤 5：运行 package 与根类型检查**

```powershell
pnpm --filter @myself/character-assets test
pnpm --filter @myself/character-assets typecheck
pnpm typecheck
```

预期：全部通过。

### 任务 5：实现原子角色存储与草稿/运行版本分离

**文件：**

- 新建：`apps/desktop/src/main/characters/character-store.ts`
- 新建：`apps/desktop/src/main/characters/character-migrations.ts`
- 新建：`apps/desktop/src/main/characters/character-errors.ts`
- 新建测试：`apps/desktop/tests/character-store.test.ts`
- 修改：`apps/desktop/package.json`
- 修改：`apps/desktop/electron.vite.config.ts`

**接口：**

- 消费：`CharacterManifestV1`
- 产出：`CharacterSummary`
- 产出：`CharacterStore`
- 产出方法：`list()`、`create()`、`saveDraft()`、`publishCompiled()`、`setActive()`、`getActive()`、`delete()`

- [ ] **步骤 1：写存储失败测试**

```ts
test('编译失败前后运行版本保持不变', async () => {
  const store = await createTestStore();
  await store.create({ id: 'demo', name: '演示角色' });
  await store.publishCompiled('demo', validManifest, compiledAssets);

  await store.saveDraft('demo', changedDraft);

  await expect(store.getRuntimeManifest('demo')).resolves.toEqual(validManifest);
  await expect(store.getDraft('demo')).resolves.toEqual(changedDraft);
});

test('同一角色并发保存经过写队列且不会留下半截 JSON', async () => {
  const store = await createTestStore();
  await Promise.all([
    store.saveDraft('demo', draftA),
    store.saveDraft('demo', draftB)
  ]);
  await expect(store.getDraft('demo')).resolves.toMatchObject(draftB);
});

test('官方默认角色不能删除', async () => {
  const store = await createTestStore();
  await expect(store.delete('builtin-default')).rejects.toThrow(
    'CHARACTER_DEFAULT_DELETE_REJECTED'
  );
});

test('旧格式迁移失败时保留原文件并隔离损坏副本', async () => {
  const store = await createStoreWithLegacyFixture();
  await expect(store.list()).resolves.toEqual([]);
  const files = await readdir(storeDirectory);
  expect(files.some(name => /^index\.json\.corrupt-/u.test(name))).toBe(true);
});
```

公开摘要固定为：

```ts
export type CharacterSummary = {
  id: string;
  name: string;
  thumbnailAssetId: string | null;
  active: boolean;
  completeness: 'complete' | 'incomplete' | 'broken';
  missingCoreStates: CoreCharacterState[];
};
```

草稿相关方法消费和返回 `CharacterDraftV1`；只有 `publishCompiled` 接受通过 `characterManifestV1Schema` 的 `CharacterManifestV1`。

- [ ] **步骤 2：运行测试确认失败**

```powershell
pnpm --filter @myself/desktop test -- character-store.test.ts
```

预期：失败，提示 `CharacterStore` 不存在。

- [ ] **步骤 3：实现目录和原子写入**

每个角色目录使用：

```text
characters/<id>/
├─ manifest.json
├─ source/
├─ draft/
├─ compiled/
└─ thumbnail.webp
```

当前角色索引保存到 `characters/index.json`。所有 JSON 写入采用“临时文件 + `fsync` + 原子替换”，同一存储实例复用现有 `SettingsStore` 的串行写队列模式。

- [ ] **步骤 4：实现发布和恢复语义**

`publishCompiled` 必须：

1. 在临时版本目录写入全部资源。
2. 验证清单可以重新解析。
3. 原子替换当前 `compiled/`。
4. 失败时删除临时版本，不修改旧运行版本。

启动时发现损坏活动角色，则返回稳定错误 `CHARACTER_RUNTIME_UNAVAILABLE`，由应用层切换官方默认角色，不自动删除数据。

`character-migrations.ts` 暴露 `migrateCharacterDocument(raw: unknown): CharacterDraftV1`。当前只接受版本 1；未来版本迁移必须新增显式分支。未知版本和迁移失败都保留原文件并创建隔离副本。

- [ ] **步骤 5：接入 workspace 构建**

桌面依赖增加：

```json
"@myself/character-assets": "workspace:*"
```

`electron.vite.config.ts` 的 `externalizeDeps.exclude` 增加 `@myself/character-assets`。

- [ ] **步骤 6：运行验证**

```powershell
pnpm --filter @myself/desktop test -- character-store.test.ts
pnpm --filter @myself/desktop typecheck
```

预期：全部通过。

### 任务 6：实现安全素材接收与浏览器侧图集编译

**文件：**

- 新建：`apps/desktop/src/main/characters/character-asset-service.ts`
- 新建：`apps/desktop/src/renderer/src/characters/import/image-decoder.ts`
- 新建：`apps/desktop/src/renderer/src/characters/import/atlas-compiler.ts`
- 新建测试：`apps/desktop/tests/character-asset-service.test.ts`
- 新建测试：`apps/desktop/tests/character-atlas-compiler.test.ts`

**接口：**

- Main 产出：`importSources(characterId, selectedPaths): ImportedSource[]`
- Main 产出：`readSource(characterId, assetId): Promise<Uint8Array>`
- Main 产出：`saveCompiled(characterId, input): Promise<void>`
- Renderer 产出：`decodeSource(bytes, mimeType): Promise<ImageBitmapLike>`
- Renderer 产出：`compileAtlas(input, canvasFactory): Promise<CompiledAtlas>`

相关数据结构固定为：

```ts
export type ImportedSource = {
  assetId: string;
  displayName: string;
  mimeType: 'image/png' | 'image/webp';
  byteLength: number;
};

export type CompiledAtlas = {
  mimeType: 'image/png' | 'image/webp';
  bytes: Uint8Array;
  width: number;
  height: number;
  frames: ActionFrame[];
  sourceChecksums: Record<string, string>;
};

export type ImageBitmapLike = {
  width: number;
  height: number;
  close(): void;
};
```

- [ ] **步骤 1：写 Main 边界失败测试**

```ts
test('只接收系统选择结果中的白名单图片并生成内部资源标识', async () => {
  const imported = await service.importSources('demo', [
    join(fixtures, 'frame-1.png'),
    join(fixtures, 'script.js')
  ]);

  expect(imported).toEqual([
    expect.objectContaining({ assetId: expect.any(String), mimeType: 'image/png' })
  ]);
  expect(JSON.stringify(imported)).not.toContain(fixtures);
});
```

- [ ] **步骤 2：写 Renderer 编译失败测试**

使用注入的 `canvasFactory` 和伪 `ImageBitmapLike` 验证：

- 精灵图矩形按计划裁切。
- 不同尺寸单帧放入统一逻辑画布但不拉伸。
- `ground` 默认值为 `{ x: 0.5, y: 1 }`。
- 编译结果包含 PNG/WebP 字节、帧矩形和源资源校验值。

- [ ] **步骤 3：运行测试确认失败**

```powershell
pnpm --filter @myself/desktop test -- character-asset-service.test.ts character-atlas-compiler.test.ts
```

预期：失败，提示素材服务和图集编译器不存在。

- [ ] **步骤 4：实现安全接收**

Main 只允许 `.png` 和 `.webp`，同时验证文件签名而不是只信任扩展名。读入前检查单文件大小，复制到 `source/` 后使用内部 UUID 作为文件名，Renderer 只看到 `assetId`、显示名、MIME 和尺寸摘要。

- [ ] **步骤 5：实现浏览器解码与编译**

`image-decoder.ts` 只封装 `createImageBitmap(new Blob(...))`。`atlas-compiler.ts` 使用 `@myself/character-assets` 的矩形计划，通过 Canvas 绘制图集并返回可测试的结构化结果。

编译入口接受 `AbortSignal`，每处理一帧都检查取消状态；取消后关闭已经创建的 `ImageBitmap` 并删除临时产物。一次保存只重新编译当前动作，角色发布阶段再汇总未变化动作的既有图集。

- [ ] **步骤 6：运行验证**

```powershell
pnpm --filter @myself/desktop test -- character-asset-service.test.ts character-atlas-compiler.test.ts
pnpm --filter @myself/desktop typecheck
```

预期：全部通过。

### 任务 7：实现角色包导入导出安全策略

**文件：**

- 新建：`packages/character-assets/src/package-policy.ts`
- 新建测试：`packages/character-assets/tests/package-policy.test.ts`
- 新建：`apps/desktop/src/main/characters/character-package-service.ts`
- 新建测试：`apps/desktop/tests/character-package-service.test.ts`

**接口：**

- 产出：`validatePackageEntries(entries): PackageValidationResult`
- 产出：`CharacterPackageService.exportCharacter(characterId, destination)`
- 产出：`CharacterPackageService.importCharacter(packagePath)`

包策略返回类型固定为：

```ts
export type PackageEntryDescriptor = {
  path: string;
  compressedBytes: number;
  uncompressedBytes: number;
  kind: 'file' | 'directory' | 'symlink';
};

export type PackageValidationResult = {
  fileCount: number;
  totalUncompressedBytes: number;
  normalizedPaths: string[];
};
```

- [ ] **步骤 1：写恶意包失败测试**

```ts
test.each([
  '../outside.txt',
  'C:/outside.txt',
  '/absolute.txt',
  'scripts/run.js'
])('拒绝危险角色包条目：%s', path => {
  expect(() => validatePackageEntries([{
    path,
    compressedBytes: 10,
    uncompressedBytes: 20,
    kind: 'file'
  }])).toThrow();
});

test('拒绝符号链接和压缩倍率异常内容', () => {
  expect(() => validatePackageEntries([symlinkEntry])).toThrow('CHARACTER_PACKAGE_LINK_REJECTED');
  expect(() => validatePackageEntries([zipBombEntry])).toThrow('CHARACTER_PACKAGE_EXPANSION_LIMIT');
});
```

- [ ] **步骤 2：运行安全策略测试确认失败**

```powershell
pnpm --filter @myself/character-assets test -- package-policy.test.ts
```

预期：失败，提示策略函数不存在。

- [ ] **步骤 3：实现纯策略**

策略必须拒绝：

- 绝对路径、盘符、UNC 和 `..`。
- 符号链接、Junction 和非普通文件。
- `.js`、`.html`、`.exe`、`.dll`、`.node` 等非白名单条目。
- 超过 1 GiB 解压总量。
- 单条目压缩倍率超过 100。
- 超过 2,000 个文件。

- [ ] **步骤 4：写服务集成测试**

覆盖：

- 导出包不包含设置、密钥、授权目录或对话数据。
- 导入先进入隔离临时目录。
- 同名角色生成新标识，不覆盖原角色。
- 校验失败后角色存储区无新增内容。

- [ ] **步骤 5：实现 package 服务**

安装并限定在桌面 Main：

```powershell
pnpm --filter @myself/desktop add yauzl@^3.4.0 yazl@^3.3.1
pnpm --filter @myself/desktop add -D @types/yauzl@^3.4.0 @types/yazl@^3.3.1
```

使用 `yauzl` 的逐条读取和惰性解压能力进行导入，使用 `yazl` 流式导出；禁止自行解析 ZIP 二进制。所有解压目标必须经过 `resolve` 后确认仍在隔离目录内。

- [ ] **步骤 6：运行安全与桌面测试**

```powershell
pnpm --filter @myself/character-assets test
pnpm --filter @myself/desktop test -- character-package-service.test.ts
pnpm test:security
```

预期：全部通过。

---

## 阶段三：安全 IPC、窗口与角色工作室

### 任务 8：增加角色工作室窗口和白名单 IPC

**文件：**

- 修改：`apps/desktop/src/shared/ipc-channels.ts`
- 修改：`apps/desktop/src/shared/myself-api.ts`
- 修改：`apps/desktop/src/preload/index.ts`
- 修改：`apps/desktop/src/main/ipc/register-ipc.ts`
- 修改：`apps/desktop/src/main/windows/window-manager.ts`
- 修改：`apps/desktop/src/main/index.ts`
- 修改：`apps/desktop/src/renderer/src/App.tsx`
- 新建测试：`apps/desktop/tests/character-ipc.test.ts`
- 修改测试：`apps/desktop/tests/window-security.test.ts`
- 修改测试：`apps/desktop/tests/window-commands.test.ts`

**接口：**

- 产出视图：`view=characters`
- 产出 API：`openCharacterWorkshop()`
- 产出 API：`listCharacters()`、`createCharacter()`、`duplicateCharacter()`、`getCharacterDraft()`、`saveCharacterDraft()`
- 产出 API：`chooseCharacterSources()`、`readCharacterSource()`、`publishCharacter()`
- 产出 API：`activateCharacter()`、`deleteCharacter()`、`importCharacterPackage()`、`exportCharacterPackage()`

- [ ] **步骤 1：写窗口和 IPC 失败测试**

```ts
test('角色工作室使用独立安全窗口', () => {
  expect(characterWorkshopWindowOptions('preload.js')).toMatchObject({
    width: 1120,
    height: 760,
    minWidth: 900,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true
  });
  expect(characterWorkshopWindowOptions('preload.js').webPreferences)
    .toEqual(secureWebPreferences('preload.js'));
});

test('角色 IPC 只接受结构化角色标识和动作草稿', async () => {
  await expect(handler({}, {
    characterId: '../outside',
    arbitraryPath: 'C:\\private'
  })).rejects.toThrow();
});
```

- [ ] **步骤 2：运行测试确认失败**

```powershell
pnpm --filter @myself/desktop test -- character-ipc.test.ts window-security.test.ts
```

预期：失败，提示窗口和 IPC 尚不存在。

- [ ] **步骤 3：扩展强类型 API**

所有 IPC 输入使用 Zod `.strict()`。Renderer 只能传递角色标识、状态标识、动作草稿和资源标识；文件选择由 Main 调用 `dialog.showOpenDialog`，导出目标由 Main 调用 `dialog.showSaveDialog`。

- [ ] **步骤 4：创建和管理角色工作室窗口**

`rendererUrl`、`loadRenderer` 和 `currentView` 增加 `characters`。窗口关闭时隐藏，不退出应用。托盘和桌宠右键菜单增加“角色工作室”，并为已有角色增加快速切换子菜单。

- [ ] **步骤 5：注册角色应用服务**

`createApplicationWindows` 创建：

```ts
const characterStore = new CharacterStore(join(storageDirectory, 'characters'));
const characterActions = new CharacterActions({
  store: characterStore,
  assets: characterAssetService,
  packages: characterPackageService
});
```

角色事件使用固定 `character:event` 通道广播索引变化、编译结果和活动角色变化。

- [ ] **步骤 6：运行安全和类型验证**

```powershell
pnpm --filter @myself/desktop test -- character-ipc.test.ts window-security.test.ts window-commands.test.ts
pnpm --filter @myself/desktop typecheck
pnpm test:security
```

预期：全部通过。

### 任务 9：实现角色工作室状态层和三栏外壳

**文件：**

- 新建：`apps/desktop/src/renderer/src/characters/store/character-workshop-store.ts`
- 新建：`apps/desktop/src/renderer/src/characters/workshop/CharacterWorkshopView.tsx`
- 新建：`apps/desktop/src/renderer/src/characters/workshop/CharacterList.tsx`
- 新建：`apps/desktop/src/renderer/src/characters/workshop/StateList.tsx`
- 新建：`apps/desktop/src/renderer/src/characters/workshop/character-workshop.css`
- 修改：`apps/desktop/src/renderer/src/App.tsx`
- 新建测试：`apps/desktop/tests/character-workshop-store.test.ts`
- 新建测试：`apps/desktop/tests/character-workshop-components.test.tsx`

**接口：**

- 产出：`createCharacterWorkshopStore(api)`
- 产出：`CharacterWorkshopView`
- 产出状态：角色列表、当前角色、当前状态、当前动作、草稿状态、编译状态和通知。

- [ ] **步骤 1：写 store 失败测试**

```ts
test('新建角色后选中待机状态并自动保存草稿', async () => {
  const store = createCharacterWorkshopStore(api);
  await store.getState().createCharacter('新角色');

  expect(store.getState().selectedStateId).toBe('idle');
  expect(api.createCharacter).toHaveBeenCalledWith({ name: '新角色' });
});
```

- [ ] **步骤 2：写三栏布局失败测试**

服务端渲染检查必须包含：

- “角色”
- “状态与动作”
- “实时预览”
- “动作属性”
- “新建角色”
- “导入素材”
- “启用角色”
- “导入角色包”
- “导出角色包”

- [ ] **步骤 3：运行测试确认失败**

```powershell
pnpm --filter @myself/desktop test -- character-workshop-store.test.ts character-workshop-components.test.tsx
```

预期：失败，提示 store 和组件不存在。

- [ ] **步骤 4：实现 Zustand 状态层**

所有异步动作使用明确状态：

```ts
type WorkshopBusyAction =
  | 'loading'
  | 'creating'
  | 'saving'
  | 'compiling'
  | 'activating'
  | 'importing'
  | 'exporting'
  | 'deleting'
  | null;
```

自动保存使用 500 毫秒防抖；关闭窗口前调用 `flushDraft()`。编译与保存分离，保存草稿不自动替换运行版本。

- [ ] **步骤 5：实现三栏工作区**

左栏显示角色和状态；中栏预留预览和时间轴；右栏显示动作属性。角色工作室使用独立 CSS 文件，不继续扩张现有 `styles.css`。

角色列表提供新建、复制、单个删除和启用操作。首版不提供批量删除；单个删除使用明确确认对话框，官方默认角色不显示删除命令。

- [ ] **步骤 6：运行组件与类型验证**

```powershell
pnpm --filter @myself/desktop test -- character-workshop-store.test.ts character-workshop-components.test.tsx
pnpm --filter @myself/desktop typecheck
```

预期：全部通过。

### 任务 10：实现序列帧时间轴、动作属性和锚点编辑

**文件：**

- 新建：`apps/desktop/src/renderer/src/characters/workshop/ActionTimeline.tsx`
- 新建：`apps/desktop/src/renderer/src/characters/workshop/ActionInspector.tsx`
- 新建：`apps/desktop/src/renderer/src/characters/workshop/AnchorEditor.tsx`
- 新建：`apps/desktop/src/renderer/src/characters/workshop/PreviewControls.tsx`
- 新建：`apps/desktop/src/renderer/src/characters/workshop/IncompleteCharacterDialog.tsx`
- 修改：`apps/desktop/src/renderer/src/characters/workshop/CharacterWorkshopView.tsx`
- 新建测试：`apps/desktop/tests/character-action-editor.test.tsx`

**接口：**

- 消费：`ActionClip`、`AnchorSet`
- 产出：帧重排、删除、复制、持续时间覆盖、帧率、循环、权重、方向和锚点编辑事件。

- [ ] **步骤 1：写时间轴和锚点失败测试**

```ts
test('拖动帧后提交稳定的新顺序', () => {
  const next = reorderFrames(['f1', 'f2', 'f3'], 2, 0);
  expect(next).toEqual(['f3', 'f1', 'f2']);
});

test('左右镜像时锚点同步镜像', () => {
  expect(mirrorAnchor({ x: 0.2, y: 0.8 })).toEqual({ x: 0.8, y: 0.8 });
});

test('碰撞区域镜像后仍位于归一化画布内', () => {
  expect(mirrorRegion({ x: 0.1, y: 0.2, width: 0.3, height: 0.4 }))
    .toEqual({ x: 0.6, y: 0.2, width: 0.3, height: 0.4 });
});
```

- [ ] **步骤 2：写动作不完整提示文案测试**

```ts
expect(markup).toContain('部分动作尚未配置');
expect(markup).toContain('缺少动画的状态将暂时播放“待机”动作');
expect(markup).toContain('返回完善');
expect(markup).toContain('仍然使用');
```

- [ ] **步骤 3：运行测试确认失败**

```powershell
pnpm --filter @myself/desktop test -- character-action-editor.test.tsx
```

预期：失败，提示编辑组件不存在。

- [ ] **步骤 4：实现时间轴和动作属性**

时间轴使用稳定帧标识，不以数组索引作为 React key。数值输入边界与 Zod 契约一致：帧率 1 至 60、权重大于 0 且不超过 100。

- [ ] **步骤 5：实现锚点编辑**

预览坐标转换统一通过：

```ts
export function screenToNormalizedPoint(
  point: { x: number; y: number },
  bounds: { left: number; top: number; width: number; height: number }
): AnchorPoint;
```

普通动作编辑整段锚点；开启“逐帧锚点”后只覆盖当前帧对应锚点。`ground` 不能删除。

同一编辑器提供点击、拖动和碰撞矩形区域。未配置 `carry`、`mouth`、`seat` 或 `focus` 时，预览器使用角色逻辑边界框计算保守默认点，但不把推导值写回用户草稿。

- [ ] **步骤 6：实现完整预览控制**

`PreviewControls` 提供播放、暂停、上一帧、下一帧、循环、背景明暗、左右方向、模拟速度、锚点显隐、文件挂载模拟和全状态巡览。预览服务只使用内存数据，不调用真实文件工具。

- [ ] **步骤 7：实现启用确认**

首次启用不完整角色或完整角色变为不完整后再次启用时显示确认对话框。确认状态由 Main 保存，不能只依赖当前 React 生命周期。

- [ ] **步骤 8：运行验证**

```powershell
pnpm --filter @myself/desktop test -- character-action-editor.test.tsx
pnpm --filter @myself/desktop typecheck
```

预期：全部通过。

---

## 阶段四：PixiJS 播放、桌面交互与端到端验收

### 任务 11：接入 PixiJS 角色播放器和资源缓存

**文件：**

- 修改：`apps/desktop/package.json`
- 修改：`pnpm-lock.yaml`
- 新建：`apps/desktop/src/renderer/src/characters/player/pixi-character-player.ts`
- 新建：`apps/desktop/src/renderer/src/characters/player/character-resource-cache.ts`
- 新建：`apps/desktop/src/renderer/src/characters/player/CharacterPlayer.tsx`
- 修改：`apps/desktop/src/renderer/src/pet/PetView.tsx`
- 新建测试：`apps/desktop/tests/character-player.test.ts`
- 修改测试：`apps/desktop/tests/renderer-components.test.tsx`

**接口：**

- 消费：活动角色运行清单、状态快照和编译纹理。
- 产出：`PixiCharacterPlayer`
- 产出：`CharacterResourceCache`
- 产出：`CharacterPlayer`

播放器资源结构固定为：

```ts
export type CharacterAssetBundle = {
  characterId: string;
  atlasUrls: ReadonlyMap<string, string>;
};
```

**内容前置条件：**

在执行本任务前，产品负责人需要提供官方默认角色的八张透明精灵图，文件名固定为：

```text
apps/desktop/resources/characters/default/idle.png
apps/desktop/resources/characters/default/listening.png
apps/desktop/resources/characters/default/thinking.png
apps/desktop/resources/characters/default/moving.png
apps/desktop/resources/characters/default/acting.png
apps/desktop/resources/characters/default/carrying.png
apps/desktop/resources/characters/default/success.png
apps/desktop/resources/characters/default/error.png
```

每张图片同时提供行数、列数、有效帧数和帧率。内容未到位时允许先完成播放器单元测试，但不能执行任务 13 的最终产品验收，也不能宣称官方默认角色完成。

- [ ] **步骤 1：添加 PixiJS 8 依赖**

执行：

```powershell
pnpm --filter @myself/desktop add pixi.js@^8
```

该命令只修改依赖文件，不执行 Git 操作。

- [ ] **步骤 2：写播放器生命周期失败测试**

```ts
test('切换角色时释放旧纹理并只保留当前角色缓存', async () => {
  const cache = new CharacterResourceCache(loader, destroyer);
  await cache.activate('character-a');
  await cache.activate('character-b');

  expect(destroyer).toHaveBeenCalledWith('character-a');
  expect(cache.activeCharacterId).toBe('character-b');
});

test('静态模式显示当前动作代表帧而不启动 ticker', async () => {
  const player = createTestPlayer({ motionMode: 'static' });
  await player.setAction(action);
  expect(player.isTickerRunning()).toBe(false);
});
```

- [ ] **步骤 3：运行测试确认失败**

```powershell
pnpm --filter @myself/desktop test -- character-player.test.ts
```

预期：失败，提示播放器不存在。

- [ ] **步骤 4：实现 PixiJS 适配器**

适配器封装 PixiJS，不让 React 组件直接管理纹理：

```ts
export interface CharacterPlayerPort {
  load(manifest: CharacterManifestV1, assets: CharacterAssetBundle): Promise<void>;
  play(selection: ActionSelectionResult, motionMode: CharacterMotionMode): void;
  setDirection(direction: 'left' | 'right'): void;
  getAnchor(name: keyof AnchorSet): AnchorPoint | null;
  destroy(): void;
}
```

`destroy()` 必须停止 ticker、销毁 AnimatedSprite、释放 Blob URL 和当前角色纹理。

- [ ] **步骤 5：替换临时 CSS 角色**

`PetView` 保留点击打开聊天和拖动窗口行为；视觉主体切换为 `CharacterPlayer`。当官方角色资源也无法加载时，才显示现有静态 CSS 备用角色。

- [ ] **步骤 6：运行播放器、组件和类型验证**

```powershell
pnpm --filter @myself/desktop test -- character-player.test.ts renderer-components.test.tsx
pnpm --filter @myself/desktop typecheck
```

预期：全部通过。

### 任务 12：连接移动、搬运锚点和扩展状态触发

**文件：**

- 新建：`apps/desktop/src/renderer/src/characters/player/character-motion-controller.ts`
- 新建：`apps/desktop/src/renderer/src/characters/player/extension-trigger-controller.ts`
- 修改：`apps/desktop/src/renderer/src/characters/player/CharacterPlayer.tsx`
- 修改：`apps/desktop/src/renderer/src/stores/task-store.ts`
- 新建测试：`apps/desktop/tests/character-motion-controller.test.ts`
- 新建测试：`apps/desktop/tests/extension-trigger-controller.test.ts`

**接口：**

- 消费：任务事件、移动命令、用户点击、关键词和 LLM 情绪标签。
- 产出：统一 `CharacterStateRequest`。
- 产出：当前帧 `carry`、`seat`、`focus` 锚点的桌面坐标。

- [ ] **步骤 1：写位移与挂载失败测试**

```ts
test('角色位置由运动控制器推进而不是由序列帧决定', () => {
  const next = advanceMotion({
    current: { x: 10, y: 20 },
    target: { x: 110, y: 20 },
    speed: 100,
    deltaMs: 500
  });
  expect(next.position).toEqual({ x: 60, y: 20 });
});

test('文件图标位置跟随当前帧 carry 锚点', () => {
  expect(resolveDesktopAnchor(
    { x: 0.75, y: 0.5 },
    { x: 100, y: 200, width: 120, height: 160 },
    'right'
  )).toEqual({ x: 190, y: 280 });
});
```

- [ ] **步骤 2：写扩展状态优先级失败测试**

覆盖待机随机、单击、双击、右键菜单、关键词和 LLM 情绪触发；任何 `thinking`、`acting`、`carrying`、`success`、`error` 请求都必须中断扩展状态。

- [ ] **步骤 3：运行测试确认失败**

```powershell
pnpm --filter @myself/desktop test -- character-motion-controller.test.ts extension-trigger-controller.test.ts
```

预期：失败，提示控制器不存在。

- [ ] **步骤 4：实现运动和锚点坐标转换**

运动控制器使用单调时间差推进位置，限制最大 `deltaMs`，避免系统唤醒后角色瞬移。方向变化驱动精灵镜像和锚点镜像。

- [ ] **步骤 5：实现扩展触发适配**

触发器只产生请求，不直接播放动画。关键词在本地匹配；LLM 只能返回已存在扩展状态的标识，未知状态被拒绝。核心任务状态始终由 `state-arbiter` 最终裁决。

- [ ] **步骤 6：运行验证**

```powershell
pnpm --filter @myself/desktop test -- character-motion-controller.test.ts extension-trigger-controller.test.ts
pnpm --filter @myself/desktop typecheck
```

预期：全部通过。

### 任务 13：完成恢复、性能和端到端验收

**文件：**

- 修改：`apps/desktop/src/main/index.ts`
- 修改：`apps/desktop/src/main/e2e-boundary.ts`
- 修改：`tests/fixtures/electron-app.ts`
- 修改：`tests/e2e/desktop.spec.ts`
- 修改：`tests/integration/desktop-agent.test.ts`
- 新建：`docs/operations/character-workshop-acceptance.md`
- 修改：`package.json`

**接口：**

- 产出脚本：`verify:characters`
- 产出：角色工作室 E2E 固定素材和验收记录。

- [ ] **步骤 1：添加确定性 E2E 角色素材**

测试启动边界只允许在临时 `userData` 下创建：

- 一张 2×2 透明测试精灵图。
- 三张独立测试帧。
- 一个安全角色包。
- 一个包含路径穿越条目的恶意角色包。

测试素材不能引用用户真实图片目录。

- [ ] **步骤 2：写端到端失败场景**

Playwright 场景按顺序验证：

1. 从托盘或设置打开角色工作室。
2. 新建角色。
3. 导入待机精灵图并设置 2×2 网格。
4. 调整帧率和 `ground` 锚点。
5. 启用不完整角色并看到确认文案。
6. 返回桌宠并看到新角色运行。
7. 缺少 `thinking` 时继续使用待机动作且 Agent 请求不受影响。
8. 追加搬运动作和 `carry` 锚点。
9. 新建点击触发的扩展状态。
10. 导出角色包并在隔离数据目录中导入。
11. 恶意角色包被拒绝且现有角色不变。
12. 重启后恢复活动角色和草稿。

- [ ] **步骤 3：运行 E2E 确认新增场景失败**

```powershell
pnpm --filter @myself/desktop build
pnpm test:e2e:desktop
```

预期：新角色工作室场景失败，现有桌面场景继续通过。

- [ ] **步骤 4：补齐启动恢复和错误反馈**

应用启动顺序：

1. 加载角色索引。
2. 校验活动角色运行版本。
3. 失败则切换官方默认角色。
4. Renderer 就绪后再发送活动角色快照。
5. 不自动删除损坏角色或草稿。

所有稳定错误码映射到中文说明和“打开角色工作室”修复入口。

- [ ] **步骤 5：增加性能生命周期测试**

使用可观察适配器验证：

- 工作室关闭后不扫描素材目录。
- 切换角色后旧纹理销毁。
- 窗口隐藏或减少动态效果开启时 ticker 停止。
- 启动时不加载全部角色纹理。
- 编译操作不会阻塞 Agent IPC 测试。

- [ ] **步骤 6：增加统一验证脚本**

根 `package.json` 增加：

```json
"verify:characters": "pnpm --filter @myself/character-runtime test && pnpm --filter @myself/character-assets test && pnpm --filter @myself/desktop typecheck && pnpm --filter @myself/desktop test && pnpm test:security && pnpm test:integration && pnpm test:e2e:desktop"
```

- [ ] **步骤 7：编写中文人工验收清单**

`docs/operations/character-workshop-acceptance.md` 必须逐项记录：

- 精灵图和多图片导入。
- 新建即用。
- 动作不完整提示。
- 待机降级。
- 核心状态和扩展状态优先级。
- 锚点编辑与文件挂载。
- 草稿和运行版本恢复。
- 角色包安全。
- 减少动态效果。
- 空闲 CPU、内存和纹理释放观察结果。

- [ ] **步骤 8：运行最终验证**

```powershell
pnpm verify:characters
```

预期：类型检查、单元测试、安全测试、集成测试和桌面 E2E 全部通过。

- [ ] **步骤 9：只读审查全部实施差异**

```powershell
git status --short
git diff --stat
git diff --check
```

确认没有修改用户无关文件，没有 Git 暂存或提交。

---

## 实施顺序与检查点

1. 任务 1 至 3 完成后，角色协议和状态仲裁可以独立发布测试，不依赖 Electron。
2. 任务 4 至 7 完成后，角色素材、存储和角色包安全可以在无 UI 条件下完整验证。
3. 任务 8 至 10 完成后，角色工作室能够新建、编辑、编译和启用角色。
4. 任务 11 至 12 完成后，桌宠正式使用序列帧角色，并接入位移、锚点和扩展触发。
5. 任务 13 完成后，才允许宣称角色工作室子项目达到可验收状态。

每个检查点都必须运行其阶段内全部测试。后续阶段不得通过跳过前一阶段失败测试来继续。

## 规格覆盖索引

| 规格范围 | 实施任务 |
|---|---|
| 角色、状态、动作和序列帧协议 | 任务 1 |
| 动作池、权重、方向、冷却和待机降级 | 任务 2 |
| 核心状态、扩展状态和中断规则 | 任务 3、12 |
| 精灵图与多图片导入 | 任务 4、6、10 |
| 编辑源、运行产物和增量编译 | 任务 5、6 |
| 角色包导入导出与安全边界 | 任务 7 |
| 角色工作室窗口、入口和 IPC | 任务 8 |
| 三栏编辑器、新建即用和自动保存 | 任务 9 |
| 时间轴、动作属性、锚点和提示文案 | 任务 10 |
| PixiJS 播放、缓存和静态模式 | 任务 11 |
| 桌面位移、文件挂载和扩展触发 | 任务 12 |
| 错误恢复、性能、E2E 和人工验收 | 任务 13 |
