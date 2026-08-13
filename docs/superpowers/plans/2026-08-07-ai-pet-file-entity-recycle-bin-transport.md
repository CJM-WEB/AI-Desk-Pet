# AI 桌宠文件实体与回收站搬运闭环实施计划

> **面向智能代理执行者：** 实施时必须使用 `superpowers:subagent-driven-development` 逐任务执行；每个任务先使用 `superpowers:test-driven-development` 建立真实 RED，阶段完成前使用 `superpowers:verification-before-completion` 和 `superpowers:requesting-code-review`。共享核心文件不得并行修改。

**目标：** 在现有文件授权、一次性确认和自主行为闭环上，交付“模型提出移入回收站 → Main 预览并重新验证 → 用户醒目确认 → 桌宠播放搬运动作 → 可信播放令牌到达提交帧 → Windows 回收站执行 → 真实成功/失败动作与 Agent 总结”的单目标纵向闭环。

**架构：** `@myself/file-tools` 继续独占路径验证和不可伪造写动作，新增可注入的回收站端口；Electron Main 新增内存事务协调器，持有确认动作、行为播放令牌、提交帧和一次性执行状态；`CharacterBehaviorService` 仍是角色动作权威；Renderer 只播放 Main 发放的动作并报告帧里程碑。角色包只声明表现和提交帧，不能携带命令、绝对路径或系统权限。

**基线：** `AgentCoreExtension` 分支，计划编写时 HEAD 为 `a6e98334da3e8cbfd44e35b60569cc01b8d4867d`。

**技术栈：** TypeScript 5.9、Zod 3、Electron 43、React 19、PixiJS 8、Vitest 3、Playwright 1.61、pnpm 11、Windows 10/11。

**设计依据：**

- [AI 桌宠参考架构吸收与自主陪伴体系演进设计](../specs/2026-08-01-ai-pet-reference-architecture-evolution-design.md)
- [AI 桌宠自主陪伴演进路线](./2026-08-01-ai-pet-autonomous-companion-roadmap.md)
- [AI 桌宠自主行为最小闭环实施计划](./2026-08-02-ai-pet-autonomous-behavior-minimum-loop.md)

---

## 1. 实施边界

### 1.1 本计划包含

- 单个普通文件或普通目录移入 Windows 回收站。
- 模型工具、严格参数、权限策略、预览、确认卡和执行结果闭环。
- 确认前与提交前两次路径、授权根、链接和目标身份验证。
- 不可伪造且只能消费一次的 `VerifiedWriteAction`。
- `carry` 动作的 V2 可选提交帧和角色工作室编辑入口。
- Main 发放的任务播放令牌、Renderer 帧里程碑反馈和一次性提交。
- 现有通用文件图标跟随角色 `carry` 锚点，不读取文件缩略图或内容。
- 播放失败、提交超时、角色切换、用户中断、应用退出和系统回收站失败的安全收敛。
- V1 角色或缺少提交帧的 V2 角色采用受控降级，不阻断基本文件能力。
- 单元、安全、集成、Electron E2E 和 Windows 人工验收。

### 1.2 本计划不包含

- 永久删除、绕过回收站、清空回收站或恢复回收站项目。
- 批量删除、多选目标、通配符、递归枚举或整盘扫描。
- 文件复制、跨目录移动、覆盖、文件内容编辑或任意 Shell。
- 文件缩略图、文件内容、完整绝对路径或资源管理器图标提取。
- 目录藏身、资源管理器目录观察、动态窗口层级、托盘呼唤和迷路恢复；这些属于阶段 3B。
- 长期记忆、主动陪伴、模型目录、语音、UIA、视觉自动化或 MCP 恢复。
- WebsiteExtension、网站代码、网站测试或发布流程。

### 1.3 固定安全规则

1. 只有用户已经授权的根目录内目标可进入回收站。
2. 相对路径必须由 `PathPolicy` 解析；模型、Renderer 和角色包不得提交绝对路径。
3. 符号链接、Junction、授权根本身和不支持的实体类型必须拒绝。
4. 用户确认前不得播放会暗示操作已发生的结果动作，更不得改变文件系统。
5. 提交前必须重新解析路径并比较预览时捕获的目标身份；目标已替换时终止事务。
6. 回收站调用只能位于 Electron Main 的受控端口实现中。
7. Renderer 里程碑只是一条携带 Main 播放令牌的进度证明，不能携带路径、命令或工具参数。
8. 同一事务最多调用一次回收站端口；重复确认、重复帧、乱序帧和旧令牌均不得重复执行。
9. 回收站返回成功前不得发布成功阶段；失败时不得隐藏真实文件仍存在的事实。
10. Agent 总结失败与本地回收站成功必须分开报告，不得把总结失败描述为文件操作失败。
11. 本计划编写阶段不执行 Git 写操作；实施阶段的 Git 行为以用户当时授权为准。

