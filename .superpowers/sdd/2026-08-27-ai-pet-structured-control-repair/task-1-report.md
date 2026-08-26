# 任务 1 实施报告

## 范围

- 日期：2026-08-27
- 分支：`AgentCoreExtension`
- 规格：`docs/superpowers/specs/2026-08-27-ai-pet-structured-control-repair-design.md`
- 任务：稳定统一控制计划契约与自然语言入口。
- 非范围：未修改 Agent 执行器、Provider、Scheduler、IPC、Renderer 或权限执行链。

## RED 证据

1. `pnpm.cmd --filter @myself/agent-core test`
   - 退出码：`1`。
   - 结果：既有 84 项通过；新增测试套件因 `capability-control-plan.ts` 尚不存在而失败。
2. `pnpm.cmd --filter @myself/character-runtime test`
   - 退出码：`1`。
   - 结果：既有 303 项通过；新增 12 项因 `movementControlPlanSchema` 尚不存在而失败。
3. `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/capability-intent-router.test.ts tests/explicit-character-behavior-gate.test.ts`
   - 退出码：`1`。
   - 结果：255 项中 245 项通过、10 项失败；截图原句及一个常见语序仍落入 `chat`，8 条运动归一化断言缺少 `movementControl`。新增否定、讨论、引用和代码安全负例均通过。
4. 相对方向补充 RED：`pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/explicit-character-behavior-gate.test.ts`
   - 退出码：`1`。
   - 结果：78 项中 76 项通过、2 项失败；`up/down` 尚未归一为公开目标 `top/bottom`。

## GREEN 证据

- `pnpm.cmd --filter @myself/agent-core test`：4 个文件、93/93 通过。
- `pnpm.cmd --filter @myself/agent-core typecheck`：退出码 `0`。
- `pnpm.cmd --filter @myself/character-runtime test`：15 个文件、315/315 通过。
- `pnpm.cmd --filter @myself/character-runtime typecheck`：退出码 `0`。
- `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/capability-intent-router.test.ts tests/explicit-character-behavior-gate.test.ts`：2 个文件、257/257 通过。
- `pnpm.cmd --filter @myself/desktop typecheck`：退出码 `0`。
- `git diff --check`：退出码 `0`；只有 Windows 行尾转换提示，无空白错误。
- 首次 `pnpm.cmd --filter @myself/desktop test`：2582 项中 2581 项通过、1 项失败；失败准确暴露结构化澄清续接没有命中封闭 Router。
- 增加精确内部补充标记语法后，`capability-intent-router + conversation-coordinator + explicit-character-behavior-gate`：362/362 通过。
- 重新运行 `pnpm.cmd --filter @myself/desktop test`：104 个文件、2582/2582 通过；测试夹具既有 stderr 不包含断言失败。

## 修改文件

- `packages/agent-core/src/capability-control-plan.ts`
- `packages/agent-core/src/index.ts`
- `packages/agent-core/package.json`
- `packages/agent-core/tests/capability-control-plan.test.ts`
- `packages/character-runtime/src/character-behavior-plan.ts`
- `packages/character-runtime/tests/character-behavior-plan.test.ts`
- `apps/desktop/src/main/conversation/capability-intent-router.ts`
- `apps/desktop/src/main/conversation/explicit-character-behavior-gate.ts`
- `apps/desktop/tests/capability-intent-router.test.ts`
- `apps/desktop/tests/explicit-character-behavior-gate.test.ts`
- `pnpm-lock.yaml`
- `.superpowers/sdd/2026-08-27-ai-pet-structured-control-repair/task-1-report.md`

`packages/character-runtime/src/index.ts` 已经通过 `export * from './character-behavior-plan'` 公开新增契约，无需制造重复导出差异。Agent Core 直接使用仓库既有 `zod@3.25.76`，仅补充直接依赖声明与锁文件 importer，没有引入新版本或第二套校验器。

## 自审结论

