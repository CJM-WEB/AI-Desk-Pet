# AI 桌宠核心质量修复实施计划

> 规格：`docs/superpowers/specs/2026-08-26-ai-pet-core-quality-repair-design.md`

## 实施原则

- 所有行为变更先 RED，再最小 GREEN，最后删除被替代旧路径。
- 三个切片可并行：本地模型；拖拽/状态/隐私；文件工具与 Agent 编排。共享契约变更由主智能体先稳定或分阶段合并，避免并发修改同一文件。
- OpenCode 只迁移兼容行为和纯算法；任何副作用必须复用现有 Main/FileToolService 安全链。

## 任务 1：本地模型结构约束与 GPU 选择

文件：`apps/desktop/src/main/providers/local-model-provider.ts`、`apps/desktop/src/main/local-model/local-model-runtime.ts` 及定向测试。

1. RED：多 Vulkan 设备、软件设备、乱序与 CPU fallback；带响应契约的本地请求必须携带 llama.cpp JSON Schema。
2. GREEN：解析所有设备并确定性优先独显；为本地结构化聊天启用 Schema 约束，保持 `reasoning_effort:none` 与 `enable_thinking:false`。
3. 完成标准：定向测试和 desktop typecheck 通过，不改变远程 Provider 请求。

## 任务 2：本地文字流式链

文件：`packages/agent-core/src/types.ts`、`packages/shared-types/src/contracts.ts`、OpenAI/本地 Provider、Coordinator、Preload、Renderer task store 及对应测试。

1. RED：SSE 分片、Unicode/escape、start/delta/commit、Abort/generation 隔离；工具回合不得流式。
2. GREEN：增加可选增量回调；只投影结构化顶层 `text`，最终完整响应仍按现有契约校验；Renderer 原位更新单条消息。
3. REFACTOR：删除本地非流式专用重复代码，云 Provider 保持兼容。
4. 完成标准：Provider、IPC、Store、Coordinator 测试与桌面门禁通过。

## 任务 3：温和上下文预算

文件：conversation history/chat adapter、角色目录序列化、文件读取预算及测试。

1. RED：超预算历史只删除最旧完整回合；当前输入、最近回合和工具调用/结果不被拆散；候选目录无重复聚合字段。
2. GREEN：本地档案应用 6000 至 6500 输入 token 估算预算并预留输出；文件读取按完整行温和截断。
3. 完成标准：无摘要、无当前正文截断、角色自定义候选完整保留。

## 任务 4：拖拽尺寸与跟手性

文件：`PetView.tsx`、`character-motion-controller.ts`、备用角色样式及测试。

1. RED：拖拽不切换播放器 motionMode、不重建动作；`moving:false` 权威快照立即清零 residual；窗口宽高和 scale tick 恒定。
2. GREEN：删除 drag→static 路径；非运动快照直接吸附；删除备用呼吸动画的 scale 分量。
3. 完成标准：交互、播放器、几何测试通过；真实手感标记待用户人工确认。

## 任务 5：停止后可靠恢复

文件：`character-behavior-director.ts`、显式行为 Gate 与定向/行为门禁测试。

1. RED：stopped + Provider once/continuous 先 save(false) 再 Motion；move→stop→move 不依赖旧 playback finished；none/保存失败零解锁。
2. GREEN：stop 清理显式移动所有权；经 Schema 校验的当前用户移动计划可解锁；补充少量高置信常见说法。
3. 完成标准：停止仍永久禁止自主移动，只有用户明确移动才恢复。

## 任务 6：隐私设置减法迁移

文件：Settings DTO、Store、Dashboard、Renderer Privacy UI 及测试。

1. RED：公开 DTO/UI 不含 screenshot/clipboard；旧设置只剥离这两个字段；严格保存拒绝旧字段。
2. GREEN：删除五层占位字段并增加定向迁移；保留底层通用 DisclosureCategory 安全协议。
3. 完成标准：其余隐私、Provider、路由、位置与密钥引用不变。

## 任务 7：文件查询与精确编辑深模块

文件：`packages/file-tools`、工具注册、共享契约与测试；参考 OpenCode 固定提交中的 read/glob/grep/core edit。

1. RED：分页、BOM/CRLF、二进制、Glob/Grep、截断、唯一 edit/replaceAll、精确 move，以及所有越界/链接/目标冲突/确认后变化。
2. GREEN：扩展 `executeRead/preview/executeWrite`，只公开相对路径；精确编辑采用 CAS，不启用低阈值模糊自动替换。
3. 来源：若复制实质代码，新增第三方声明与 MIT notice；若独立适配实现，在规格与注释记录参考来源。
4. 完成标准：确认前零副作用，失败不留临时文件，不覆盖、不永久删除。
5. 减法结论：不提供 OpenCode 不存在的独立 `copy_file`。其 Shell 复制不能迁入；本轮试制入口因无法满足 Windows 句柄被移出授权根时的 TOCTOU 回滚不变量而整链删除。Router 仍识别明确复制请求并由 Main 稳定拒绝，不允许降级聊天或伪称成功。

## 任务 8：OpenCode 风格多步 Agent 编排

文件：`packages/agent-core`、AgentService、ToolRegistry、Provider tool-name/schema seam 及集成测试。

1. RED：read→edit→确认→read；create→move 两次独立确认；稳定失败回注并可改参；重复调用有界终止；取消/失效后不能续跑。
2. GREEN：移除确认后的 `finalizationOnly` 单步限制；每次只允许一个 pending mutation；工具失败作为可信失败结果回注，最终文本不得覆盖本地事实。
3. 扩充高置信文件意图措辞，但不让模型自行授予文件能力。
4. 完成标准：OpenAI/DeepSeek/Gemini/本地 Qwen 使用同一 canonical 工具定义和 Main 执行链。

## 任务 9：集成、复审与提交

1. 分别运行定向测试和 package typecheck。
2. 运行 `pnpm.cmd test:security`、`pnpm.cmd test:integration`、`pnpm.cmd verify:desktop`、`pnpm.cmd verify:behavior`。
3. 运行真实隔离目录 E2E，证明创建、读取、检索、编辑、移动、回收站删除和多步确认的真实副作用。
4. 并行执行规格审查与代码质量审查；修复后运行 `git diff --check`。
5. 按切片提交；最终报告自动证据、待人工拖拽验收与剩余风险。
