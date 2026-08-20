# AI Pet 角色包导入恢复原位收敛实施计划

> **面向智能代理执行者：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`，逐任务实施本计划。所有步骤使用复选框（`- [ ]`）跟踪。

**目标：** 在不改变正常角色包业务的前提下，原位深化 `CharacterPackageService` 的 v3 导入恢复，保证异常退出后的完整排他 marker、逐项隔离和带令牌安全回滚，并删除旧 v1/v2 与普通删除路径。

**架构：** `CharacterPackageService` 继续同时作为角色包导入 saga 和 package marker 的唯一 owner，不新增 `CharacterImportJournal` 或同义模块。现有原子文件协调器只增加可复用的完整排他发布原语；`CharacterStore` 只把现有带令牌回滚收敛为判别结果；B3 只消费 `initialize()` 返回的最小不可变问题报告。

**技术栈：** Electron 43、TypeScript、Node.js `fs/promises`、Zod、Vitest、Playwright、Windows NTFS。

**设计规格：** [角色包导入恢复设计](../specs/2026-08-15-character-import-journal-design.md)

**覆盖规格：** [桌面架构优化减法收口设计](../specs/2026-08-20-desktop-code-subtraction-design.md)；本计划原位替代旧计划中的 v4、独立 Journal 和双 owner 任务，不保留附录式兼容路线。

**后续消费者：** [角色恢复公开反馈与降级计划](./2026-08-15-character-recovery-degradation.md) 只能消费本文定义的 `CharacterPackageRecoveryReport`，不得读取 marker、令牌、路径或内部恢复阶段。

## 全局约束

- 只修改桌面端角色恢复及其直接测试、验收记录；`apps/website`、`apps/cloudbase-api`、`apps/package-scanner` 与网站 E2E 零触碰。
- 保留现有 v3 `{ version: 3, characterId, importTransactionId }` 磁盘语义；不得新增 v4、迁移器、`character-import-journal.ts`、`CharacterImportJournal` 或第二个恢复 owner。
- 候选稳定排序后只取活动角色正式 marker 加最多其余 255 项（无活动项时取前 256 项）；`.complete-*` 永不执行，第 257 项及以后不读取、不逐项 issue/log；2000ms 软预算只在已入 inventory 的项目之间检查，已经开始的单项必须完成。
- legacy、坏 marker、权限失败、证据冲突和身份变化全部 fail closed；无当前 owner token 的 v1/v2 绝不删除角色目录。
- Renderer、Preload、Provider、普通日志和 B3 报告不得接收 marker 文件名、绝对路径、正文、哈希、`importTransactionId`、`dev/ino`、句柄或隔离证据名。
- 测试采用 replace-don't-layer：原子协调器拥有文件发布矩阵，Store 拥有 token/活动角色/身份边界，PackageService 拥有调度、隔离和最小报告矩阵，Electron E2E 只保留一条纵向证据。
- 用户已于 2026-08-20 对本规格第 10 节的大量删除范围完成二次批准；新路径定向测试通过后，同一任务直接删除批准范围内的旧实现和旧测试，不再等待额外删除批准。
- Git 写操作已获用户授权；每个实现任务通过 RED → GREEN → 删除门 → 新鲜审查后，以独立提交落地，不使用破坏性 Git 命令。
- 任一单点诊断或命令达到 15 分钟仍未收敛时，立即终止该次命令并拆分、换方案或按真实证据放宽非安全门；不得立即跳过，也不得用新增层掩盖卡点。

## 文件结构

- 修改 `apps/desktop/src/main/storage/atomic-file-coordinator.ts`：增加唯一通用能力 `atomicWriteFileExclusive()`，保持 `atomicWriteText()` replacement 语义不变。
- 新增 `apps/desktop/tests/atomic-file-coordinator.test.ts`：独占真实 Windows 完整排他发布与失败清理矩阵。
- 修改 `apps/desktop/src/main/characters/character-store.ts`：把 `rollbackImportedCharacter()` 的布尔结果原位替换为判别联合，不改变 draft/publish transaction recovery。
- 修改 `apps/desktop/tests/character-store.test.ts`：保留 Store 独有的 owner token、活动角色、Junction 和移动前后身份边界。
- 修改 `apps/desktop/src/main/characters/character-package-service.ts`：保留 v3 并原位实现 inventory、逐 marker 恢复、证据隔离、预算、最小报告和导入失败安全回滚，同时删除旧 owner。
- 修改 `apps/desktop/tests/character-package-service.test.ts`：从公开 `initialize()` 与 `importCharacter()` 覆盖完整恢复算法，不为私有 helper 建第二套测试表面。
- 修改 `tests/e2e/desktop.spec.ts`：只增加一个“一坏一好仍启动且聊天可用”的真实 Electron 纵向场景。
- 修改 `docs/operations/character-workshop-acceptance.md`：只记录实际执行的环境、命令、结果和待人工确认项。

---

### Task 1：增加完整排他文件发布原语

**文件：**

- 修改：`apps/desktop/src/main/storage/atomic-file-coordinator.ts`
- 新增：`apps/desktop/tests/atomic-file-coordinator.test.ts`

**接口：**

- 保留：`atomicWriteText(file: string, content: string): Promise<void>`，继续使用 replacement 语义。
- 产出：

```ts
export async function atomicWriteFileExclusive(
  file: string,
  content: Uint8Array
): Promise<void>;
```

- 约束：函数只负责同目录临时文件、完整写入、`sync()`、关闭、`link(temp, final)` 和临时文件清理；不得拥有 marker Schema、角色 ID 或恢复状态。

- [ ] **Step 1：写并发与已有目标 RED 测试**

在 `atomic-file-coordinator.test.ts` 添加实际测试名 `32 个并发排他写入只有一个成功且 final 正文完整` 与 `已有 final 时保持原字节且返回 EEXIST`。核心断言固定为：

```ts
const bodies = Array.from({ length: 32 }, (_, index) =>
  Buffer.from(`writer-${index}-${'x'.repeat(4096)}`, 'utf8'));