- `CapabilityControlPlan` 与 `MovementControlPlan` 均为严格判别联合，额外字段、未知工具、越界模式、坐标目标和 `distance: none` 均被拒绝。
- 文件 Router 已删除依赖地点、礼貌词和操作固定排列的中文正则；正向路径只组合操作、本地对象、执行请求和同句关系，没有无界 `.*` 或 `.+`。
- 无空格的 `ab.txt文件` 通过目标槽线性裁剪识别；复合操作词和相对路径的既有用例保持通过。
- 否定、知识讨论、引用与代码块继续封闭；普通聊天不会因此获得文件或运动能力。
- 显式行为 Gate 规范化输出 `keep/set_mode/move_once`；旧显式指令仅为当前 Director 兼容保留，持久状态单入口删除由计划任务 3 完成。
- 未发现任务 1 范围外修改。

## 提交

- 提交信息：`feat(control): 统一桌宠能力与运动控制契约`
- 提交哈希：以本报告所在提交的 `git rev-parse HEAD` 输出为准；Git 提交不能在自身内容中内嵌自己的最终哈希。

## 修复轮 1/5：封闭拒绝证据与跨句绑定

### RED 证据

- 命令：`pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/capability-intent-router.test.ts tests/explicit-character-behavior-gate.test.ts`
- 退出码：`1`。
- 结果：2 个文件共 271 项，261 项通过、10 项失败。
- Router 的 6 项预期失败覆盖：省略“在”的本地点状语、`不用`/`不必` 否定同义词、分析流程、无成对引号的引用语境，以及英文请求跨句借用后续操作和目标。
- 行为 Gate 的 4 项预期失败覆盖：动作短语后接“是什么意思”“为什么”“怎么”等知识问句。

### GREEN 与门禁证据

- 同一 Desktop 定向命令：2 个文件、271/271 通过。
- `pnpm.cmd --filter @myself/agent-core test`：4 个文件、93/93 通过。
- `pnpm.cmd --filter @myself/agent-core typecheck`：退出码 `0`。
- `pnpm.cmd --filter @myself/character-runtime test`：15 个文件、315/315 通过。
- `pnpm.cmd --filter @myself/character-runtime typecheck`：退出码 `0`。
- `pnpm.cmd --filter @myself/desktop typecheck`：退出码 `0`。
- `git diff --check`：退出码 `0`；只有 Windows 行尾转换提示，无空白错误。

### 最小修复与自审

- 文件 Router 补齐否定、分析流程和引用语境的拒绝证据；省略“在”的本地点状语作为独立执行句式证据，不新增固定动宾排列。
- `hasExecutionStructure` 只接收已绑定的操作槽；英文直接请求只授权首个已绑定操作，并继续要求操作与目标同句，后续句子不能借用前句请求权限。
- 行为 Gate 在动作解析后、边界接受前拒绝知识问句后缀，保留既有组合能力分流。
- 修复只修改 Router、行为 Gate 及其测试，没有触碰 Agent 执行器、Provider、Scheduler、IPC 或权限执行链。
- 未发现新的人工验收项；剩余风险是自然语言拒绝词表仍为封闭集合，后续新增表达应继续以安全负例驱动扩展。

## 修复轮 2/5：对象名边界与可行性咨询

### RED 证据

- 命令：`pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/capability-intent-router.test.ts`
- 退出码：`1`。
- 结果：196 项中 190 项通过、6 项失败。
- 预期失败覆盖：`别` 否定漏判；`流程文件夹`、`分析文件` 两个合法对象名被全局知识词误伤；三种句尾可行性咨询错误进入文件任务。
- 保护性正例 `可以帮我创建a.txt吗` 在 RED 阶段已经通过，证明测试没有把所有“可以……吗”一律拒绝。

### GREEN 与门禁证据

- `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/capability-intent-router.test.ts`：196/196 通过。
- `pnpm.cmd --filter @myself/agent-core test`：4 个文件、93/93 通过。
- `pnpm.cmd --filter @myself/agent-core typecheck`：退出码 `0`。
- `pnpm.cmd --filter @myself/character-runtime test`：15 个文件、315/315 通过。
- `pnpm.cmd --filter @myself/character-runtime typecheck`：退出码 `0`。
- `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/capability-intent-router.test.ts tests/explicit-character-behavior-gate.test.ts`：2 个文件、278/278 通过。
- `pnpm.cmd --filter @myself/desktop typecheck`：退出码 `0`。
- `git diff --check`：退出码 `0`；只有 Windows 行尾转换提示，无空白错误。

