# 文件意图门与日志证据第二轮修复 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让可信 Main 文件意图门正确区分常见中英文执行请求与域名、版本号、知识讨论，同时让 Electron 日志泄漏证据在原始采集时不可逆累计，消除截断和滚动缓存造成的假绿。

**Architecture:** `ExplicitFileIntentGate` 保持纯分类器接口，内部先屏蔽引用与远程资源，再从文件操作附近提取受保护的本地目标，最后只在目标片段之外判断元语言和否定。测试夹具新增独立 `CapturedLogEvidenceTracker`，在 stdout/stderr 原始块进入截断、缓存和脱敏前分别累计布尔命中，并仅保留匹配跨块所需的有界尾部。

**Tech Stack:** TypeScript、Electron、React、Vitest、Playwright、pnpm workspace。

## Global Constraints

- 只修改智能桌宠相关代码、测试与中文文档；禁止修改、构建、启动或验证 `apps/website`。
- 严格执行 RED→GREEN；一个测试、一个最小实现切片，不横向批量写完测试后再实现。
- Main 规则是聊天与文件任务的唯一分流权威；模型不得提升文件权限。
- Renderer 继续只提交自然文本，不新增路由、Provider、权限或路径字段。
- 文件授权根、相对路径限制、历史披露、写入确认、重置和迟到事件隔离保持不变。
- 普通输入默认聊天；文件操作、合法本地目标、实际执行语气三项证据必须同时成立。
- 不记录或持久化用户正文、Provider 回复、文件正文、密钥或绝对路径；日志证据只公开布尔值或稳定类别。
- 不增加生产 preload 测试接口，不增加 DeepSeek 特例，不修改无关测试或全局超时。
- 所有新增文档、结构性注释和测试名称使用中文；代码标识符沿用英文风格。
- 单个问题超过 10 分钟仍未收敛时安全中止当前路径，保留证据并改用更窄测试或更小接缝。
- 用户已批准本计划必要的依赖安装和 Git 写操作；每项通过定向测试与双轴审查后小步提交。

---

## Task 1：把文件意图门收敛为操作邻接的小语法

**Files:**

- Modify: `apps/desktop/src/main/conversation/explicit-file-intent-gate.ts`
- Modify: `apps/desktop/tests/explicit-file-intent-gate.test.ts`

**Interfaces:**

- Consumes: `ExplicitFileIntentGate.classify(text: string): ConversationRoute`
- Produces: 与现有接口相同的冻结 `{ kind: 'chat' | 'file_task' }`；不返回路径、正文或内部证据。

- [ ] **Step 1：为常见礼貌执行语气写 RED**

在现有文件任务表中加入：

```ts
'你能帮我读取 a.txt 吗？',
'Can you please delete a.txt?',
'Could you read pyproject.toml?',
'Would you please list .\\drafts?'
```

运行：

```powershell
& .\node_modules\.bin\vitest.cmd run --config apps/desktop/vitest.config.ts apps/desktop/tests/explicit-file-intent-gate.test.ts
```

预期：新增礼貌请求失败，既有用例继续通过。

- [ ] **Step 2：最小扩展中英文执行结构并 GREEN**

执行结构必须只负责识别请求语气，不负责猜测文件对象。最小形式：

```ts
const chinesePoliteExecutionPattern = /^(?:请问)?你能(?:不能)?(?:帮我)?\s*(?:读取|列出|创建|写入|修改|重命名|复制|移动|删除|搜索|整理)/u;
const englishPoliteExecutionPattern = /^(?:can|could|would)\s+you\s+(?:please\s+)?(?:read|list|create|write|modify|rename|copy|move|delete|search|organize)\b/iu;
```

将两者并入 `hasDirectExecutionRequest`，不放宽对象规则。重跑聚焦测试并保存 GREEN 计数。

- [ ] **Step 3：为元语言紧邻文件名写 RED**

在聊天表中加入：

```ts
'读取 a.txt是什么意思？',
'读取 a.txt为什么失败？',
'Can you explain why reading a.txt failed?'
```

运行同一聚焦命令。预期前两项至少失败，证明现有文件对象正则吞掉知识后缀。

- [ ] **Step 4：提取并保护本地对象片段**

用一个内部函数替换“全句任意点号 token”判断：

```ts
type LocalObjectScan = Readonly<{
  hasLocalObject: boolean;
  semanticText: string;
}>;

function scanLocalObjects(text: string): LocalObjectScan {
  // 只从文件操作附近提取本地路径、文件名或明确目录指代；
  // semanticText 用等长空格遮蔽已确认对象，使文件名内部词语不参与元语言判断。
}
```

要求：

