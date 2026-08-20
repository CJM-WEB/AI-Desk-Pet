# B2/B3 测试表达减法实施计划

> **供智能体执行：** 必须使用 `subagent-driven-development`（推荐）或 `executing-plans`，逐任务执行、独立复审并提交。所有步骤使用复选框跟踪。

**目标：** 不删除任何唯一安全、竞态或跨进程证据，通过复用文件内夹具、表驱动和删除已被强 owner 替代的旧入口，收敛 B2/B3 实施期间的测试表达与少量生产浅别名。

**架构：** 不建立跨文件测试框架，也不引入万能场景 DSL。每个测试文件只拥有与其领域相符的深 helper；调用点继续直接显示故障发生阶段和关键安全断言。完成门以唯一 owner 清单、mutation 证据、定向测试和实际净减共同裁决，行数不得凌驾于安全边界。

**技术栈：** TypeScript、Vitest、Playwright、Electron、pnpm、Windows PowerShell。

## 全局约束

- 适用规格：`docs/superpowers/specs/2026-08-20-desktop-code-subtraction-design.md`、B2/B3 当前规格与计划。
- 基线提交固定为 `7b79cc9`；减法总基线仍为 `c7d951d`。
- 不修改网站、CloudBase、package scanner、网站 E2E；不新增生产能力、依赖、公开接口或磁盘格式。
- 必须保留：真实 Store token 重启回滚、token/active/identity 竞态、exclusive publish、证据保留、256/2000ms、启动顺序、Schema Main/Preload 双边界、Pet 两种异步顺序、Workshop StrictMode、Workshop RPC 失败脱敏、两条角色恢复 Electron 重启场景。
- 不新建共享测试工具文件；helper 原位留在唯一消费者文件。删除 helper 后复杂度只回到一个调用点的，不得建立。
- 本计划是行为不变的测试重构：先取得新鲜 characterization GREEN；需要删除旧测试 owner 时，必须做一次可恢复 mutation，证明保留 owner 会 RED；恢复生产代码后再 GREEN。
- 单点或单命令 15 分钟硬停；失败只做一次精确定向复现，不提高 5 秒测试超时，不用重复重跑掩盖波动。
- 每任务记录修改前后 `git diff --numstat`；净增即暂停复审，不以浅 helper 换行数。
- Git 写操作已获用户授权；每任务只提交自身文件，不 push、不 merge、不 rebase、不 reset。

---

### Task 1：删除启动恢复浅入口并合并重复编排表达

**文件：**
- 修改：`apps/desktop/src/main/characters/character-startup.ts`
- 修改：`apps/desktop/src/shared/character-recovery.ts`
- 修改：`apps/desktop/tests/character-startup.test.ts`
- 修改：`apps/desktop/tests/character-recovery.test.ts`

**接口：**
- 保留 owner：`prepareCharacterStartup()`、`characterRecoveryPresentation()`、`characterRecoveryMessage()`。
- 删除旧入口：`apps/desktop/src/main/characters/character-startup.ts` 对 `characterRecoveryMessage` 的浅 re-export。
- 文件内 helper：`recordingDependencies(order, overrides?): CharacterStartupDependencies`，只集中四个顺序 double，不隐藏断言。

- [ ] **Step 1：取得 characterization GREEN 与消费者清单**

  运行：

  ```powershell
  pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/character-startup.test.ts tests/character-recovery.test.ts
  rg -n "characterRecoveryMessage" apps/desktop/src apps/desktop/tests
  ```

  预期：两文件通过；浅 re-export 只有测试消费者，生产消费者直接读取 shared owner。

- [ ] **Step 2：用 mutation 证明 runtime 白名单矩阵是强 owner**

  临时修改 `publicFallbackCode()`：仅当输入为 `CHARACTER_RESOURCE_INTEGRITY_FAILED` 时返回 `CHARACTER_OPERATION_FAILED`。只运行 `apps/desktop/tests/character-startup.test.ts`，必须由 runtime 表驱动矩阵的对应 case RED。立即用反向 `apply_patch` 恢复生产代码，并用 `git diff -- apps/desktop/src/main/characters/character-startup.ts` 确认 mutation 零残留。

