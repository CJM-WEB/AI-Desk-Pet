# Task 3 报告：按文件名读取的确定性闭环

## 状态快照

- 日期：2026-08-28
- 起始基线：538c0d4
- 当前状态：已完成实现、RED/GREEN、类型检查与完整桌面门禁；待最终差异审查和提交。

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
- 唯一候选再使用真实 read_file 返回相对路径和正文，并通过既有 emitTrustedToolResult 发布 glob/read 两个可信结果。重名、不存在、搜索截断均只产生 target_path 澄清，候选至多十项。
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
