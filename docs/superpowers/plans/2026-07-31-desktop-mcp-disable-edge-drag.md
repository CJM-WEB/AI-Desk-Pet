# 桌宠 MCP 暂停开放与边缘拖拽修复实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在完整保留 MCP 源码和持久化数据的前提下关闭桌面端 MCP 运行时入口，并修复桌宠位于工作区边缘时被自动运动写回、无法向屏幕内部拖动的问题。

**Architecture:** 新增共享、只读的桌面能力策略，由 Main 服务和 Renderer 共同读取；Main 在服务边界拒绝所有 MCP 操作并返回空工具集合，Renderer 隐藏 MCP 导航和面板。拖拽期间由 `PetWindowInteractionController` 独占窗口位置写入，`CharacterMotionService` 只同步真实坐标快照，拖拽结束后再从最终位置恢复自动运动。

**Tech Stack:** TypeScript、Electron 43、React 19、Vitest 3、Playwright 1.61、pnpm 11。

## 全局约束

- 严格执行测试先行：每个行为先增加失败测试并确认失败原因，再写最小实现。
- MCP 代码、IPC、Preload、Manager、Store、设置组件和依赖均保留，不删除、不重构。
- MCP 禁用策略固定在代码中，不从环境变量、用户设置或本地文件读取。
- 禁用期间不得读取、保存、删除、恢复或迁移 MCP 设置与密钥。
- 拖拽根因测试若不能证明“用户拖拽与自动运动双写竞争”，立即停止该实现，转而记录 Renderer 命中、IPC 会话、系统光标、窗口写入者和窗口事件顺序。
- 桌宠始终完整位于当前显示器工作区；不得以允许窗口越界规避拖拽问题。
- 所有新增文档和结构性注释使用中文。
- 每项任务完成后先运行目标测试，再进行相关回归；不得依赖固定时长休眠。

---

### Task 1: 建立共享 MCP 能力策略与 Main 硬禁用边界

**Files:**

- Create: `apps/desktop/src/shared/desktop-runtime-capabilities.ts`
- Modify: `apps/desktop/src/main/settings/desktop-settings-service.ts`
- Test: `apps/desktop/tests/desktop-settings-service.test.ts`

- [ ] **Step 1: 为初始化、Dashboard 和 Agent 工具注册补充失败测试**

在 `desktop-settings-service.test.ts` 中复用 `createFixture()`，预置一条 MCP 设置和对应密钥读取结果，验证：

```ts
await fixture.service.initialize();

expect(fixture.settings.getMcpServerSettings).not.toHaveBeenCalled();
expect(fixture.secrets.readForProviderCall).not.toHaveBeenCalled();
expect(fixture.mcpStore.list()).toEqual([]);
expect((await fixture.service.getDashboard()).mcpServers).toEqual([]);
expect(await fixture.service.enabledReadToolRegistrations()).toEqual([]);
expect(fixture.mcpManager.connect).not.toHaveBeenCalled();
```

同时保存设置和 Secret mock 的调用计数，证明初始化、读取 Dashboard 和注册 Agent 工具均未触发 MCP 持久化写入。

- [ ] **Step 2: 为全部 MCP 操作补充统一拒绝和零副作用测试**

以表驱动方式调用下列入口：

```ts
fixture.service.upsertMcpServer(input)
fixture.service.confirmMcpLaunch('server-1', 'fingerprint')
fixture.service.testMcpServer('server-1')
fixture.service.setMcpServerEnabled('server-1', true)
fixture.service.setMcpToolEnabled('server-1', 'read-note', true)
fixture.service.authorizeMcpToolReadOnly('server-1', 'read-note')
fixture.service.revokeMcpToolReadOnly('server-1', 'read-note')
fixture.service.deleteMcpServer('server-1')
fixture.service.executeMcpRead('mcp.server-1.read-note', {})
```

每个调用都应拒绝为：

```ts
await expect(operation()).rejects.toThrow('MCP_MODULE_DISABLED');
```

随后断言 `settings`、`secrets`、`mcpStore` 和 `mcpManager` 的读写、连接、断开及执行方法均未发生新的调用。`close()` 仍应调用一次 `mcpManager.close()`。

