# 最终全分支审查修复报告

## 状态

- 状态：`DONE_WITH_CONCERNS`
- 实施时段：2026-08-11 20:39–21:09（Asia/Shanghai），约 30 分钟；后续验证与审批收口持续至 21:10 后。
- 基线：`3ae4a763bb6d9b890ab2c027caa78d0ec9cda79c`
- 分支：`AgentCoreExtension`
- 最终修复提交：`b08a9da fix: 收敛默认聊天最终审查问题`。

## 根因与最小修复

### 1. Main 明确文件意图门

根因有三项：文件对象主要由扩展名白名单和 Unix 路径决定；执行语气未覆盖“请把/帮我把/Can you”；知识、否定与 URL 判断没有先隔离文件对象片段。最小修复保留“三项独立证据”和 Main 唯一分流权威，只扩展本地相对路径/常见文件名识别、先排除 URL，并仅在文件对象片段外判断知识、否定和陈述语义。Renderer 路由接口未改，仍只提交 `text`；文件授权、披露、确认与工具安全链未放宽。

### 2. Toast 原位替换竞态

根因是队首 ID effect 无条件清空 hover/focus 暂停位；React 复用同一 DOM 时不会再次触发 enter/focus，新提示因此错误启动计时。最小修复在 ID 原位替换时保留交互暂停位并重置新时长，仅在队列为空、节点真实移除时清空暂停状态。

### 3. Electron 日志断言假绿

根因是 Provider 脚本回复在断言前作为 `additionalSecrets` 被 fixture 删除，字符串“不包含”断言无法发现 Main 原始流泄漏。最小修复在测试 fixture 内从原始捕获流计算去标识化布尔证据，只公开 API key、授权根、Authorization 和各哨兵是否命中；公开诊断仍在证据计算后脱敏，不返回或持久化正文。未新增生产 preload 接口。

### 4. 旧验收文档

最小更新了固定 Clarify、三次规划、严格 JSON `chat_reply` 和“模糊请求只澄清”等旧表述，使其指向默认自然聊天与可信 Main 明确文件意图门。

## RED → GREEN 证据

### Gate

- RED：`pnpm.cmd --filter @myself/desktop test -- explicit-file-intent-gate.test.ts`。目标文件新增 10 个精确用例，10 failed；失败均为预期分类错误。该命令因脚本参数边界同时运行了 Desktop 单元文件，但未运行 website。
- GREEN：在 `apps/desktop` 运行 `pnpm.cmd exec vitest run --config vitest.config.ts tests/explicit-file-intent-gate.test.ts`，1 文件、58/58 通过。

### Toast

- RED：`pnpm.cmd exec vitest run --config vitest.config.ts tests/transient-toast-layer.dom.test.tsx`，2 failed、12 passed；hover/focus 原位替换均在 3000ms 错误关闭。
- GREEN：`pnpm.cmd exec vitest run --config vitest.config.ts tests/transient-toast-layer.dom.test.tsx tests/settings-toast.dom.test.tsx`，2 文件、23/23 通过。

### 日志 fixture 与受控变异

- fixture 证据 RED：单个“直接 spawn 后连接 CDP”测试收到 `capturedLogEvidence: undefined`，1 failed。
- fixture 证据 GREEN：同一测试 1/1 通过。
- 报告脱敏 RED：原始流布尔命中为真时，公开日志仍包含测试哨兵，1 failed。
- 报告脱敏 GREEN：fixture 边界与命名 Electron 场景合跑 2/2 通过；原始流证据保留，公开诊断不含哨兵正文。
- 受控生产变异：仅临时在 Main Provider 回复边界加入日志输出。旧命名 Electron 断言在泄漏存在时仍 1/1 通过，证明假绿。
- 新断言 RED：保持同一变异，新断言失败并只报告 6 个回复哨兵布尔命中，不输出正文。
- 恢复证明：逐行移除临时变异后，`git diff --exit-code -- apps/desktop/src/main/conversation/conversation-chat-adapter.ts` 为 0；重建 Desktop 后命名场景 1/1 通过，最终 fixture + 命名场景 2/2 通过。