---

## 2. 已确认的当前复用点

- `packages/file-tools/src/path-policy.ts` 已负责授权根、相对路径、路径穿越、符号链接和 Junction 防护。
- `packages/file-tools/src/file-tool-service.ts` 已通过私有 `WeakMap` 签发 `VerifiedWriteAction`，并在执行前重新解析目标。
- `apps/desktop/src/main/agent/pending-action-store.ts` 已提供单个、内存、限时、一次性确认能力。
- `apps/desktop/src/main/agent/agent-service.ts` 已区分本地写入成功与 Provider 总结失败，并发布 `acting/success/error`。
- `apps/desktop/src/main/agent/tool-registry.ts` 已由本地注册表决定工具风险，模型不能伪造风险等级。
- `packages/character-runtime` 已支持 `carry` 语义、播放令牌、硬约束、回退和终态反馈。
- `CharacterBehaviorService` 已是 Main 唯一行为权威，Renderer 不能通过 props 抢播 V2 动作。
- `CharacterPlayer` 和 Pixi 播放器已提供逐帧订阅、播放生命周期和动作帧稳定 ID。
- `PetView` 已使用 `carry` 锚点显示通用文件图标，不需要新增文件缩略图系统。
- `CharacterMotionService` 已维护 Main 权威的 `carrying` 快照。

---

## 3. 关键设计决策

### 3.1 首个切片只处理一个目标

工具名固定为 `builtin.files.move_to_recycle_bin`，参数只有一个授权根内相对路径：

```ts
type MoveToRecycleBinArguments = {
  relativePath: string;
};
```

不接受数组、通配符和递归选项。普通目录由 Windows 回收站整体处理，但不得由应用预先递归枚举内容。

### 3.2 回收站端口与文件工具解耦

`@myself/file-tools` 不导入 Electron。新增最小端口：

```ts
export interface RecycleBinPort {
  moveToRecycleBin(absolutePath: string): Promise<void>;
}
```

生产组合根只在 Main 中把 `electron.shell.trashItem` 包装为该端口；单元和安全测试使用内存假实现。

### 3.3 提交帧属于表现，不属于系统权限

V2 `actionPresentation` 增加可选 `commitFrameId`，必须引用同一表现内唯一稳定帧 ID。它只说明“动画何时适合提交”，不能声明工具名或能力：

```ts
type CharacterActionPresentationV2 = {
  actionId: string;
  fps: number;
  frames: CharacterActionFrame[];
  anchors: AnchorSet;
  commitFrameId?: string;
};
```

只有 Main 已经创建受控文件事务时，该字段才会绑定到任务播放令牌。普通自主 `carry` 动作到达同一帧不会执行任何系统操作。

### 3.4 缺少提交帧的安全降级

- V2 精确表现存在 `commitFrameId`：到达该帧才提交。
- V2/V1 表现可播放但没有提交帧：Renderer 报告 `started` 后，由 Main 将 `started` 作为合成提交点；验收记录标注为降级表现。
- 搬运动作不可播放、加载失败、启动超时或在提交前被中断：不执行回收站操作，事务失败并允许用户重新发起。
- 已进入系统回收站调用后发生动画中断：等待真实系统结果，不伪造回滚。

### 3.5 Main 内存事务是唯一提交权威

事务状态固定为：

```text
confirmed
  → waiting-playback
  → waiting-commit
  → executing
  → succeeded | failed | cancelled
```

事务保存 `actionId`、私有 `VerifiedWriteAction`、Agent continuation、动作播放令牌、动作 ID、预期提交帧、截止时间和是否已经提交。公开事件只包含操作种类、经过隐私处理的相对路径摘要和状态，不包含绝对路径或私有令牌。

### 3.6 先完成本地事实，再恢复 Agent

只有回收站端口真实成功后，才用结构化结果恢复 Agent：

```ts
{
  ok: true,
  toolName: 'move_to_recycle_bin',
  targetRelativePath: 'notes/old.txt',
  destination: 'windows_recycle_bin'
}
```

如果模型总结失败，公开提示必须明确“项目已经移入回收站，但模型总结失败”。

---

## 4. 目标数据流

