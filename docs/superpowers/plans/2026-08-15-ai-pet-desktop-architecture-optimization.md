# AI Pet 桌宠架构优化总实施路线

> **执行要求：** 必须使用 `subagent-driven-development` 或 `executing-plans` 按任务实施；每个行为切片严格执行 RED → GREEN → REFACTOR，并在检查点停下复核。

**目标：** 在不修改网站、CloudBase 和包扫描器业务代码的前提下，完成桌面验证闭包、当前聊天窗口授权、会话事件最小投影以及角色恢复可靠性，达到恢复常规功能开发的九项门槛。

**架构：** 先建立能证明改动有效的 Desktop 验证入口，再依次收紧 Agent IPC 和 Renderer 事件边界；之后串行收敛 Store journal、Package import journal 与启动降级。每个阶段只保留一个正式 owner，替代路径通过定向测试后立即删除旧路径，不建立永久双轨。

**技术栈：** TypeScript、Electron、Zod、Node.js `fs/promises`、Vitest、Playwright、pnpm workspace。

## 全局约束

- 总规格：`docs/superpowers/specs/2026-08-15-ai-pet-desktop-architecture-optimization-design.md`。
- 允许范围仅为根目录桌面验证脚本、`apps/desktop`、`packages/agent-core`、`packages/file-tools`、`packages/shared-types`、`packages/character-runtime`、`packages/character-assets` 和本轮桌面文档。
- `apps/website`、`apps/cloudbase-api`、`apps/package-scanner`、`cloudbase` 业务文件必须保持零差异；不以运行网站门禁代替零差异证明。
- `packages/shared-types` 若需修改，必须先证明没有改变网站使用的导出和行为；A1–B3 当前方案不要求改变其既有 `TaskEvent` Schema。
- MCP 源码、持久化结构和内部测试桩保留；运行时、Agent 工具和 Renderer 入口继续关闭。
- 不修改 verified action、generation、TTL、逐次确认、路径策略和本地工具结果事实源。
- 每完成一个计划，先运行其定向测试和规定门禁，再进入后续计划。
- 任何大量删除必须另行列出精确目标并取得用户第二次批准；当前已批准的删除仅限 A1 计划明确列出的单个孤立 E2E 文件，不属于大量删除。
- 不执行任何 Git 写操作；若需要暂存、提交、建分支或推送，必须另行取得用户批准。

## 执行顺序与检查点

### 检查点 0：固定基线

- [ ] 运行 `git status --short`、`git diff --name-only` 和 `git branch --show-current`，记录用户已有差异。
- [ ] 确认六份子规格均为“已批准”，六份实施计划均引用本总规格。
- [ ] 确认根 `package.json` 与各 workspace 中计划引用的脚本仍存在。
- [ ] 若代码或脚本已与计划证据漂移，停止对应任务并先更新规格/计划，不把旧行号当作当前事实。

### 检查点 1：A1 Desktop 验证覆盖

- [ ] 执行 `docs/superpowers/plans/2026-08-15-desktop-validation-coverage.md`。
- [ ] 验收 `.ts`/`.tsx` 全部进入 TypeScript 检查。
- [ ] 验收 Desktop Playwright 配置成为唯一 E2E owner，且只拥有批准的 Desktop specs。
- [ ] 验收 MCP 入口、表单和 `mcp.*` Agent 工具仍不可见、不可达。
- [ ] 运行 A1 计划中的定向测试、Desktop E2E 和 `verify:desktop`。

### 检查点 2：A2 当前聊天窗口 IPC 授权

- [ ] 执行 `docs/superpowers/plans/2026-08-15-current-chat-agent-ipc-authorization.md`。
- [ ] 六个 Agent mutating handler 必须在解析敏感负载和调用 service 前动态校验当前 chat sender。
- [ ] BrowserWindow 真正销毁并替换后，旧 sender 立即失效；普通关闭仅隐藏同一窗口，不伪称 sender 已替换。
- [ ] 非 chat 窗口即使已知有效 `actionId` 也不能确认或取消动作。
- [ ] A2 全绿后才能进入 A3。

### 检查点 3：A3 会话事件投影

- [ ] 执行 `docs/superpowers/plans/2026-08-15-conversation-event-projection.md`。
- [ ] Main 内部角色行为服务继续接收经 Schema 验证的完整事件。
- [ ] chat 只接收经验证的完整 `TaskEvent`；pet Renderer 只接收严格 phase 投影；settings/workshop 不接收会话任务事件。
- [ ] Preload 丢弃非法事件且不记录 payload。
- [ ] 旧四窗口广播路径在替代测试全部通过后删除，不保留运行时开关或 fallback。

### 检查点 4：B1 Store journal 分面隔离

- [ ] 执行 `docs/superpowers/plans/2026-08-15-character-transaction-recovery.md`。
- [ ] 活动角色优先；最多处理 256 个索引角色；2000ms 软预算只在角色之间检查。
- [ ] 坏 draft、坏 publish 和双分面损坏互相隔离，原 marker 字节保留，健康角色继续恢复。
- [ ] 超预算角色保持原文件不变并标记待后续恢复，应用和普通聊天继续启动。
- [ ] B1 全绿后才能修改同一 Store 的 B2 接口。

### 检查点 5：B2 Package import journal 原子发布

- [ ] 执行 `docs/superpowers/plans/2026-08-15-character-import-journal.md`。
- [ ] 在真实 Windows 临时目录证明 exclusive publish 不覆盖既有最终文件。
- [ ] 空文件、半 JSON、未知版本、权限失败和 owner/物理身份不匹配逐 marker 隔离。
- [ ] 只有 owner token、角色 ID 和物理文件身份全部匹配时才能回滚。
- [ ] 新 journal 路径通过故障注入矩阵后删除旧直接写 marker 和整轮 fail-stop 恢复路径。

### 检查点 6：B3 恢复体验与降级

- [ ] 执行 `docs/superpowers/plans/2026-08-15-character-recovery-degradation.md`。
- [ ] 只有活动角色 publish/runtime 不可用才触发官方默认角色 fallback。
- [ ] Renderer 只收到角色标识、稳定错误码、受影响能力和恢复建议，不收到绝对路径、marker 正文、哈希或 owner token。
- [ ] 非活动角色损坏不影响活动健康角色，普通文字聊天始终可用。
- [ ] 没有真实 Windows 人工观察的项目记录为“待用户人工确认”。

### 检查点 7：恢复常规功能开发门

- [ ] 运行 `pnpm.cmd verify:desktop`。
- [ ] 运行 `pnpm.cmd test:security`。
- [ ] 运行 `pnpm.cmd test:integration`。
- [ ] 因触及角色链，运行 `pnpm.cmd verify:characters`；因触及行为事件链，运行 `pnpm.cmd verify:behavior`。
- [ ] 运行 `git diff --check`。
- [ ] 运行 `git diff --name-only -- apps/website apps/cloudbase-api apps/package-scanner cloudbase`，预期无输出。
- [ ] 创建独立验收记录，写明日期、Windows 环境、真实执行命令、退出码、失败项、人工待确认项和网站零差异证据。
- [ ] 逐项核对总规格第 8 节九项门槛；任何一项缺少当前证据都不得宣布达标。

## 后续阶段

A1–B3 达标后恢复普通功能开发。阶段 C/D 不在本计划中实施；后续功能触及设置 mutation、compiled writer、Package source import、消息长度、atlas、Player API、工作室状态、V1/V2 动作、展示快照或 Provider fallback 时，必须先使用 brainstorming 形成独立规格，再编写独立 TDD 计划。