- `semanticText` 只遮蔽目标本身，不吞掉紧邻的 `是什么意思`、`为什么失败`。
- `读取 不要删除.txt` 中目标整体被遮蔽，目标内部的“不要”不触发否定。
- `请把 report.md 重命名为 archive.md` 可提取源和目标两个对象。
- 不改变现有文件操作词集合及返回类型。

重跑聚焦测试，确认紧邻知识后缀和既有文件名用例同时 GREEN。

- [ ] **Step 5：为非本地点号 token 写 RED**

在聊天表中加入：

```ts
'read www.example.com/manual.pdf',
'read www.example.com',
'delete user@example.com',
'Can you delete version 1.2?',
'read release 2.0.1'
```

预期新增用例失败，且不得通过加入这些字符串的逐项黑名单修复。

- [ ] **Step 6：实现候选目标验证并 GREEN**

候选目标验证顺序固定为：

```ts
function isLocalObjectCandidate(candidate: string): boolean {
  if (isUrlOrBareDomain(candidate)) return false;
  if (isEmailAddress(candidate)) return false;
  if (isNumericVersion(candidate)) return false;
  return isRelativePath(candidate)
    || isDottedLocalName(candidate)
    || isKnownDirectoryReference(candidate);
}
```

具体约束：

- URL 同时覆盖 `scheme://`、`www.` 与域名后路径。
- 邮箱覆盖 `local@domain.tld`。
- 数字版本覆盖 `1.2` 与 `2.0.1`，但不拒绝 `report.v2.txt`。
- 点号文件名不依赖扩展名白名单，但必须是操作邻接的单个本地名称，不能是域名、邮箱或纯数字版本。
- 相对路径继续支持 `.\`、`..\`、`./`、`../` 与内部目录分隔符。

重跑 Gate 全文件，预期全部通过。

- [ ] **Step 7：三项证据变异与静态边界检查**

依次临时使文件操作、合法本地目标、执行语气任一证据恒真或恒假；每次至少一个正例或反例必须 RED，随后恢复。最终执行：

```powershell
& .\node_modules\.bin\vitest.cmd run --config apps/desktop/vitest.config.ts apps/desktop/tests/explicit-file-intent-gate.test.ts apps/desktop/tests/conversation-coordinator.test.ts
pnpm.cmd --filter @myself/desktop typecheck
rg -n "provider|generation|capability|authorizedRoot" apps/desktop/src/main/conversation/explicit-file-intent-gate.ts
git diff --name-only -- apps/website
```

最后两条应分别无新增权限字段、网站零差异。

- [ ] **Step 8：写 Task 1 报告并提交**

报告写入 `.superpowers/sdd/2026-08-11-ai-pet-intent-log-evidence-fix/task-1-report.md`，记录每个 RED/GREEN、变异恢复、文件和耗时，不记录测试正文之外的敏感值。

```powershell
git add -- apps/desktop/src/main/conversation/explicit-file-intent-gate.ts apps/desktop/tests/explicit-file-intent-gate.test.ts
git add -f -- .superpowers/sdd/2026-08-11-ai-pet-intent-log-evidence-fix/task-1-report.md
git commit -m "fix: 收紧本地文件意图语法"
```

---

## Task 2：在原始日志采集时不可逆累计泄漏证据

**Files:**

- Modify: `tests/fixtures/electron-app.ts`
- Modify: `tests/e2e/desktop.spec.ts`

**Interfaces:**

- Consumes: `CreateElectronAppFixtureOptions.logSentinels?: readonly string[]`
- Produces: 现有 `ElectronAppFixture.capturedLogEvidence` 只读快照，字段保持 `apiKey`、`authorizedRoot`、`authorizationHeader`、`sentinels`；不向生产代码暴露接口。

- [ ] **Step 1：为截断和缓存淘汰写 RED**

扩展 `desktop.spec.ts` 中现有“直接 spawn 后连接 CDP”夹具测试，分别让 fake child 输出：

```ts
`${'x'.repeat(4_100)}${logSentinel}`
```

以及先输出哨兵、再输出 101 个无敏感信息的块。断言最终：

```ts
expect(fixture.capturedLogEvidence.sentinels).toEqual([true]);
```

运行：

```powershell
pnpm.cmd exec playwright test --config tests/playwright.config.ts tests/e2e/desktop.spec.ts -g "测试夹具直接 spawn 后连接 CDP"
```

预期：两类新增行为至少一项 RED；公开 `fixture.logs` 仍不得包含哨兵。

- [ ] **Step 2：实现独立证据跟踪器并 GREEN**

在 `tests/fixtures/electron-app.ts` 内新增并导出测试夹具级接口：

```ts
export interface CapturedLogEvidenceTracker {
  capture(source: 'stdout' | 'stderr', chunk: string | Buffer): void;
  snapshot(): ElectronAppFixture['capturedLogEvidence'];
  dispose(): void;
}