```text
模型工具调用 builtin.files.move_to_recycle_bin(relativePath)
                         │
                         ▼
              ToolRegistry 严格解析与本地风险判定
                         │
                         ▼
           FileToolService.preview + 目标身份快照
                         │
                         ▼
            PendingActionStore 发放一次性确认 ID
                         │
                  用户醒目确认
                         │
                         ▼
          FileTaskTransactionCoordinator（Main）
                         │
        请求 CharacterBehaviorService 选择 carry 动作
                         │
                         ▼
      behavior-action(playbackToken, actionId, commitFrameId?)
                         │
                         ▼
              CharacterPlayer / Pixi（Renderer）
                         │
          started / commit-frame / terminal feedback
                         │
                         ▼
        Main 校验事务 + 播放令牌 + 动作 + 提交帧
                         │
                         ▼
 FileToolService.executeWrite → RecycleBinPort → shell.trashItem
                         │
               ┌─────────┴─────────┐
               ▼                   ▼
        task-success            task-failure
               │                   │
               ▼                   ▼
       成功/庆祝动作            失败动作
               └─────────┬─────────┘
                         ▼
                  Agent 恢复或本地说明
```

---

### Task 0：关闭任务动作依赖的 Pixi 终态残留

**目的：** 修复已记录的非阻断 P2，避免 `showAction` 失败后再次切换方向恢复已终态动作。文件事务不能依赖一个可能在 `failed` 后无令牌播放的 Renderer。

**文件：**

- 修改：`apps/desktop/src/renderer/src/characters/player/pixi-character-player.ts`
- 修改测试：`apps/desktop/tests/pixi-character-player.test.ts`

- [ ] **步骤 1：写 RED**

首次播放成功，方向重建时 `showAction` 抛错并产生一次 `failed`；随后再次改变方向且 `showAction` 恢复成功，断言旧动作不会重新出现，也不会产生无播放令牌的画面。

- [ ] **步骤 2：运行并确认真实失败**

```powershell
pnpm.cmd --filter @myself/desktop test -- pixi-character-player.test.ts
```

- [ ] **步骤 3：最小修复**

方向重建失败时清空当前选择和运动模式，或要求存在活动播放才能重建；必须继续保持恰好一次 `failed`，不得破坏 RAF 异常隔离。

- [ ] **步骤 4：复验**

```powershell
pnpm.cmd --filter @myself/desktop test -- pixi-character-player.test.ts character-player.test.tsx
pnpm.cmd --filter @myself/desktop typecheck
```

---

### Task 1：建立回收站工具、公开确认和提交帧契约

**文件：**

- 修改：`packages/file-tools/src/schemas.ts`
- 修改：`packages/file-tools/src/file-tool-service.ts`
- 修改：`packages/file-tools/src/index.ts`
- 修改：`packages/shared-types/src/contracts.ts`
- 修改：`packages/character-runtime/src/character-v2-schema.ts`
- 修改测试：`packages/file-tools/tests/file-tool-service.test.ts`
- 修改测试：`packages/shared-types/tests/contracts.test.ts`
- 修改测试：`packages/character-runtime/tests/character-v2-schema.test.ts`

**契约要求：**

- `toolArguments.move_to_recycle_bin` 只接受 `relativePath`。
- `VerifiedWriteAction` 增加 `toolName: 'move_to_recycle_bin'` 分支。
- `PendingAction` 增加严格 `operation` 判别字段，现有创建和重命名动作同步补齐。
- `actionPresentationSchema.commitFrameId` 可选，存在时必须引用同一表现内唯一帧 ID。
- 未知字段、未知操作、空路径、绝对路径风格输入和悬空提交帧引用必须拒绝。

- [ ] **步骤 1：为三层契约写 RED**
- [ ] **步骤 2：分别运行聚焦测试并确认因契约缺失失败**

```powershell
pnpm.cmd --filter @myself/file-tools test -- file-tool-service.test.ts
pnpm.cmd --filter @myself/shared-types test -- contracts.test.ts
pnpm.cmd --filter @myself/character-runtime test -- character-v2-schema.test.ts
```

- [ ] **步骤 3：实现最小严格 Schema 和类型导出**

不得复制安全标识符正则；提交帧必须复用帧稳定 ID。

- [ ] **步骤 4：聚焦测试和类型检查**

```powershell
pnpm.cmd --filter @myself/file-tools test
pnpm.cmd --filter @myself/shared-types test
pnpm.cmd --filter @myself/character-runtime test -- character-v2-schema.test.ts
pnpm.cmd --filter @myself/file-tools typecheck
pnpm.cmd --filter @myself/shared-types typecheck
pnpm.cmd --filter @myself/character-runtime typecheck
```

---

### Task 2：实现可注入的 Windows 回收站写动作

