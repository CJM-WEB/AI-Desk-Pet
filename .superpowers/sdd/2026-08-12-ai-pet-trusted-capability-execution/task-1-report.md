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

## 修复轮次 1/5

- 修复实现提交：`1126240 fix: 封闭命令讨论与文件正文路由`。

1. RED：在 `capability-intent-router.test.ts` 新增“运行 PowerShell 是什么？”和“执行这条命令有什么风险？”后，运行：

   ```powershell
   & '..\\..\\node_modules\\.bin\\vitest.cmd' run --config vitest.config.ts tests/capability-intent-router.test.ts
   ```

   结果：111 项中 3 项失败。前两项错误返回 `powershell_task`，证明 Shell 正向证据在知识/风险语义判定前被采纳；“读取 notes.txt，文件正文为：执行这条命令 npm test”错误返回 `file_task`，证明正文封闭只覆盖部分句式。

2. GREEN：先保留现有文件对象脱敏后的知识、否定和风险语义封闭，再判断 Shell；Shell 正则要求明确可执行请求及其载荷。文件正文结构提取正文片段并复用同一完整 Shell 正向证据函数，不使用示例字符串黑名单。

3. GREEN 验证：

   ```powershell
   & '..\\..\\node_modules\\.bin\\vitest.cmd' run --config vitest.config.ts tests/capability-intent-router.test.ts tests/conversation-coordinator.test.ts
   ```

   结果：2 个文件、158 个测试全部通过。

4. 同轮最小修改：测试套件标题由英文 `CapabilityIntentRouter` 改为中文“能力意图路由器”。

## 修复轮次 2/5

- 修复实现提交：`e6ca246 fix: 收紧命令执行请求结构`。

1. RED：新增三个同类评价/咨询句“运行 PowerShell 安全吗？”、“运行 PowerShell 好不好？”和“运行 PowerShell 值得吗？”，并补充礼貌明确执行正例“请运行 Get-ChildItem”。运行：

   ```powershell
   & '..\\..\\node_modules\\.bin\\vitest.cmd' run --config vitest.config.ts tests/capability-intent-router.test.ts
   ```

   结果：115 项中 4 项失败。三个咨询句错误返回 `powershell_task`，证明旧正则把任意非空尾词当作载荷；`请运行 Get-ChildItem`错误返回 `chat`，证明礼貌 cmdlet 请求未被识别。

2. GREEN：把“运行/执行”解析为请求结构与独立命令载荷。载荷只接受 cmdlet、包管理器子命令或脚本路径，PowerShell 宿主前缀会被剥离后再验证；后台构建/测试作为独立明确请求保留。该规则不依赖任何测试句字符串，评价/咨询自然语言因不是命令形态默认归为 `chat`。

3. GREEN 验证：

   ```powershell
   & '..\\..\\node_modules\\.bin\\vitest.cmd' run --config vitest.config.ts tests/capability-intent-router.test.ts tests/conversation-coordinator.test.ts
   ```

   结果：2 个文件、162 个测试全部通过。

## 修复轮次 3/5

- 修复实现提交：`17c65f4 fix: 支持通用显式命令载荷`。

1. RED：新增通用原生命令、解释器脚本和多段 Windows 相对脚本路径正例：“执行这条命令 git status”、“运行 node build.js”和“运行 `.\\scripts\\build.ps1`”。运行：

   ```powershell
   & '..\\..\\node_modules\\.bin\\vitest.cmd' run --config vitest.config.ts tests/capability-intent-router.test.ts
   ```

   结果：118 项中 3 项失败，三项均错误返回 `chat`；说明轮次 2 的载荷规则错误排除了普通原生命令与多段相对路径。

2. GREEN：载荷改为通用结构：首 token 必须是 ASCII 可执行标识，或以 `./`、`.\\`、`../`、`..\\` 开头的相对路径；其后最多接受 16 个非空参数。盘符、UNC、设备路径和 Unicode 自然词不符合此词法，仍保守归为 `chat`。Router 仅分类，路径授权留待后续 AST/PathPolicy。

3. GREEN 验证：

   ```powershell
   & '..\\..\\node_modules\\.bin\\vitest.cmd' run --config vitest.config.ts tests/capability-intent-router.test.ts tests/conversation-coordinator.test.ts
   ```

   结果：2 个文件、165 个测试全部通过。

## 修复轮次 4/5

- 修复实现提交：`dcfeaa9 fix: 拒绝未引用的命令评价尾句`；子智能体审批拒绝后由主控依据用户直接授权提交。

1. RED：新增两个不同命令与问法的中文评价句“运行 git 安全吗？”、“运行 node 合适吗？”，以及英文评价问句“Run git - is that safe?”；同时增加四个引号内疑问参数或中文路径正例。运行：

   ```powershell
   pnpm.cmd exec vitest run --config vitest.config.ts tests/capability-intent-router.test.ts
   ```

   结果：125 项中 3 项按预期失败，三个未引用评价问句均错误返回 `powershell_task`；引号内的疑问参数与中文路径保持通过。

2. 根因：通用 Shell 载荷正则只约束首 token 为 ASCII 可执行标识或显式相对路径，其后的 `\S+` 参数可接受任意 Unicode 与问句尾部，因此自然语言评价被误当作命令参数。

3. GREEN：仅在 `isShellCommandPayload` 载荷校验接缝增加统一结构化否定：先等长屏蔽成对引号，再将未引用 Unicode 参数或句尾问号视为无法与咨询稳定区分的歧义尾句，保守回落 `chat`。该实现不硬编码整句、不依赖中英文评价词黑名单、不回退到命令白名单；成对引号内的疑问结构与中文路径/参数不参与否定。

4. GREEN 与回归验证：

   - Router 单文件：125 项全部通过。
   - Router + Coordinator：2 个文件、172 项全部通过。
   - `pnpm.cmd --filter @myself/desktop typecheck`：通过。
   - 旧名静态检索：无命中。
   - `git diff --check`：通过。
   - `git diff --name-only -- apps/website`：无输出，网站零差异；本轮未执行任何网站命令。
