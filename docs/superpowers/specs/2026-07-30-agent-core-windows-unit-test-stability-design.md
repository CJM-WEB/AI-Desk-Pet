# AgentCoreExtension Windows 单元测试稳定性修复设计

> 状态：待用户审阅
> 日期：2026-07-30
> 范围：仅修复测试稳定性，不修改生产代码

## 1. 背景

`AgentCoreExtension` 在 Windows 工作树中从仓库根目录运行
`pnpm test:unit` 时出现五个失败。调查确认生产功能未表现出对应缺陷，
失败分别来自测试对当前工作目录、检出换行符和并行冷启动耗时的隐含假设。

本次修复只调整测试代码，使根级聚合测试和 desktop 包内测试在 Windows
环境下保持一致。不得借机修改桌宠、角色运行时或 MCP 生产实现。

## 2. 已确认根因

### 2.1 CSS 文件路径依赖启动目录

三个用例使用 `process.cwd()` 拼接
`src/renderer/src/styles.css`。从 `apps/desktop` 目录运行时路径有效，
从仓库根运行聚合测试时则错误指向仓库根下不存在的 `src` 目录。

### 2.2 IPC 接线断言依赖 LF

一个用例读取 `apps/desktop/src/main/index.ts` 后，与包含固定 LF 的多行字符串
比较。当前 Windows 工作树检出的是 CRLF，且仓库没有全局换行约束，
因此实现接线正确时仍会失败。

### 2.3 MCP 首次连接预算过紧

MCP stdio 集成测试把连接和能力发现的总预算固定为 1000ms。用例隔离运行
三次均在 342–415ms 内通过；与完整 desktop 测试并行时，首次 TypeScript
fixture 冷启动会超过 1000ms，随后同类连接仍能在预算内通过。

## 3. 修复设计

### 3.1 文件定位

CSS 用例改为以测试模块自身的 `import.meta.dirname` 为基准解析文件路径，
与仓库内其他稳定测试的文件读取方式保持一致。测试不再依赖调用者的
当前工作目录，也避开 jsdom 全局 `URL` 与 Node 原生 URL 对象不兼容的问题，
不改变 Vitest 的全局 `root` 或根级测试脚本。

### 3.2 源码接线断言

保留以下行为约束：

- `registerPetWindowInteractionIpc` 只注册一次；
- 注册参数包含 `ipcMain`、桌宠交互控制器、桌宠 `webContents` 和同一个
  右键菜单回调；
- 不恢复旧的 `context-menu` 监听路径；
- 菜单仍提供“打开聊天”入口。

其中固定多行字符串改为允许普通空白和 CRLF/LF 的结构正则。该断言仍验证
参数顺序和接线关系，但不再把换行格式当成业务行为。

### 3.3 MCP 测试预算

仅将 stdio 集成测试中需要成功建立连接的辅助构造器和直接构造点统一使用
3000ms 成功连接预算，为 Windows 并行冷启动留出余量。以下边界保持不变：

- 生产 `McpManager` 默认值不修改；
- 工具调用超时用例继续显式使用 30ms；
- 取消、并发限制、输出限制和连接关闭行为不放宽；
- 分页发现的总预算测试继续使用自身显式的 1000ms。

## 4. 修改范围

预计只修改以下测试文件：

- `apps/desktop/tests/renderer-components.test.tsx`
- `apps/desktop/tests/pet-view.test.tsx`
- `apps/desktop/tests/character-motion-controller.test.ts`
- `apps/desktop/tests/mcp-manager.test.ts`

不新增测试辅助模块，不修改生产代码、根脚本、Vitest 全局配置或
`.gitattributes`。

## 5. 实施顺序

1. 将 CSS 文件路径改为模块相对 URL，运行两个相关测试文件。
2. 将 IPC 接线断言改为跨平台结构正则，运行对应测试文件。
3. 调整 MCP 测试辅助构造器的成功连接预算，运行 MCP 测试文件。
4. 从仓库根运行 `pnpm test:unit`。
5. 从 `apps/desktop` 目录运行 desktop 测试，验证两种入口一致。

现有失败已经作为修复前的 RED 证据。每个修改保持独立，若某一步未按预期
转绿，则停止叠加修改并重新调查该失败。

## 6. 验收标准

- 根目录执行 `pnpm test:unit` 全部通过。
- desktop 包内测试全部通过。
- CSS 用例从根目录和 desktop 包目录启动时结果一致。
- IPC 接线断言同时兼容 CRLF 与 LF。
- MCP 成功连接用例在完整并行测试中稳定通过。
- 超时、取消和权限相关测试语义不变。
- Git 差异中不包含生产代码修改、无关重构或依赖变更。