**文件：**

- 新建：`packages/file-tools/src/recycle-bin-port.ts`
- 修改：`packages/file-tools/src/file-tool-service.ts`
- 修改：`packages/file-tools/src/path-policy.ts`（仅在现有接口不能返回必要身份时）
- 修改：`packages/file-tools/src/errors.ts`
- 修改：`packages/file-tools/src/index.ts`
- 修改测试：`packages/file-tools/tests/file-tool-service.test.ts`
- 修改安全测试：`tests/security/permission-boundary.test.ts`

**实现规则：**

1. `preview` 重新使用 `PathPolicy.resolveExisting`，拒绝授权根本身、链接和不支持实体。
2. 内部私有动作保存规范化相对路径以及目标身份快照；公开动作不包含绝对路径。
3. `executeWrite` 在任何副作用前从签发表删除动作，失败后也不能用同一对象重放。
4. 执行前再次解析并比较目标身份；不一致时返回稳定错误 `ENTRY_CHANGED`。
5. 调用注入的 `RecycleBinPort`，不得使用 `rm`、`unlink`、`rmdir` 或永久删除 API。
6. 系统拒绝、目标消失和端口失败映射为稳定中文错误，不泄露完整绝对路径。

- [ ] **步骤 1：写 RED**

覆盖：文件成功、目录成功、授权根拒绝、未授权路径、链接/Junction、目标替换、重复执行、伪造动作、端口失败和执行后目标仍存在的假成功端口。

- [ ] **步骤 2：确认 RED**

```powershell
pnpm.cmd --filter @myself/file-tools test -- file-tool-service.test.ts
pnpm.cmd exec vitest run --config tests/vitest.config.ts tests/security/permission-boundary.test.ts
```

- [ ] **步骤 3：实现端口和一次性动作**

生产端口尚不在本任务接线；本任务只完成平台无关包。

- [ ] **步骤 4：复验**

```powershell
pnpm.cmd --filter @myself/file-tools test
pnpm.cmd --filter @myself/file-tools typecheck
pnpm.cmd test:security
```

---

### Task 3：接入工具注册、醒目确认和生产回收站端口

**文件：**

- 修改：`apps/desktop/src/main/agent/tool-registry.ts`
- 修改：`apps/desktop/src/main/agent/permission-policy.ts`（只补现有风险映射测试需要的最小逻辑）
- 修改：`apps/desktop/src/main/index.ts`
- 修改：`apps/desktop/src/renderer/src/chat/ConfirmationCard.tsx`
- 修改：`apps/desktop/src/renderer/src/styles.css` 或实际确认卡样式文件
- 修改测试：`apps/desktop/tests/tool-permission-policy.test.ts`
- 修改测试：`apps/desktop/tests/renderer-components.test.tsx`
- 修改集成测试：`tests/integration/desktop-agent.test.ts`

**实现规则：**

- 注册 `builtin.files.move_to_recycle_bin`，风险仍由本地注册表确定为可恢复写操作并强制确认。
- `FileToolService` 生产实例注入 `shell.trashItem` 包装器；不得把 Electron 依赖传入 workspace 包。
- `PendingAction.operation` 决定确认卡文案，不再通过 `summary.includes()` 猜测操作类型。
- 回收站确认卡明确显示“将移入 Windows 回收站，可从回收站恢复”，确认按钮使用醒目危险样式，但不得写“永久删除”。
- 取消确认不播放搬运动作、不调用回收站端口、不恢复 Agent continuation。

- [ ] **步骤 1：写注册表、组合根和确认卡 RED**
- [ ] **步骤 2：确认 RED**

```powershell
pnpm.cmd --filter @myself/desktop test -- tool-permission-policy.test.ts renderer-components.test.tsx
pnpm.cmd exec vitest run --config tests/vitest.config.ts tests/integration/desktop-agent.test.ts
```

- [ ] **步骤 3：最小接线**
- [ ] **步骤 4：复验与类型检查**

```powershell
pnpm.cmd --filter @myself/desktop test -- tool-permission-policy.test.ts renderer-components.test.tsx
pnpm.cmd --filter @myself/desktop typecheck
pnpm.cmd test:integration
```

---

### Task 4：实现 Main 文件任务事务协调器

**文件：**

- 新建：`apps/desktop/src/main/agent/file-task-transaction-coordinator.ts`
- 新建测试：`apps/desktop/tests/file-task-transaction-coordinator.test.ts`

**建议接口：**

