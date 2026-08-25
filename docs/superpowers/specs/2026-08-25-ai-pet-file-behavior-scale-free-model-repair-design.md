# AI 桌宠文件、行为、固定尺寸与匿名免费模型修复规格

日期：2026-08-25

状态：已按用户预授权完成自审，进入实施

## 1. 目标

本轮只处理四项已明确需求：

1. 文件写操作在用户确认后由 Electron Main 立即执行，不再依赖角色搬运动画或 Renderer 帧事件。
2. 删除滚轮缩放入口与对应 IPC，桌宠始终使用 `1.0` 默认尺寸；旧位置记录中的缩放值只作为兼容输入读取，不再影响运行时。
3. 停止命令持久禁止自主移动；模型可通过受限结构化数据表达运动模式、时长、目标范围和定性距离；“跑远一点”不能退化成无约束近点。
4. 增加 OpenCode Zen 匿名免费远程模型选项，无需保存 API Key；模型仍只提出标准工具调用，本地文件能力继续由现有 Main 安全边界裁决和执行。

## 2. 非目标与硬边界

- 不启用桌宠 MCP，不把 OpenCode CLI 或 OpenCode 文件工具作为本项目执行器。
- 不允许 Provider、Renderer 或角色包直接访问文件系统。
- 不接受模型返回屏幕坐标；运动目标仍由 Main 在当前单屏工作区内计算。
- 匿名免费模型不是本地模型，也不承诺永久免费、无限额度或稳定可用。
- 不伪装 OpenCode `User-Agent`，不复制其大型 Agent 运行时；只复用其公开 Zen 匿名 Provider 模式与标准 OpenAI-compatible 协议。
- 不重做已验收合格的碰撞、拖拽、工作台编译发布逻辑。

## 3. 现状证据与根因

### 3.1 文件确认后失败

`AgentService.confirmDeleteFile` 在执行 `FileToolService.executeWrite` 前强制调用 `beginTaskCarry`，并等待 Renderer 的播放开始或提交帧。当前角色没有 carry 语义、尚未 ready 或已有动作占用时，行为服务会抛出 `CHARACTER_BEHAVIOR_CARRY_UNAVAILABLE`；该普通错误最终显示为“任务执行失败，请重试”，且文件操作从未发生。

OpenCode 的成熟边界是工具执行栈在权限询问处暂停，权限回复后在同一可信执行栈继续调用工具。UI 与动画不拥有提交权。

### 3.2 停止与远距离运动失效

- 显式 Gate 不识别用户实际用语“停止不动”，于是只能依赖可能退化为纯文本的模型输出。
- `motionPlan` 只有模式、时长和区域，没有距离字段；模型即使理解“远”也无法传给 Main。
- `random_work_area` 对全工作区均匀采样但没有最小位移，近点属于合法结果。
- 模型提示只描述字段形状，没有规定停止、单次、持续、时长和距离的选择语义；`behaviorPlan` 也不是必填。
- 停止布尔锁命中后的 Store → Director → Scheduler 链路已存在，但 `local-idle semantic:move` 仍需在 Director 内增加第二道锁。

### 3.3 缩放

当前 Renderer wheel → preload → IPC → Main 几何事务是一整条可变缩放路径，并把缩放持久化到角色位置。用户已明确撤销该功能。

### 3.4 匿名免费模型

OpenCode 使用 OpenCode Zen 远程网关和公开占位凭据 `public`；无用户密钥时只开放零成本且允许匿名的模型。公开端点存在共享 IP 日限额，模型列表和免费状态会变化。当前项目已有 OpenAI-compatible 工具调用协议和本地文件安全链，无需复制 OpenCode Agent 或文件工具。

## 4. 方案

### 4.1 文件执行：确认即提交，动画仅反馈

1. 所有文件写操作统一复用 `executeCapability`：消费一次性确认、校验任务所有权，然后直接执行既有 `VerifiedWriteAction`。
2. 删除 `delete_file` 的动画提交分叉以及只服务该分叉的事务协调器、播放令牌和提交帧 IPC 接线。
3. `character_carrying` 仅作为执行期间的尽力反馈；反馈失败不得改变真实文件结果。
4. `executeWrite` 的本地返回值仍是唯一事实。写入已成功但模型总结失败时，明确显示“本地文件操作已成功”。
5. 删除继续调用现有 Windows 回收站端口；不扩大为递归、永久或批量删除。

### 4.2 固定默认尺寸

1. 删除 Renderer wheel 监听与 `handleWheel`，删除 preload `stepPetScale`、缩放 IPC channel/schema/handler 和缩放专用探针。
2. Main 几何协调器不再公开 `stepScale`，初始化和角色切换一律采用 tick `10`，即 `scale=1.0`。
3. 旧设置中的 `scale` 暂保留为兼容字段，读取时忽略并在下一次正常位置保存时写回 `1.0`；避免一次大规模迁移或破坏已有位置。
4. 缩放删除不得改变 alpha 命中、拖拽边界、脚底锚点和单屏限制。