const results = await Promise.allSettled(
  bodies.map(bytes => atomicWriteFileExclusive(finalFile, bytes))
);
expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
expect(results.filter(result => result.status === 'rejected')).toHaveLength(31);
expect(bodies).toContainEqual(await readFile(finalFile));
```

已有目标用例先写入 `original-bytes`，再调用原语并断言拒绝对象的 `code` 为 `EEXIST`、最终字节仍为 `original-bytes`。

- [ ] **Step 2：写 write/sync/link 失败 RED 测试**

通过 Vitest 对 `node:fs/promises` 做模块级 mock，不向生产接口增加 fault seam。添加实际测试名：

- `临时文件 write 失败时 final 不出现且清理 temp`
- `临时文件 sync 失败时 final 不出现且清理 temp`
- `hard-link 发布失败时不调用 rename 或 copyFile`

每项断言 final 不存在、目录中无本次 `.tmp`，且 `rename`、`copyFile` 调用次数均为 0。

- [ ] **Step 3：运行 RED 并核对失败原因**

```powershell
pnpm.cmd --filter @myself/desktop test -- atomic-file-coordinator.test.ts
```

预期：FAIL，原因是 `atomicWriteFileExclusive` 尚未导出；不得接受环境、fixture 或现有 `atomicWriteText()` 失败作为正确 RED。

- [ ] **Step 4：实现最小 GREEN 原语**

在现有文件中增加 `link` 导入，并按固定顺序实现：

```ts
export async function atomicWriteFileExclusive(
  file: string,
  content: Uint8Array
): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const temporaryFile = `${file}.${randomUUID()}.tmp`;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporaryFile, 'wx', 0o600);
    await handle.writeFile(content);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporaryFile, file);
  } finally {
    await handle?.close().catch(() => undefined);
    await rm(temporaryFile, { force: true }).catch(() => undefined);
  }
}
```

不得加入 `rename()`、`copyFile()` 或直接写 final 的 fallback；原生 `EEXIST` 原样向上抛出。

- [ ] **Step 5：运行 GREEN 与相邻回归**

```powershell
pnpm.cmd --filter @myself/desktop test -- atomic-file-coordinator.test.ts character-store.test.ts official-default-character.test.ts
pnpm.cmd --filter @myself/desktop typecheck
```

预期：全部 PASS；真实 Windows 并发结果恰好 1 成功/31 失败。hard link 不支持或权限拒绝时该验证必须 FAIL 并记录环境，不得跳过后宣称通过。

- [ ] **Step 6：执行删除门与自审**

```powershell
git diff -- apps/desktop/src/main/storage/atomic-file-coordinator.ts | rg "^\+.*(rename|copyFile)"
git diff --check
git diff -- apps/desktop/src/main/storage/atomic-file-coordinator.ts apps/desktop/tests/atomic-file-coordinator.test.ts
```

预期：第一条零命中；差异中没有新增 rename/copy fallback、marker 业务或依赖注入接口，也没有改变 `atomicWriteText()` 的既有 rename replacement 路径。

- [ ] **Step 7：新鲜审查并提交**

由未实现本任务的审查者分别检查规格一致性与代码质量；Critical/Important 全部修复并重跑 Step 5 后提交：

```powershell
git add apps/desktop/src/main/storage/atomic-file-coordinator.ts apps/desktop/tests/atomic-file-coordinator.test.ts
git commit -m "feat(desktop): 增加完整排他文件发布"
```

---

### Task 2：把 Store 导入回滚收敛为判别结果

**文件：**

- 修改：`apps/desktop/src/main/characters/character-store.ts`
- 修改：`apps/desktop/tests/character-store.test.ts`

**接口：**

- 产出：

```ts
export type ImportedCharacterRollbackResult =
  | Readonly<{ kind: 'rolled-back' }>
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'ownership-mismatch' }>
  | Readonly<{ kind: 'active-character' }>;