- [ ] **Step 3：实施最小减法**

  - 删除浅 re-export 和只验证该旧入口的尾部测试。
  - 将两条 message 映射断言移入 `apps/desktop/tests/character-recovery.test.ts` 的共享映射 owner。
  - 用 `recordingDependencies()` 合并重复四依赖装配。
  - 将单独的 resource-integrity 测试并入现有 runtime 错误矩阵，并保留默认角色准备与 `activeCharacterId === 'builtin-default'` 断言。
  - 将 active draft/B2 不 fallback 样例并入问题投影测试。
  - 删除 `apps/desktop/src/shared/character-recovery.ts` 文件尾空白和已由 exact equality 覆盖的逐字段重复隐私断言。

- [ ] **Step 4：验证与审查**

  ```powershell
  pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/character-startup.test.ts tests/character-recovery.test.ts
  pnpm.cmd --filter @myself/desktop typecheck
  git diff --check
  ```

  完成门：所有启动顺序、重试、默认准备失败、白名单和深冻结 owner 仍在；生产与测试合计净减；独立规格/质量复审均无 Critical/Important。

### Task 2：收敛 IPC、Preload 与 Pet 测试装配

**文件：**
- 修改：`apps/desktop/tests/character-ipc.test.ts`
- 修改：`apps/desktop/tests/preload-api.test.ts`
- 修改：`apps/desktop/tests/pet-view.test.tsx`

**接口：**
- `characterIpcHarness(options?)` 返回当前 handlers、service、dialogs；不进入生产代码。
- 原位替换既有 `renderPet(api, ready)`，不保留重载或旧签名：

  ```ts
  function renderPet(
    loadRecovery: MyselfApi['getCharacterRecoverySnapshot'] = async () => EMPTY_RECOVERY_SNAPSHOT,
    playerReady = false
  ): ReturnType<typeof render> & { api: MyselfApi };
  ```

  函数内部唯一创建 `createPetViewApi()`、安装 loader、设置 player ready、render 并返回 `api`；不得在 `createPetViewApi()` 与 `renderPet()` 之上新增第三层 helper。deferred/reject Promise 仍由测试调用点传入闭包。

- [ ] **Step 1：取得三文件 characterization GREEN**

  ```powershell
  pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/character-ipc.test.ts tests/preload-api.test.ts tests/pet-view.test.tsx
  ```

- [ ] **Step 2：表驱动与文件内 factory 重构**

  - 把 Character snapshot 的五个非法对象改为一个 `test.each`，合法对象仍单独验证。
  - 用 `characterIpcHarness()` 替换重复的 `createIpcMain + service double + dialog double + register` 三连装配；handler 调用与快照不可变断言留在测试正文。
  - Preload 保留一个合法值和一组表驱动非法值，继续证明固定 channel 与二次 Schema 拒绝。
  - 原位深化现有 `renderPet()` 并替换旧签名，集中 API/render boilerplate；RPC reject、两个 deferred 完成顺序和播放器 callback 仍直接写在各测试中。

- [ ] **Step 3：mutation 验证双层边界与异步 owner**

  - 临时令 Preload 直接返回未经 Schema 解析的 payload；Preload 非法值测试必须 RED，随后恢复。
  - 临时把 `onRuntimeError` callback 改为先 `setPlayerRuntimeError(error)`，并在 `error === null` 时额外调用 `setStartupFallbackError(null)`；“启动 fallback 不被播放器 null 清除”必须 RED，随后恢复并确认生产 diff 零残留。

- [ ] **Step 4：验证与审查**

  ```powershell
  pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/character-ipc.test.ts tests/preload-api.test.ts tests/pet-view.test.tsx
  pnpm.cmd --filter @myself/desktop typecheck
  git diff --check
  ```

  完成门：Main/Preload Schema 两层、Pet 两种异步顺序均有独立 owner；三文件净减；双审查清零 Critical/Important。

