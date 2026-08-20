# AI Pet 角色恢复公开反馈与降级实施计划

> **面向智能代理执行者：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`，逐任务实施本计划。所有步骤使用复选框（`- [ ]`）跟踪。

**目标：** 用 Main 启动时生成的一份最小不可变快照替换旧单错误码链，让 Pet 只提示真实 fallback、Workshop 只提示当前选中角色的问题，且普通聊天独立可用。

**架构：** `character-startup.ts` 是唯一裁决 owner；它在 B2 完成后按固定顺序汇总 B1/B2 报告、索引恢复与活动 runtime 校验。现有 Character IPC 注册位置直接持有该值，Preload 复用现有方法；不新增 Actions getter、动态 callback、Renderer Store、通道或兼容双轨。

**技术栈：** Electron 43、React 19、TypeScript、Zod、Vitest、Testing Library、Playwright、Windows 10/11。

**设计规格：** [角色恢复公开反馈与降级设计](../specs/2026-08-15-character-recovery-degradation-design.md)

**约束规格：** [桌面架构优化减法收口设计](../specs/2026-08-20-desktop-code-subtraction-design.md)

**硬前置：** [B2 角色包导入恢复设计](../specs/2026-08-15-character-import-journal-design.md)及其[实施计划](./2026-08-15-character-import-journal.md)必须已完成、审查通过并提交；`CharacterPackageService.initialize()` 必须已经返回下文的最小报告。前置未满足时不得开始 Task 1。

## 全局约束

- 只修改 `apps/desktop`、桌面 E2E 与现有角色验收文档；`apps/website`、`apps/cloudbase-api`、`apps/package-scanner` 及网站 E2E 必须零差异。
- B3 不重做 B1/B2 的 256 项上限、2000ms 角色间软预算、证据保留、所有权或磁盘恢复算法。
- 正式运行时只允许一个启动裁决 owner、一条 recovery IPC 通道和一种公开载荷。
- 禁止新增 `CharacterActions.getCharacterRecoverySnapshot()` 或同义方法、函数式快照 getter/callback、Renderer 恢复 Store 和新 IPC 通道。
- 禁止跨 IPC 传递 `fallbackActive`、`affectedCapabilities`、`suggestion`、绝对路径、marker 正文、哈希、事务令牌、物理身份或内部异常。
- 实现任务 Task 1/2 执行 RED → 最小 GREEN → 删除旧路径；Task 3 是跨进程纵向验收，先记录 Task 1/2 的先验绿，再增加或合并替代证据，不伪造 RED。完整矩阵只放在最能证明不变量的一层。
- 每个任务完成后由新审查者分别检查规格符合性和代码质量；Critical 或 Important 未清零不得进入下一任务。
- 单点排障或单条命令达到 15 分钟即终止该路线，保存证据后拆分、换方案或按用户规则放宽门禁。
- 用户已授权本计划所需的本地 Git 写操作；每个任务通过审查后小步提交，不执行 push、merge、rebase、reset。
- 最终范围检查以本计划文件的最新提交为基线，并在同一个 PowerShell 进程中解析、引用该提交；不得使用会掩盖已提交 B3 变更的 `HEAD` 对 `HEAD` 比较。

## 固定公开契约

`apps/desktop/src/shared/character-ipc.ts` 中旧 Schema 原位替换为以下封闭契约：

```ts
export const characterRecoveryIssueErrorCodeSchema = z.enum([
  'CHARACTER_DRAFT_RECOVERY_BLOCKED',
  'CHARACTER_PUBLISH_RECOVERY_BLOCKED',
  'CHARACTER_RECOVERY_DEFERRED',
  'CHARACTER_IMPORT_RECOVERY_BLOCKED',
  'CHARACTER_IMPORT_RECOVERY_DEFERRED'
]);