rollbackImportedCharacter(
  characterId: string,
  importTransactionId: string
): Promise<ImportedCharacterRollbackResult>;
```

- 保留：`completeImportedCharacter(characterId, importTransactionId): Promise<boolean>`、Store owner 文件、活动角色保护、Junction 拒绝以及 rename 前后目录/owner `dev/ino` 复核。
- 消费方：Task 3 的 `CharacterPackageService` 必须按 `kind` 决定是否完成 marker，不能把结果做真值判断。

- [ ] **Step 1：把现有 token 测试改写为判别 RED**

将实际测试 `角色包导入所有权令牌允许重启后只回滚本次创建的角色` 的断言改为：错误 token 返回 `{ kind: 'ownership-mismatch' }`，正确 token 返回 `{ kind: 'rolled-back' }`。新增实际测试 `不存在角色返回 absent 且不创建目录或索引项`：

```ts
await expect(store.rollbackImportedCharacter('missing', transactionId))
  .resolves.toEqual({ kind: 'absent' });
await expect(access(join(charactersDirectory, 'missing'))).rejects.toThrow();
```

- [ ] **Step 2：补齐活动角色与身份替换 RED**

新增实际测试 `活动角色即使 owner 令牌匹配也返回 active-character 且不删除`；把现有 `角色包回滚读取令牌后同 ID 目录被替换时保留替代角色` 的期望改为 `{ kind: 'ownership-mismatch' }`。保留现有真实路径/Junction 断言，不复制 PackageService 的 marker 矩阵。

- [ ] **Step 3：运行 RED 并核对失败原因**

```powershell
pnpm.cmd --filter @myself/desktop test -- character-store.test.ts
```

预期：FAIL，原因只应是当前接口返回 `boolean`，不是 Store 既有目录身份保护失效。

- [ ] **Step 4：最小替换返回类型**

导出 `ImportedCharacterRollbackResult`，并把现有私有 owner 查询结果收敛为：

```ts
type ImportedCharacterOwnershipLookup =
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'ownership-mismatch' }>
  | Readonly<{
      kind: 'owned';
      identity: Readonly<{
        directoryDev: number;
        directoryIno: number;
        ownerDev: number;
        ownerIno: number;
      }>;
    }>;
