# B2/B3 第二轮测试表达减法实施计划

> **供智能体执行：** 必须使用 `subagent-driven-development`（推荐）或 `executing-plans`，逐任务执行、独立复审并提交。所有步骤使用复选框跟踪。

**目标：** 在不删除任何唯一行为、安全或跨进程证据的前提下，再删除一轮 B2/B3 测试中的重复守卫、重复装配和重复 Schema 样例，预计净减 150–165 行。

**架构：** 只深化四个既有文件内 owner：Electron fixture loader、启动依赖 factory、共享恢复 Schema 矩阵和证据读取 helper。失败语义、业务场景和原字节断言继续留在原测试中；不新增生产 seam、共享测试框架或万能 DSL。

**技术栈：** TypeScript、Vitest、Playwright、Electron、pnpm、Windows PowerShell。

## 全局约束

- 代码实施基线固定为 `b16d542`；测试与 E2E 减法总基线仍为 `c7d951d`。计划文件和验收补证可以位于其后的纯文档提交；实施开始前必须确认 `git diff --name-only b16d542..HEAD -- apps/desktop tests/e2e` 只包含本计划已经完成的任务文件，不把别的代码任务混入本轮。
- 当前相对 `c7d951d` 的 `apps/desktop/tests` 与 `tests/e2e` 实测为新增 1,958 行、删除 1,135 行、净增 823 行。本轮 150–165 行是观察目标，不是删除唯一 owner 的理由；预计完成后仍净增约 658–673 行，必须按实测值登记为唯一 owner 债务，不得写成归零或总门通过。
- 严格执行“能不加就不加，能减则减”：优先删除重复表达；若某项必须靠新增浅 helper 才能减行，则不做该项。
- 不修改 `apps/website`、`apps/cloudbase-api`、`apps/package-scanner`、`cloudbase`、网站 E2E 或网站配置；不新增依赖、生产能力、生产公开接口、磁盘格式或第二条运行路径。
- 禁止删除唯一 owner：完整共享 Schema 矩阵、Main/Preload 双边界、启动顺序与最终 load 重试、证据原字节、证据发布失败、两条角色恢复 Electron 重启场景及其余现有业务场景全部保留。
- 只允许本计划明确列出的四类测试表达减法；不顺手整理相邻代码，不新建共享测试工具，不建立万能 DSL，不新增生产 fault seam。
- mutation 必须可恢复：先记录生产文件 diff，做最小临时改动并看到指定测试因正确原因 RED，立即反向 `apply_patch` 恢复，再确认生产 diff 零残留。不得用 `git checkout`、`reset` 或提高 timeout 恢复现场。
- 单点或单命令 15 分钟硬停；失败只做一次精确定向复现。超时后记录证据并换方案或收窄范围，不反复重跑掩盖问题。
- 每任务记录修改前后 `git diff --numstat`；任务范围必须净减且测试数量、标题或场景 owner 不意外减少。每任务由新鲜独立审查者核对规格与质量，Critical/Important 清零后才提交。
- Git 写操作已获用户授权；每个提交只包含该任务文件，不 push、不 merge、不 rebase、不 reset。

## 文件职责与修改边界

| 文件 | 本轮职责 | 允许的修改 |
| --- | --- | --- |
| `tests/e2e/desktop.spec.ts` | Desktop E2E 与 Electron fixture 消费者 | 深化 loader，收敛 58 个调用点中的 57 组 nullable 断言/guard 和 1 个 `beforeAll` 的 nullable throw |
| `apps/desktop/tests/character-startup.test.ts` | 启动恢复行为 owner | 让 `start()` 复用既有 `recordingDependencies()` |
| `apps/desktop/tests/character-ipc.test.ts` | Main IPC 与共享恢复 Schema owner | 删除恢复专用 case 中已被通用空输入矩阵覆盖的非法输入断言 |
| `apps/desktop/tests/preload-api.test.ts` | Preload 二次 Schema 边界 owner | 非法 Main 返回矩阵只保留一个代表样例 |
| `apps/desktop/tests/character-package-service.test.ts` | 包恢复与证据字节 owner | 复用既有 `preservedEvidence()` 读取两个 corrupt 证据 |
| `docs/operations/character-workshop-acceptance.md` | 实测验收记录 | 记录命令、结果、净值、mutation 与未达门 |
| `docs/superpowers/specs/2026-08-20-desktop-code-subtraction-design.md` | 减法状态账本 | 只更新本轮实测和剩余唯一 owner 债务，不改变安全门 |