export const characterRecoveryFallbackErrorCodeSchema = z.enum([
  'CHARACTER_INDEX_UNAVAILABLE',
  'CHARACTER_PUBLISH_RECOVERY_BLOCKED',
  'CHARACTER_RECOVERY_DEFERRED',
  'CHARACTER_MANIFEST_INVALID',
  'CHARACTER_MIGRATION_FAILED',
  'CHARACTER_RESOURCE_INTEGRITY_FAILED',
  'CHARACTER_RESOURCE_NOT_FOUND',
  'CHARACTER_RUNTIME_UNAVAILABLE',
  'CHARACTER_VERSION_UNSUPPORTED',
  'CHARACTER_OPERATION_FAILED'
]);

export const characterRecoveryIssueSchema = z.object({
  characterId: characterIdSchema,
  errorCode: characterRecoveryIssueErrorCodeSchema
}).strict();

export const characterRecoverySnapshotResultSchema = z.object({
  fallbackErrorCode: characterRecoveryFallbackErrorCodeSchema.nullable(),
  issues: z.array(characterRecoveryIssueSchema)
}).strict();

export type CharacterRecoveryIssueErrorCode = z.output<
  typeof characterRecoveryIssueErrorCodeSchema
>;
export type CharacterRecoveryFallbackErrorCode = z.output<
  typeof characterRecoveryFallbackErrorCodeSchema
>;
export type CharacterRecoveryIssueDto = Readonly<
  z.output<typeof characterRecoveryIssueSchema>
>;
export type CharacterRecoverySnapshotDto = Readonly<{
  fallbackErrorCode: CharacterRecoveryFallbackErrorCode | null;
  issues: readonly CharacterRecoveryIssueDto[];
}>;
```

`fallbackErrorCode !== null` 是已经切换官方默认角色的唯一表达。Package issue 码不能进入 fallback；fallback-only 码不能进入 issue。

## 固定启动接口与一致性顺序

```ts
export type CharacterStartupResult = Readonly<{
  activeCharacterId: string;
  recoverySnapshot: CharacterRecoverySnapshotDto;
}>;

export type CharacterStartupInput = Readonly<{
  indexRecovered: boolean;
  packageRecoveryReport: CharacterPackageRecoveryReport;
}>;

export interface CharacterStartupDependencies {
  validateActiveRuntime(): Promise<{ activeCharacterId: string } | null>;
  ensureOfficialDefaultCharacter(): Promise<{ activeCharacterId: string }>;
  loadFinalIndex(): Promise<unknown>;
  getTransactionRecoveryReport(): CharacterTransactionRecoveryReport;
}

