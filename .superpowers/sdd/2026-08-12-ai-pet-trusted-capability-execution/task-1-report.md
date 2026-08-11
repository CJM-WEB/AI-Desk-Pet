# Task 1（C1）执行报告

## 结果

- 状态：DONE
- 最终定向测试：2 个文件、155 个测试通过。
- 实现提交：`ff1cc53 refactor: 统一桌宠能力意图路由`。

## TDD 记录

1. RED：新增 `capability-intent-router.test.ts` 后，运行：

   ```powershell
   & '..\\..\\node_modules\\.bin\\vitest.cmd' run --config vitest.config.ts tests/capability-intent-router.test.ts tests/conversation-coordinator.test.ts
   ```

   失败原因：新模块 `capability-intent-router` 不存在；原有 Coordinator 测试 46 项通过。

2. RED：新增 Coordinator 的 PowerShell 未就绪测试后，运行：

   ```powershell
   & '..\\..\\node_modules\\.bin\\vitest.cmd' run --config vitest.config.ts tests/conversation-coordinator.test.ts
   ```

   失败原因：明确的“执行这条命令 npm test”被旧聊天路径处理，公开错误码为 `AGENT_INTERNAL_ERROR`，而非期望的 `POWERSHELL_TASK_NOT_READY`；46 项既有测试通过、1 项新增测试失败。

3. GREEN：移动成熟文件意图词法器、加入锚定 Shell 正向证据并迁移 Coordinator 后，运行同一双文件命令。第一次得到 5 项失败：中文 Shell 正则的词界错误、文件正文 Shell 文本未封闭为聊天，以及手工迁移时遗漏旧性能夹具中的句号。分别以最小修改修复。

4. GREEN：再次运行双文件命令，2 个文件、155 个测试全部通过。

## 验证命令

- `pnpm.cmd --filter @myself/desktop test -- capability-intent-router.test.ts conversation-coordinator.test.ts`
  - 现有脚本把第二个 `--` 传给 Vitest，导致筛选参数未被收集，实际执行了完整已有套件；因此不作为定向 RED/GREEN 证据。
- `pnpm.cmd --filter @myself/desktop typecheck`
  - 通过。
- `pnpm.cmd --filter @myself/desktop test`
  - 完整桌面端套件通过。既有角色加载和 jsdom Canvas 测试输出预期诊断；无失败。
- `rg -n "ExplicitFileIntentGate|explicit-file-intent-gate" apps/desktop --glob '!apps/website/**'`
  - 无命中。
- `git diff --check`
  - 无输出。
- `git diff --name-only -- apps/website`
  - 无输出，网站零差异；未修改、构建、启动或测试网站。

## 修改范围

- 新增：`apps/desktop/src/main/conversation/capability-intent-router.ts`
- 新增：`apps/desktop/tests/capability-intent-router.test.ts`
- 修改：`apps/desktop/src/main/conversation/conversation-coordinator.ts`
- 修改：`apps/desktop/tests/conversation-coordinator.test.ts`
- 删除：`apps/desktop/src/main/conversation/explicit-file-intent-gate.ts`
- 删除：`apps/desktop/tests/explicit-file-intent-gate.test.ts`

## 冲突与取舍

旧 Gate 会把“读取 notes.txt，文件正文是：运行 PowerShell ……”作为文件读取请求。C1 已确认的新安全目标要求文件正文中的命令不能触发能力，因此 Router 在识别到明确的“文件正文 + Shell 命令”结构时封闭为 `chat`。该变化只覆盖新要求指定的混合文本，保留其余已审查文件词法与迁移测试。

## 自审

- Router 是 Coordinator 的唯一能力分流入口；文件任务仍复用原有成熟词法器和文件链。
- `powershell_task` 只由明确、消息开头的正向执行措辞产生；未实现执行端口时稳定报 `POWERSHELL_TASK_NOT_READY`，不创建聊天 Provider、不触发文件端口、不写历史。
- `ExplicitBehaviorHint` 在 C1 是无成员的封闭联合，`chat.behaviorHint` 恒为 `null`，不授予能力。
- 路由证据不含文件路径、命令或正文；三种意图互斥。
