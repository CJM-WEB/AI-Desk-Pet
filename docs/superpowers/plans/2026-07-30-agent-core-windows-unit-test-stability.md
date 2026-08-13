# AgentCoreExtension Windows 单元测试稳定性修复实施计划

> **供代理执行者使用：** 必须使用 `superpowers:executing-plans` 按任务执行本计划，并在每个任务后复核结果。所有步骤使用复选框跟踪。

**目标：** 在不修改生产代码的前提下，使 Windows 环境下的根级和 desktop 包内单元测试稳定通过。

**架构：** 只修正测试对当前工作目录、换行格式和并行冷启动耗时的错误假设。文件读取改为基于模块目录解析，源码接线断言改为跨平台空白匹配，MCP 测试辅助构造器使用独立的成功连接预算。

**技术栈：** TypeScript、Vitest 3、Node.js、pnpm workspace、Electron desktop 测试。

## 全局约束

- 仅修改测试代码，不修改生产代码。
- 不修改根测试脚本、Vitest 全局配置、依赖或 `.gitattributes`。
- 所有文档和新增注释使用中文。
- 采用最小修改策略，不新增测试辅助模块。
- 未获得单独授权，不执行 Git 暂存、提交、合并或推送。

---

### 任务 1：消除 CSS 测试对当前工作目录的依赖

**文件：**

- 修改：`apps/desktop/tests/renderer-components.test.tsx:2-3,184-188`
- 修改：`apps/desktop/tests/pet-view.test.tsx:3-4,56-61,198-203`

**接口：**

- 输入：测试模块的 `import.meta.dirname`。
- 输出：指向 `apps/desktop/src/renderer/src/styles.css` 的绝对路径。

- [ ] **步骤 1：确认现有失败**

从仓库根运行：

```powershell
pnpm.cmd test:unit
```

预期：三个 CSS 断言以 `ENOENT` 失败，错误路径指向仓库根下的
`src/renderer/src/styles.css`。

- [ ] **步骤 2：修改 `renderer-components.test.tsx`**

保留路径解析导入：

```ts
import { resolve } from 'node:path';
```

把 CSS 读取改为：

```ts
const styles = readFileSync(
  resolve(import.meta.dirname, '../src/renderer/src/styles.css'),
  'utf8'
);
```

- [ ] **步骤 3：修改 `pet-view.test.tsx`**

保留路径解析导入：

```ts
import { resolve } from 'node:path';
```

把两处 CSS 读取都改为：

```ts
const css = readFileSync(
  resolve(import.meta.dirname, '../src/renderer/src/styles.css'),
  'utf8'
);
```

- [ ] **步骤 4：验证两个启动目录**

从仓库根运行：

```powershell
node_modules\.bin\vitest.cmd run --project desktop apps/desktop/tests/renderer-components.test.tsx apps/desktop/tests/pet-view.test.tsx
```

从 `apps/desktop` 运行：

```powershell
..\..\node_modules\.bin\vitest.cmd run --config vitest.config.ts tests/renderer-components.test.tsx tests/pet-view.test.tsx
```

预期：两个测试文件在两种启动目录下全部通过。

---

### 任务 2：使 IPC 接线断言兼容 CRLF 与 LF

**文件：**

- 修改：`apps/desktop/tests/character-motion-controller.test.ts:272-284`

**接口：**

- 输入：`apps/desktop/src/main/index.ts` 的原始源码文本。
- 输出：验证 IPC 注册参数顺序、同时忽略平台换行差异的结构断言。

- [ ] **步骤 1：确认现有失败**

从仓库根运行：

```powershell
node_modules\.bin\vitest.cmd run --project desktop apps/desktop/tests/character-motion-controller.test.ts
```

预期：固定 LF 多行字符串无法匹配 Windows CRLF 源码。

- [ ] **步骤 2：替换固定多行字符串断言**