```ts
export type FileTaskPlaybackGrant = {
  playbackToken: string;
  actionId: string;
  commitFrameId: string | null;
};

export interface FileTaskTransactionCoordinatorOptions {
  now?: () => number;
  requestCarryPlayback(): FileTaskPlaybackGrant;
  execute(action: VerifiedWriteAction): Promise<void>;
  reportResult(result: FileTaskResult): void;
}
```

协调器必须是显式状态机，不通过多个松散布尔值推断状态。它只允许一个活动事务，并提供：

- `begin`：用户确认后绑定私有写动作与 continuation。
- `onPlaybackStarted`：进入等待提交；无提交帧时执行合成提交。
- `onCommitFrame`：严格校验播放令牌、动作 ID 和帧 ID后消费提交权。
- `onPlaybackTerminal`：提交前中断/失败则取消；提交后只记录表现终态，不伪造回滚。
- `cancel`/`close`：提交前安全取消，提交后等待系统结果。
- 启动和提交超时：使用注入时钟和现有 Main 轮询推进，不增加每事务散落定时器。

- [ ] **步骤 1：写状态机 RED**

覆盖正常提交、无标记降级、重复帧、乱序帧、伪造令牌、错误动作、错误帧、提交前中断、提交后中断、执行失败、关闭、超时和并发事务拒绝。

- [ ] **步骤 2：确认 RED**

```powershell
pnpm.cmd --filter @myself/desktop test -- file-task-transaction-coordinator.test.ts
```

- [ ] **步骤 3：实现最小纯 Main 状态机**

测试使用可控 Promise 验证：即使帧事件重复到达，`execute` 也只被调用一次。

- [ ] **步骤 4：复验**

```powershell
pnpm.cmd --filter @myself/desktop test -- file-task-transaction-coordinator.test.ts
pnpm.cmd --filter @myself/desktop typecheck
```

---

### Task 5：让行为权威发放受控搬运播放授权

**文件：**

- 修改：`packages/character-runtime/src/behavior-contracts.ts`
- 修改：`packages/character-runtime/src/behavior-state-inference.ts`
- 修改：`packages/character-runtime/src/character-behavior-engine.ts`
- 修改：`apps/desktop/src/main/characters/character-behavior-service.ts`
- 修改测试：`packages/character-runtime/tests/behavior-contracts.test.ts`
- 修改测试：`packages/character-runtime/tests/behavior-state-inference.test.ts`
- 修改测试：`packages/character-runtime/tests/character-behavior-engine.test.ts`
- 修改测试：`apps/desktop/tests/character-behavior-service.test.ts`

**实现规则：**

- 增加 Main 可信的 `carrying` 活动信号，映射到既有 `carry-start/carry-stop` 和 `carry` 语义；不得允许 Agent 直接指定动作 ID。
- `CharacterBehaviorService.beginTaskCarry()` 通过现有引擎硬约束选择动作并返回实际 `playbackToken/actionId/commitFrameId`。
- 提交帧从当前皮肤的实际 V2 表现解析；缺失时返回 `null`，由事务协调器使用受控降级。
- 活动文件事务期间，普通待机、随机移动和低优先级 Agent 意图不能抢占搬运动作。
- 用户直接拖拽可在提交前中断事务；提交后只影响表现，不改变系统操作结果。
- 角色切换必须使旧任务播放授权失效；新角色不得继承旧角色提交帧。

- [ ] **步骤 1：写行为 RED**
- [ ] **步骤 2：确认 RED**

```powershell
pnpm.cmd --filter @myself/character-runtime test -- behavior-contracts.test.ts behavior-state-inference.test.ts character-behavior-engine.test.ts
pnpm.cmd --filter @myself/desktop test -- character-behavior-service.test.ts
```

- [ ] **步骤 3：最小扩展现有行为链**

不得建立第二套动作选择器或第二份播放令牌表。

- [ ] **步骤 4：复验**

```powershell
pnpm.cmd --filter @myself/character-runtime test
pnpm.cmd --filter @myself/desktop test -- character-behavior-service.test.ts
pnpm.cmd --filter @myself/character-runtime typecheck
pnpm.cmd --filter @myself/desktop typecheck
```

---

### Task 6：建立提交帧 IPC 与 Renderer 单次反馈

**文件：**

- 修改：`apps/desktop/src/shared/character-motion-ipc.ts`
- 修改：`apps/desktop/src/shared/ipc-channels.ts`
- 修改：`apps/desktop/src/shared/myself-api.ts`
- 修改：`apps/desktop/src/preload/index.ts`
- 修改：`apps/desktop/src/main/ipc/register-ipc.ts`
- 修改：`apps/desktop/src/renderer/src/characters/player/CharacterPlayer.tsx`
- 修改测试：`apps/desktop/tests/character-motion-ipc.test.ts`
- 修改测试：`apps/desktop/tests/preload-api.test.ts`
- 修改测试：`apps/desktop/tests/character-player.test.tsx`