### 4.3 结构化行为协议

`motionPlan` 固定为以下隐藏结构，绝不显示为聊天正文：

```ts
{
  mode: 'none' | 'stop' | 'once' | 'continuous';
  durationSeconds: number | null;
  target: 'current' | 'random_work_area' | ScreenRegion;
  distance: 'none' | 'near' | 'medium' | 'far';
}
```

- `stop` 必须使 `movementStopped=true` 并立即停止 Motion；只有明确恢复命令才重开自主移动。
- `once` 执行一次；`continuous` 在时限内持续抽取目标，`null` 表示直到明确停止。
- `far` 由 Main 在当前单屏可达工作区中采样，优先保证与当前脚点的位移达到可达跨度的安全阈值；屏幕空间不足时选择最远可达点，不越界、不死循环。
- 明确 Gate 补齐“停止不动”“你停止不动”“跑远一点”等常见高置信命令；其余自然语言由模型结构化输出决定。
- Provider 提示写明每个字段的决策语义和少量正反例，`behaviorPlan` 改为必填；有精确公开候选时复制候选 kind/name，没有时返回 `none`。
- Main 仍校验候选确实存在于当前角色目录；`activity + status + motionPlan + 候选 semantic/tags` 仅用于在合法自定义动作中选最高相似项。
- 纯文本回退可以保证聊天可用，但必须留下不含正文的结构化缺失诊断；它不得制造动作成功事实。

### 4.4 OpenCode Zen 匿名免费模型

1. 新增固定身份 `opencode-zen-anonymous`，固定 `https://opencode.ai/zen/v1`，使用真实 `AI Pet` 客户端标识和内存占位凭据 `public`，不写入 SecretStore。
2. 首版使用经核验的严格内置 allowlist；模型必须同时满足零成本、支持工具调用、未废弃且使用现有 chat-completions 协议。远程元数据只能缩小列表，不能改写 endpoint、协议或权限。
3. 设置页将其显示为“OpenCode Zen 匿名免费试用”，选中即用，不要求 API Key；同时明确联网、共享限额、可能的数据处理和非稳定可用性。
   该入口位于现有“模型”区域，作为新增选项与 DeepSeek、其他预设和自定义 Provider 并存；不得替换、迁移或删除用户已有模型配置，切回原 Provider 时原配置必须完整保留。
4. 429 映射为匿名额度耗尽并保留 `Retry-After` 的安全时间提示；401、模型退役和网络失败各自稳定报错。
5. 切换 Provider 触发现有 generation/确认失效逻辑。免费模型产生的工具调用仍进入同一工具 Schema、授权根、确认卡和 Main 执行链。

## 5. 失败与清理

- 用户取消或确认过期：不执行文件动作，丢弃续跑令牌。
- 文件执行失败：把稳定本地错误显示给用户并把失败事实续跑给模型；不得说成功。
- 行为结构缺失：保留文字聊天，动作不执行并增加诊断计数。
- 停止设置落盘失败：不假装停止成功；保持旧快照并给出错误。
- 匿名模型额度耗尽：不回退到另一个可能收费或需要密钥的 Provider。
- 应用关闭、会话 reset、Provider 切换继续失效旧请求和确认。

## 6. TDD 与验收

### 6.1 文件

- RED：合法但无 carry 动作的自定义角色确认 `delete_file`，当前执行次数为 0；目标应进入回收站一次。
- 覆盖 create/create_directory/apply_patch/delete 的确认执行、取消、过期、真实失败与总结失败。
- 真实 Electron E2E 不再注入播放开始或提交帧，确认后检查临时授权根中的实际结果。

### 6.2 行为

- RED：“停止不动”纵向进入持久锁；推进 30 秒后自主位移请求仍为 0。
- RED：停止锁下直接提交 local-idle move 也被拒绝。
- RED：“跑远一点”保留 `distance=far`；固定随机数时目标满足最小位移或选择最远可达点。
- 连续运动到达后继续抽样，明确停止后不再抽样；自定义候选相似度仍选最高且目录外候选被拒。

### 6.3 固定尺寸

- wheel 不再注册、不再触发任何 IPC；生产 preload 不再暴露缩放方法。
- 旧 `scale=0.5/2.0` 启动均得到 tick `10`、运行时 `scale=1.0`，拖拽与边界测试保持通过。

### 6.4 匿名免费模型

- 单元测试证明无 SecretStore 读取、固定 endpoint、`public` 只存在内存、工具调用按既有协议解析。
- Provider 切换后文件工具仍走确认，模型不能绕过 Main。
- 使用 mock 覆盖 429/401/退役/网络失败；实网只作非稳定人工验收，不作为 CI 成功门禁。

## 7. 完成门禁

依次运行定向测试、相关 package typecheck、`pnpm verify:desktop` 与 `pnpm verify:behavior`，再运行不依赖视觉判断的真实 Electron 文件、停止状态、远距离目标和固定尺寸探针。最终只把实际运行通过的项目记为通过。