### Task 3：表驱动 exclusive publish 失败阶段

**文件：**
- 修改：`apps/desktop/tests/atomic-file-coordinator.test.ts`

**接口：**
- 生产 `atomicWriteFileExclusive()` 完全不变。
- 测试使用文件内 `FailureStage = 'write' | 'sync' | 'link'` 与 `test.each`，不增加生产 fault seam。

- [ ] **Step 1：取得 characterization GREEN**

  ```powershell
  pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/atomic-file-coordinator.test.ts
  ```

- [ ] **Step 2：合并重复失败测试**

  在 `beforeEach` 统一建立临时目录和 final 路径；将 write、sync、link 三项失败合并为 `test.each`。每一行仍必须断言 final 不存在、temp 清零、`rename`/`copyFile` 均未调用。并发 32 writer 与已有 final 字节不变保持独立；`atomicWriteText()` replacement 语义继续由现有 CharacterStore/official-default 消费者测试拥有，本任务不新增重复测试。

- [ ] **Step 3：mutation 验证禁止 fallback**

  临时在 `await link(temporaryFile, file)` 周围增加 catch，并在 catch 内调用 `rename(temporaryFile, file)`；link case 必须因 `rename` 被调用而 RED。恢复生产文件并以 `git diff -- apps/desktop/src/main/storage/atomic-file-coordinator.ts` 确认生产零差异。

- [ ] **Step 4：验证与审查**

  ```powershell
  pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/atomic-file-coordinator.test.ts
  pnpm.cmd --filter @myself/desktop typecheck
  git diff --check
  ```

  完成门：所有阶段和并发 owner 保留，测试文件净减，生产文件零最终差异，双审查清零 Critical/Important。

### Task 4：原位深化角色包恢复测试 fixture

**文件：**
- 修改：`apps/desktop/tests/character-package-service.test.ts`

**接口：**
- 文件内常量：`IMPORT_TOKEN`、`BROKEN_MARKER_BYTES`。
- 文件内 helper：

  ```ts
  type RecoveryMarkerSeed = Readonly<{
    fileCharacterId: string;
    bytes?: Buffer;
    bodyCharacterId?: string;
    importTransactionId?: string;
  }>;

  async function seedRecoveryMarkers(
    rootName: string,
    markers: readonly RecoveryMarkerSeed[]
  ): Promise<{
    root: string;
    bytesByCharacterId: ReadonlyMap<string, Buffer>;
  }>;

  async function exportDemoPackage(
    fileName?: string,
    sourceRoot?: string
  ): Promise<string>;
  ```

  `RecoveryMarkerSeed.bytes` 存在时按原字节写入并忽略 body 字段；否则写入 `markerV3(bodyCharacterId ?? fileCharacterId, importTransactionId ?? IMPORT_TOKEN)`；`bytesByCharacterId` 保存实际落盘字节。`exportDemoPackage()` 的前置条件是测试已用现有 helper 创建可发布 demo 角色；它只集中导出路径与调用，不隐式创建角色。marker 路径、证据查找、Service 构造和故障注入继续使用现有函数/模块级 mock，禁止再包一层浅对象或通用 fs DSL。

- [ ] **Step 1：取得 characterization GREEN 和 owner 清单**

  ```powershell
  pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/character-package-service.test.ts
  rg -n "test(?:\.each)?\(" apps/desktop/tests/character-package-service.test.ts
  ```

  记录并逐项保护以下 18 类 owner：导入 token rollback、blocked 同 ID、durable publish 顺序、publish-read race、真实 Store 重启回滚、坏 marker 与后续合法项、v1/v2 inert、strict marker/4096 边界、扫描失败、四种 rollback 结果、读取后替换、detached evidence、evidence publish 三种失败、marker open/read、cleanup 单故障重试与双故障 inert、活动角色优先与无活动角色 256 上限、2000ms 项间预算、inventory 跨预算首项。