**严格输入：**

```ts
type CharacterActionMilestoneInput = {
  playbackToken: string;
  actionId: string;
  kind: 'commit-frame';
  frameId: string;
};
```

**实现规则：**

- Main 下发的任务 `behavior-action` 才携带可选 `commitFrameId`。
- Renderer 复用 Pixi 逐帧订阅，在当前播放令牌的动作首次进入目标帧时报告一次。
- Renderer 不发送相对路径、绝对路径、工具名、确认 ID或系统能力名。
- 每个播放令牌只允许本地报告一个提交帧；reload、投影刷新、循环动画和方向重建不能重复报告。
- Main 严格校验发送者是 pet `webContents`，再交给事务协调器；未知、旧或已终态令牌稳定拒绝。
- 现有 `started/completed/interrupted/failed` 反馈仍先经过统一严格解析，再同时通知行为服务和事务协调器；协调器只能观察已绑定的任务令牌，不能成为第二套动作调度权威。
- 生产 preload 只暴露严格的里程碑方法，不暴露事务快照或回收站端口。

- [ ] **步骤 1：写 Schema、IPC 和 Renderer RED**
- [ ] **步骤 2：确认 RED**

```powershell
pnpm.cmd --filter @myself/desktop test -- character-motion-ipc.test.ts preload-api.test.ts character-player.test.tsx
```

- [ ] **步骤 3：实现最小单次反馈**
- [ ] **步骤 4：复验生产 preload 边界**

```powershell
pnpm.cmd --filter @myself/desktop test -- character-motion-ipc.test.ts preload-api.test.ts preload-production-boundary.test.ts character-player.test.tsx
pnpm.cmd --filter @myself/desktop typecheck
```

---

### Task 7：角色工作室编辑提交帧并保留迁移兼容

**文件：**

- 修改：`apps/desktop/src/renderer/src/characters/workshop/ActionInspector.tsx`
- 修改：`apps/desktop/src/renderer/src/characters/workshop/CharacterWorkshopView.tsx`
- 修改：`apps/desktop/src/renderer/src/characters/store/character-workshop-store.ts`
- 修改：`packages/character-runtime/src/character-v1-converter.ts`
- 修改：`packages/character-runtime/src/legacy-runtime-projection.ts`（仅在帧 ID 未保留时）
- 修改：`apps/desktop/src/main/characters/official-default-character.ts`
- 修改相关角色工作室、迁移和默认角色测试

**编辑规则：**

- 动作表现提供“任务提交帧”选择器，选项来自当前动作稳定帧 ID。
- 只有 `carry` 语义展示该编辑项；切换到其他语义时清除无效提交帧。
- 删除被引用帧时显示引用影响并要求确认，不能留下悬空引用。
- 默认角色的搬运动作声明一个确定提交帧和 `carry` 锚点。
- V1 转换不伪造精确提交帧；保持 `undefined`，运行时走 `started` 合成提交降级。
- 导入、导出、编译、发布和重启后提交帧保持一致。

- [ ] **步骤 1：写编辑、引用和迁移 RED**
- [ ] **步骤 2：确认 RED**
- [ ] **步骤 3：实现最小表单与引用维护**
- [ ] **步骤 4：复验角色包闭环**

```powershell
pnpm.cmd --filter @myself/character-runtime test
pnpm.cmd --filter @myself/desktop test -- character-action-editor.test.tsx character-workshop-store.test.ts character-package-service.test.ts
pnpm.cmd verify:characters
```

---

### Task 8：把 Agent 确认流程接入动画提交事务

**文件：**

- 修改：`apps/desktop/src/main/agent/agent-service.ts`
- 修改：`apps/desktop/src/main/agent/pending-action-store.ts`（只在事务所有权转移需要明确接口时）
- 修改：`apps/desktop/src/main/index.ts`
- 修改测试：`apps/desktop/tests/agent-service.test.ts`
- 修改测试：`apps/desktop/tests/pending-action-store.test.ts`
- 修改集成测试：`tests/integration/desktop-agent.test.ts`

**流程要求：**