export function createCapturedLogEvidenceTracker(input: Readonly<{
  apiKey: string;
  authorizedRootDirectory: string;
  sentinels: readonly string[];
}>): CapturedLogEvidenceTracker;
```

实现要求：

- 构造时若 `sentinels` 含空字符串，抛稳定 `EMPTY_LOG_SENTINEL`，避免恒真匹配。
- `capture` 在任何截断、缓存和脱敏前更新布尔值；命中只能从 `false` 变为 `true`。
- `snapshot` 返回冻结对象和冻结 `sentinels` 数组。
- `dispose` 清空跨块尾部并使后续 `capture` 成为无副作用操作。
- stdout/stderr 分别保存尾部，不能把两个不同流拼成一个哨兵。

夹具的现有 `capture` 先调用 tracker，再维护最多 100 条、每条 4000 字符的脱敏诊断缓存。重跑聚焦测试并 GREEN。

- [ ] **Step 3：为跨块与 Authorization 写 RED**

同一夹具测试增加：

- 同一 stdout 两个块拼成一个哨兵，必须命中。
- stdout 前半与 stderr 后半不得拼成哨兵。
- `Authorization: Bearer …` 必须命中。
- `{"authorization":"Bearer …"}` 必须命中。

预期跨块或 JSON Authorization 在实现补齐前 RED。

- [ ] **Step 4：实现有界尾部与 Authorization 累计并 GREEN**

每个流只保留：

```ts
const tailLength = Math.max(
  64,
  input.apiKey.length - 1,
  input.authorizedRootDirectory.length - 1,
  ...input.sentinels.map(value => value.length - 1)
);
```

扫描内容为“该流上一块尾部 + 当前完整块”。Authorization 使用不区分大小写的普通头与 JSON 字段表达；更新证据后才截取新尾部。不得保存完整原始块历史。

重跑聚焦测试，确认全部 GREEN。

- [ ] **Step 5：受控泄漏变异验证 E2E 灵敏度**

只在 `apps/desktop/src/main/conversation/conversation-chat-adapter.ts` 的 Provider 回复边界临时输出一个已配置回复哨兵：

1. 运行命名 Electron 场景，确认新 `capturedLogEvidence` 断言 RED。
2. 确认失败输出只显示布尔索引或稳定标签，不显示正文。
3. 立即移除变异。
4. 执行 `git diff --exit-code -- apps/desktop/src/main/conversation/conversation-chat-adapter.ts`，必须为零差异。
5. 重建 Desktop 后重跑命名场景并 GREEN。

命令：

```powershell
pnpm.cmd --filter @myself/desktop build
pnpm.cmd exec playwright test --config tests/playwright.config.ts tests/e2e/desktop.spec.ts -g "默认聊天与设置浮层提示"
```

- [ ] **Step 6：夹具生命周期与脱敏回归**

聚焦断言：

- `dispose` 后的迟到日志不改变快照。
- `fixture.logs` 和诊断错误继续脱敏 API key、授权根和哨兵。
- `capturedLogEvidence` 只含布尔值。
- 不存在生产 preload 变更。

运行：

```powershell
pnpm.cmd exec playwright test --config tests/playwright.config.ts tests/e2e/desktop.spec.ts -g "测试夹具直接 spawn 后连接 CDP|默认聊天与设置浮层提示"
pnpm.cmd test:integration
git diff --name-only -- apps/desktop/src/preload apps/website
```

最后一条应无输出。

- [ ] **Step 7：写 Task 2 报告并提交**

报告写入 `.superpowers/sdd/2026-08-11-ai-pet-intent-log-evidence-fix/task-2-report.md`。

```powershell
git add -- tests/fixtures/electron-app.ts tests/e2e/desktop.spec.ts
git add -f -- .superpowers/sdd/2026-08-11-ai-pet-intent-log-evidence-fix/task-2-report.md
git commit -m "test: 累计原始日志泄漏证据"
```

---

## Task 3：纵向验收、报告校正与非网站门禁

**Files:**

- Modify: `.superpowers/sdd/2026-08-10-ai-pet-default-chat-settings-toast/final-fix-report.md`
- Create: `.superpowers/sdd/2026-08-11-ai-pet-intent-log-evidence-fix/task-3-report.md`
- Modify only if an actual wiring RED requires it: `tests/e2e/desktop.spec.ts`

**Interfaces:**

- Consumes: Task 1 的 `ExplicitFileIntentGate.classify` 与 Task 2 的 `capturedLogEvidence`。
- Produces: 可追溯的最终报告、完整非网站自动证据和干净提交。

- [ ] **Step 1：补纵向 Gate 场景**

在命名 Electron 场景中加入最小可观测输入：

- 礼貌本地文件请求进入既有授权/文件链。
- 裸域名、版本号和紧邻知识后缀保持普通聊天，文件授权 UI 不出现。

只使用现有 Provider 请求摘要、可见 DOM 和授权 UI；不增加生产探针。先运行命名场景取得 wiring RED；若现有接线已 GREEN，记录“生产接线无需修改”，不得制造无意义生产改动。

- [ ] **Step 2：校正旧最终修复报告**

更新旧报告中的陈旧信息：

- 写入真实提交 `b08a9da`，删除“未提交/工作树待主控提交”的表述。
- 追加本计划 Task 1/2 的修复提交与复审结论。
- 保留先前 `verify:behavior` 失败事实，不把历史失败改写为通过。
- 不写入任何哨兵正文、密钥或绝对路径。

- [ ] **Step 3：执行完整非网站门禁**

先确认没有本 worktree 的测试进程残留，然后严格顺序运行：

```powershell
pnpm.cmd --filter @myself/desktop typecheck
pnpm.cmd test:security
pnpm.cmd test:integration
pnpm.cmd test:e2e:desktop
pnpm.cmd verify:behavior
git diff --check
git diff --name-only -- apps/website
```

约束：

- 禁止根 `pnpm typecheck`，它会递归进入网站。
- 每条命令独立记录退出码、计数和耗时；不并发执行完整门。
- `verify:behavior` 只运行一次 fresh 门。若仍只有未修改测试的并发固定 5 秒超时，停止重跑并记录为基础设施 concern；不得放宽超时。若 Task 1/2 覆盖范围内失败，必须修复后重新验证。
- 单条命令运行期间可挂后台，但每 60 秒报告进度；超过 10 分钟安全终止。

- [ ] **Step 4：进程、差异和敏感信息收口**

执行只读检查：

```powershell
git status --short
git diff --check
git diff --name-only -- apps/website
rg -n "未生成|待主控提交|尚无提交" .superpowers/sdd/2026-08-10-ai-pet-default-chat-settings-toast/final-fix-report.md .superpowers/sdd/2026-08-11-ai-pet-intent-log-evidence-fix
```

并扫描本 worktree 相关 Electron/Node 进程。网站 diff、占位符和进程残留必须为空。

- [ ] **Step 5：写 Task 3 报告并提交**

`task-3-report.md` 记录三项任务提交、规格/质量审查、完整门结果、已知 concern 和网站零修改。

```powershell
git add -f -- .superpowers/sdd/2026-08-10-ai-pet-default-chat-settings-toast/final-fix-report.md .superpowers/sdd/2026-08-11-ai-pet-intent-log-evidence-fix/task-3-report.md
git add -- tests/e2e/desktop.spec.ts
git commit -m "test: 验收文件意图与日志证据修复"
```

---

## 审查流程

每个 Task 完成后均执行：

1. 实现子智能体自审并提交。
2. 独立规格轴检查本 Task 的精确要求。
3. 独立质量轴检查权限误升、正则灾难性回溯、跨流拼接、日志正文持久化、dispose 竞态和测试假绿。
4. Critical/Important 进入最多 5 轮的 task-scoped RED→GREEN 修复循环。
5. 三个 Task 完成后执行一次全分支审查；若仍有发现，按流程只允许一个集中修复波和一次 scoped re-review。

## 规格覆盖矩阵

| 规格要求 | 自动证据 |
| --- | --- |
| 中英文礼貌执行请求 | Task 1 Gate 表驱动测试、Task 3 Electron 场景 |
| 紧邻知识后缀默认聊天 | Task 1 Gate 测试 |
| URL、裸域名、邮箱、版本号默认聊天 | Task 1 Gate 测试、Task 3 Electron 场景 |
| 文件名内部否定词不误伤 | Task 1 既有 `读取 不要删除.txt` 回归 |
| 截断与缓存淘汰不丢证据 | Task 2 fixture 测试 |
| 同流跨块匹配、跨流不拼接 | Task 2 fixture 测试 |
| 普通与 JSON Authorization 检测 | Task 2 fixture 测试 |
| 原始正文不持久化 | Task 2 类型/断言、命名 E2E、报告反查 |
| Main/Renderer/文件安全链不变 | Task 1 静态边界、Coordinator、安全门 |
| 网站零修改与完整桌宠门禁 | Task 3 最终门 |