- [ ] **Step 2：引入两个领域 seed helper 并保持 GREEN**

  只加入 `exportDemoPackage()` 与 `seedRecoveryMarkers()`，逐组替换重复 setup；每替换一组立即运行本文件。marker/evidence/Service/故障仍在测试正文显式表达，rename/link/rm 结果断言不得移入 helper。

- [ ] **Step 3：保留真实重启 owner并强化 token 传递证据**

  保留“应用重启初始化会按所有权令牌回滚创建后中断的半安装角色”，它是 owner 文件持久化、新 Store 实例、真实目录清理和 marker 清理的唯一集成证据；只允许复用 `seedRecoveryMarkers()` 减少准备代码。在四种 rollback 判别结果测试中额外记录每次 `importTransactionId` 并断言全部等于 `IMPORT_TOKEN`。

  mutation：只把恢复循环中 `rollbackImportedCharacter(document.characterId, document.importTransactionId)` 的第二参数临时改成固定错误 UUID；不得修改导入 catch 中另一处正常回滚调用。真实重启回滚测试必须 RED 并保留半安装目录。恢复生产代码并用 `git diff -- apps/desktop/src/main/characters/character-package-service.ts` 确认 mutation 零残留后再继续。

- [ ] **Step 4：共享 active priority 与 256 上限准备但保留两个 case**

  用同一个 seed helper 或 `test.each` 复用最小 257 marker 准备，但必须分别执行两个语义 case：一是活动角色位于稳定排序第 257 位仍被提升到首位；二是无活动角色时严格处理稳定排序前 256 项且第 257 项未 open/无 issue/无逐项日志。2000ms 两个测试继续独立。

- [ ] **Step 5：验证、净值与审查**

  ```powershell
  pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/character-package-service.test.ts
  pnpm.cmd --filter @myself/desktop typecheck
  git diff --check
  ```

  完成门：本文件必须净减，80–120 行仅为观察目标；未达到目标时列出剩余唯一 owner，禁止为凑数字继续抽浅 helper或删除 owner。上述 18 类安全证据全部可枚举；无新增测试文件/生产接口；双审查清零 Critical/Important。

### Task 5：统一 Desktop E2E 窗口发现 helper

**文件：**
- 修改：`tests/e2e/desktop.spec.ts`

**接口：**

```ts
type AppFixture = Awaited<ReturnType<ElectronFixtureModule['createElectronAppFixture']>>;
function rendererPages(fixture: AppFixture): Page[];
function rendererPage(fixture: AppFixture, view: string): Page | undefined;
async function waitForRendererPage(
  fixture: AppFixture,
  view: string,
  timeout?: number
): Promise<Page>;
```

`rendererPage()` 遇到不可解析 URL 时返回 `undefined`；`waitForRendererPage()` 在 poll 成功后必须重新取值，若页面在两步之间消失则抛固定错误，不使用非空断言掩盖竞态。

- [ ] **Step 1：列出重复 owner 并取得先验 GREEN**

  ```powershell
  rg -n "const (rendererPages|pages|pageFor|waitForPage|petPageForCurrentLaunch|waitForPetPage)" tests/e2e/desktop.spec.ts
  pnpm.cmd --filter @myself/desktop build
  pnpm.cmd exec playwright test --config tests/playwright.config.ts --grep "角色恢复"
  ```

- [ ] **Step 2：机械替换重复闭包**

  在现有 fixture loader 后定义三个 helper，替换所有只做 `contexts().flatMap(...).find(view)` 的局部闭包。特殊诊断、页面事件订阅和不同 timeout 仍留在场景中；不改测试标题、不合并业务场景、不新增 retry/timeout。

