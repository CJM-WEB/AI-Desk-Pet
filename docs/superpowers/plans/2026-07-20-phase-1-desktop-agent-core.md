# 第一阶段桌面端与 Agent 核心实施计划

> **面向执行代理：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`，逐项执行本计划。所有步骤使用复选框（`- [ ]`）跟踪。

**目标：** 构建可安装的 Windows 桌宠应用：配置一个 OpenAI 兼容模型、授权一个目录，并通过需要确认的 Agent 流程安全地列出、读取、新建和重命名条目。

**架构：** Electron Renderer 只负责展示；preload 暴露强类型白名单；Electron Main 负责密钥、模型通信、权限策略、待确认动作和文件执行。`agent-core`、`file-tools`、`shared-types` 与 `character-runtime` 均为可独立测试的工作区包。

**技术栈：** pnpm workspace、Electron、electron-vite、React、TypeScript、Zustand、Zod、Tailwind CSS、Vitest、Playwright、electron-builder。

## 全局约束

- 目标平台为 Windows 10/11 x64，版本为 `0.1.0-alpha.1`。
- `nodeIntegration` 必须为 false，`contextIsolation` 必须为 true，并启用 Renderer 沙盒。
- Renderer 永远不能取得 API Key，也不能获得不受限制的 IPC 原语。
- 第一阶段仅提供 `list_directory`、`read_text_file`、`create_file`、`create_directory` 和 `rename_entry`。
- 所有写操作都必须预览并确认，绝不覆盖已有目标。
- 同时只允许一个授权根目录、一个活动模型配置、一个活动任务和一个待确认写操作。
- 模型循环最多四次响应；无效工具调用只允许修正一次。
- Codex 不执行暂存、提交或推送；每个任务都以用户通过 Fork/GitHub 验收为结束点。
- 首次生成的 `pnpm-lock.yaml` 冻结依赖版本；新增计划外依赖必须经过用户验收。
- 面向人的文档、计划、错误说明和代码注释使用中文；代码标识符、协议字段、文件名和命令保留英文。

---

## 计划文件结构

```text
package.json                              workspace scripts only
pnpm-workspace.yaml                       workspace membership
tsconfig.base.json                        strict shared compiler settings
vitest.config.ts                         单元测试与集成测试项目
apps/desktop/
  package.json                            Electron app commands/dependencies
  electron.vite.config.ts                 Main/preload/renderer builds
  src/main/index.ts                       secure application bootstrap
  src/main/windows/window-manager.ts      pet/chat/settings/tray lifecycle
  src/main/ipc/register-ipc.ts            explicit IPC handlers
  src/main/storage/settings-store.ts      atomic versioned settings
  src/main/storage/secret-store.ts        safeStorage key encryption
  src/main/providers/openai-provider.ts    compatible chat-completions adapter
  src/main/agent/agent-service.ts          task orchestration and cancellation
  src/main/agent/pending-action-store.ts   in-memory confirmation capability
  src/main/permissions/root-service.ts     system picker and root lifecycle
  src/preload/index.ts                    typed allowlisted API
  src/renderer/src/App.tsx                UI route/state composition
  src/renderer/src/stores/task-store.ts    renderer task view state
  src/renderer/src/pet/PetView.tsx         draggable character surface
  src/renderer/src/chat/ChatPanel.tsx      conversation/input/stop UI
  src/renderer/src/chat/ConfirmationCard.tsx write preview UI
  src/renderer/src/settings/SettingsView.tsx provider/root/data UI
  src/renderer/src/character/state-map.ts  TaskPhase to animation state