- [ ] **Step 3: 运行目标测试并确认 RED 原因**

Run:

```powershell
pnpm vitest run --project desktop apps/desktop/tests/desktop-settings-service.test.ts
```

Expected: 新测试因当前仍读取 MCP 设置、公开 MCP 数据、连接工具或执行 MCP 操作而失败；不得接受导入错误、测试夹具错误或无关断言失败。

- [ ] **Step 4: 新增共享能力常量**

创建 `desktop-runtime-capabilities.ts`：

```ts
/** 桌面端当前版本的静态运行时能力策略。 */
export const desktopRuntimeCapabilities = {
  mcp: false
} as const;
```

不增加环境变量、设置读取器或动态覆盖入口。

- [ ] **Step 5: 在 Main 服务入口实施最小硬禁用**

在 `DesktopSettingsService` 中导入共享能力常量，增加集中守卫：

```ts
function assertMcpEnabled(): void {
  if (!desktopRuntimeCapabilities.mcp) {
    throw new Error('MCP_MODULE_DISABLED');
  }
}
```

按以下顺序落地：

- `initialize()` 在 MCP 能力关闭时跳过整个 MCP 设置和密钥恢复循环；
- `getDashboard()` 在能力关闭时固定返回 `mcpServers: []`；
- 九个 MCP 操作方法在方法首行调用 `assertMcpEnabled()`；
- `enabledReadToolRegistrations()` 在关闭时立即返回 `[]`；
- `executeMcpRead()` 在调用 Manager 前执行守卫；
- `close()` 保持防御性 `mcpManager.close()`，不改变隐私会话清理。

不得改动 IPC 和 Preload 的公开签名。

- [ ] **Step 6: 运行目标测试并确认 GREEN**

Run:

```powershell
pnpm vitest run --project desktop apps/desktop/tests/desktop-settings-service.test.ts
```

Expected: PASS；原有 MCP Manager、Store 和风险判定测试仍保留并通过。

- [ ] **Step 7: 运行 Main 设置与 IPC 相关回归**

Run:

```powershell
pnpm vitest run --project desktop apps/desktop/tests/advanced-settings-ipc.test.ts apps/desktop/tests/mcp-manager.test.ts apps/desktop/tests/mcp-server-store.test.ts apps/desktop/tests/desktop-settings-service.test.ts
```

Expected: PASS。若旧 IPC 测试仍期待 MCP 成功，应只调整产品边界断言为 `MCP_MODULE_DISABLED`，不得删除接口覆盖。

- [ ] **Step 8: 提交 Task 1**

```powershell
git add apps/desktop/src/shared/desktop-runtime-capabilities.ts apps/desktop/src/main/settings/desktop-settings-service.ts apps/desktop/tests/desktop-settings-service.test.ts apps/desktop/tests/advanced-settings-ipc.test.ts
git commit -m "feat：暂停桌面端 MCP 运行时"
```

---

### Task 2: 隐藏 Renderer MCP 入口并处理异常标签状态

**Files:**

- Modify: `apps/desktop/src/renderer/src/settings/SettingsView.tsx`
- Test: `apps/desktop/tests/renderer-components.test.tsx`

- [ ] **Step 1: 补充设置导航和异常状态失败测试**

从现有 `SettingsWorkspace` 测试提取最小公共 Props 构造器，增加两项断言：

```ts
const normalMarkup = renderToStaticMarkup(
  <SettingsWorkspace {...props} activeTab="local" />
);
expect(normalMarkup).not.toContain('工具');

const invalidMarkup = renderToStaticMarkup(
  <SettingsWorkspace {...props} activeTab="tools" />
);
expect(invalidMarkup).not.toContain('MCP');
expect(invalidMarkup).toContain('模型服务');
```

测试必须同时证明工具标签不存在、MCP 表单不渲染、异常 `tools` 状态有明确的有效页面回退，而不是空白。

- [ ] **Step 2: 运行组件测试并确认 RED**

Run:

```powershell
pnpm vitest run --project desktop apps/desktop/tests/renderer-components.test.tsx
```

Expected: 当前“工具”导航或 `McpSettings` 仍存在导致失败。

- [ ] **Step 3: 使用共享能力策略过滤导航与内容**

在 `SettingsView.tsx` 导入 `desktopRuntimeCapabilities`：

- `tabs` 由完整定义过滤掉能力关闭的 `tools`；
- `SettingsWorkspace` 将无效的 `activeTab="tools"` 规范化为 `models`；
- 导航高亮和内容分支统一使用规范化后的标签；
- 保留 `SettingsTab` 的 `tools` 联合成员、`McpSettings` 源码和 `mcpActions` Props，以便未来恢复且兼容现有调用边界。

建议使用一个局部纯函数，避免导航和内容各自实现不同的回退规则：

```ts
function availableSettingsTab(tab: SettingsTab): Exclude<SettingsTab, 'tools'> {
  return tab === 'tools' && !desktopRuntimeCapabilities.mcp ? 'models' : tab;
}
```

- [ ] **Step 4: 运行目标测试和 Renderer 回归**

Run:

```powershell
pnpm vitest run --project desktop apps/desktop/tests/renderer-components.test.tsx apps/desktop/tests/settings-view.test.tsx
```

如果仓库不存在 `settings-view.test.tsx`，使用：

```powershell
pnpm vitest run --project desktop apps/desktop/tests/renderer-components.test.tsx
pnpm --filter @myself/desktop typecheck
```

Expected: PASS，且 TypeScript 不因标签联合类型缩窄报错。

- [ ] **Step 5: 提交 Task 2**

```powershell
git add apps/desktop/src/renderer/src/settings/SettingsView.tsx apps/desktop/tests/renderer-components.test.tsx
git commit -m "feat：隐藏桌面端 MCP 设置入口"
```

---

### Task 3: 用交错测试证明拖拽双写根因

**Files:**

- Modify: `apps/desktop/tests/character-motion-controller.test.ts`
- Reference: `apps/desktop/src/main/characters/character-motion-service.ts`
- Reference: `apps/desktop/src/main/windows/pet-window-interaction-controller.ts`

- [ ] **Step 1: 增加左上角交错顺序失败测试**

构造不自动触发 `move` 事件的窗口替身并记录所有 `setPosition`：

```ts
let bounds = { x: 0, y: 0, width: 180, height: 220 };
const setPosition = vi.fn((x: number, y: number) => {
  bounds = { ...bounds, x, y };
});
```

测试顺序严格模拟：

1. 自动运动目标位于左上角；
2. `beginUserMove()` 建立用户移动所有权；
3. 拖拽控制器已把窗口写到 `{ x: 24, y: 18 }`，但尚无 `move` 事件反馈；
4. 推进时间并调用 `service.tick()`；
5. 期望自动运动不调用 `setPosition()`，快照位置和目标均为 `{ x: 24, y: 18 }`。

测试前清空拖拽控制器写入产生的 mock 记录，确保只观察 `tick()` 是否成为第二个写入者。

- [ ] **Step 2: 运行根因测试并确认 RED 证据**

Run:

```powershell
pnpm vitest run --project desktop apps/desktop/tests/character-motion-controller.test.ts -t "用户拖拽期间自动运动不覆盖窗口位置"
```

Expected: 失败必须明确显示 `tick()` 调用了 `setPosition()` 或快照回到了旧目标。

若失败来自测试夹具、时钟或命名匹配，先修正测试；若测试未能证明自动运动发生第二次写入，停止 Task 3，不修改生产代码，并按设计文档继续追踪 Renderer 命中、IPC、光标差值、`setPosition` 调用方及 `move/moved` 顺序。

- [ ] **Step 3: 增加拖拽生命周期的失败覆盖**

继续增加：

- 用户移动期间连续多次 `tick()` 均读取最新 `getBounds()`，且不写窗口；
- `endUserMove()` 后最终坐标成为目标，下一次 `tick()` 不回弹；
- 快照 `revision` 和 `timestampMs` 单调递增；
- `direction`、`carrying` 不因暂停自动写入而改变。