- [ ] **Step 3：复核两条恢复场景没有因机械替换丢失证据**

  两条恢复 E2E 继续分别拥有非活动不 fallback 与活动 fallback；普通聊天提交和 `activeCharacterId` 跨进程读取保留在各场景正文，不为两个调用点新增浅 helper。不得删除 marker 原字节、公开快照隐私、默认播放器 ready、Workshop 选择过滤断言。

- [ ] **Step 4：验证与审查**

  ```powershell
  pnpm.cmd --filter @myself/desktop build
  pnpm.cmd exec playwright test --config tests/playwright.config.ts
  pnpm.cmd exec playwright test --list --config tests/playwright.config.ts
  git diff --check
  ```

  完成门：重复窗口发现闭包只保留特殊用途者；Desktop E2E owner 数量和标题不变；文件净减；双审查清零 Critical/Important。

### Task 6：全门禁、净减账本与状态裁决

**文件：**
- 修改：`docs/operations/character-workshop-acceptance.md`
- 修改：`docs/superpowers/specs/2026-08-20-desktop-code-subtraction-design.md`（只更新实测账本与状态，不改安全门）

- [ ] **Step 1：运行定向聚合与完整门**

  ```powershell
  pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/atomic-file-coordinator.test.ts tests/character-package-service.test.ts tests/character-startup.test.ts tests/character-ipc.test.ts tests/preload-api.test.ts tests/character-recovery.test.ts tests/pet-view.test.tsx tests/character-workshop-close-renderer.test.tsx
  pnpm.cmd --filter @myself/desktop typecheck
  pnpm.cmd --filter @myself/desktop test
  pnpm.cmd test:security
  pnpm.cmd test:integration
  pnpm.cmd verify:characters
  pnpm.cmd verify:desktop
  ```

  每个顶层命令最多运行一次；脚本内部重复运行 Desktop test/security/integration 属当前 `package.json` 契约。任一顶层命令达到 15 分钟立即终止并记录；失败仅定向复现一次并保留原失败。

- [ ] **Step 2：计算净值与旧入口删除门**

  ```powershell
  git diff --numstat c7d951d..HEAD -- apps/desktop/tests tests/e2e
  rg -n "startupRecoveryErrorCode|loadCharacterStartupRecovery|fallbackActive|CharacterActions.*getCharacterRecoverySnapshot|export \{ characterRecoveryMessage \}" apps/desktop/src
  rg -n "fallbackActive" apps/desktop/tests/character-ipc.test.ts
  git diff --name-only c7d951d..HEAD -- apps/website apps/cloudbase-api apps/package-scanner cloudbase tests/e2e/website.spec.ts tests/playwright.website.config.ts
  git diff --name-only -- apps/website apps/cloudbase-api apps/package-scanner cloudbase tests/e2e/website.spec.ts tests/playwright.website.config.ts
  git diff --cached --name-only -- apps/website apps/cloudbase-api apps/package-scanner cloudbase tests/e2e/website.spec.ts tests/playwright.website.config.ts
  git diff --check c7d951d..HEAD
  git diff --check
  git diff --cached --check
  git status --short
  ```

- [ ] **Step 3：更新真实验收状态**

  记录每任务净值、mutation RED、最终 GREEN、完整门和人工未验项。生产旧符号必须零命中；测试中的 `fallbackActive` 必须只保留 `character-ipc.test.ts` 的严格 Schema 负例，并记录精确命中数。最终 owner 表还要点名 Workshop StrictMode 单请求与 RPC 失败通用文案/异常脱敏。若测试与 E2E 仍相对 `c7d951d` 净增，只能在 owner 审计证明剩余均为唯一证据时写“安全减法已穷尽、行数总门未达”；不得删除唯一证据、不得建立万能 DSL、不得宣称减法总门通过。

- [ ] **Step 4：最终独立双审查与提交**

  规格审查核对 replace-don't-layer、旧路径删除和保护路径；质量审查核对 helper 深度、可读性、mutation 真实性和测试门结果。Critical/Important 清零后提交文档；工作树必须干净。