---

### Task 1：深化 Electron fixture loader 并收敛 58 个调用点

**文件：**
- 修改：`tests/e2e/desktop.spec.ts`

**接口：**
- `loadElectronFixtureModule(): Promise<ElectronFixtureModule>` 成为 fixture 模块装载的唯一 owner。
- 所有调用者直接获得非空模块；动态 import 失败沿原异常抛出，不再把基础设施错误伪装成 `null` 后早退。
- 业务级 `fixture.dispose()`、诊断订阅、重启状态和场景自身 cleanup 不属于删除范围。
- 审计基数是 58 个调用点：普通场景有 57 组 nullable 断言/guard，`角色恢复` 的 `beforeAll` 另有 1 个 `if (!loaded) throw`。不得把“58 个调用点”误写为 58 组可删除 guard。
- `if (!fixture.restart) return` 检查的是可选业务能力，不检查 loader nullability，必须原样保留。

- [ ] **Step 1：取得守卫清单与 characterization GREEN**

  ```powershell
  rg -n "loadElectronFixtureModule|not\.toBeNull|createElectronAppFixture\)\.toBe|if \(!(?:fixture|fixtureModule|loaded)|if \(!(?:fixture|fixtureModule|loaded)\?\.createElectronAppFixture" tests/e2e/desktop.spec.ts
  rg -n "if \(!fixture\.restart\)|fixture\.restart" tests/e2e/desktop.spec.ts
  pnpm.cmd --filter @myself/desktop build
  pnpm.cmd exec playwright test --list --config tests/playwright.config.ts
  pnpm.cmd exec playwright test --config tests/playwright.config.ts
  ```

  预期：除函数定义外恰有 58 个 loader 调用点；57 组普通 nullable `expect`/guard 与 1 个 `beforeAll` nullable throw 可逐项对应。完整 Desktop E2E 与清单均 GREEN。若某个 guard 还保护业务资源而非 module nullability，标为唯一 owner 并禁止删除；单独记录现有 `if (!fixture.restart) return` 的行号，供完成门复核。

- [ ] **Step 2：先把八个 Provider 场景改为 loader-first**

  下列八个场景当前先启动 Provider、后加载 fixture，nullable guard 内还承担 `provider.close()`：

  1. “聊天阶段、情绪、错误降级与角色切换保持 Main 到 Renderer 闭环”；
  2. “默认聊天与设置浮层提示”；
  3. “无授权范围时连续三轮普通聊天并把完整可见回合传入第三轮”；
  4. “模糊请求按默认聊天回复且明确文件请求在无授权时只引导设置”；
  5. “Chat 与 Agent 跨 Provider 时两种披露决定均继续且单次共享不会复用”（`sourceProvider` 与 `targetProvider` 两个 Provider 都必须后移）；
  6. “模型响应挂起时新建对话会隔离迟到回复并允许新会话继续”；
  7. “文件动作待确认时新建对话会使旧确认失效且不改文件”；
  8. “回收站搬运闭环只在提交帧后写入隔离适配器并安全处理中断与失败”。

  在仍保留 nullable loader 实现和原 guard 的阶段，逐场景把：

  ```ts
  const fixtureModule = await loadElectronFixtureModule();
  ```

  移到该场景第一次 `startProviderServer(...)` 之前；双 Provider 场景必须位于两次启动之前。只移动 loader 调用，不新建 `try/finally` helper 或 cleanup DSL，不改变场景结束时已有的 `provider.close()`。

  静态列出顺序并逐项人工核对：

  ```powershell
  rg -n "loadElectronFixtureModule|startProviderServer" tests/e2e/desktop.spec.ts
  ```

  完成门：上述八个场景中，loader 的行号都小于本场景任意 `startProviderServer` 行号；没有场景为了 loader 失败而先启动 Provider。通过后才进入 Step 3。