export function prepareCharacterStartup(
  input: CharacterStartupInput,
  dependencies: CharacterStartupDependencies
): Promise<CharacterStartupResult>;
```

Main 先完成 `recoverCorruptIndex()` 和 B2 `initialize()`。`prepareCharacterStartup()` 内顺序固定为：校验活动 runtime → 必要时准备并启用默认角色 → 最后一次 `CharacterStore.list()` → 紧接着读取一次 `getTransactionRecoveryReport()` → 不再 load Store → 投影 B1/B2 → 去重排序 → 深冻结后返回。

同一角色的 draft、publish 各保留一项；相同 `characterId + errorCode` 去重。先按 `characterId` 升序，再按以下次序升序：

```ts
const CHARACTER_RECOVERY_ISSUE_ORDER = [
  'CHARACTER_DRAFT_RECOVERY_BLOCKED',
  'CHARACTER_PUBLISH_RECOVERY_BLOCKED',
  'CHARACTER_RECOVERY_DEFERRED',
  'CHARACTER_IMPORT_RECOVERY_BLOCKED',
  'CHARACTER_IMPORT_RECOVERY_DEFERRED'
] as const;
```

## 文件责任

- `character-ipc.ts`：唯一公开 unions、严格 Schema 与 DTO。
- `character-startup.ts`：唯一汇总、fallback 裁决、稳定排序与深冻结 owner。
- `main/index.ts`：提供 B1/B2 输入并保存一次性快照。
- `register-ipc.ts`：现有 recovery handler 直接返回注入值。
- `myself-api.ts`、Preload：现有方法的精确返回类型与二次校验。
- `character-recovery.ts`：稳定码到中文说明、能力影响和建议的唯一 Renderer 映射。
- `PetView.tsx`：只读取 fallback；`CharacterWorkshopView.tsx`：View 内按当前选择过滤。
- `desktop.spec.ts`：最多两个真实重启纵向场景。

---

### Task 1：一次贯通 Schema、启动 owner、Main、IPC、Preload 与 Pet

**文件：**

- 修改：`apps/desktop/src/shared/character-ipc.ts`
- 修改：`apps/desktop/src/shared/myself-api.ts`
- 修改：`apps/desktop/src/main/characters/character-startup.ts`
- 修改：`apps/desktop/src/main/index.ts`
- 修改：`apps/desktop/src/main/ipc/register-ipc.ts`
- 修改：`apps/desktop/src/preload/index.ts`
- 修改：`apps/desktop/src/renderer/src/pet/PetView.tsx`
- 修改：`apps/desktop/tests/character-startup.test.ts`
- 修改：`apps/desktop/tests/character-ipc.test.ts`
- 修改：`apps/desktop/tests/preload-api.test.ts`
- 修改：`apps/desktop/tests/main-lifecycle.test.ts`
- 修改：`apps/desktop/tests/official-default-character.test.ts`
- 修改：`apps/desktop/tests/pet-view.test.tsx`

**接口：**

- 消费：B1 `CharacterTransactionRecoveryReport` 与 B2 `CharacterPackageRecoveryReport`。
- 产出：上述固定公开契约、固定启动接口、`MyselfApi.getCharacterRecoverySnapshot(): Promise<CharacterRecoverySnapshotDto>`。
- 产出直接值接口：

```ts
export function registerCharacterIpc(
  ipcMain: IpcMain,
  service: CharacterIpcService,
  dialogs: CharacterIpcDialogs,
  recoverySnapshot: CharacterRecoverySnapshotDto
): void;
```

- 删除：旧 `{ errorCode }` Schema/类型、`CharacterStartupResult` kind 联合、`startupRecoveryErrorCode`、`remove?` seam、`recoveryErrorCode: () => string | null` 及其默认值、`loadCharacterStartupRecovery()`。

- [ ] **步骤 1：写 Schema RED 测试**

合法快照必须通过；外层额外 `fallbackActive`、issue 额外 `ownerToken`、非法角色 ID、issue 使用 fallback-only 码、fallback 使用 import-only 码分别失败：

```ts
const valid = {
  fallbackErrorCode: 'CHARACTER_RESOURCE_NOT_FOUND',
  issues: [{
    characterId: 'demo',
    errorCode: 'CHARACTER_IMPORT_RECOVERY_BLOCKED'
  }]
};
expect(characterRecoverySnapshotResultSchema.parse(valid)).toEqual(valid);
expect(() => characterRecoverySnapshotResultSchema.parse({
  ...valid,
  fallbackActive: true
})).toThrow();
```

- [ ] **步骤 2：写启动 owner RED 测试**

用调用数组断言 `runtime → default（仅 fallback）→ final-index → b1-report`；报告读取后若再 load 就失败。完整覆盖：非活动 B1/B2 问题不 fallback；活动 draft blocked 且 runtime 健康不 fallback；活动角色只有 B2 blocked 或 deferred 且 runtime 健康时不 fallback；活动 publish blocked、活动 B1 deferred、runtime/manifest/resource/version 失败或索引已恢复触发对应 fallback；未知异常规范化为 `CHARACTER_OPERATION_FAILED`。断言重复问题去重、双分面保留、固定排序，以及快照/数组/每个 issue 均 `Object.isFrozen(...) === true`。

- [ ] **步骤 3：写 IPC/Preload/Pet RED 纵向测试**

handler 只接受严格空对象并返回注入值；额外输入在读取前失败。Preload 对合法值二次解析，含私有字段或非法 union 值时拒绝。Pet 直接读取最小 DTO：fallback 非空显示官方默认角色提示和工作室入口；只有 issues 时不显示横幅、不替换健康播放器；RPC 失败不回显异常正文。只保留纵向边界证据，不重复启动矩阵。

- [ ] **步骤 4：运行 RED**

```powershell
pnpm.cmd --filter @myself/desktop test -- character-startup.test.ts character-ipc.test.ts preload-api.test.ts main-lifecycle.test.ts official-default-character.test.ts pet-view.test.tsx
```

预期：FAIL，旧链仍是标量 callback，启动 owner 尚不接收 B1/B2 报告。

- [ ] **步骤 5：最小实现严格契约与启动 owner**

逐字实现固定 unions 和接口；只从 B1 两个分面与 B2 `issues` 白名单重建对象，不 spread 内部报告。fallback 前先执行默认角色依赖，最后一次 load 与 report 读取相邻，随后不再触发 Store load。深冻结每个 issue、issues 数组和快照。

- [ ] **步骤 6：原位替换 Main 与直接 IPC 值**

Main 按下列形状保存值，不建立 getter：

```ts
const packageRecoveryReport = await characterPackageService.initialize();
const defaultResources = app.isPackaged
  ? join(app.getAppPath(), 'resources/characters/default')
  : join(__dirname, '../../resources/characters/default');