- [ ] **Step 4: 再次运行目标测试确认失败集中于所有权冲突**

Run:

```powershell
pnpm vitest run --project desktop apps/desktop/tests/character-motion-controller.test.ts
```

Expected: 只有新增的拖拽所有权断言失败，现有程序化运动、窗口事件和空闲播放测试通过。

---

### Task 4: 让用户拖拽期间独占窗口位置写入

**Files:**

- Modify: `apps/desktop/src/main/characters/character-motion-service.ts`
- Modify: `apps/desktop/tests/character-motion-controller.test.ts`

- [ ] **Step 1: 在 `tick()` 增加用户移动同步分支**

在读取 `now` 和窗口边界后、调用 `advanceMotion()` 前，增加结构性注释和最小分支：

```ts
// 用户拖拽期间窗口位置只由拖拽控制器写入，运动服务仅同步真实坐标。
if (this.userMoving) {
  const position = { x: bounds.x, y: bounds.y };
  this.target = position;
  this.lastTickMs = now;
  this.latestSnapshot = {
    revision: ++this.revision,
    timestampMs: now,
    position,
    target: { ...position },
    direction: this.direction,
    moving: false,
    carrying: this.carrying
  };
  for (const listener of [...this.listeners]) listener(this.latestSnapshot);
  return structuredClone(this.latestSnapshot);
}
```

不得调用 `setPosition()`，不得向 `expectedProgrammaticPositions` 增加记录，不改变计时器生命周期。

- [ ] **Step 2: 保持结束拖拽后的最终位置语义**

复核 `endUserMove()` 的调用顺序，使其在 `userMoving` 仍为 `true` 时通过 `handleWindowMoved()` 接管最终位置，再退出用户移动状态：

```ts
this.handleWindowMoved();
this.userMoving = false;
```

除非失败测试证明必要，不新增第二套快照发布方法或大范围重构。

- [ ] **Step 3: 运行运动服务目标测试**

Run:

```powershell
pnpm vitest run --project desktop apps/desktop/tests/character-motion-controller.test.ts
```

Expected: PASS，交错测试证明 `tick()` 不再成为拖拽期间的第二写入者。

- [ ] **Step 4: 运行拖拽控制器边界矩阵回归**

在 `pet-window-interaction-controller.test.ts` 中确认或补足表驱动覆盖：

- 左上、右上、左下、右下四角向内部拖动；
- 上、下、左、右四边向内部拖动；
- 非零工作区原点；
- 负坐标显示器；
- 向屏幕外拖动时按窗口宽高夹紧；
- 取消、超时、窗口销毁和 Renderer 会话失效后的安全清理。

只在现有覆盖缺失时增加测试，不重复已有用例。

Run:

```powershell
pnpm vitest run --project desktop apps/desktop/tests/pet-window-interaction-controller.test.ts apps/desktop/tests/character-motion-controller.test.ts
```

Expected: PASS；所有最终坐标满足：

```text
workArea.x <= x <= workArea.x + workArea.width - window.width
workArea.y <= y <= workArea.y + workArea.height - window.height
```

- [ ] **Step 5: 提交 Task 3 与 Task 4**

```powershell
git add apps/desktop/src/main/characters/character-motion-service.ts apps/desktop/tests/character-motion-controller.test.ts apps/desktop/tests/pet-window-interaction-controller.test.ts
git commit -m "fix：修复桌宠边缘拖拽位置竞争"
```

---

### Task 5: 增加 Electron 验收并完成全量验证

**Files:**

- Modify: `tests/e2e/desktop.spec.ts`
- Modify if needed: `tests/fixtures/electron-app.ts`

- [ ] **Step 1: 为 E2E 夹具增加最小受限探针**

优先复用现有窗口发现和 `getPetInteractionProbe()`。仅当现有 CDP 能力无法读取或设置桌宠窗口边界时，在 `electron-app.ts` 增加最小、只读/受限测试探针：

- 读取桌宠窗口边界和当前显示器工作区；
- 将桌宠窗口定位到当前工作区左上角；
- 读取 Agent 当前注册工具名称。