### 最小修复与自审

- 恢复 `别` 的否定证据，与 `不要`、`不用`、`不必` 保持同一拒绝边界。
- `分析`、`引用` 只在请求句首作为讨论行为生效；`流程`、`这句话` 不再作为无边界全局黑名单，因此对象名称内部同字不被误伤，既有真实讨论和引用负例仍通过。
- 可行性证据只匹配句尾的 `可行吗`、`是否可以`、`可以吗` 等完整咨询结构，不拦截前置礼貌请求。
- 本轮只修改 Router、Router 测试和本报告；未触碰 Agent 执行器、Provider、Scheduler、IPC 或权限执行链。
- 剩余风险仍是自然语言表达无法穷举；新增咨询或否定表达应继续先增加安全负例，再扩展有界结构。

## 修复轮 3/5：拒绝证据句法化

### RED 证据

- 命令：`pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/capability-intent-router.test.ts`
- 退出码：`1`。
- 结果：205 项中 196 项通过、9 项失败。
- 预期失败覆盖：三种有界嵌套礼貌壳后的分析请求误入文件任务；两个明确礼貌执行请求被句尾 `可以吗` 误拒；四个包含 `可行` 或 `别` 子串的合法对象名被裸关键词误拒。

### GREEN 与门禁证据

- `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/capability-intent-router.test.ts`：205/205 通过。
- `pnpm.cmd --filter @myself/agent-core test`：4 个文件、93/93 通过。
- `pnpm.cmd --filter @myself/agent-core typecheck`：退出码 `0`。
- `pnpm.cmd --filter @myself/character-runtime test`：15 个文件、315/315 通过。
- `pnpm.cmd --filter @myself/character-runtime typecheck`：退出码 `0`。
- `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/capability-intent-router.test.ts tests/explicit-character-behavior-gate.test.ts`：2 个文件、287/287 通过。
- `pnpm.cmd --filter @myself/desktop typecheck`：退出码 `0`。
- `git diff --check`：退出码 `0`；只有 Windows 行尾转换提示，无空白错误。

### 架构修复与自审

- 文件 Gate 删除对整段 `semanticText` 的知识、否定和陈述裸关键词扫描；拒绝证据只从句首讨论/知识问句、句首否定命令和对象之后的咨询尾句产生。
- 讨论前缀支持 `请帮我`、`请你帮我`、`麻烦帮我` 三种有界嵌套礼貌壳，不使用无界重复。
- 咨询尾句必须位于最后一个真实对象槽之后；`可行文件`、`类别文件` 等对象名称内部子串无法再充当拒绝证据。
- 明确礼貌请求、操作和目标必须在同一句内，满足后仅覆盖礼貌性可行询问；知识解释和风险陈述仍优先回落聊天。
- 本轮只修改 Router、Router 测试和本报告；未触碰 Agent 执行器、Provider、Scheduler、IPC 或权限执行链。
- 剩余风险：规则只覆盖获批的有界句法角色，未识别的新型讨论表达会保守依赖正向执行结构；后续扩展仍须以安全负例驱动，不得恢复全局词表。

## 修复轮 4/5：封闭直接命令与模型升级证据

### RED 证据

1. `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/capability-intent-router.test.ts`
   - 退出码：`1`。
   - 结果：210 项中 206 项通过、4 项失败。
   - 预期失败覆盖：`你能帮我分析...`、`可以帮我分析...`、`请问...可以吗` 与嵌套显式否定仍会借用内部操作词进入文件任务。
2. 增加模型补充分流证据后运行同一命令。
   - 退出码：`1`。
   - 结果：217 项中 210 项通过、7 项失败。
   - 预期失败覆盖：普通未命中缺少 `modelEscalation: allowed`；否定、引用、代码和嵌入式命令讨论缺少 `modelEscalation: blocked`。

### GREEN 与门禁证据