const characterStartup = await prepareCharacterStartup(
  {
    indexRecovered: recoveredCorruptCharacterIndex.recovered,
    packageRecoveryReport
  },
  {
    validateActiveRuntime: async () => {
      const snapshot = await characterActions.getCharacterRuntimeSnapshot();
      return snapshot ? { activeCharacterId: snapshot.activeCharacterId } : null;
    },
    ensureOfficialDefaultCharacter: async () => {
      await ensureOfficialDefaultCharacter(characterStore, defaultResources);
      return { activeCharacterId: 'builtin-default' };
    },
    loadFinalIndex: () => characterStore.list(),
    getTransactionRecoveryReport: () =>
      characterStore.getTransactionRecoveryReport()
  }
);
const characterRecoverySnapshot = characterStartup.recoverySnapshot;
```

`registerCharacterIpc(..., characterRecoverySnapshot)` 直接注入深冻结值；handler 执行严格空输入校验后以新 Schema parse 该值。Preload 保留现有通道和方法，只更新返回类型与二次 Schema 校验。Pet 在既有 effect 中直接调用 API，只保存 fallback 文案所需局部状态，并在同一步删除 `loadCharacterStartupRecovery()` 的导出、调用和专属测试，不保留新旧载荷双轨。普通聊天、Secret、Settings 和窗口初始化不以恢复结果为退出条件。

- [ ] **步骤 7：删除旧链并运行 GREEN**

删除旧标量、callback、kind 分支、匿名返回类型、Pet 旧 loader 及只服务旧形状的测试：

```powershell
pnpm.cmd --filter @myself/desktop test -- character-startup.test.ts character-ipc.test.ts preload-api.test.ts main-lifecycle.test.ts official-default-character.test.ts pet-view.test.tsx main-conversation-composition.test.ts
pnpm.cmd --filter @myself/desktop typecheck
```

预期：全部 PASS；聊天组合没有 recovery snapshot 依赖。

- [ ] **步骤 8：删除门与双重审查**

```powershell
rg -n "startupRecoveryErrorCode" apps/desktop/src/main/index.ts
rg -n "recoveryErrorCode\s*:\s*\(\)\s*=>|recoveryErrorCode\(\)" apps/desktop/src/main/index.ts apps/desktop/src/main/ipc/register-ipc.ts
rg -n "kind: 'fallback'|kind: 'active'|remove\?:|errorCode: string \| null|fallbackActive|affectedCapabilities|suggestion|loadCharacterStartupRecovery" apps/desktop/src/main apps/desktop/src/preload apps/desktop/src/shared/character-ipc.ts apps/desktop/src/shared/myself-api.ts apps/desktop/src/renderer/src/pet apps/desktop/tests/pet-view.test.tsx apps/desktop/tests/character-startup.test.ts
rg -n "getCharacterRecoverySnapshot" apps/desktop/src/main/characters/character-actions.ts
git diff --check
```

预期：前四条零命中。扫描刻意不匹配 B1 内部合法的 `recoveryErrorCode` helper。规格审查核对 B2 硬前置、exact unions 和一致性顺序；质量审查核对无 Actions getter、动态 callback、第二通道、双轨或内部数据泄漏。

- [ ] **步骤 9：提交**

```powershell
git add apps/desktop/src/shared/character-ipc.ts apps/desktop/src/shared/myself-api.ts apps/desktop/src/main/characters/character-startup.ts apps/desktop/src/main/index.ts apps/desktop/src/main/ipc/register-ipc.ts apps/desktop/src/preload/index.ts apps/desktop/src/renderer/src/pet/PetView.tsx apps/desktop/tests/character-startup.test.ts apps/desktop/tests/character-ipc.test.ts apps/desktop/tests/preload-api.test.ts apps/desktop/tests/main-lifecycle.test.ts apps/desktop/tests/official-default-character.test.ts apps/desktop/tests/pet-view.test.tsx
git commit -m "refactor(desktop): replace scalar character recovery chain"
```

---

### Task 2：建立共享 issue presentation 并原位接入 Workshop

**文件：**

- 修改：`apps/desktop/src/shared/character-recovery.ts`
- 修改：`apps/desktop/src/renderer/src/characters/workshop/CharacterWorkshopView.tsx`
- 修改：`apps/desktop/tests/character-recovery.test.ts`
- 修改：`apps/desktop/tests/character-workshop-components.test.tsx`
- 修改：`apps/desktop/tests/character-workshop-close-renderer.test.tsx`

**接口：**

- 消费：Task 1 的 `MyselfApi.getCharacterRecoverySnapshot()`。
- 产出仅限 Renderer 映射：

```ts
export type CharacterRecoveryPresentation = Readonly<{
  text: string;
  affectedCapabilities: readonly ('draft-save' | 'publish' | 'activate')[];
  suggestion: string;
}>;