## 最终验证

| 门 | 结果 |
| --- | --- |
| Gate 聚焦 | 58/58 通过 |
| Toast + 设置调用方 | 23/23 通过 |
| fixture + 命名 Electron | 2/2 通过 |
| Desktop typecheck | `tsc --noEmit`，退出码 0 |
| security | 1 文件，20/20 通过 |
| integration | 4 文件，33/33 通过 |
| 完整 Desktop E2E | 使用同一已构建产物按有界主序列完成 47 项，再精确补跑剩余 3 项；合计 50/50 通过、0 失败。长单文件命令在约 3 分钟边界由主控要求中止，不把中止轮记作单命令 GREEN。 |
| verify:behavior | 两次均在 Desktop 单元阶段退出：76 文件通过，3 个未改文件的首项固定 5 秒超时；1528 passed、3 failed、14 skipped，未进入后续 security/integration/E2E。三文件单 worker 串行复验 3 文件、99/99 通过，原超时用例耗时分别为 962ms、513ms、1378ms，确认是并发负载抖动。此门真实状态仍为 FAILED。 |
| diff-check | `git diff --check` 无空白错误，仅有 LF/CRLF 转换提示 |
| website | `git diff --name-only -- apps/website` 为空；未修改、构建、启动或测试 website；未运行根 `pnpm typecheck` |
| 进程残留 | 最终只读扫描未发现本 worktree 相关 `electron.exe` 或 `node.exe` |

## 第二轮文件意图与日志证据复审

### Task 1：文件意图门

- 实现与修复提交：`66a99ef`、`83c699e`、`fec7ed5`、`f4fbc37`；对应报告提交：`0d97331`、`1708853`、`11ab75a`、`c46d06e`。
- 三轮限定复审后结论为 clean，`0` 项 Critical/Important 开放。
- 保留 `1` 项性能 Minor：候选点号正则仍有理论最坏形态的超线性扫描疑点；现有适度长畸形 token 行为测试已通过，该项不阻断本轮交付。

### Task 2：原始日志证据

- 实现与修复提交：`6cca547`、`ef877ff`、`086045c`、`fff4932`、`e83b00f`；对应报告提交：`6700dc3`、`38997cd`、`85a49ac`、`116b133`、`6e8507f`。
- 四轮限定复审后结论为 APPROVED，`0` 项 Critical/Important 开放。
- 修复覆盖 cleanup 异常、restart 流 epoch、UTF-8 半码、构造输入快照，以及 restart/dispose 的两个确定性竞态；公开证据仍只包含冻结布尔结果。

## 修改文件

1. `apps/desktop/src/main/conversation/explicit-file-intent-gate.ts`
2. `apps/desktop/tests/explicit-file-intent-gate.test.ts`
3. `apps/desktop/src/renderer/src/components/TransientToastLayer.tsx`
4. `apps/desktop/tests/transient-toast-layer.dom.test.tsx`
5. `tests/fixtures/electron-app.ts`
6. `tests/e2e/desktop.spec.ts`
7. `docs/operations/conversation-routing-acceptance.md`
8. `.superpowers/sdd/2026-08-10-ai-pet-default-chat-settings-toast/final-fix-report.md`

## 自审

- Main 意图门仍是唯一分流权威；Renderer 未增加分流字段或文件能力。
- 文件授权、隐私披露、确认、工具权限与受保护区域链路未修改。
- Toast 被替换的旧状态逻辑已删除，没有保留重复计时分支。
- 日志证据只暴露布尔命中，不新增生产 preload 测试接口，不把原始正文写入本报告。
- 变异文件最终零 diff；工作树只包含上述目标文件与本报告。
- 单个问题没有在无收敛状态下持续超过 10 分钟；完整门按主控要求拆成有界执行。`verify:behavior` 相同负载超时重复两次后停止，不修改无关测试超时。
- 历史疑虑：本报告所记录的原始 `verify:behavior` 当时未取得 GREEN；该事实按原始执行结果保留，不改写为通过。