- [ ] **Step 3：先实现非空 loader，再删除 nullable 表达**

  将 loader 收敛为以下非空接口，不增加 wrapper：

  ```ts
  async function loadElectronFixtureModule(): Promise<ElectronFixtureModule> {
    const moduleUrl = pathToFileURL(
      resolve(process.cwd(), 'tests/fixtures/electron-app.ts')
    ).href;
    return await import(moduleUrl) as ElectronFixtureModule;
  }
  ```

  确认该实现已落盘后，才机械删除 57 组只验证 module 存在的 nullable 断言/guard，并把 `const loaded = ...; if (!loaded) throw ...; fixtureModule = loaded` 收敛为直接赋值。八个 Provider 场景中 guard 内旧的 `provider.close()` 随 nullable guard 一并消失，因为此时 Provider 尚未启动且 loader 已直接抛错；场景结束时原有 cleanup 不动。

  不得合并测试标题、删除场景、改 timeout、添加 retry，或删除业务对象自己的 dispose/cleanup。特别保留：

  ```ts
  if (!fixture.restart) return;
  ```

- [ ] **Step 4：在非空实现上做模块路径 mutation**

  临时把 loader 中的固定路径：

  ```ts
  resolve(process.cwd(), 'tests/fixtures/electron-app.ts')
  ```

  改为：

  ```ts
  resolve(process.cwd(), 'tests/fixtures/electron-app-does-not-exist.ts')
  ```

  运行：

  ```powershell
  pnpm.cmd exec playwright test --config tests/playwright.config.ts --grep "使用项目精确 Electron 路径"
  ```

  预期：RED，错误含 `ERR_MODULE_NOT_FOUND` 或明确的“无法导入 `electron-app-does-not-exist.ts`”信息，证明非空 loader 直接抛出，而不是返回 `null` 后静默 return。立即反向 `apply_patch` 恢复原路径，并用 `git diff -- tests/e2e/desktop.spec.ts` 确认只剩计划内测试重构。

- [ ] **Step 5：恢复后运行完整验证**

  ```powershell
  pnpm.cmd --filter @myself/desktop build
  pnpm.cmd exec playwright test --config tests/playwright.config.ts
  pnpm.cmd exec playwright test --list --config tests/playwright.config.ts
  git diff --numstat HEAD -- tests/e2e/desktop.spec.ts
  git diff --check
  ```

  再做一次静态与人工顺序核对：

  ```powershell
  rg -n "loadElectronFixtureModule|startProviderServer|if \(!fixture\.restart\)" tests/e2e/desktop.spec.ts
  ```

  完成门：Desktop E2E 场景数和标题清单不变；非空 loader 上的路径 mutation 曾因 `ERR_MODULE_NOT_FOUND` 或等价缺失模块错误 RED；最终完整 E2E GREEN；当前工作树相对 `HEAD` 的文件净减；57 组 nullable guard 与 1 个 `beforeAll` nullable throw 已删除；`if (!fixture.restart) return` 保留；上述八个场景均不存在本场景 `startProviderServer` 先于 loader；独立审查确认没有删除业务 cleanup 且 Critical/Important 为零。

- [ ] **Step 6：提交本任务**

  ```powershell
  git add tests/e2e/desktop.spec.ts
  git commit -m "test(e2e): 深化 Electron fixture 装载"
  ```

---

### Task 2：让启动测试入口复用 recordingDependencies

**文件：**
- 修改：`apps/desktop/tests/character-startup.test.ts`

**接口：**
- 继续保留 `recordingDependencies(order, overrides?): CharacterStartupDependencies`，它仍是四个依赖 double 的唯一 owner。
- `start(overrides?, startupInputValue?)` 只把无顺序检查的调用委托给 `recordingDependencies([], overrides)`；不改签名、不隐藏断言、不增加第三个 helper。

- [ ] **Step 1：取得 characterization GREEN 并确认所有场景标题**

  ```powershell
  pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/character-startup.test.ts
  rg -n "test(?:\.each)?\(" apps/desktop/tests/character-startup.test.ts
  ```

  预期：全部启动恢复场景 GREEN，尤其“最后 Store load 瞬时失败时先完成 fallback 再重读一次”存在且通过。