```

角色目录不存在返回 `{ kind: 'absent' }`；目录存在但 owner 缺失、token 不符或身份变化返回 `{ kind: 'ownership-mismatch' }`；有效 owner 对应活动角色返回 `{ kind: 'active-character' }`；tombstone、索引提交和尽力清理完成后返回 `{ kind: 'rolled-back' }`。不得新建 Store 包装器，不得删减移动前后身份复核。

- [ ] **Step 5：运行 GREEN 与消费者类型检查**

```powershell
pnpm.cmd --filter @myself/desktop test -- character-store.test.ts
pnpm.cmd --filter @myself/desktop typecheck
```

预期：全部 PASS。当前 `CharacterPackageService` 只等待回滚 Promise 而不读取布尔值，因此本任务可以独立通过 typecheck；不得为 Task 3 提前加入兼容布尔分支、重载或临时字段。

- [ ] **Step 6：执行删除门与自审**

```powershell
rg -n "rollbackImportedCharacter\(" apps/desktop/src
rg -n -U "rollbackImportedCharacter\([^;]+?\)\)\s*\.resolves\.toBe\((true|false)\)" apps/desktop/tests/character-store.test.ts
git diff --check
```

预期：生产消费者只有 `CharacterPackageService`；第二条零命中；Store 没有同时保留布尔与判别两套正式接口。

- [ ] **Step 7：新鲜审查并提交**

由未实现本任务的审查者检查四种结果是否互斥、活动角色和陌生目录是否始终保留；Critical/Important 全部修复并重跑 Step 5 后提交：

```powershell
git add apps/desktop/src/main/characters/character-store.ts apps/desktop/tests/character-store.test.ts
git commit -m "refactor(desktop): 细化导入回滚结果"
```

---

### Task 3：原位替换 PackageService 恢复与导入回滚

**文件：**

- 修改：`apps/desktop/src/main/characters/character-package-service.ts`
- 修改：`apps/desktop/tests/character-package-service.test.ts`

**接口：**

- 消费：Task 1 的 `atomicWriteFileExclusive(file, content)` 与 Task 2 的 `ImportedCharacterRollbackResult`。
- 产出：

```ts
export type CharacterPackageRecoveryIssue = Readonly<{
  characterId: string;
  errorCode:
    | 'CHARACTER_IMPORT_RECOVERY_BLOCKED'
    | 'CHARACTER_IMPORT_RECOVERY_DEFERRED';
}>;

export type CharacterPackageRecoveryReport = Readonly<{
  issues: readonly CharacterPackageRecoveryIssue[];
}>;

initialize(): Promise<CharacterPackageRecoveryReport>;
```

- 私有磁盘类型固定为：

```ts
type CharacterPackageImportMarkerV3 = Readonly<{
  version: 3;
  characterId: string;
  importTransactionId: string;
}>;

type ImportMarkerIdentity = Readonly<{
  dev: number;
  ino: number;
  size: number;
}>;

private completeOwnedMarker(
  marker: string,
  expected: ImportMarkerIdentity
): Promise<void>;

private preserveMarkerEvidence(
  marker: string,
  bytes: Uint8Array,
  expected: ImportMarkerIdentity
): Promise<void>;
```

- B3 只能接收不可变快照中的 `characterId + errorCode`；报告不得加入成功项、计数、`budgetExceeded`、阶段、内部原因或诊断详情。

- [ ] **Step 1：写 v3 完整发布与正常导入顺序 RED**

把现有 `回滚删除失败时写入 marker 并在下一次导入前恢复` 改写为实际测试 `导入失败只调用带令牌回滚并保留无法完成的 v3 marker`。使用 spy 明确证明安全路径：

```ts
const deleteSpy = vi.spyOn(store, 'delete');
const rollbackSpy = vi.spyOn(store, 'rollbackImportedCharacter');

await expect(service.importCharacter(packagePath))
  .rejects.toThrow('CHARACTER_PACKAGE_ROLLBACK_FAILED');
expect(rollbackSpy).toHaveBeenCalledTimes(1);
const [[rolledBackId, rolledBackToken]] = rollbackSpy.mock.calls;
expect(rolledBackId).toBe('demo');
expect(JSON.parse(await readFile(marker, 'utf8')).importTransactionId)
  .toBe(rolledBackToken);