1. 非回收站写操作继续走现有同步确认流程，不受本计划重构影响。
2. 回收站确认消费一次性 `PendingAction`，把私有动作和 continuation 移交事务协调器。
3. 发布 `acting` 和 `character_carrying=true` 后请求搬运动作，不立即执行文件操作。
4. 提交帧校验成功才调用 `executeWrite`。
5. 真实成功后发布 `character_carrying=false`、恢复 Agent、再由现有事件产生成功动作。
6. 提交前失败时丢弃 continuation，发布明确错误，文件保持不变。
7. 本地回收站已成功但模型总结失败时，继续使用 `PROVIDER_SUMMARY_FAILED_AFTER_WRITE`，公开任务终态保持本地成功并附带总结警告，不能再发布会驱动失败动作的普通 `phase:error`。
8. 重复确认、取消确认、退出、Provider/授权根改变和新任务替换都不能遗留可提交事务。

- [ ] **步骤 1：写 Agent 与组合根 RED**
- [ ] **步骤 2：确认 RED**

```powershell
pnpm.cmd --filter @myself/desktop test -- agent-service.test.ts pending-action-store.test.ts file-task-transaction-coordinator.test.ts
pnpm.cmd exec vitest run --config tests/vitest.config.ts tests/integration/desktop-agent.test.ts
```

- [ ] **步骤 3：最小分流接线**

不得把全部现有写工具改造成动画事务；本阶段只分流 `move_to_recycle_bin`。

- [ ] **步骤 4：复验**

```powershell
pnpm.cmd --filter @myself/desktop test
pnpm.cmd test:integration
pnpm.cmd --filter @myself/desktop typecheck
```

---

### Task 9：补全安全、集成和 Electron E2E

**文件：**

- 修改：`tests/security/permission-boundary.test.ts`
- 修改：`tests/integration/desktop-agent.test.ts`
- 修改：`tests/e2e/desktop.spec.ts`
- 修改：`tests/fixtures/electron-app.ts`（只添加 E2E 临时目录和安全探针需要的最小能力）
- 修改：`apps/desktop/src/main/e2e-boundary.ts` 或实际 E2E 边界文件（若需要）

**安全测试矩阵：**

- 未授权路径、父级穿越、绝对路径、符号链接和 Junction。
- 预览后目标被替换、删除或变成链接。
- 伪造 `VerifiedWriteAction`、伪造确认 ID和重复确认。
- 伪造、乱序、重复、过期和跨角色播放令牌。
- 提交帧前文件不变；提交帧后只调用一次回收站端口。
- 系统回收站失败时文件仍存在且只播放失败分支。
- 成功后文件不在原位置，且测试适配器确认进入隔离回收站夹具；测试不得操作用户真实回收站。
- 生产 preload 不暴露绝对路径、私有写动作、事务状态或 E2E 探针。

**E2E 场景：**

1. 在系统临时授权目录创建单个测试文件。
2. 脚本 Provider 提出 `move_to_recycle_bin`。
3. 确认卡显示相对路径和回收站说明。
4. 确认前文件存在且行为未进入成功。
5. 确认后观察 `carry` 动作 `started`。
6. 提交帧前文件仍存在。
7. 提交帧后文件离开原位置，动作最终为 `completed` 或结果动作。
8. 角色切换、拖拽中断和回收站失败分别验证不重复执行。

- [ ] **步骤 1：写安全与 E2E RED**
- [ ] **步骤 2：运行聚焦集成和 E2E**

```powershell
pnpm.cmd test:security
pnpm.cmd test:integration
pnpm.cmd --filter @myself/desktop build
pnpm.cmd exec playwright test --config tests/playwright.config.ts tests/e2e/desktop.spec.ts --grep "回收站搬运闭环"
```

- [ ] **步骤 3：只修复闭环暴露的真实接线问题**
- [ ] **步骤 4：重新运行聚焦验证，确认没有残留 Electron/Node 测试进程**

---

### Task 10：中文验收记录、完整门禁和人工验收

**文件：**

- 新建：`docs/operations/file-entity-recycle-bin-transport-acceptance.md`

**自动验收记录至少包含：**

- Windows 版本、应用版本、角色和测试日期。
- 确认前、提交帧前和提交帧后的文件真实状态。
- 回收站成功、回收站拒绝、目标变化、动画失败和角色切换结果。
- 精确提交帧与无标记降级两种表现。
- 重复里程碑和旧令牌不会重复执行的证据。
- 日志不包含 API Key、Authorization、完整绝对路径或文件内容。
- 明确说明未实现永久删除、批量删除、目录藏身、UIA、视觉自动化和 MCP。

- [ ] **步骤 1：运行三道完整门禁**

```powershell
pnpm.cmd verify:behavior
pnpm.cmd verify:characters
pnpm.cmd verify:desktop
```

- [ ] **步骤 2：运行文件工具专属复验**