- [ ] **Step 2：mutation 验证最终 load 的第二次读取是强 owner**

  仅临时把 `prepareCharacterStartup()` catch 分支中的第二次：

  ```ts
  await dependencies.loadFinalIndex();
  ```

  替换成：

  ```ts
  await Promise.resolve();
  ```

  首次读取保持不变。运行：

  ```powershell
  pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/character-startup.test.ts -t "最后 Store load 瞬时失败"
  ```

  预期：因顺序缺少第二个 `final-index` 而 RED。立即反向 `apply_patch` 恢复，并确认：

  ```powershell
  git diff -- apps/desktop/src/main/characters/character-startup.ts
  ```

  输出为空。

- [ ] **Step 3：删除 start() 内的第二套依赖装配**

  保持现有签名，只将函数体收敛为：

  ```ts
  function start(
    overrides: Partial<CharacterStartupDependencies> = {},
    startupInputValue: StartupInput = EMPTY_INPUT
  ) {
    return prepareCharacterStartup(
      startupInputValue,
      recordingDependencies([], overrides)
    );
  }
  ```

  不移动任何 case，不删除启动顺序、白名单 fallback、瞬时/持续 load 失败、默认角色失败或深冻结断言。

- [ ] **Step 4：验证、独立审查与提交**

  ```powershell
  pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/character-startup.test.ts
  pnpm.cmd --filter @myself/desktop typecheck
  git diff --numstat HEAD -- apps/desktop/tests/character-startup.test.ts
  git diff --check
  ```

  完成门：测试标题和所有场景不变；mutation RED 和恢复后 GREEN 均有记录；文件净减；独立审查 Critical/Important 为零。

  ```powershell
  git add apps/desktop/tests/character-startup.test.ts
  git commit -m "test(desktop): 复用启动依赖装配"
  ```

---

### Task 3：删除 Main 与 Preload 的重复恢复 Schema 样例

**文件：**
- 修改：`apps/desktop/tests/character-ipc.test.ts`
- 修改：`apps/desktop/tests/preload-api.test.ts`

**接口：**
- `character-ipc.test.ts` 顶部合法值与五项非法值继续作为 `characterRecoverySnapshotResultSchema` 完整矩阵的唯一 owner。
- Main 的通用“所有 channel 拒绝多余 payload 字段”矩阵继续覆盖 `characterRecoverySnapshotGet`；恢复专用返回值测试不再重复 `{ path: 'C:\\private' }` 非法输入。
- Preload 仍用一个非法 Main 返回值证明二次 Schema 解析；删除第二个同义非法值，不改变固定 channel 断言。

- [ ] **Step 1：取得两文件 characterization GREEN 与 owner 清单**

  ```powershell
  pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/character-ipc.test.ts tests/preload-api.test.ts
  rg -n "恢复快照|characterRecoverySnapshotGet|characterRecoverySnapshotResultSchema" apps/desktop/tests/character-ipc.test.ts apps/desktop/tests/preload-api.test.ts
  ```

- [ ] **Step 2：Main mutation 证明通用非法输入矩阵会 RED**

  临时删除 `register-ipc.ts` 的恢复 handler 中这一行：

  ```ts
  parseCharacterInput(characterEmptyInputSchema, raw);
  ```

  运行：

  ```powershell
  pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/character-ipc.test.ts -t "characterRecoverySnapshotGet 拒绝多余 payload 字段"
  ```

  预期：通用矩阵中的 Main case RED。立即恢复该行，并确认 `git diff -- apps/desktop/src/main/ipc/register-ipc.ts` 为空。

- [ ] **Step 3：Preload mutation 证明代表非法返回值会 RED**

  临时把 `getCharacterRecoverySnapshot` 从 Schema parse 改为把 `ipcRenderer.invoke(...)` 结果直接返回。运行：

  ```powershell
  pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/preload-api.test.ts -t "恢复快照拒绝"
  ```

  预期：保留的“含有私有路径字段”样例因不再 reject 而 RED。立即恢复 Preload 的 `characterRecoverySnapshotResultSchema.parse(...)`，并确认 `git diff -- apps/desktop/src/preload/index.ts` 为空。

