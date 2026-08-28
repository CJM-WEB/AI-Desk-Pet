# Task 3 报告：按文件名读取的确定性闭环

## 状态快照

- 日期：2026-08-28
- 起始基线：538c0d4
- 当前状态：已完成两轮实现、RED/GREEN、类型检查与完整桌面门禁；待最终差异审查和提交。

## RED 记录

1. Router：pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/capability-intent-router.test.ts 首轮 250 项中 2 项失败。失败原因是 FilePlanningHint 尚无 targetNameQuery。
2. 真实临时授权根：pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/agent-service.test.ts 首轮 90 项中 4 项失败。四种输入均进入 AgentLoop 并调用空脚本 Provider，证明缺少 Main 的确定性预解析。
3. 正式 Provider 链 mutation 自检：临时移除预解析返回分支后，pnpm.cmd exec vitest run --config tests/vitest.config.ts tests/integration/desktop-agent.test.ts 共 78 项中 2 项失败。OpenAI-compatible 与内置本地 fixture 都转而访问 Provider 并分别报告网络/服务器错误；随后已立即恢复该分支。

## 已完成 GREEN 证据

- Router：251/251 通过。
- 真实 FileToolService 临时根：Router 与 AgentService 定向测试共 342/342 通过。
- 正式 Provider 链：集成测试 78/78 通过。
- pnpm.cmd --filter @myself/agent-core typecheck：通过。
- pnpm.cmd --filter @myself/desktop typecheck：通过。期间发现测试使用当前 TS 目标不支持的 findLast，已改为既有 filter(...).at(-1)，复跑通过。

## 实现摘要

- FilePlanningHint 新增可选 targetNameQuery。Router 只从封闭的文件内容问句提取 NFKC 单文件名；拒绝分隔符、通配符、控制字符、绝对路径前缀和引用文本。
- AgentService 在同一 Agent 会话内、AgentLoop 之前执行真实 glob_files。候选按相对路径末段精确匹配；无扩展查询额外允许 stem 精确相等。
- 唯一候选再使用真实 read_file 返回相对路径和正文，并通过既有 emitTrustedToolResult 只发布最终 read_file 成功事实。重名、不存在、搜索截断均只产生 target_path 澄清，候选至多十项。
- 没有新增授权根、Renderer 权限、MCP 运行时、依赖或第二套 Agent 循环。

## 完整门禁

pnpm.cmd verify:desktop 退出码 0，实际观察到：

- workspace typecheck：通过；
- 单元测试：136 files、3542 tests 通过；
- 安全测试：28/28 通过；
- 集成测试：4 files、92 tests 通过；
- 生产构建与 preload/生产边界校验：通过；
- Electron E2E：77 通过、1 跳过、0 失败。

## 自审

- 真实临时授权根测试覆盖唯一、重名、未命中、十项上限和 glob 截断；没有仅以 mock 替代 FileToolService。
- OpenAI-compatible 与内置本地模型 fixture 都证明原句不产生 Provider 调用，且文件结果来自真实临时授权根。
- 搜索和读取的返回值先经受控形状与根内相对路径验证；无效结果只会失败，不会输出成功文案。
- 全程复用既有 FileToolService、PathPolicy、Main 会话、可信结果发布与 AgentLoop；没有扩大授权范围。

## Concerns

- 无功能性阻塞。
- 真实 DeepSeek 网络、真实本地 GGUF 推理以及人工 Windows 窗口观察不在本任务自动化范围内；本轮仅验证正式 Provider 适配器的本地 fixture 链。

## 独立审查 Important 修复第 1 轮

### 范围与非范围

- 只处理 task-3-review.md 的三项 Important：目标相关 glob、内部 glob 不进入可信事务、截断候选澄清。
- 两项 Minor 未改动：正式 Provider fixture 未扩展到 Coordinator 完整入口，AgentService 未增加 targetNameQuery 的第二层防御校验。

### RED 记录

1. 目标相关搜索：将真实临时授权根的既有“100 个 filler 后澄清”测试改为“仍读取 test.txt”，并增加方括号文件名的字面 glob 测试。定向命令 2/2 失败：旧实现仍调用 **/*，且唯一候选返回 target_path 澄清。
2. 可信结果：将唯一读取期望改为只含 read_file，并为重名、未找到和真实 101 个匹配候选截断场景期望空 trustedResults。旧实现分别发布 glob_files 路径，截断场景实际泄露了 100 个预解析相对路径。
3. 截断澄清：真实 101 个匹配候选测试要求公开 candidate-000 至 candidate-009。旧实现只返回泛化文案，没有候选。另以受控截断返回的单候选分支做变异：临时把截断判断改成候选数大于一才澄清，测试立即因为错误调用 read_file 而失败。
4. 桌面 typecheck 首次失败，原因是新增受控返回测试使用 ToolRequest 却漏导入类型；补齐现有 shared-types 类型导入后通过。这是测试编译缺口，不改变产品路径。

### GREEN 证据

- apps/desktop/tests/agent-service.test.ts：94/94 通过，测试使用真实 FileToolService 与临时授权根覆盖 100 个无关文件、重名、未找到、真实截断和唯一读取；单候选截断分支由窄受控返回测试及变异失败保护。
- apps/desktop/tests/capability-intent-router.test.ts：251/251 通过。
- tests/integration/desktop-agent.test.ts：78/78 通过。
- pnpm.cmd --filter @myself/desktop typecheck：通过。
- pnpm.cmd verify:desktop：退出码 0；单元 136 files、3545 tests，安全 28/28，集成 4 files、92 tests，Electron E2E 77 通过、1 跳过。

### 实现与自审

- AgentService 从 targetNameQuery 构造 **/加字面编码文件名的受控模式；无扩展名时仅额外使用框架自有的扩展匹配，最终仍由 basename/stem 精确过滤。用户名称中的 glob 语义字符不会原样进入模式。
- 内部 glob_files 只用于解析，不再调用 emitTrustedToolResult；只有真实 read_file 成功且返回路径一致时才发布单一可信相对路径。
- 截断在候选精确筛选后优先返回，保留最多十个已发现候选并列入澄清文案；即使当前返回只包含一个候选也不读取。
- 未新增授权根、Renderer 权限、MCP 运行时、Provider 调用或依赖；未扩大本次授权范围。
- 曾尝试以 5000 个真实硬链接触发访问预算的极端夹具，但 Windows 并发创建在约 1022 项处报 UNKNOWN，且 afterEach 清理超过框架 10 秒；该夹具已删除，不纳入最终套件。真实 101 匹配截断覆盖仍保留，单候选顺序由变异验证覆盖。

### Concerns

- 无功能性阻塞。
- 极端夹具失败时在系统临时目录留下一个以 ai-pet-named-read- 开头的测试目录；运行时策略拒绝递归清理命令，未尝试绕过该策略。