保留注册次数、旧监听路径和菜单入口断言，仅把参数接线断言改为：

```ts
expect(source).toMatch(
  /registerPetWindowInteractionIpc\(\s*ipcMain,\s*petWindowInteraction,\s*pet\.webContents,\s*openPetContextMenu/u
);
```

该正则验证参数顺序，不约束换行符或缩进。

- [ ] **步骤 3：验证用例**

```powershell
node_modules\.bin\vitest.cmd run --project desktop apps/desktop/tests/character-motion-controller.test.ts
```

预期：文件内 30 个测试全部通过。

---

### 任务 3：放宽 MCP 测试成功连接的冷启动预算

**文件：**

- 修改：`apps/desktop/tests/mcp-manager.test.ts:695-712`

**接口：**

- 输入：stdio 测试服务配置。
- 输出：所有需要成功建立 stdio 连接的测试 `McpManager` 使用 3000ms
  成功连接预算。
- 不影响：显式 30ms 工具调用超时和显式 1000ms 分页总预算测试。

- [ ] **步骤 1：确认并行失败与隔离成功**

完整 desktop 测试中，预期首个 stdio 发现用例可能在约 1000ms 后以
`MCP_CONNECTION_FAILED` 失败。

隔离运行：

```powershell
node_modules\.bin\vitest.cmd run --project desktop apps/desktop/tests/mcp-manager.test.ts -t "通过官方 stdio 传输发现工具、资源和提示词"
```

预期：隔离用例通过，证明协议实现可用。

- [ ] **步骤 2：调整测试辅助构造器**

在 stdio 集成测试附近新增测试常量：

```ts
const STDIO_SUCCESS_TIMEOUT_MS = 3_000;
```

将 `createManager` 中的默认预算改为：

```ts
const manager = new McpManager({
  store,
  defaultTimeoutMs: STDIO_SUCCESS_TIMEOUT_MS,
  outputLimitBytes,
  inputLimitBytes
});
```

将“显式环境隔离”“固定工作目录”和“并发调用限制”三个直接构造的
`McpManager` 中的 `defaultTimeoutMs` 同样改为：

```ts
defaultTimeoutMs: STDIO_SUCCESS_TIMEOUT_MS
```

未确认启动拒绝用例不需要成功连接，继续保留显式 1000ms。

- [ ] **步骤 3：验证 MCP 测试**

```powershell
node_modules\.bin\vitest.cmd run --project desktop apps/desktop/tests/mcp-manager.test.ts
```

预期：63 个测试全部通过；工具调用超时用例仍在 300ms 内完成并返回
`MCP_TOOL_TIMEOUT`。

---

### 任务 4：执行完整回归并检查修改范围

**文件：**

- 验证：根级单元测试配置。
- 验证：desktop 包内测试配置。
- 检查：全部工作区差异。

**接口：**

- 输入：前三个任务的四个测试文件修改。
- 输出：两种测试入口均通过，且差异不包含生产代码。

- [ ] **步骤 1：运行根级单元测试**

```powershell
pnpm.cmd test:unit
```

预期：所有 shared-types、file-tools、agent-core、character-runtime、
character-assets 和 desktop 单元测试通过。

- [ ] **步骤 2：运行 desktop 包测试**

在 `apps/desktop` 目录运行：

```powershell
pnpm.cmd test
```

预期：desktop 全部测试通过。

- [ ] **步骤 3：检查类型和差异**

```powershell
pnpm.cmd --filter @myself/desktop typecheck
git diff --check
git status --short
git diff --stat
```

预期：

- TypeScript 检查通过；
- `git diff --check` 无错误；
- 仅包含已批准的规格、计划和四个测试文件；
- 不包含生产代码、依赖或配置修改。

- [ ] **步骤 4：交付结果**

报告每条验证命令的实际结果和测试数量。保留全部修改为未提交状态，
等待用户决定是否授权 Git 暂存或提交。