- `pnpm.cmd --filter @myself/agent-core test`：4 个文件、93/93 通过。
- `pnpm.cmd --filter @myself/agent-core typecheck`：退出码 `0`。
- `pnpm.cmd --filter @myself/character-runtime test`：15 个文件、315/315 通过。
- `pnpm.cmd --filter @myself/character-runtime typecheck`：退出码 `0`。
- `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/capability-intent-router.test.ts tests/explicit-character-behavior-gate.test.ts`：2 个文件、299/299 通过。
- `pnpm.cmd --filter @myself/desktop typecheck`：退出码 `0`。
- `git diff --check`：退出码 `0`；只有 Windows 行尾转换提示，无空白错误。

### 架构收口与自审

- Router 从 625 行收敛为 318 行，删除开放式知识、咨询、可行性和陈述词表及其多槽语义组合器。
- 本地同步入口只接受封闭的中文/英文直接命令形状、可验证本地对象和同句操作证据；截图原句与既有直接正例保留。
- 开放式未命中统一回落 `chat + modelEscalation: allowed`，交由任务 2 的严格 `CapabilityControlPlan` 判断；本任务没有实现授权卡或 Agent 执行。
- 否定、引用、代码、嵌入式文件正文和不合法的显式 PowerShell 请求返回 `chat + modelEscalation: blocked`，后续模型建议不能绕过 Main 的确定性拒绝。
- 结构化澄清只接受 Main 生成的精确 `补充信息(覆盖此前缺失字段):` 标记续接原任务，不把普通路径陈述提升为文件任务。
- 运动控制契约和 Gate 保持既有实现，定向 82 项全部通过；未修改 Provider、Coordinator、Agent 执行器、Scheduler、IPC 或 Renderer。

## 修复轮 5/5：不可伪造澄清续接与确定性拒绝边界

### RED 证据

- 命令：`pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/capability-intent-router.test.ts`
- 退出码：`1`。
- 结果：227 项中 217 项通过、10 项失败。
- 预期失败覆盖：两种普通用户伪造补充标记会直接进入文件任务；专用受信续接入口不存在；`你不能帮我`、`我不想让你`、`千万不要`、引用翻译、转述引用、四空格缩进和 `~~~` 围栏没有全部返回 blocked。

### GREEN 证据

- 同一 Router 命令：227/227 通过。
- 普通 `route()` 不再识别任何补充标记；`routeTrustedFileContinuation()` 是 Coordinator 持有澄清状态时使用的专用内部入口。
- 四空格缩进在 `trim()` 前判定，避免预处理移除代码证据；反引号与波浪线围栏、确定性否定和引用包裹均返回 `modelEscalation: blocked`。
- Coordinator 正由任务 2 实现者在其现有改动中接入专用入口，避免并发修改同一文件；本提交不包含任务 2 授权链文件。

## 第二次复审补充：跨行代码结构与英文否定

### RED 证据

- 命令：`pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/capability-intent-router.test.ts`
- 退出码：`1`。
- 结果：231 项中 227 项通过、4 项失败。
- 预期失败覆盖：英文 `Never delete a.txt`、前置空行后的四空格缩进代码、说明文字后的反引号围栏和波浪线围栏未被确定性阻断。

### GREEN 证据

- 同一 Router 命令：231/231 通过。
- Router 在 `trim()` 前按整段行结构识别缩进代码和两类围栏，不再依赖整段文本的首字符。
- 英文句首 `never` 纳入明确否定边界并返回 `chat + modelEscalation: blocked`；未新增开放式知识、咨询或可行性词表。
- 本轮只修改 Router、Router 测试和本报告；未触碰任务 2 的 Coordinator 或授权实现。

## 第三次复审补充：英文礼貌否定续接

### RED 证据

- Router 与 Coordinator 定向测试共 301 项，299 项通过、2 项失败。
- `Please never delete a.txt` 被错误标为 `chat + allowed`；存在文件澄清待续接时，该文本会借用受信入口进入文件任务。

### GREEN 证据

- Router 与 Coordinator 定向测试：301/301 通过。
- 英文 `never` 只新增单层可选 `please` 礼貌前缀；既有 `please do not` 与 `please don't` 边界保持不变。
- Coordinator 纵向测试确认 blocked 文本不会产生第二次文件提交，并且后续普通路径文本也不能恢复已清理的 pending continuation。