expect(deleteSpy).not.toHaveBeenCalled();
```

不得用让 `delete()` 抛 sentinel 的方式代替“未调用”证据。新增实际测试 `已有 blocked marker 的目标导入稳定失败且不换 ID`：预置目标 ID 的 blocked v3 marker，让 `createId` spy 依次可返回 `blocked-target`、`unexpected-retry`，断言导入以 `CHARACTER_PACKAGE_ROLLBACK_FAILED` 拒绝、`createId` 只调用一次、marker 和目标目录字节不变，且没有创建 `unexpected-retry`。

新增实际测试 `v3 marker 完整发布后才创建 Store owner 且完成后复核并清理`，记录调用顺序并断言：

```ts
expect(calls).toEqual([
  'marker:published',
  'store:create-owner',
  'source:installed',
  'draft:saved',
  'compiled:published',
  'owner:completed',
  'marker:completed'
]);
```

- [ ] **Step 2：写逐 marker 隔离与 legacy RED**

添加实际测试：

- `半截 marker 不阻断后续合法 v3 且原字节被排他隔离`
- `v1 与 v2 只保留证据且从不调用角色删除`
- `未知版本与正文文件名角色不一致均返回 blocked`
- `无法从严格文件名识别角色时不伪造 issue`
- `证据目标冲突或权限失败保留原 marker 且继续后续项`
- `marker open 或 read 失败只 blocked 当前项且继续后续合法项`
- `证据发布 ENOSPC 时保留原 marker 且继续后续合法项`
- `证据发布后单独清理失败且正式名排他恢复成功时不报告恢复，只由正式 marker 支持下次重试`
- `清理与恢复正式名同时失败时 complete 原字节证据不执行、不生成角色 issue，只记录 CHARACTER_IMPORT_RECOVERY_DETACHED_EVIDENCE`

用 `Buffer.from('{"version":3')` 作为半截字节 sentinel；恢复后逐字节比较隔离证据，报告只断言：

```ts
expect(report).toEqual({
  issues: [{
    characterId: 'broken',
    errorCode: 'CHARACTER_IMPORT_RECOVERY_BLOCKED'
  }]
});
expect(JSON.stringify(report)).not.toContain(transactionId);
expect(JSON.stringify(report)).not.toContain(charactersDirectory);
expect(Object.isFrozen(report)).toBe(true);
expect(Object.isFrozen(report.issues)).toBe(true);
expect(report.issues.every(Object.isFrozen)).toBe(true);
```

`open/read`、`ENOSPC` 与清理失败通过 Vitest 模块 mock 在文件边界制造，不增加生产 fault seam。每个用例同时放置一张后续合法 v3 marker，并断言后续项确实调用带令牌回滚；不能只断言 `initialize()` 没有抛错。

- [ ] **Step 3：写所有权、竞态和清理 RED**

添加实际测试 `rolled-back 与 absent 完成 marker，ownership-mismatch 与 active-character 保留证据并 blocked`。实际测试 `marker 读取后被替换时不删除替代文件且后续项继续` 使用 `CharacterStore` 测试子类覆写 `rollbackImportedCharacter()`：该方法被调用时说明 marker 已完成读取和解析，此时替换 marker 路径，再返回 `{ kind: 'ownership-mismatch' }`。不得为此扩展 `onCheckpoint`、公开 I/O fault seam、句柄或物理身份接口。

- [ ] **Step 4：写活动优先、256 和 2000ms RED**

在现有 `CharacterPackageServiceDependencies` 增加私有调度所需的 `recoveryNow?: () => number`，与 B1 既有时钟模式一致；它只作为 Main 构造依赖中的时钟 seam，不进入 Renderer、Preload、IPC 或产品方法。添加实际测试：

- `活动角色 marker 先于稳定文件名顺序处理`
- `排序后第 257 项及以后保持不变、不读取、不返回 issue 且只记录一次聚合诊断`
- `达到 2000ms 软预算后只推迟未开始项`
- `单项开始后即使越过预算也完成身份复核与恢复`

数量测试只完整创建边界附近的 255、256、257 三类候选，不在 Store 或 E2E 重复 257 项矩阵。

- [ ] **Step 5：先同步改写或删除旧测试 owner**

在运行整组 RED 前，原位改写所有仍断言 v1 静默删除、v2 物理摘要回滚、普通 `store.delete()` 或整轮抛错的旧测试；无法表达新接口行为且只服务旧实现的 fixture/helper 直接删除。不得保留旧矩阵再叠加新矩阵，也不得在 GREEN 后才删除会与新规格冲突的旧测试。

```powershell
rg -n "package-import-rollback|preserveRollback|rollbackImportedCharacter|store\.delete|CHARACTER_PACKAGE_ROLLBACK_FAILED" apps/desktop/tests/character-package-service.test.ts
git diff -- apps/desktop/tests/character-package-service.test.ts
```

预期：检索到的 marker 样本中，v1/v2 只用于“隔离且不删除”的新断言；`delete` 只作为 `vi.spyOn(store, 'delete')` 的未调用证据；测试差异明确表现为替换旧测试而非只追加。

- [ ] **Step 6：运行 PackageService RED 并核对失败原因**

```powershell
pnpm.cmd --filter @myself/desktop test -- character-package-service.test.ts
```

预期：FAIL，失败来自生产代码仍是旧整轮恢复、旧 v1/v2 删除、普通 `store.delete()`、布尔结果或 `initialize(): Promise<void>`；已经改写的新规格测试必须失败，ZIP 导入、导出和 source 校验旧测试仍应保持通过。

- [ ] **Step 7：实现 v3 Schema、inventory 与有界读取**

在 `character-package-service.ts` 内增加 `.strict()` 的 v3 Zod Schema、`MAX_IMPORT_RECOVERY_ENTRIES = 256`、`IMPORT_RECOVERY_BUDGET_MS = 2_000`、`MAX_IMPORT_MARKER_BYTES = 4_096`。候选只接收角色根直属、严格以 `.package-import-rollback-<characterId>.json` 命名的普通目录项；显式排除 `.tmp`、`.corrupt-*` 和 `.complete-*` 证据。候选先把活动角色正式 marker 排首位，其余按文件名稳定排序，再截取活动项加最多其余 255 项；第 257 项及以后保持不变，不读取、不生成 issue 或逐项日志，只记录一次 `CHARACTER_IMPORT_RECOVERY_LIMIT_REACHED`。

marker 必须通过 `open('r')` 后的句柄 `stat()` 验证普通文件，读取至多 `MAX_IMPORT_MARKER_BYTES + 1`，记录 `dev/ino/size` 并在隔离、回滚和清理前后复核。超限、链接、Junction、路径越界或身份变化统一 fail closed。

- [ ] **Step 8：实现逐项恢复、隔离与最小报告**

`recoverPendingRollbacks()` 原位改为返回 `CharacterPackageRecoveryReport`。每个 inventory 项独立捕获错误；v3 只调用 `rollbackImportedCharacter(characterId, importTransactionId)`：

```ts
switch (result.kind) {
  case 'rolled-back':
  case 'absent':
    await this.completeOwnedMarker(marker, originalIdentity);
    return null;
  case 'ownership-mismatch':
  case 'active-character':
    await this.preserveMarkerEvidence(marker, originalBytes, originalIdentity);
    return {
      characterId,
      errorCode: 'CHARACTER_IMPORT_RECOVERY_BLOCKED'
    } as const;
}
```

legacy、坏 JSON 和未知版本只调用同文件内的私有证据保留逻辑；证据正文通过 `atomicWriteFileExclusive()` 原样发布，随后复核原 marker 仍为读取时同一普通文件才移除。`.complete-*` 永不进入 inventory；单独清理失败时只在 hard link 排他恢复正式名成功后允许正式 marker 下次重试，清理与恢复正式名双故障则保留不可执行原字节证据、记录一次 `CHARACTER_IMPORT_RECOVERY_DETACHED_EVIDENCE`，且不生成角色 issue。不可归属正式候选只在 Main 内记录 `CHARACTER_IMPORT_RECOVERY_UNATTRIBUTED`，扫描失败只记录 `CHARACTER_IMPORT_RECOVERY_SCAN_FAILED`，日志不拼接路径、文件名或正文。最终 issue 按角色 ID 稳定排序并按 blocked 高于 deferred 去重，使用 `Object.freeze()` 冻结每个 issue、issues 数组和 report 后一次性返回；deferred 只来自已入 inventory 但因 2000ms 预算尚未开始的项。

- [ ] **Step 9：把正常导入失败改为同一安全回滚**

`writePendingImport()` 继续作为 `CharacterPackageService` 私有方法，但正文固定为 v3 并调用 `atomicWriteFileExclusive()`。如果目标 marker 已存在或本轮恢复报告已把该目标判为 blocked，当前导入立即以稳定 `CHARACTER_PACKAGE_ROLLBACK_FAILED` 结束；不得把 marker 冲突解释成角色 ID 冲突并调用 `createId()` 换号重试。

导入 catch 在已取得 `createdId + importTransactionId` 时只调用 `rollbackImportedCharacter()`；`rolled-back|absent` 才按身份复核完成 marker，`ownership-mismatch|active-character` 或异常均保留 v3 marker 并抛稳定 `CHARACTER_PACKAGE_ROLLBACK_FAILED`。正常完成仍要求 `completeImportedCharacter()` 返回 `true` 后才清理本次 marker 和返回角色 ID。

- [ ] **Step 10：运行 GREEN 与相邻回归**

```powershell
pnpm.cmd --filter @myself/desktop test -- atomic-file-coordinator.test.ts character-store.test.ts character-package-service.test.ts
pnpm.cmd --filter @myself/desktop typecheck
```

预期：全部 PASS；PackageService 已开始按 Task 2 的 `kind` 判别结果处理 marker。

- [ ] **Step 11：删除旧生产 owner 与旧回退**

只在 Step 10 通过后删除生产代码中的 v1 静默删除、v2 物理摘要恢复/回写、`CharacterOwnership`、package rollback 专用 `captureCharacterOwnership()`/`sameCharacterOwnership()`/SHA-256 摘要、`preserveRollback()` 和导入 catch 中普通 `store.delete()`。旧测试 owner 已在 Step 5 与 RED 同步替换，不得拖到此处再删。若同名哈希或身份 helper 仍被 ZIP 导出安全使用，只删除 package rollback 专用分支，不动真实消费者。

- [ ] **Step 12：执行删除门与差异审查**

```powershell
rg -n "CharacterImportJournal|character-import-journal|version:\s*4" apps/desktop/src/main/characters/character-package-service.ts
Test-Path apps/desktop/src/main/characters/character-import-journal.ts
rg -n "CharacterOwnership|captureCharacterOwnership|sameCharacterOwnership|preserveRollback" apps/desktop/src/main/characters/character-package-service.ts
rg -n "store\.delete\(" apps/desktop/src/main/characters/character-package-service.ts
rg -n "version:\s*[12].*ownership|document\.version === [12]" apps/desktop/src/main/characters/character-package-service.ts
pnpm.cmd --filter @myself/desktop test -- atomic-file-coordinator.test.ts character-store.test.ts character-package-service.test.ts
pnpm.cmd --filter @myself/desktop typecheck
git diff --check
git diff --stat
```

预期：第一、第三、第四、第五条零命中，`Test-Path` 返回 `False`，删除后的定向测试与 typecheck PASS；测试中允许保留 `version: 4` 作为未知版本拒绝样本。生产 owner 数仍为 1；差异报告分别记录生产代码与测试的新增、删除和净值。若生产代码只增不减，本任务不得过审，必须先核对旧路径是否真正删除。

- [ ] **Step 13：新鲜审查并提交**

由未实现本任务的规格审查者逐条对照 B2 规格第 5—11 节，再由另一名代码质量审查者检查竞态、日志脱敏、测试分层和净删除；Critical/Important 全部修复并重跑 Step 10、Step 12 后提交：

```powershell
git add apps/desktop/src/main/characters/character-package-service.ts apps/desktop/tests/character-package-service.test.ts
git commit -m "feat(desktop): 原位收敛角色包导入恢复"
```

---

### Task 4：建立纵向启动证据并完成 B2 验收

**文件：**

- 修改：`tests/e2e/desktop.spec.ts`
- 修改：`docs/operations/character-workshop-acceptance.md`
- 只读核对：`apps/desktop/src/main/index.ts`
- 只读核对：`apps/desktop/src/main/characters/character-startup.ts`

**接口：**

- 消费：Task 3 的 `CharacterPackageService.initialize(): Promise<CharacterPackageRecoveryReport>`；B2 阶段 Main 可以继续 `await` 并忽略返回值，B3 再把同一不可变报告汇入启动快照。
- 产出：一个真实 Electron 场景，证明坏 marker 不阻断健康 v3 恢复、基础桌宠和普通聊天。
- 禁止：本任务不得提前实现 B3 DTO、IPC、Pet/Workshop 提示、`startupRecoveryErrorCode` 替换或新的 Actions getter。

- [ ] **Step 1：写唯一 Electron 纵向 RED 场景**

在 `desktop.spec.ts` 添加实际测试名 `角色包恢复一坏一好时继续启动桌宠与普通聊天`。使用现有 `prepareUserData` 和 `CharacterStore` 正式接口准备：一个含合法 owner token 的半安装角色及对应合法 v3 marker、一个可归属的半截 marker、一个健康活动角色。启动后断言：

```ts
await expect(pet.locator('.character-player'))
  .toHaveAttribute('data-status', 'ready');