- [ ] **Step 4：实施严格减法**

  - 从“启动恢复快照只接受空输入并返回注入的不可变值”删除 `{ path: 'C:\\private' }` 的重复非法输入断言；合法返回断言保留。
  - Preload 的非法返回 `test.each` 只保留“含有私有路径字段”一个代表；删除“把角色级错误伪装为启动 fallback”的重复样例。
  - `character-ipc.test.ts` 顶部共享 Schema 的一个合法样例和五项非法矩阵一项不删；Main 通用 channel 矩阵一项不删。

- [ ] **Step 5：验证、独立审查与提交**

  ```powershell
  pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/character-ipc.test.ts tests/preload-api.test.ts
  pnpm.cmd --filter @myself/desktop typecheck
  git diff --numstat HEAD -- apps/desktop/tests/character-ipc.test.ts apps/desktop/tests/preload-api.test.ts
  git diff --check
  ```

  完成门：Main/Preload mutation 各自因预期 owner RED；共享 Schema 完整矩阵、Main 通用输入边界和 Preload 代表边界仍 GREEN；两文件合计净减；独立审查 Critical/Important 为零。

  ```powershell
  git add apps/desktop/tests/character-ipc.test.ts apps/desktop/tests/preload-api.test.ts
  git commit -m "test(desktop): 删除重复恢复 Schema 样例"
  ```

---

### Task 4：复用包恢复证据读取 owner

**文件：**
- 修改：`apps/desktop/tests/character-package-service.test.ts`

**接口：**
- 继续复用现有 `preservedEvidence(root, characterId): Promise<Buffer>`；不改生产代码，不新增通用 fs DSL 或第二个证据 helper。
- “坏 marker 与后续合法项”场景中的 `broken`、`BAD!` 两份 corrupt 证据都通过该 helper 读取，两个 `BROKEN_MARKER_BYTES` 原字节断言仍各自保留。
- `.complete-*` detached evidence 属另一种生命周期，不强塞进只认 `.corrupt-*` 的 helper。

- [ ] **Step 1：取得 characterization GREEN 与直接读取清单**

  ```powershell
  pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/character-package-service.test.ts
  rg -n "preservedEvidence|evidenceName|BROKEN_MARKER_BYTES|证据目标冲突|证据目标权限失败|证据发布 ENOSPC" apps/desktop/tests/character-package-service.test.ts
  ```

- [ ] **Step 2：mutation 证明证据发布失败不得清理原 marker**

  临时把 `preserveMarkerEvidence()` 的两步顺序从：

  ```ts
  await atomicWriteFileExclusive(evidence, bytes);
  await this.completeOwnedMarker(marker, expected);
  ```

  交换为先 `completeOwnedMarker()`、后 `atomicWriteFileExclusive()`。运行：

  ```powershell
  pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/character-package-service.test.ts -t "证据.*时保留原 marker"
  ```

  预期：EEXIST、EACCES 或 ENOSPC 代表 case 至少一项因原 marker 不再保留而 RED。立即恢复正确顺序，并确认 `git diff -- apps/desktop/src/main/characters/character-package-service.ts` 为空。

- [ ] **Step 3：删除两份 corrupt 证据的重复查找样板**

  将 `broken` 证据的 `readdir + find + toBeDefined + readFile` 替换为：

  ```ts
  expect(await preservedEvidence(root, 'broken')).toEqual(BROKEN_MARKER_BYTES);
  expect(await preservedEvidence(root, 'BAD!')).toEqual(BROKEN_MARKER_BYTES);
  ```

  不删除任一原字节断言，不改变坏 marker、无归属 marker、后续合法项、脱敏日志、回滚 token 或深冻结报告断言。

- [ ] **Step 4：验证、独立审查与提交**

  ```powershell
  pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/character-package-service.test.ts
  pnpm.cmd --filter @myself/desktop typecheck
  git diff --numstat HEAD -- apps/desktop/tests/character-package-service.test.ts
  git diff --check
  ```

  完成门：证据发布失败 mutation RED；恢复后全文件 GREEN；两个 corrupt 证据的原字节断言都保留；文件净减；独立审查 Critical/Important 为零。

  ```powershell
  git add apps/desktop/tests/character-package-service.test.ts
  git commit -m "test(desktop): 复用包恢复证据读取"
  ```

---

### Task 5：完整门、精确净值与唯一 owner 债务登记

