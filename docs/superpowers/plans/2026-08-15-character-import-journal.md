# AI Pet 角色包导入 Journal 实施计划

> **面向智能代理执行者：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`，逐任务实施本计划。所有步骤使用复选框跟踪。

**目标：** 实现 B2 独立 `CharacterImportJournal`，以 Windows 可验证的 exclusive 原子发布和逐 marker 隔离替换 PackageService 内旧 marker 路径。

**架构：** 通用文件协调器只提供 exclusive 文件原语；ImportJournal 独立拥有 import marker schema、恢复与证据隔离；PackageService 继续拥有 ZIP、source、Store publish 和外层 saga；Store 继续拥有 owner 文件及物理身份验证。

**技术栈：** Electron 43、TypeScript、Node.js `fs/promises`、Zod、Vitest、Windows NTFS 测试。

**设计规格：** [角色包导入 Journal 设计](../specs/2026-08-15-character-import-journal-design.md)

## 全局约束

- 不合并 Store draft/publish journal 与 Package import journal。
- 活动角色相关 marker 优先；最多 256 个索引角色；2000ms 软预算只在角色之间检查。
- 最终 publish 禁止普通 rename、copy 或直接流式写 final；不支持 hard link 时 fail closed。
- 删除角色目录前必须同时证明 character ID、owner token 和物理身份。
- Git 暂存和提交仅在用户另行明确授权后执行。

## 文件结构

- 修改 `apps/desktop/src/main/storage/atomic-file-coordinator.ts`：exclusive 写入与证据发布原语。
- 新增 `apps/desktop/tests/atomic-file-coordinator.test.ts`：Windows 真实并发测试。
- 新增 `apps/desktop/src/main/characters/character-import-journal.ts`：独立 import journal。
- 新增 `apps/desktop/tests/character-import-journal.test.ts`：journal 失败矩阵。
- 修改 `character-store.ts`/`character-store.test.ts`：细化 import rollback/complete 结果。
- 修改 `character-package-service.ts`/对应测试：接入 journal、删除旧路径。
- 修改 `apps/desktop/src/main/index.ts`：接收恢复报告而非让单 marker 终止启动。

---

### Task 1：实现并验证 Windows exclusive 原语

**文件：**

- 修改：`apps/desktop/src/main/storage/atomic-file-coordinator.ts`
- 新增：`apps/desktop/tests/atomic-file-coordinator.test.ts`

**接口：**

- 产出：`atomicWriteTextExclusive(file: string, content: string): Promise<void>`。
- 产出：内部 `publishExistingFileExclusive(source: string, destination: string): Promise<void>`，仅供同目录证据隔离。
- 保留：现有 `atomicWriteText()` replacement 语义不变。

- [ ] **步骤 1：写真实 Windows 并发 RED 测试**

在实际 `mkdtemp()` 目录并发发起 32 次不同正文写入。断言恰好一个 fulfilled、31 个因目标存在失败、最终正文完整等于 winner，且不存在可见半截 final。

- [ ] **步骤 2：写已有目标和 fault RED 测试**

预置 final 后断言字节不变；分别在 open/write/sync/link 注入失败，断言 link 前 final 不存在、临时文件可清理、不报告成功。验证不支持 hard link/跨卷错误不调用 rename/copy fallback。

- [ ] **步骤 3：运行 RED**

```powershell
pnpm.cmd --filter @myself/desktop test -- atomic-file-coordinator.test.ts
```

预期：FAIL，新函数不存在。

- [ ] **步骤 4：实现 temp、flush、hard-link publish**

固定顺序：同目录 UUID temp、`open('wx', 0o600)`、write、`handle.sync()`、close、`link(temp, final)`、finally 清理 temp。保留原生 `EEXIST` 语义，不添加 rename/copy fallback。

- [ ] **步骤 5：运行真实 Windows GREEN**

```powershell
pnpm.cmd --filter @myself/desktop test -- atomic-file-coordinator.test.ts
```

预期：Windows 实际文件系统用例 PASS；若 hard link 不可用则明确 FAIL，不得跳过后宣称语义已验证。

- [ ] **步骤 6：在获得 Git 授权后提交本任务**

未获授权不执行 Git 写操作。

---

### Task 2：建立独立 ImportJournal 与失败隔离

**文件：**

- 新增：`apps/desktop/src/main/characters/character-import-journal.ts`
- 新增：`apps/desktop/tests/character-import-journal.test.ts`

**接口：**

- 产出：规格定义的 record、entry result、recovery report。
- 产出：`create(record)`、`complete(record)`、`recoverAll()`。
- 消费：Task 1 的 exclusive writer/证据 publish。
- 依赖端口：`rollbackImportedCharacter(characterId, importTransactionId)` 返回判别联合。

- [ ] **步骤 1：写 durable 创建 RED 矩阵**

在 `journal:open`、`journal:write`、`journal:flush`、`journal:publish` checkpoint 注入中断。断言 publish 前 final 不存在，publish 后 final 是完整 v4 JSON；已有 final 不覆盖。

- [ ] **步骤 2：写损坏与隔离 RED 矩阵**

分别放入空文件、半截 JSON、未知 version、合法 marker。断言坏 marker 各自隔离、evidence 字节逐字节相同、合法 marker 仍恢复。增加 evidence 名冲突、权限、磁盘满：失败项保留原 marker、返回 blocked、后续项继续。

- [ ] **步骤 3：写所有权 RED 矩阵**

对 `rolled-back`、`absent`、`ownership-mismatch`、`active-character` 逐项断言：前两者可完成 marker；后两者不得删除 marker 或目录并返回 blocked。v1/v2 legacy 只能隔离，不能触发 rollback。

- [ ] **步骤 4：写预算 RED 测试**

活动角色 marker 首先处理；第 257 个角色或角色间时钟超过 2000ms 后，剩余 marker 不打开、不修改并报告 deferred。单 marker 开始后必须完成其读、验证和恢复，不被时钟中断。

- [ ] **步骤 5：运行 RED**

```powershell
pnpm.cmd --filter @myself/desktop test -- character-import-journal.test.ts
```

预期：FAIL，模块不存在。

- [ ] **步骤 6：实现最小 journal**

以 Zod 严格解析 v4；每个 marker 独立 `try/catch`。通过打开句柄读取原字节并记录物理身份；evidence hard-link 成功且身份复核一致后才 unlink 原 marker。隔离失败保留原文件并返回 blocked。

- [ ] **步骤 7：运行 GREEN**

```powershell
pnpm.cmd --filter @myself/desktop test -- atomic-file-coordinator.test.ts character-import-journal.test.ts
```

预期：PASS。

- [ ] **步骤 8：在获得 Git 授权后提交本任务**

未获授权不执行 Git 写操作。

---

### Task 3：细化 Store import 所有权结果

**文件：**

- 修改：`apps/desktop/src/main/characters/character-store.ts`
- 修改：`apps/desktop/tests/character-store.test.ts`

**接口：**

- 产出：`rollbackImportedCharacter()` 返回 `rolled-back|absent|ownership-mismatch|active-character`。
- 产出：`completeImportedCharacter()` 返回 `completed|owner-missing|ownership-mismatch`。
- 保留：owner 文件、rename 前后目录/owner `dev/ino` 复核。

- [ ] **步骤 1：写判别结果 RED 测试**

分别构造不存在、token 不匹配、活动角色、rename checkpoint 身份替换和正常回滚；断言准确 kind，且除正常回滚外均不删陌生目录。complete 对 owner 缺失/不匹配不得返回 completed。

- [ ] **步骤 2：运行 RED**

```powershell
pnpm.cmd --filter @myself/desktop test -- character-store.test.ts
```

预期：FAIL，当前接口只返回 boolean。

- [ ] **步骤 3：最小替换返回类型并运行 GREEN**

保留现有验证顺序，仅在每个现有 return 点返回对应判别对象；不改 Store draft/publish journal。

```powershell
pnpm.cmd --filter @myself/desktop test -- character-store.test.ts
```

预期：PASS。

- [ ] **步骤 4：在获得 Git 授权后提交本任务**

未获授权不执行 Git 写操作。

---

### Task 4：PackageService 接入 journal 并删除旧 marker owner

**文件：**

- 修改：`apps/desktop/src/main/characters/character-package-service.ts`
- 修改：`apps/desktop/tests/character-package-service.test.ts`
- 修改：`apps/desktop/src/main/index.ts`

**接口：**

- 消费：Task 2 的 `CharacterImportJournal` 与 Task 3 的判别结果。
- 产出：`CharacterPackageService.initialize(): Promise<CharacterImportJournalRecoveryReport>`。
- 保留：ZIP 校验、source 安装、draft save、Store publish、外层 import saga。

- [ ] **步骤 1：写导入顺序与中断 RED 测试**

记录 journal create、Store create/owner、source、draft、Store publish、owner complete、journal complete 的调用顺序。分别在 owner/source/Store publish 后中断，重建 Service 后断言 journal 按 token、ID、物理身份恢复。

- [ ] **步骤 2：写不误报成功 RED 测试**

让 Store complete 返回 owner-missing/ownership-mismatch，断言 import 不返回 character ID、journal 不完成、无成功事件。让 rollback 返回 mismatch，断言不调用通用 `store.delete()`。

- [ ] **步骤 3：写启动隔离 RED 测试**

一个坏 marker 与一个合法 marker 并存，断言 `initialize()` 返回两个独立结果且不抛全局异常。Main 收到 quarantined/blocked report 后继续调用角色启动和聊天初始化。

- [ ] **步骤 4：运行 RED**

```powershell
pnpm.cmd --filter @myself/desktop test -- character-package-service.test.ts
```

预期：FAIL，Service 仍直接拥有 marker。

- [ ] **步骤 5：最小接入独立 journal**

严格按批准顺序编排 saga；只有 owner complete 为 completed 后才 complete journal 和返回 ID。`initialize()` 直接返回 report，Main 保存报告供 B3 使用但不让单 marker 退出应用。

- [ ] **步骤 6：删除旧路径**

在新测试通过后删除 PackageService 内 marker schemas、regexp、直接 marker IO、`writePendingImport()`、`recoverPendingRollbacks()`、`preserveRollback()`，以及 v1 静默删除/v2 无 token 删除分支。不得删除 Store owner 文件或物理身份验证。

- [ ] **步骤 7：运行 B2 定向与阶段门禁**

```powershell
pnpm.cmd --filter @myself/desktop test -- atomic-file-coordinator.test.ts character-import-journal.test.ts character-store.test.ts character-package-service.test.ts
pnpm.cmd --filter @myself/desktop typecheck
pnpm.cmd --filter @myself/desktop test
pnpm.cmd test:security
pnpm.cmd test:integration
```

预期：全部 PASS。

- [ ] **步骤 8：在获得 Git 授权后提交本任务**

未获授权不执行 Git 写操作。