await expect(access(validImportedCharacterDirectory)).rejects.toThrow();
expect(await readFile(brokenEvidenceFile)).toEqual(brokenMarkerBytes);
await submitChatMessage(chat, '角色包恢复后继续普通聊天');
await expect(chat.getByText('请先完成模型服务设置。')).toBeVisible();
```

该场景不得读取新的恢复 IPC，不重复 256/2000ms、legacy、权限或全部 Store 结果矩阵。

- [ ] **Step 2：运行定向 E2E RED**

```powershell
pnpm.cmd --filter @myself/desktop build
pnpm.cmd exec playwright test --config tests/playwright.config.ts -g "角色包恢复一坏一好时继续启动桌宠与普通聊天"
```

预期：在 Task 3 尚未通过时 FAIL 于坏 marker 阻断启动；Task 3 已通过时该步骤直接成为回归基线，必须记录为“先验已绿”，不得伪造 RED。

- [ ] **Step 3：纵向失败时退回 Task 3 独立修复闭环**

若失败暴露 Task 3 实现缺口，立即暂停 Task 4：先在 `character-package-service.test.ts` 写最小失败复现，再只修改 Task 3 已有 `CharacterPackageService` 路径；重跑 Task 3 定向测试与删除门，交给未参与修复的新鲜审查者复审，并以独立 `fix(desktop): ...` 提交完成修复。然后重新开始 Task 4 的定向 E2E。不得把任何产品代码或 PackageService 单元测试混入 Task 4 的验收提交，也不得为 E2E 增加产品探针、恢复 IPC、第二个状态 owner 或测试专用 Journal。每个失败点最多诊断 15 分钟，超时后拆分到更小的 PackageService 定向复现。

- [ ] **Step 4：运行纵向 GREEN 与完整桌面门禁**

按从小到大的顺序执行，每条命令独立计时：

```powershell
pnpm.cmd --filter @myself/desktop test -- atomic-file-coordinator.test.ts character-store.test.ts character-package-service.test.ts
pnpm.cmd --filter @myself/desktop typecheck
pnpm.cmd test:security
pnpm.cmd test:integration
pnpm.cmd verify:characters
pnpm.cmd verify:desktop
```

预期：全部 PASS。若完整门禁只有与本次变更无关的已知波动，保留失败命令、精确场景和一次定向复现证据，交由审查者按事实裁决；不得写成已通过，也不得无限重跑。

- [ ] **Step 5：核对旧路径、保护路径和文档范围**

```powershell
rg -n "CharacterImportJournal|character-import-journal|version:\s*4" apps/desktop/src/main/characters/character-package-service.ts
Test-Path apps/desktop/src/main/characters/character-import-journal.ts
rg -n "CharacterOwnership|captureCharacterOwnership|sameCharacterOwnership|preserveRollback" apps/desktop/src/main/characters/character-package-service.ts
rg -n "store\.delete\(" apps/desktop/src/main/characters/character-package-service.ts
$b2PlanCommit = git log -1 --format=%H -- docs/superpowers/plans/2026-08-15-character-import-journal.md
git diff --name-only "$b2PlanCommit" -- apps/website apps/cloudbase-api apps/package-scanner tests/e2e/website.spec.ts
git diff --check
```

预期：第一、第三、第四条零命中，`Test-Path` 返回 `False`；测试中允许保留未知 v4 拒绝样本。保护路径命令同时覆盖已提交和未提交工作树差异，网站/CloudBase/Scanner 路径零差异，格式检查通过。另用只读差异确认 `character-store.ts` 中 owner 文件、活动角色保护和移动前后身份复核仍在。

- [ ] **Step 6：更新现有验收记录**

在 `character-workshop-acceptance.md` 的 B2 小节记录日期、Windows 环境、每条实际命令、退出码、测试数量、耗时、生产/测试净行数与未覆盖项。明确区分：`.complete-*` 永不执行；清理与正式名恢复双故障只留不可执行证据和固定诊断；第 257 项及以后没有逐项 issue/log；deferred 只由 2000ms 预算产生。真实断电、强制终止、非恶意外部程序竞态和窗口提示可读性没有人工证据时必须写“待用户人工确认”；同用户恶意进程不在本阶段威胁模型内，不得写成待验收承诺。

- [ ] **Step 7：最终新鲜双审查**

规格审查者核对：v3 唯一 owner、无 token 不删除、逐项隔离、预算、最小报告、B3 边界和网站零触碰。代码质量审查者核对：没有浅模块、公开 fault seam、重复矩阵、敏感日志或只增不减。Critical/Important 全部修复并重跑受影响的 Step 4 命令；Minor 必须明确裁决，不静默遗留。

- [ ] **Step 8：提交纵向验收**

```powershell
git add tests/e2e/desktop.spec.ts docs/operations/character-workshop-acceptance.md
git commit -m "test(desktop): 验收角色包导入恢复"
```

提交后使用 `git status --short` 确认没有遗漏属于 B2 的改动；随后才能把 `CharacterPackageRecoveryReport` 交给 B3 计划消费。