packages/shared-types/src/                Zod IPC/domain contracts
packages/agent-core/src/                  provider-neutral agent loop
packages/file-tools/src/                  path policy and five tools
packages/character-runtime/src/           deterministic character state machine
tests/integration/desktop-agent.test.ts    end-to-end service composition
tests/security/permission-boundary.test.ts path/confirmation abuse cases
tests/e2e/desktop.spec.ts                  Electron user journey
```

### 任务 1：工作区与共享契约

**文件：**
- 新建： `package.json`
- 新建： `pnpm-workspace.yaml`
- 新建： `tsconfig.base.json`
- 新建： `vitest.config.ts`
- 新建： `packages/shared-types/package.json`
- 新建： `packages/shared-types/src/index.ts`
- 新建： `packages/shared-types/src/contracts.ts`
- 新建： `packages/shared-types/tests/contracts.test.ts`
- 新建： `apps/desktop/package.json`

**接口：**
- 输入： approved `MVP-SCOPE-001` through `MVP-SCOPE-012`.
- 输出： `ToolName`, `TaskPhase`, `PublicSettings`, `ToolRequest`, `PendingAction`, `TaskEvent`, and Zod schemas used by every later task.

- [ ] **步骤 1： 创建工作区清单**

```json
// package.json
{
  "name": "myself",
  "private": true,
  "version": "0.1.0-alpha.1",
  "packageManager": "pnpm@11.9.0",
  "scripts": {
    "dev:desktop": "pnpm --filter @myself/desktop dev",
    "test": "vitest run --workspace vitest.workspace.ts",
    "test:watch": "vitest --workspace vitest.workspace.ts",
    "typecheck": "pnpm -r typecheck"
  },
  "devDependencies": {
    "typescript": "^5",
    "vitest": "^3"
  }
}
```

```yaml
# pnpm-workspace.yaml
packages:
  - apps/*
  - packages/*
```

```json
// tsconfig.base.json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "useUnknownInCatchVariables": true,
    "skipLibCheck": true
  }
}
```

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: ['packages/shared-types/vitest.config.ts']
  }
});
```

- [ ] **步骤 2： 先编写失败的契约测试**

```ts
// packages/shared-types/tests/contracts.test.ts
import { describe, expect, it } from 'vitest';
import { pendingActionSchema, toolRequestSchema } from '../src/contracts';

describe('toolRequestSchema', () => {
  it('accepts a known tool and rejects an unknown tool', () => {
    expect(toolRequestSchema.parse({
      requestId: 'req-1', toolName: 'create_file', arguments: { relativePath: 'notes.md' }
    }).toolName).toBe('create_file');
    expect(() => toolRequestSchema.parse({
      requestId: 'req-2', toolName: 'run_shell', arguments: { command: 'whoami' }
    })).toThrow();
  });
});

describe('pendingActionSchema', () => {
  it('requires a target relative path and expiry', () => {
    expect(pendingActionSchema.parse({
      actionId: 'act-1', conversationId: 'conv-1', requestId: 'req-1',
      risk: 'write', summary: 'Create notes.md', targetRelativePath: 'notes.md',
      createdAt: '2026-07-20T00:00:00.000Z', expiresAt: '2026-07-20T00:02:00.000Z'
    }).risk).toBe('write');
  });
});
```

- [ ] **步骤 3： 运行测试并确认红灯状态**

运行： `pnpm install && pnpm exec vitest run packages/shared-types/tests/contracts.test.ts`

预期： FAIL because `../src/contracts` does not exist.

- [ ] **步骤 4： 实现共享契约**

```ts
// packages/shared-types/src/contracts.ts
import { z } from 'zod';

export const toolNameSchema = z.enum([
  'list_directory', 'read_text_file', 'create_file', 'create_directory', 'rename_entry'
]);
export type ToolName = z.infer<typeof toolNameSchema>;

export const taskPhaseSchema = z.enum([
  'idle', 'listening', 'thinking', 'awaiting_confirmation',
  'acting', 'success', 'error', 'cancelled'
]);
export type TaskPhase = z.infer<typeof taskPhaseSchema>;

export const toolRequestSchema = z.object({
  requestId: z.string().min(1),
  toolName: toolNameSchema,
  arguments: z.record(z.string(), z.unknown())
}).strict();
export type ToolRequest = z.infer<typeof toolRequestSchema>;

export const pendingActionSchema = z.object({
  actionId: z.string().min(1),
  conversationId: z.string().min(1),
  requestId: z.string().min(1),
  risk: z.literal('write'),
  summary: z.string().min(1),
  sourceRelativePath: z.string().min(1).optional(),
  targetRelativePath: z.string().min(1),
  createdAt: z.string().datetime(),
  expiresAt: z.string().datetime()
}).strict();
export type PendingAction = z.infer<typeof pendingActionSchema>;

export const providerProfileSchema = z.object({
  id: z.string().min(1), displayName: z.string().min(1),
  baseUrl: z.string().url(), model: z.string().min(1), hasStoredSecret: z.boolean()
}).strict();
export type ProviderProfile = z.infer<typeof providerProfileSchema>;

export const publicSettingsSchema = z.object({
  version: z.literal(1), provider: providerProfileSchema.nullable(),
  authorizedRoot: z.object({ id: z.string(), displayName: z.string(), pathHint: z.string() }).nullable(),
  petPosition: z.object({ x: z.number(), y: z.number() }).nullable(),
  fileDisclosureAccepted: z.boolean()
}).strict();
export type PublicSettings = z.infer<typeof publicSettingsSchema>;

export const taskEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('phase'), phase: taskPhaseSchema }),
  z.object({ type: z.literal('message'), role: z.enum(['user', 'assistant']), text: z.string() }),
  z.object({ type: z.literal('pending_action'), action: pendingActionSchema }),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string(), nextAction: z.string().optional() })
]);
export type TaskEvent = z.infer<typeof taskEventSchema>;
```

```ts
// packages/shared-types/src/index.ts
export * from './contracts';
```

- [ ] **步骤 5： 验证契约与类型检查**

运行： `pnpm exec vitest run packages/shared-types/tests/contracts.test.ts && pnpm typecheck`

预期： 2 tests PASS and every workspace typecheck command exits 0.

- [ ] **用户验收交接点**

交付清单与契约文件列表、锁文件差异和测试输出，由用户在 Fork 中验收并管理提交。

### 任务 2：授权根目录路径策略

**文件：**
- 新建： `packages/file-tools/package.json`
- 新建： `packages/file-tools/src/errors.ts`
- 新建： `packages/file-tools/src/path-policy.ts`
- 新建： `packages/file-tools/src/index.ts`
- 新建： `packages/file-tools/tests/path-policy.test.ts`
- 新建： `packages/file-tools/vitest.config.ts`

**接口：**
- 输入： an absolute root selected by Main and model-supplied relative paths.
- 输出： `PathPolicy.resolveExisting(relativePath)` and `PathPolicy.resolveTarget(relativePath)` returning verified absolute paths; throws stable `FileToolError` codes.

- [x] **步骤 1： 先编写路径边界测试**

```ts
// packages/file-tools/tests/path-policy.test.ts
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { rm } from 'node:fs/promises';
import { PathPolicy } from '../src/path-policy';

const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'myself-policy-'));
  roots.push(root);
  await mkdir(join(root, 'docs'));
  await writeFile(join(root, 'docs', 'a.txt'), 'hello', 'utf8');
  return { root, policy: await PathPolicy.create(root) };
}
afterEach(async () => Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))));

describe('PathPolicy', () => {
  it('resolves an existing path inside the root', async () => {
    const { policy, root } = await fixture();
    expect(await policy.resolveExisting('docs/a.txt')).toBe(join(root, 'docs', 'a.txt'));
  });
  it.each(['../outside.txt', 'C:/Windows/system.ini', '\\\\server\\share\\x', 'docs/../../x'])
    ('rejects unsafe input %s', async relativePath => {
      const { policy } = await fixture();
      await expect(policy.resolveTarget(relativePath)).rejects.toMatchObject({ code: 'PATH_INVALID' });
    });
  it('requires a target parent to exist', async () => {
    const { policy } = await fixture();
    await expect(policy.resolveTarget('missing/a.txt')).rejects.toMatchObject({ code: 'ENTRY_NOT_FOUND' });
  });
});
```

- [x] **步骤 2： 运行聚焦测试并确认失败**

运行： `pnpm exec vitest run packages/file-tools/tests/path-policy.test.ts`

预期： FAIL because `PathPolicy` is not implemented.

- [x] **步骤 3： 实现稳定错误类型与路径检查**

```ts
// packages/file-tools/src/errors.ts
export type FileToolErrorCode =
  | 'PATH_INVALID' | 'PATH_OUTSIDE_ROOT' | 'ENTRY_NOT_FOUND' | 'TARGET_EXISTS'
  | 'ENTRY_TYPE_UNSUPPORTED' | 'LINK_NOT_ALLOWED' | 'PERMISSION_DENIED' | 'ACTION_EXPIRED';

export class FileToolError extends Error {
  constructor(public readonly code: FileToolErrorCode, message: string) {
    super(message);
    this.name = 'FileToolError';
  }
}
```

```ts
// packages/file-tools/src/path-policy.ts
import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, normalize, parse, relative, sep } from 'node:path';
import { FileToolError } from './errors';

function rejectRawPath(input: string): void {
  if (!input || input.includes('\0') || isAbsolute(input) || /^[a-zA-Z]:/.test(input) || input.startsWith('\\\\')) {
    throw new FileToolError('PATH_INVALID', 'Path must be relative to the authorized root');
  }
}

function assertInside(rootReal: string, candidateReal: string): void {
  const rel = relative(rootReal, candidateReal);
  if (rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))) return;
  throw new FileToolError('PATH_OUTSIDE_ROOT', 'Path is outside the authorized root');
}

async function assertNoLinks(rootReal: string, existingPath: string): Promise<void> {
  const rel = relative(rootReal, existingPath);
  let cursor = rootReal;
  for (const part of rel.split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    if ((await lstat(cursor)).isSymbolicLink()) {
      throw new FileToolError('LINK_NOT_ALLOWED', 'Symbolic links and junctions are not allowed');
    }
  }
}

export class PathPolicy {
  private constructor(private readonly rootReal: string) {}
  static async create(root: string): Promise<PathPolicy> {
    const rootReal = await realpath(root);
    if (!(await lstat(rootReal)).isDirectory()) throw new FileToolError('ENTRY_TYPE_UNSUPPORTED', 'Root is not a directory');
    return new PathPolicy(rootReal);
  }
  async resolveExisting(input: string): Promise<string> {
    rejectRawPath(input);
    const normalized = normalize(input);
    if (normalized === '..' || normalized.startsWith(`..${sep}`)) throw new FileToolError('PATH_INVALID', 'Parent traversal is not allowed');
    let candidateReal: string;
    try { candidateReal = await realpath(join(this.rootReal, normalized)); }
    catch { throw new FileToolError('ENTRY_NOT_FOUND', 'Entry does not exist'); }
    assertInside(this.rootReal, candidateReal);
    await assertNoLinks(this.rootReal, candidateReal);
    return candidateReal;
  }
  async resolveTarget(input: string): Promise<string> {
    rejectRawPath(input);
    const normalized = normalize(input);
    const name = parse(normalized).base;
    if (!name || normalized === '..' || normalized.startsWith(`..${sep}`)) throw new FileToolError('PATH_INVALID', 'Invalid target path');
    let parentReal: string;
    try { parentReal = await realpath(join(this.rootReal, dirname(normalized))); }
    catch { throw new FileToolError('ENTRY_NOT_FOUND', 'Target parent does not exist'); }
    assertInside(this.rootReal, parentReal);
    await assertNoLinks(this.rootReal, parentReal);
    return join(parentReal, name);
  }
}
```

- [x] **步骤 4： 运行聚焦测试与包级测试**

运行： `pnpm exec vitest run packages/file-tools/tests/path-policy.test.ts`

预期： all path-policy tests PASS.

- [x] **步骤 5： 增加 Windows Junction 与前缀碰撞安全用例**

在 Windows 允许时，测试创建一个指向第二个临时目录的 `root-link` 目录 Junction，并验证返回 `LINK_NOT_ALLOWED`；同时验证名为 `work` 的根目录绝不会授权同级的 `workspace-other`。

运行： `pnpm exec vitest run packages/file-tools/tests/path-policy.test.ts`

预期： the Junction test PASSes on Windows or is explicitly skipped only when the OS denies Junction creation; prefix-collision always PASSes.

- [ ] **用户验收交接点**

交付准确的威胁用例、聚焦测试输出和文件列表，由用户使用 Fork 验收并决定提交。

### 任务 3：五个禁止覆盖的文件工具

**文件：**
- 新建： `packages/file-tools/src/schemas.ts`
- 新建： `packages/file-tools/src/file-tool-service.ts`
- 新建： `packages/file-tools/tests/file-tool-service.test.ts`
- 修改： `packages/file-tools/src/index.ts`

**接口：**
- 输入： `PathPolicy` and tool-specific Zod arguments.
- 输出： `FileToolService.preview(request)`, `executeRead(request)`, and `executeWrite(verifiedAction)`; no write method accepts arbitrary unvalidated arguments.

- [ ] **步骤 1： 为列出、读取、新建、重命名及取消安全编写测试**

```ts
// packages/file-tools/tests/file-tool-service.test.ts
it('previews create_file without touching disk, then creates exclusively', async () => {
  const { service, root } = await fixtureService();
  const action = await service.preview({ requestId: '1', toolName: 'create_file', arguments: { relativePath: 'notes.md' } });
  await expect(stat(join(root, 'notes.md'))).rejects.toThrow();
  await service.executeWrite(action);
  expect((await stat(join(root, 'notes.md'))).isFile()).toBe(true);
  await expect(service.executeWrite(action)).rejects.toMatchObject({ code: 'TARGET_EXISTS' });
});

it('renames only within the same parent and never overwrites', async () => {
  const { service, root } = await fixtureService();
  await writeFile(join(root, 'before.txt'), 'x');
  const action = await service.preview({
    requestId: '2', toolName: 'rename_entry',
    arguments: { sourceRelativePath: 'before.txt', targetRelativePath: 'after.txt' }
  });
  await service.executeWrite(action);
  expect(await readFile(join(root, 'after.txt'), 'utf8')).toBe('x');
});
```

- [ ] **步骤 2： 运行测试并确认红灯状态**

运行： `pnpm exec vitest run packages/file-tools/tests/file-tool-service.test.ts`

预期： FAIL because `FileToolService` does not exist.

- [ ] **步骤 3： 实现精确工具 Schema**

```ts
// packages/file-tools/src/schemas.ts
import { z } from 'zod';

const relativePath = z.string().min(1).max(1024);
export const toolArguments = {
  list_directory: z.object({ relativePath: relativePath.default('.') }).strict(),
  read_text_file: z.object({ relativePath }).strict(),
  create_file: z.object({ relativePath }).strict(),
  create_directory: z.object({ relativePath }).strict(),
  rename_entry: z.object({ sourceRelativePath: relativePath, targetRelativePath: relativePath }).strict()
} as const;
```

- [ ] **步骤 4： 实现预览与执行相分离的服务**

`VerifiedWriteAction` 必须包含规范化相对路径以及私有、不可伪造的服务端标识符；`executeWrite` 在调用 `open(..., 'wx')`、`mkdir(..., { recursive: false })` 或 `rename(...)` 前立即重新解析路径。`rename_entry` 拒绝不同父目录，`list_directory` 最多返回 200 项，`read_text_file` 拒绝超过 1 MiB 或非有效 UTF-8 的文件。

在 `file-tool-service.ts` 中使用职责单一的辅助方法实现；将 `EEXIST` 映射为 `TARGET_EXISTS`、`ENOENT` 映射为 `ENTRY_NOT_FOUND`、`EACCES`/`EPERM` 映射为 `PERMISSION_DENIED`，且不返回绝对路径。

```ts
export type VerifiedWriteAction =
  | { id: string; toolName: 'create_file' | 'create_directory'; targetRelativePath: string }
  | { id: string; toolName: 'rename_entry'; sourceRelativePath: string; targetRelativePath: string };

export class FileToolService {
  constructor(private readonly policy: PathPolicy) {}
  async preview(request: ToolRequest): Promise<VerifiedWriteAction> {
    if (request.toolName === 'rename_entry') {
      const args = toolArguments.rename_entry.parse(request.arguments);
      if (dirname(args.sourceRelativePath) !== dirname(args.targetRelativePath))
        throw new FileToolError('PATH_INVALID', 'Phase 1 rename must stay in one directory');
      await this.policy.resolveExisting(args.sourceRelativePath);
      await this.policy.resolveTarget(args.targetRelativePath);
      return { id: randomUUID(), toolName: request.toolName, ...args };
    }
    if (request.toolName !== 'create_file' && request.toolName !== 'create_directory')
      throw new FileToolError('PATH_INVALID', 'Read tools do not create pending actions');
    const args = toolArguments[request.toolName].parse(request.arguments);
    await this.policy.resolveTarget(args.relativePath);
    return { id: randomUUID(), toolName: request.toolName, targetRelativePath: args.relativePath };
  }
  async executeWrite(action: VerifiedWriteAction): Promise<void> {
    if (action.toolName === 'create_file') {
      const target = await this.policy.resolveTarget(action.targetRelativePath);
      const handle = await open(target, 'wx'); await handle.close(); return;
    }
    if (action.toolName === 'create_directory') {
      await mkdir(await this.policy.resolveTarget(action.targetRelativePath), { recursive: false }); return;
    }
    const source = await this.policy.resolveExisting(action.sourceRelativePath);
    const target = await this.policy.resolveTarget(action.targetRelativePath);
    try { await lstat(target); throw new FileToolError('TARGET_EXISTS', 'Target exists'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await rename(source, target);
  }
}
```

- [ ] **步骤 5： 先运行聚焦测试，再运行全部文件工具测试**

运行： `pnpm exec vitest run packages/file-tools/tests`

预期： path-policy and file-tool-service suites PASS; a duplicate create and duplicate rename target both report `TARGET_EXISTS`.

- [ ] **用户验收交接点**

提供工具 Schema、测试矩阵以及预览或取消不会修改磁盘的证据，由用户验收并决定提交。

### 任务 4：安全的 Electron 外壳、预加载、托盘与窗口

**文件：**
- 新建： `apps/desktop/electron.vite.config.ts`
- 新建： `apps/desktop/src/main/index.ts`
- 新建： `apps/desktop/src/main/windows/window-manager.ts`
- 新建： `apps/desktop/src/main/ipc/register-ipc.ts`
- 新建： `apps/desktop/src/preload/index.ts`
- 新建： `apps/desktop/src/renderer/src/main.tsx`
- 新建： `apps/desktop/src/renderer/src/App.tsx`
- 新建： `apps/desktop/src/renderer/index.html`
- 新建： `apps/desktop/tests/window-security.test.ts`

**接口：**
- 输入： shared `PublicSettings` and `TaskEvent` contracts.
- 输出： three managed windows and `window.myself` allowlisted preload API; later tasks register implementations behind it.

- [ ] **步骤 1： 编写 BrowserWindow 安全配置测试**

测试纯函数 `secureWebPreferences(preloadPath)`，断言 `nodeIntegration === false`、`contextIsolation === true`、`sandbox === true`，并验证预期 preload 路径。

运行： `pnpm --filter @myself/desktop test -- window-security.test.ts`

预期： FAIL because the helper does not exist.

- [ ] **步骤 2： 实现安全窗口工厂**

创建职责单一的 `createPetWindow`、`createChatWindow` 和 `createSettingsWindow`。桌宠窗口透明、无边框、置顶、不显示任务栏按钮并限制为小尺寸；聊天与设置使用独立窗口。所有窗口共用安全 webPreferences，并通过 `will-navigate` 与 `setWindowOpenHandler` 拒绝任意导航。

```ts
export const secureWebPreferences = (preload: string): WebPreferences => ({
  preload, nodeIntegration: false, contextIsolation: true, sandbox: true
});
function lockNavigation(win: BrowserWindow): void {
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
}
export function createPetWindow(preload: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 180, height: 220, transparent: true, frame: false,
    alwaysOnTop: true, skipTaskbar: true, resizable: false,
    webPreferences: secureWebPreferences(preload)
  });
  lockNavigation(win); return win;
}
```

- [ ] **步骤 3： 实现托盘与生命周期行为**

托盘菜单包含“打开聊天”“设置”“显示/隐藏桌宠”和“退出”。关闭聊天或设置窗口时只隐藏；明确选择“退出”才终止进程。恢复桌宠位置前必须把坐标限制在当前显示器工作区内。

```ts
const menu = Menu.buildFromTemplate([
  { label: 'Open Chat', click: () => chat.show() },
  { label: 'Settings', click: () => settings.show() },
  { label: 'Show/Hide Pet', click: () => pet.isVisible() ? pet.hide() : pet.show() },
  { type: 'separator' }, { label: 'Quit', click: () => app.quit() }
]);
tray.setContextMenu(menu);
for (const win of [chat, settings]) win.on('close', event => { event.preventDefault(); win.hide(); });
```

- [ ] **步骤 4： 暴露固定的预加载 API**

```ts
// apps/desktop/src/preload/index.ts
import { contextBridge, ipcRenderer } from 'electron';
import type { PublicSettings, TaskEvent } from '@myself/shared-types';

const api = {
  getSettings: (): Promise<PublicSettings> => ipcRenderer.invoke('settings:get'),
  saveProvider: (input: unknown): Promise<PublicSettings> => ipcRenderer.invoke('settings:save-provider', input),
  testProvider: (): Promise<{ ok: boolean; message: string }> => ipcRenderer.invoke('settings:test-provider'),
  chooseAuthorizedRoot: (): Promise<PublicSettings> => ipcRenderer.invoke('settings:choose-root'),
  submitMessage: (text: string): Promise<void> => ipcRenderer.invoke('chat:submit', { text }),
  cancelTask: (): Promise<void> => ipcRenderer.invoke('chat:cancel'),
  confirmAction: (actionId: string): Promise<void> => ipcRenderer.invoke('action:confirm', { actionId }),
  cancelAction: (actionId: string): Promise<void> => ipcRenderer.invoke('action:cancel', { actionId }),
  onTaskEvent: (listener: (event: TaskEvent) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, payload: TaskEvent) => listener(payload);
    ipcRenderer.on('task:event', handler);
    return () => ipcRenderer.removeListener('task:event', handler);
  }
};
contextBridge.exposeInMainWorld('myself', api);
```

不得暴露 `ipcRenderer`、通道名参数、文件路径或通用 invoke 方法。

- [ ] **步骤 5： 验证安全配置并执行启动冒烟测试**

运行： `pnpm --filter @myself/desktop test && pnpm --filter @myself/desktop dev`

预期： security tests PASS; pet, chat, and settings windows load; Renderer console has no Node globals.

- [ ] **用户验收交接点**

提供截图或短录屏、BrowserWindow 设置、测试输出和文件列表，由用户验收并决定提交。

### 任务 5：版本化设置与加密密钥存储

**文件：**
- 新建： `apps/desktop/src/main/storage/settings-store.ts`
- 新建： `apps/desktop/src/main/storage/secret-store.ts`
- 新建： `apps/desktop/tests/settings-store.test.ts`
- 新建： `apps/desktop/tests/secret-store.test.ts`
- 修改： `apps/desktop/src/main/ipc/register-ipc.ts`

**接口：**
- 输出： `SettingsStore.getPublic()`, `saveProviderMetadata()`, `saveAuthorizedRoot()`, `SecretStore.save()`, `readForProviderCall()`, and `clear()`.
- Renderer 只能看到 `hasStoredSecret`。

- [ ] **步骤 1： 为原子设置与密钥不泄露编写红灯测试**

测试使用临时用户数据目录和注入的伪加密适配器。断言序列化 JSON 包含 `version: 1`、绝不包含测试 API Key，并且 `getPublic()` 只返回 `hasStoredSecret: true`。

- [ ] **步骤 2： 实现小型加密适配边界**

生产适配器委托 Electron `safeStorage.encryptString/decryptString`。加密能力不可用时，`save(..., persist: true)` 返回稳定的 `SECRET_STORAGE_UNAVAILABLE` 错误；仅会话存储保留在内存中，并在退出时清除。

```ts
export class SecretStore {
  private sessionSecret: string | null = null;
  constructor(private readonly file: string) {}
  async save(secret: string, persist: boolean): Promise<void> {
    if (!persist) { this.sessionSecret = secret; return; }
    if (!safeStorage.isEncryptionAvailable()) throw new Error('SECRET_STORAGE_UNAVAILABLE');
    await writeFile(this.file, safeStorage.encryptString(secret));
  }
  async readForProviderCall(): Promise<string> {
    if (this.sessionSecret) return this.sessionSecret;
    return safeStorage.decryptString(await readFile(this.file));
  }
  async clear(): Promise<void> { this.sessionSecret = null; await rm(this.file, { force: true }); }
}
```

- [ ] **步骤 3： 实现 JSON 原子写入**

写入 `settings.json.tmp`，刷新并关闭后再替换 `settings.json`。每次读取都使用 Zod 验证；无效或损坏的设置移到带时间戳的诊断文件名，然后加载安全默认值，日志中不得出现密钥。

```ts
async function atomicWrite(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp`;
  const handle = await open(temporary, 'w');
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, path);
}
```

- [ ] **步骤 4： 注册带输入 Schema 的设置 IPC 处理器**

`settings:save-provider` 接受 displayName、baseUrl、model 和一次性 secret。除明确的 localhost HTTP 外均要求 HTTPS；`settings:get` 永远不包含密钥材料。

```ts
ipcMain.handle('settings:get', () => settings.getPublic());
ipcMain.handle('settings:save-provider', async (_event, raw) => {
  const input = saveProviderSchema.parse(raw);
  await secrets.save(input.secret, input.persistSecret);
  await settings.saveProviderMetadata(input);
  return settings.getPublic();
});
```

- [ ] **步骤 5： 运行存储测试并扫描测试密钥泄露**

运行： `pnpm --filter @myself/desktop test -- settings-store.test.ts secret-store.test.ts`

预期： all tests PASS; searching the temp settings output for the fixture secret returns no matches.

- [ ] **用户验收交接点**

提供公开/私有数据边界和泄露测试输出，由用户验收并决定提交。

### 任务 6：模型提供方适配器与有界 Agent 循环

**文件：**
- 新建： `packages/agent-core/package.json`
- 新建： `packages/agent-core/src/types.ts`
- 新建： `packages/agent-core/src/agent-loop.ts`
- 新建： `packages/agent-core/tests/agent-loop.test.ts`
- 新建： `apps/desktop/src/main/providers/openai-provider.ts`
- 新建： `apps/desktop/tests/openai-provider.test.ts`

**接口：**
- 提供 `ModelProvider.respond(request, signal): Promise<ModelResponse>`。
- 提供 `AgentLoop.run(userText, context): AsyncGenerator<AgentEvent>`。
- Provider 返回规范化文本或一个规范化 `ToolRequest`，绝不执行工具。

- [ ] **步骤 1： 定义与提供方无关的类型及失败循环测试**

使用脚本化伪 Provider 测试：纯文本；读取工具后生成最终文本；写工具进入 `awaiting_confirmation`；无效工具只修正一次；阻止第五次模型响应；中止信号产生取消状态。

- [ ] **步骤 2： 实现最小 Agent 循环**

循环持有最大值为四的响应计数器，只传递固定工具 Schema，验证每次响应并产生任务事件。遇到写请求时暂停，并返回仅保存在 Main 中的继续令牌。只有本地 `ToolExecutor` 接口可以报告工具成功。

```ts
export async function* runAgent(input: RunInput): AsyncGenerator<AgentEvent> {
  const messages = [...input.messages, { role: 'user' as const, content: input.userText }];
  for (let turn = 0; turn < 4; turn += 1) {
    const response = await input.provider.respond({ messages, tools: input.tools }, input.signal);
    if (response.type === 'text') { yield { type: 'message', text: response.text }; return; }
    const request = toolRequestSchema.parse(response.request);
    if (input.writeTools.has(request.toolName)) { yield { type: 'write_request', request, messages }; return; }
    const result = await input.executor.executeRead(request);
    messages.push({ role: 'tool', toolCallId: request.requestId, content: JSON.stringify(result) });
  }
  throw new Error('AGENT_MAX_TURNS');
}
```

- [ ] **步骤 3： 编写 OpenAI 兼容适配器契约测试**

模拟 HTTP，断言请求 URL 规范化、Bearer Header、模型、消息和五个工具定义。覆盖 401、404、429、5xx、超时、畸形 JSON、纯文本和工具调用。

- [ ] **步骤 4： 实现适配器与错误映射**

使用注入的 HTTP 客户端或 `fetch`，绝不记录请求 Header。只有 Agent 服务判定调用安全时，429/5xx 才重试一次；适配器返回规范化的可重试信息，不得重复已经完成的工具。

```ts
export class OpenAICompatibleProvider implements ModelProvider {
  constructor(private readonly profile: ProviderProfile, private readonly getSecret: () => Promise<string>) {}
  async respond(request: ModelRequest, signal: AbortSignal): Promise<ModelResponse> {
    const response = await fetch(new URL('chat/completions', this.profile.baseUrl), {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${await this.getSecret()}` },
      body: JSON.stringify({ model: this.profile.model, messages: request.messages, tools: request.tools })
    });
    if (!response.ok) throw normalizeProviderHttpError(response.status);
    return normalizeCompatibleResponse(await response.json());
  }
}
```

- [ ] **步骤 5： 验证循环与适配器测试套件**

运行： `pnpm exec vitest run packages/agent-core apps/desktop/tests/openai-provider.test.ts`

预期： all scripted flows PASS; the fake provider confirms no fifth response is requested.

- [ ] **用户验收交接点**

提供规范化请求/响应示例和有界循环测试输出，由用户验收并决定提交。

### 任务 7：主进程 Agent 服务与确认能力

**文件：**
- 新建： `apps/desktop/src/main/agent/pending-action-store.ts`
- 新建： `apps/desktop/src/main/agent/agent-service.ts`
- 新建： `apps/desktop/tests/pending-action-store.test.ts`
- 新建： `apps/desktop/tests/agent-service.test.ts`
- 修改： `apps/desktop/src/main/ipc/register-ipc.ts`

**接口：**
- 提供 `PendingActionStore.issue(actionData)`、`consume(actionId)`、`cancel(actionId)` 和 `clear(reason)`。
- 提供 `AgentService.submit(text)`、`cancelActive()`、`confirm(actionId)` 和 `cancelAction(actionId)`。

- [ ] **步骤 1： 编写确认能力测试**

验证同时只有一个待确认动作、ID 不可猜测、过期时间生效、`consume` 只能调用一次、根目录或 Provider 改变会清除动作，并且 Renderer 提供的路径无法篡改已存动作数据。

- [ ] **步骤 2： 在内存中实现 `PendingActionStore`**

使用密码学随机数生成动作 ID，默认设置较短有效期，并将公开 `PendingAction` 与私有已验证执行数据分开返回。动作绝不持久化到磁盘。

```ts
export class PendingActionStore {
  private current: { public: PendingAction; privateAction: VerifiedWriteAction } | null = null;
  issue(publicData: Omit<PendingAction, 'actionId' | 'createdAt' | 'expiresAt'>, privateAction: VerifiedWriteAction) {
    const now = Date.now();
    const actionId = randomBytes(24).toString('base64url');
    this.current = { public: { ...publicData, actionId, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 120000).toISOString() }, privateAction };
    return this.current.public;
  }
  consume(actionId: string): VerifiedWriteAction {
    const item = this.current; this.current = null;
    if (!item || item.public.actionId !== actionId || Date.parse(item.public.expiresAt) <= Date.now()) throw new Error('ACTION_EXPIRED');
    return item.privateAction;
  }
  clear(): void { this.current = null; }
}
```

- [ ] **步骤 3： 编写 Agent 服务编排测试**

使用伪 Provider、FileToolService、SettingsStore 和事件接收器，断言列出成功、新建等待确认、新建已确认、取消、Provider 失败、无效路径和目标冲突的准确阶段序列。

- [ ] **步骤 4： 实现编排与 IPC 注册**

`chat:submit` 验证非空且限长的文本，并拒绝并发任务。`action:confirm` 只接受 `actionId`，消费私有动作数据，重新验证根目录和路径，只执行一次，然后恢复 Agent 总结。每条退出路径都必须发送终止阶段。

```ts
async confirm(actionId: string): Promise<void> {
  const action = this.pending.consume(actionId);
  this.emit({ type: 'phase', phase: 'acting' });
  try { await this.fileTools.executeWrite(action); this.emit({ type: 'phase', phase: 'success' }); }
  catch (error) { this.emit(toPublicErrorEvent(error)); this.emit({ type: 'phase', phase: 'error' }); }
}
```

- [ ] **步骤 5： 运行服务测试与回归测试**

运行： `pnpm --filter @myself/desktop test -- pending-action-store.test.ts agent-service.test.ts`

预期： all phase sequences PASS; duplicate confirmation returns `ACTION_EXPIRED` and does not write twice.

- [ ] **用户验收交接点**

提供阶段轨迹、一次性确认能力证据和测试输出，由用户验收并决定提交。

### 任务 8：渲染层界面与角色状态机

**文件：**
- 新建： `packages/character-runtime/package.json`
- 新建： `packages/character-runtime/src/state-machine.ts`
- 新建： `packages/character-runtime/tests/state-machine.test.ts`
- 新建： `apps/desktop/src/renderer/src/stores/task-store.ts`
- 新建： `apps/desktop/src/renderer/src/pet/PetView.tsx`
- 新建： `apps/desktop/src/renderer/src/chat/ChatPanel.tsx`
- 新建： `apps/desktop/src/renderer/src/chat/ConfirmationCard.tsx`
- 新建： `apps/desktop/src/renderer/src/settings/SettingsView.tsx`
- 新建： `apps/desktop/src/renderer/src/character/state-map.ts`
- 新建： `apps/desktop/src/renderer/src/styles.css`
- 修改： `apps/desktop/src/renderer/src/App.tsx`

**接口：**
- 输入： preload API and `TaskEvent`.
- 输出： accessible user controls and deterministic animation state; no business decision or file path resolution.

- [ ] **步骤 1： 编写状态机与状态存储测试**

断言事件到视图状态的转换、成功/错误一次性动画回到 idle、取消行为，以及终止事件会清除待确认动作。

- [ ] **步骤 2： 实现角色状态机**

该包接受 `TaskPhase` 并返回 `idle | listening | thinking | acting | success | error`。`awaiting_confirmation` 映射为聆听/注意而不是执行，并暴露选择静态资源的减少动态效果标记。

```ts
export function characterStateFor(phase: TaskPhase): CharacterState {
  if (phase === 'thinking') return 'thinking';
  if (phase === 'acting') return 'acting';
  if (phase === 'success') return 'success';
  if (phase === 'error') return 'error';
  if (phase === 'listening' || phase === 'awaiting_confirmation') return 'listening';
  return 'idle';
}
```

- [ ] **步骤 3： 实现 Zustand 任务视图状态库**

只订阅一次 `onTaskEvent`，追加数量受限的消息，跟踪活动阶段和待确认动作，并在卸载时取消订阅。不得存储密钥或绝对路径。

```ts
export const useTaskStore = create<TaskViewState>(set => ({
  phase: 'idle', messages: [], pendingAction: null,
  apply: event => set(state => reduceTaskEvent(state, event))
}));
```

- [ ] **步骤 4： 构建三个界面层**

`PetView` 渲染当前角色资源和拖动提示；`ChatPanel` 渲染消息、输入、停止、状态与 `ConfirmationCard`；`SettingsView` 实现 Provider 保存/测试、根目录选择、隐私说明和清除数据控件。所有按钮必须使用明确动作标签，确认卡片显示动作及相对来源/目标。

- [ ] **步骤 5： 增加组件测试与人工视觉检查**

运行： `pnpm --filter @myself/desktop test`

预期： component/state tests PASS. Manually verify idle/thinking/acting/success/error, reduced motion, chat panel edge flipping, keyboard focus, and error next-action links.

- [ ] **用户验收交接点**

提供截图或录屏、状态测试、无障碍说明和文件列表，由用户验收并决定提交。

### 任务 9：桌面端集成、安全回归与端到端门禁

**文件：**
- 新建： `tests/vitest.config.ts`
- 新建： `tests/integration/desktop-agent.test.ts`
- 新建： `tests/security/permission-boundary.test.ts`
- 新建： `tests/e2e/desktop.spec.ts`
- 新建： `tests/fixtures/provider-server.ts`
- 新建： `tests/fixtures/authorized-root.ts`
- 修改： root `package.json` scripts

**接口：**
- 输入： the complete desktop service composition.
- 输出： repeatable proof for the Phase 1 desktop acceptance requirements.

- [ ] **步骤 1： 编写服务集成流程测试**

使用临时授权根目录和脚本化 Provider，在一个确定性套件中执行列出、读取、新建预览/取消、新建确认、重命名确认、越界拒绝、重复目标拒绝和重启清除待确认动作。

- [ ] **步骤 2： 编写聚焦的滥用安全用例**

覆盖路径穿越、盘符/UNC 输入、前缀碰撞、预览后替换 Junction、动作 ID 重放、Renderer 路径篡改、文件内容提示注入以及密钥/日志扫描。

- [ ] **步骤 3： 编写 Playwright Electron 端到端测试**

使用本地 Provider 测试夹具启动已打包的开发应用，完成首次配置、通过可注入测试边界选择根目录、列出、新建确认、重命名确认、取消、托盘隐藏/显示和重启位置恢复。

- [ ] **步骤 4： 增加根级验证脚本**

```json
{
  "scripts": {
    "test:unit": "vitest run --workspace vitest.workspace.ts",
    "test:security": "vitest run tests/security",
    "test:integration": "vitest run tests/integration",
    "test:e2e:desktop": "playwright test tests/e2e/desktop.spec.ts",
    "verify:desktop": "pnpm typecheck && pnpm test:unit && pnpm test:security && pnpm test:integration && pnpm test:e2e:desktop"
  }
}
```

- [ ] **步骤 5： 运行完整桌面端门禁**

运行： `pnpm verify:desktop`

预期： typecheck exits 0; all unit, security, integration, and Electron E2E tests PASS with zero leaked fixture secrets.

- [ ] **步骤 6： 执行已批准的人工演示脚本**

在 Windows 上遵循 MVP 规格第 2 节和第 21 节，记录每个检查项、环境、应用版本和失败证据。任何功能门禁失败时都不得标记桌面端核心完成。

- [ ] **用户验收交接点**

交付完整验证输出、人工验收记录、截图和变更文件列表，由用户在 Fork 中完成最终验收和提交管理。