```powershell
pnpm.cmd --filter @myself/file-tools test
pnpm.cmd --filter @myself/file-tools typecheck
pnpm.cmd test:security
pnpm.cmd test:integration
```

- [ ] **步骤 3：Windows 人工验收**

1. 在专用授权测试目录创建不含隐私内容的临时文件。
2. 请求桌宠将该文件移入回收站。
3. 确认前检查文件仍存在，确认卡明确说明可恢复。
4. 点击确认，观察文件图标位于 `carry` 锚点且搬运动作自然。
5. 观察文件只在提交帧后离开原位置。
6. 打开 Windows 回收站，确认测试文件存在并可恢复。
7. 恢复文件，再测试动画提交前拖拽中断，确认文件仍在原位置。
8. 测试角色切换、应用退出和不可用回收站错误，确认不重复提交。
9. 连续执行至少 10 次独立临时文件任务，确认没有重复删除、旧图标残留和令牌串线。
10. 连续运行五分钟，记录 CPU、内存和错误日志。

- [ ] **步骤 4：完成前验证与代码审查**

依次使用：

1. `superpowers:verification-before-completion`
2. `superpowers:requesting-code-review`
3. `superpowers:finishing-a-development-branch`

审查重点：回收站是否只由 Main 调用、提交前是否无副作用、动作令牌是否绑定事务、重复反馈是否幂等、失败结果是否真实、角色包是否仍无系统权限，以及是否误入阶段 3B 或更后范围。

---

## 5. 子智能体执行顺序

实施时按以下依赖顺序执行；同一任务的实现、规格审查和代码质量审查依次完成后，才能进入下一任务：

1. Task 0：Pixi 终态残留。
2. Task 1：严格契约。
3. Task 2：平台无关回收站写动作。
4. Task 3：工具注册、确认 UI 和生产端口。
5. Task 4：Main 事务协调器。
6. Task 5：行为权威搬运授权。
7. Task 6：提交帧 IPC 与 Renderer 反馈。
8. Task 7：角色工作室和迁移兼容。
9. Task 8：Agent 确认接线。
10. Task 9：安全、集成和 E2E。
11. Task 10：验收与完整门禁。

可并行的只有只读调查或互不修改共享文件的测试设计。`character-v2-schema.ts`、`character-behavior-service.ts`、`CharacterPlayer.tsx`、`agent-service.ts` 和 `main/index.ts` 的实施不得并行。

---

## 6. 超时与换方案规则

- 单个问题先定位根因，不因第一次失败直接跳过。
- 同一路径连续三次没有新增证据时，切换为纯函数状态机、内存回收站端口或更小 Renderer 夹具。
- 单点累计 30 分钟仍无实质进展时，停止扩大修改范围，记录失败测试和诊断证据，再拆成独立问题。
- 不得放宽授权根、链接/Junction、一次性确认、目标身份、提交幂等、生产 preload 和 Main 行为权威测试。
- 可以放宽的只有非关键动画精确时间；即使放宽，也必须验证动作 ID、播放令牌、提交帧顺序和真实文件结果。
- 长时间构建或 E2E 可以后台运行，但每 60 秒检查输出和进程状态。

---

## 7. 完成定义

只有同时满足以下条件，才能宣称阶段 3A 完成：

- 用户可通过模型工具对单个授权文件或目录发起回收站操作。
- 确认前和提交帧前文件系统没有变化。
- 精确提交帧到达后，Main 最多调用一次 Windows 回收站端口。
- 路径、目标身份、链接/Junction 和授权根在执行前重新验证。
- Renderer、角色包和 Agent 都不能直接调用回收站或伪造系统成功。
- 动画失败、中断、超时、角色切换和应用退出不会产生未确认或重复操作。
- 系统真实结果驱动成功/失败动作，Agent 总结失败不改写本地事实。
- V1 和缺少提交帧的 V2 角色保持可用，并明确使用受控降级。
- 现有创建、建目录和重命名确认流程无回归。
- `verify:behavior`、`verify:characters`、`verify:desktop` 和文件工具专属门禁均使用新鲜输出通过。
- Windows 人工验收确认文件可从回收站恢复，且没有重复执行、图标残留或敏感日志。
- 未触碰 WebsiteExtension、网站、阶段 3B、长期记忆、语音、自动化或 MCP。

---

## 8. 阶段 3B 交接条件

本计划验收后才允许编写“目录藏身、资源管理器准确发现、动态窗口层级和托盘呼唤”的详细计划。阶段 3B 只能复用本阶段已稳定的动作事务和结果事件，不得把目录观察权限反向加入角色包或文件工具。