探针仅在 E2E 测试环境开放，不向正式 Preload API 增加任意窗口控制或任意代码执行能力。

- [ ] **Step 2: 新增 MCP 隐藏和零注册 E2E**

启动正式 Electron 后：

1. 打开设置；
2. 等待设置可见；
3. 断言不存在名为“工具”的导航按钮；
4. 断言页面没有 MCP 服务配置表单；
5. 通过受限探针断言 Agent 工具名中不存在 `mcp.` 前缀。

所有等待使用 `expect(...).toBeVisible()`、`expect.poll()` 或窗口状态条件，不使用固定 `sleep`。

- [ ] **Step 3: 新增左上角真实拖拽 E2E**

测试流程：

1. 将桌宠窗口定位到工作区左上角；
2. 在桌宠可见且可命中的像素上按下；
3. 使用 Playwright 鼠标连续向右下移动并释放；
4. `expect.poll()` 等待窗口坐标满足 `x > workArea.x` 且 `y > workArea.y`；
5. 断言窗口右边和下边未超出工作区；
6. 断言交互探针最终为 `dragging: false`，穿透状态恢复为安全值。

若透明像素命中不稳定，复用项目已有角色可见像素/交互探针，不扩大生产接口。

- [ ] **Step 4: 验证 MCP 持久化数据逐字节不变**

在 E2E 启动前向隔离的 `userDataDirectory` 写入一份有效 MCP 设置和密钥快照；完成启动、设置页访问、Agent 请求及关闭后，使用 `Buffer.equals()` 比较启动前后内容。

Expected:

- 文件仍存在；
- 字节完全一致；
- 日志中没有 MCP 连接或子进程启动痕迹；
- E2E 失败输出经过现有脱敏器处理，不显示密钥、命令、URL 或路径。

- [ ] **Step 5: 运行目标 Electron E2E**

Run:

```powershell
pnpm test:e2e:desktop --grep "MCP 暂停与左上角拖拽"
```

Expected: PASS。若 Playwright 参数透传方式不兼容，改用：

```powershell
pnpm --filter @myself/desktop build
pnpm exec playwright test --config tests/playwright.config.ts tests/e2e/desktop.spec.ts --grep "MCP 暂停与左上角拖拽"
```

- [ ] **Step 6: 执行完整验证**

依次运行：

```powershell
pnpm --filter @myself/desktop typecheck
pnpm test:unit
pnpm test:security
pnpm test:integration
pnpm test:e2e:desktop
```

Expected:

- 类型检查通过；
- 单元、安全、集成和 Electron E2E 全部通过；
- 无新增未处理 Promise、固定等待或敏感信息输出。

- [ ] **Step 7: 检查变更范围和持久化安全**

Run:

```powershell
git diff --check
git status --short
git diff --stat
git diff -- apps/desktop/src/shared/desktop-runtime-capabilities.ts apps/desktop/src/main/settings/desktop-settings-service.ts apps/desktop/src/renderer/src/settings/SettingsView.tsx apps/desktop/src/main/characters/character-motion-service.ts
```

确认：

- 没有删除 MCP 源码、依赖、IPC 或 Preload；
- 没有新增 MCP 数据迁移、清理或动态开关；
- 拖拽改动只处理窗口写入所有权；
- 不夹带模型目录、自由对话、长期记忆等后续阶段需求。

- [ ] **Step 8: 提交最终 E2E 与验收变更**

```powershell
git add tests/e2e/desktop.spec.ts tests/fixtures/electron-app.ts
git commit -m "test：覆盖 MCP 暂停与边缘拖拽验收"
```

- [ ] **Step 9: 请求最终代码审查**

使用 `superpowers:requesting-code-review` 检查：

- 需求 4 和 5 是否全部满足；
- MCP 数据是否确实零读写、零连接；
- 拖拽根因是否由失败测试证明；
- Renderer、Main 和 Agent 边界是否一致；
- 多显示器边界和异常清理是否无回归。

审查发现问题时，先增加或修正失败测试，再做最小修复并重新执行完整验证。
