# AI Pet 核心交互修复实施计划

**规格：** `docs/superpowers/specs/2026-08-24-ai-pet-core-interaction-repair-design.md`
**执行方式：** SDD + TDD + 子智能体逐任务实现；每项 RED 证据经主智能体复核后才进入 GREEN

## Task 1：文件任务真实闭环

**范围：** `packages/shared-types`、`packages/file-tools`、`packages/agent-core`、`apps/desktop` 文件能力与对话协调层。

1. RED：加入截图原句、两轮路径补充、完整参数不得澄清、创建单目录确认/冲突/越界/链接测试并确认失败原因。
2. GREEN：实现 `FilePlanningHint`、一次性澄清续接和 `create_directory`；复用现有授权、确认、执行结果与回收站边界。
3. REFACTOR：删除只服务旧“创建目录走 PowerShell/澄清后丢上下文”路径与冲突测试描述，保持单一正式入口。
4. 完成标准：截图的删除与建目录均到达准确确认卡，确认后真实结果决定终态；相关 package 测试、desktop typecheck、security/integration 定向测试通过。

## Task 2：隐藏行为语义、自定义动作匹配与自主移动

**范围：** `packages/character-runtime`、`apps/desktop` 对话行为、Director、Scheduler、Motion 与对应测试。

1. RED：隐藏 activity/status、自定义候选最高相似、目录外目标回 idle、明确移动表达、10–30 秒、单屏随机远行、24 DIP 容差和终止回 idle 测试。
2. GREEN：扩展公开描述目录与聊天契约；复用现有 resolver/engine；assistive 使用 idle，autonomous 每次到期使用 work-area wander；加入仅随机远行使用的容差。
3. REFACTOR：退役自主反思产生可见动作和 `near` 相对自主移动的旧路径，不保留双时钟或旧别名。
4. 完成标准：任意用户自定义名称/标签可由隐藏语义选择唯一最高相似可播放项；移动实际发生并在附近停止回 idle；行为定向测试与 typecheck 通过。

## Task 3：wheel 与长按回归

**范围：** `PetView`、`PetInteractionController` 及定向 Renderer/真实 Electron E2E；不改 Main 几何缩放算法和拖拽边界。

1. RED：无前置 pointermove wheel 失败、回退桌宠 wheel 失败、长按不应启动 drag/scale 或静止位置写入、超过 4 DIP 仍应拖动。
2. GREEN：wheel 使用本次坐标并支持既有回退命中；按压会话增加 4 DIP 阈值并禁止按压中 wheel；Main 跳过未变化的拖动坐标。
3. REFACTOR：保持单一会话清理函数，覆盖 pointerup/cancel/lost capture/blur/timeout/dispose。
4. 完成标准：wheel 每次一个档位，长按 scaleTick 不变，拖动功能与已验收边界回归通过。

## Task 4：纵向验收与减法收口

1. 运行三组定向测试，再运行 `pnpm verify:desktop`、`pnpm verify:behavior`、`pnpm verify:characters`。
2. 启动非 EXE 的 Electron 开发版，使用本地可控 Provider/E2E 验收三条真实 UI 链；不启用 MCP。
3. 只读审查 Git 差异、`git diff --check`、新增文档和外部代码许可证记录。
4. 独立子智能体做规格与实现终审；P0/P1/P2 问题回到对应 Task 修复。
5. 更新 `docs/operations/lightweight-agent-acceptance.md` 与角色人工验收记录，只写实际观察结果。

## 第二轮失败修复任务

### Task 5：默认隐私配置下的明确写操作闭环

**目标：** 保留只读文件数据默认关闭，同时让用户明确给出目标的创建、补丁和删除请求拥有仅本轮有效的写工具许可。

1. RED：使用 `fileDisclosureAllowed=false`、已授权临时根和完整 `FilePlanningHint`，断言当前工具表为空或 `FILE_DISCLOSURE_DENIED`，并确认测试确因隐私总闸门失败。
2. GREEN：让 Session 保有内部完整注册表，但只有明确写提示暴露唯一对应工具；AgentService 在预览和确认执行时校验同一提示许可。列目录、读取、无提示和跨工具请求继续拒绝。
3. RED/GREEN 纵向：通过 Coordinator → DeepSeek 兼容 Tool Calls → 确认卡 → `FileToolService` 在临时根创建真实目录；删除仅回收该测试目录。直接读取文件系统断言结果，不接受模型文字作为成功。
4. REFACTOR：删除把所有文件写操作等同于文件内容披露的旧统一断言，保留一条按操作风险判断的正式路径。

### Task 6：停止锁、连续运动与隐藏运动计划

**目标：** 明确布尔状态控制自主移动，并让一次、定时和持续运动均有可验证语义。

1. RED：加入“静止不动/保持静止/不要再动”“保持运动/一直走/继续跑”Gate 用例；证明当前停止锁未改变、持续运动只跑一个目标。
2. GREEN：增加 `autonomousMovementAllowed` 与 `continuousMovementRequested`；停止命令原子落盘后禁用 Scheduler 并停止，恢复命令只在明确请求后重新允许。
3. RED/GREEN：扩展必需 `motionPlan` Schema、Provider 提示和本地校验；支持 `none/stop/once/continuous`、1–600 秒和公开单屏区域目标。
4. RED/GREEN 纵向：用真实 MotionService 状态快照证明一次移动终止回 idle、持续运动依次选择至少两个目标、停止后跨 30 秒 Scheduler 不再移动。状态断言替代视觉观察。

### Task 7：真实 Windows mousemove 与 wheel 链

**目标：** 去掉旧 E2E 的合成 PointerEvent 前置条件，让真实输入改变 Main 和持久化缩放。

1. RED：从初始穿透状态只发送 mousemove 后滚轮，证明当前 `onPointerMove` 没有取消穿透或 scale 不变。
2. GREEN：mouse 与 pointer 复用同一命中状态机；wheel 自身坐标最终复核，拖动阈值和透明点击穿透不变。
3. RED/GREEN E2E：禁止 `dispatchEvent(PointerEvent)`，真实输入后断言 Renderer 计数、Main `scaleTick/revision` 和 `settings.json` scale 同步改变；长按仍保持 scale。

### Task 8：真实验收与独立终审

1. 在隔离临时根运行真实文件副作用验收并清理本轮测试实体；不接触用户其他文件。
2. 监视行为诊断快照完成停止 30 秒、连续两个目标、一次移动回 idle 三条验收。
3. 运行无 DOM 注入的 wheel E2E，并核对持久化 scale。
4. 运行三个 verify 门禁和 `git diff --check`；独立子智能体按规格与质量双轴终审，发现问题返回对应 Task 修复。