**文件：**
- 修改：`docs/operations/character-workshop-acceptance.md`
- 修改：`docs/superpowers/specs/2026-08-20-desktop-code-subtraction-design.md`

- [ ] **Step 1：运行本轮定向聚合**

  ```powershell
  pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/character-package-service.test.ts tests/character-startup.test.ts tests/character-ipc.test.ts tests/preload-api.test.ts
  pnpm.cmd --filter @myself/desktop build
  pnpm.cmd exec playwright test --config tests/playwright.config.ts
  pnpm.cmd exec playwright test --list --config tests/playwright.config.ts
  ```

  每个顶层命令最多一次；任一命令达到 15 分钟立即终止并记录。E2E 场景数、标题和本轮前 characterization 清单必须一致。

- [ ] **Step 2：运行完整质量门**

  ```powershell
  pnpm.cmd --filter @myself/desktop typecheck
  pnpm.cmd --filter @myself/desktop test
  pnpm.cmd test:security
  pnpm.cmd test:integration
  pnpm.cmd verify:characters
  pnpm.cmd verify:desktop
  ```

  脚本内部重复运行测试属于根 `package.json` 契约；不因已在 Step 1 运行而删门。失败只定向复现一次，15 分钟硬停不变。

- [ ] **Step 3：计算精确净值并检查越界**

  ```powershell
  git diff --numstat b16d542..HEAD -- tests/e2e/desktop.spec.ts apps/desktop/tests/character-startup.test.ts apps/desktop/tests/character-ipc.test.ts apps/desktop/tests/preload-api.test.ts apps/desktop/tests/character-package-service.test.ts
  git diff --numstat c7d951d..HEAD -- apps/desktop/tests tests/e2e
  git diff --name-only b16d542..HEAD -- apps/website apps/cloudbase-api apps/package-scanner cloudbase tests/e2e/website.spec.ts tests/playwright.website.config.ts
  git diff --name-only -- apps/website apps/cloudbase-api apps/package-scanner cloudbase tests/e2e/website.spec.ts tests/playwright.website.config.ts
  git diff --cached --name-only -- apps/website apps/cloudbase-api apps/package-scanner cloudbase tests/e2e/website.spec.ts tests/playwright.website.config.ts
  git diff --check b16d542..HEAD
  git diff --check
  git diff --cached --check
  git status --short
  ```

  用 PowerShell 对 `numstat` 的 added/deleted 分别求和，不凭估算填写。若本轮未净减，停止文档结论并复审；若净减低于 150 或高于 165，只解释真实差异，不为凑区间继续删测试。

- [ ] **Step 4：登记剩余唯一 owner 债务**

  在两份文档中记录：本轮每任务净值、四项 mutation RED、恢复后 GREEN、完整门、网站零触碰和人工未验项。相对 `c7d951d` 的剩余约 660 行必须写成精确实测数，并明确仍由下列唯一 owner 占用：

  - 角色包导入 token、真实 Store 重启、竞态、证据发布/保留、256 项与 2000ms 预算；
  - 启动恢复顺序、fallback、最终 load 瞬时/持续失败与深冻结快照；
  - Main/Preload Schema 双边界、Pet 异步顺序、Workshop StrictMode 与 RPC 失败脱敏；
  - Desktop Electron 生命周期、安全诊断、窗口交互和两条角色恢复重启 E2E；
  - 其余由既有减法规格逐项列明的安全与跨进程证据。

  状态只能写“第二轮安全表达减法完成，测试行数总门仍未达”；不得写“债务归零”“安全减法全部穷尽”或“可删除唯一 owner”。如精确剩余值不在 658–673 观察区间，记录真实值和差异来源。

- [ ] **Step 5：最终独立双审查与文档提交**

  规格审查核对四项范围、replace-don't-layer、网站零触碰、mutation 真实性和未达总门；质量审查核对 loader 深度、测试可读性、唯一 owner 清单、命令证据与净值算术。Critical/Important 清零后提交：

  ```powershell
  git add docs/operations/character-workshop-acceptance.md docs/superpowers/specs/2026-08-20-desktop-code-subtraction-design.md
  git commit -m "docs(desktop): 记录第二轮测试表达减法"
  ```

  最终工作树必须干净；若存在用户原有改动，只报告并排除，不得代为提交或覆盖。