export function characterRecoveryPresentation(
  errorCode: CharacterRecoveryIssueErrorCode
): CharacterRecoveryPresentation;
```

- 保留：Task 1 已迁移的 Pet fallback 路径；本任务不再次修改 Pet。

- [ ] **步骤 1：写共享映射 RED 测试**

在 `character-recovery.test.ts` 对五个 issue union 值逐一断言中文 text、受影响能力和建议；这是完整文案矩阵唯一 owner。映射结果不得包含注入的绝对路径或 token sentinel；Workshop RPC 失败只显示通用安全文案，不回显异常正文。

- [ ] **步骤 2：写 Workshop RED 测试并补齐 API doubles**

Workshop View 读取一次快照，按当前 `selectedCharacterId` 过滤；切换选择只过滤内存值；其他角色问题不显示；mock store action 不因恢复读取而调用。同步更新 `character-workshop-components.test.tsx` 和 `character-workshop-close-renderer.test.tsx` 的 API double，为 `getCharacterRecoverySnapshot()` 返回 `{ fallbackErrorCode: null, issues: [] }`，避免类型检查靠强制断言绕过。

- [ ] **步骤 3：运行 RED**

```powershell
pnpm.cmd --filter @myself/desktop test -- character-recovery.test.ts character-workshop-components.test.tsx character-workshop-close-renderer.test.tsx
```

预期：FAIL，Workshop 尚未读取和过滤恢复快照。

- [ ] **步骤 4：实现最小 Renderer 映射**

`CharacterWorkshopViewProps.api` 原位扩展为 `CharacterWorkshopApi & Pick<MyselfApi, 'onCharacterWorkshopFlushRequested' | 'getCharacterRecoverySnapshot'>`；View 保存一次只读快照局部 state，并在 render 时执行：

```ts
const selectedRecoveryIssues = recoverySnapshot?.issues.filter(
  issue => issue.characterId === state.selectedCharacterId
) ?? [];
```

复用现有 alert/toast/按钮样式；不修改 `character-workshop-store.ts`，不把恢复状态交给 store action，不从错误码推导磁盘操作。

- [ ] **步骤 5：删除重复矩阵**

共享映射测试拥有五个 issue 码完整矩阵；Workshop 只保留选中角色过滤、切换选择、不写 Store和 RPC 安全失败，不重复全部错误码。

- [ ] **步骤 6：运行 GREEN 与聊天回归**

```powershell
pnpm.cmd --filter @myself/desktop test -- character-recovery.test.ts character-workshop-components.test.tsx character-workshop-close-renderer.test.tsx character-workshop-store.test.ts main-conversation-composition.test.ts
pnpm.cmd --filter @myself/desktop typecheck
```

预期：全部 PASS。

- [ ] **步骤 7：删除门与双重审查**

```powershell
rg -n "loadCharacterStartupRecovery|fallbackActive" apps/desktop/src apps/desktop/tests
rg -n "recoverySnapshot|RecoveryIssue" apps/desktop/src/renderer/src/characters/store
rg -n "affectedCapabilities|suggestion" apps/desktop/src/main apps/desktop/src/preload apps/desktop/src/shared/character-ipc.ts apps/desktop/src/shared/myself-api.ts
git diff --check
```

预期：三条零命中。规格审查确认 Pet/Workshop/Chat 职责；质量审查确认派生字段只在 `character-recovery.ts` 本地映射，Workshop Store 未成为第二 owner。

- [ ] **步骤 8：提交**

```powershell
git add apps/desktop/src/shared/character-recovery.ts apps/desktop/src/renderer/src/characters/workshop/CharacterWorkshopView.tsx apps/desktop/tests/character-recovery.test.ts apps/desktop/tests/character-workshop-components.test.tsx apps/desktop/tests/character-workshop-close-renderer.test.tsx
git commit -m "refactor(desktop): replace scalar recovery renderer path"
```

---

### Task 3：用最多两个重启场景完成纵向验收并关闭旧路径

**文件：**

- 修改：`tests/e2e/desktop.spec.ts`
- 条件修改：`tests/fixtures/electron-app.ts`（只有现有 fixture 无法完成正式重启和用户数据准备时；不得增加公开 fault seam）
- 复用：`tests/fixtures/character-storage-snapshot.ts`
- 修改：`docs/operations/character-workshop-acceptance.md`

**接口：**

- 消费：正式 Workshop、Pet、Chat UI，`fixture.restart()`、用户数据准备和既有 recovery API。
- 产出：两个或更少的真实 Electron 重启纵向证据。

- [ ] **步骤 1：盘点并合并既有恢复 E2E**

用 `rg` 列出角色恢复、marker 和 restart 场景。删除或合并可由 B1/B2 模块测试证明的矩阵，最终 B3 恢复重启场景不得超过两个。修改 E2E 前先运行并记录先验绿：

```powershell
pnpm.cmd --filter @myself/desktop test -- character-startup.test.ts character-ipc.test.ts preload-api.test.ts official-default-character.test.ts character-recovery.test.ts pet-view.test.tsx character-workshop-components.test.tsx character-workshop-close-renderer.test.tsx
```

预期：Task 1/2 的定向行为证据 PASS；Task 3 只验证这些行为跨 Main/Preload/Renderer/真实重启后仍成立。

- [ ] **步骤 2：建立非活动角色纵向场景**

通过正式 UI 准备健康活动角色和非活动角色；退出后准备非活动 Store 坏 marker、一个坏 Package marker 和一个可恢复 Package marker；重启断言健康播放器 ready、Pet 无 fallback、Workshop 只在选中相应角色时显示问题、聊天可提交。序列化公开快照，断言不含用户目录、marker sentinel、哈希或 token。

- [ ] **步骤 3：建立活动角色 fallback 纵向场景**

损坏活动角色 publish marker 或 runtime 后重启；断言当前已是官方默认角色、Pet 显示降级与工作室入口、原始恢复证据字节仍保留、其他健康角色仍列出、聊天可提交。这两个场景是对已由 Task 1/2 单元测试证明行为的跨进程替代证据，不要求先出现失败；若现有场景已经覆盖，则原位合并并先记录修改前的通过基线，不为制造 RED 破坏生产代码。

- [ ] **步骤 4：运行定向 E2E**

```powershell
pnpm.cmd --filter @myself/desktop build
pnpm.cmd exec playwright test --config tests/playwright.config.ts --grep "角色恢复"
```

预期：两个或更少场景全部 PASS。单点失败最多定向复现一次；达到 15 分钟即停止该路线。

- [ ] **步骤 5：最终删除与边界扫描**

```powershell
rg -n "startupRecoveryErrorCode" apps/desktop/src/main/index.ts
rg -n "recoveryErrorCode\s*:\s*\(\)\s*=>|recoveryErrorCode\(\)" apps/desktop/src/main/index.ts apps/desktop/src/main/ipc/register-ipc.ts
rg -n "loadCharacterStartupRecovery|fallbackActive|CharacterActions\.getCharacterRecoverySnapshot" apps/desktop/src apps/desktop/tests tests/e2e
rg -n "affectedCapabilities|suggestion" apps/desktop/src/main apps/desktop/src/preload apps/desktop/src/shared/character-ipc.ts apps/desktop/src/shared/myself-api.ts
$b3PlanBase = (git log -1 --format=%H -- docs/superpowers/plans/2026-08-15-character-recovery-degradation.md).Trim()
git diff --name-only "$b3PlanBase" -- apps/website apps/cloudbase-api apps/package-scanner tests/e2e/website.spec.ts
git diff --check "$b3PlanBase" --
```

预期：全部无输出。另按测试标题确认恢复重启场景不超过两个。

- [ ] **步骤 6：运行自动化门禁**

逐条运行，任何单条达到 15 分钟即终止并记录现有证据：

```powershell
pnpm.cmd --filter @myself/desktop test -- character-startup.test.ts character-ipc.test.ts preload-api.test.ts official-default-character.test.ts character-recovery.test.ts pet-view.test.tsx character-workshop-components.test.tsx character-workshop-close-renderer.test.tsx
pnpm.cmd --filter @myself/desktop typecheck
pnpm.cmd --filter @myself/desktop test
pnpm.cmd test:security
pnpm.cmd test:integration
pnpm.cmd verify:characters
pnpm.cmd verify:desktop
```

预期：全部退出 0。若出现与既有页面关闭波动相同的现象，只如实记录定向复现和等价门禁，不宣称根因已修复。

- [ ] **步骤 7：更新现有验收记录**

在 `character-workshop-acceptance.md` 写明日期、环境、实际命令、退出码、两个场景结果、旧符号扫描、受保护路径零差异和生产/测试新增删除行数。真实 Windows 窗口层级、焦点、布局、文案可读性及重启视觉没有人工观察时写“待用户人工确认”。

- [ ] **步骤 8：最终双重审查**

规格审查逐项对照 B3 设计第 4—12 节；质量审查确认 owner、接口和通道数量未增加，无兼容双轨或重复 B1/B2 矩阵。Critical、Important 清零且 Minor 已修复或由主智能体明确裁决后才能提交。

- [ ] **步骤 9：提交**

```powershell
git add tests/e2e/desktop.spec.ts docs/operations/character-workshop-acceptance.md
git add tests/fixtures/electron-app.ts # 仅当该文件确有本任务差异
git commit -m "test(desktop): verify character recovery degradation flow"
```

## 完成标准

- B2 已完成，B3 未重写 B1/B2 恢复算法。
- `character-startup.ts` 是唯一启动裁决 owner，并按固定顺序产出一次性深冻结快照。
- 公开类型严格等于两个封闭 union；`fallbackErrorCode !== null` 是唯一 fallback 状态。
- IPC 直接持有不可变值；没有 Actions getter、动态 callback、第二通道或 Renderer 恢复 Store。
- Pet 只消费 fallback，Workshop 只筛选当前角色，Chat 不读取快照。
- 旧标量、旧 loader 和跨 IPC 派生字段零正式引用；B3 recovery E2E 不超过两个。
- 定向测试、适用门禁、删除扫描和受保护路径检查均有真实记录；未执行或未人工观察项目不写成通过。
