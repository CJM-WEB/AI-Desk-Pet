# Task 3：发布层级角色目录与详细描述——执行报告

## 1. 基本信息

- 执行日期：2026-08-28
- 环境：Windows / PowerShell / pnpm workspace
- 基线提交：`6bd0cdf379d881a6dd3840af25fe6d60524d6ff0`
- 分支：`AgentCoreExtension`
- 提交消息：`feat(character): 发布层级状态动作描述`
- 提交说明：本报告与实现使用上述消息在同一提交中提交；提交哈希在提交完成后的最终短报中记录，避免报告自引用改变提交哈希。

## 2. 范围结论

本任务已按 Task 3 简报完成以下范围：

1. V2 状态和动作新增可选、最大 2,000 字符的 `description`；旧 V2 不提供该字段仍合法。
2. 角色工作台增加状态、动作详细描述编辑入口，并复用既有 `updateState`、`updateAction`、草稿保存、编译发布和重载链路。
3. Provider 公开目录从扁平聚合字段迁移为 `identity + states[].actions[]` 层级，保留状态到动作归属及状态、动作描述。
4. 公开人设只包含有界字段：`name`、`description`、`background`、`traits`、`languageStyle`、`likes`、`behavioralTendencies`。
5. 正式 Provider 目录已删除 `candidates`、`characterName`、`semantics`、`stateNames`、`actionNames`、聚合 `tags` 旧路径，直接消费者与测试夹具同步迁移。
6. 公开目录不包含 `stateId`、`actionId`、资源路径、帧、脚本或其他私有能力引用；私有 ID 只在 Main 内部解析器中使用。

实际组件位于：

- `apps/desktop/src/renderer/src/characters/workshop/StateInspector.tsx`
- `apps/desktop/src/renderer/src/characters/workshop/ActionInspector.tsx`

简报中的 `workshop/components/` 路径与仓库现状不同，因此只对上述真实路径做必要最小调整。

`character-workshop-store.ts` 生产实现未修改。调查确认既有不可变更新、草稿持久化、编译发布与重载会自然携带 Schema 中新增的可选字段；新增测试覆盖该链路，未创建第二套持久化机制。

## 3. TDD 证据

### 3.1 初始 RED：共享契约与公开目录

命令：

```powershell
pnpm.cmd --filter @myself/character-runtime test
```

- 退出码：`1`
- 结果：312 项中 5 项失败
- 失败原因：严格 V2 Schema 拒绝状态/动作 `description`；公开目录仍为扁平聚合结构；层级目录与隐私断言尚未满足。

### 3.2 初始 RED：工作台保存、发布与重载

命令：

```powershell
pnpm.cmd exec vitest run --config apps/desktop/vitest.config.ts apps/desktop/tests/character-workshop-components.test.tsx apps/desktop/tests/character-workshop-store.test.ts
```

- 退出码：`1`
- 结果：128 项中 3 项失败
- 失败原因：状态/动作 Inspector 尚无详细描述输入；严格 Schema 阻止带描述草稿发布，因此发布调用次数为 0。

### 3.3 自审补充 RED：重复动作归属

命令：

```powershell
pnpm.cmd exec vitest run packages/character-runtime/tests/behavior-target-resolver.test.ts
```

- 退出码：`1`
- 结果：17 项中 1 项失败
- 失败原因：同一个动作归属于多个状态时，层级目录按归属重复展示；Main 本地兼容展开误把重复归属计为不同公开动作。
- 最小修复：公开目录构建时复用同一公开动作对象，本地兼容展开按对象归属去重；不同私有动作即使同名仍保持歧义并由私有解析器拒绝。

### 3.4 最终 GREEN

| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| `pnpm.cmd --filter @myself/character-runtime test` | 15 个文件、313 项通过 | `0` |
| `pnpm.cmd exec vitest run --config apps/desktop/vitest.config.ts apps/desktop/tests/character-workshop-components.test.tsx apps/desktop/tests/character-workshop-store.test.ts` | 2 个文件、128 项通过 | `0` |
| 8 个角色目录直接消费者定向测试 | 8 个文件、478 项通过 | `0` |
| `pnpm.cmd typecheck` | 10 个 workspace 类型检查通过 | `0` |
| `pnpm.cmd test:security` | 28 项通过 | `0` |
| `pnpm.cmd test:integration` | 83 项通过 | `0` |
| `pnpm.cmd verify:characters` | runtime、assets、desktop、security、integration、build、边界检查及 Electron E2E 全部通过 | `0` |

`verify:characters` 的主要计数：

- `character-runtime`：312 项通过（自审补充用例前的该次全门禁；最终定向为 313 项）
- `character-assets`：99 项通过
- Desktop 全量单测：2,650 项通过
- 安全测试：28 项通过
- 集成测试：83 项通过
- Electron E2E：77 项通过，1 项按套件既有条件跳过
- E2E 用时约 7.8 分钟；没有单个命令超过 15 分钟时间盒。

## 4. 额外门禁波动记录

首次执行 `pnpm.cmd verify:behavior` 时，`character-runtime` 与 `agent-core` 已通过，但 Desktop 全量套件有 3 项文件系统测试超过各自固定 5 秒超时，结果为 2,647/2,650 通过，命令退出码 `1`：

1. `character-asset-service`：首次写与 `expectedPreviousSha256` 覆盖匹配；
2. `character-package-service`：竞争目录下的 staging 保留；
3. `character-store`：坏发布事务恢复与草稿可用性。

三项分别单独重跑均退出码 `0`。随后 `verify:characters` 中同一 Desktop 全量套件 2,650/2,650 通过，且后续安全、集成、构建、边界检查和 Electron E2E 均通过。该现象按并发负载下的既有超时波动记录，不将首次 `verify:behavior` 写成通过。

## 5. 修改摘要

### 5.1 Schema 与工作台

- `character-v2-schema.ts`：状态、动作增加可选有界描述。
- `StateInspector.tsx`、`ActionInspector.tsx`：增加受控文本域，`maxLength=2000`，空字符串回落为 `undefined`。
- Schema 与工作台测试覆盖：描述有界、旧 V2 兼容、保存、发布、重载。

### 5.2 公开目录与私有解析

- `character-behavior-plan.ts`：定义并严格校验有界公开人设及状态到动作层级。
- `behavior-target-resolver.ts`：按当前皮肤只发布可播放动作，保留描述和归属；私有 ID、素材与帧不进入公开对象。
- 旧 `play` 目标在 Task 3 期间只通过 Main 内部临时展开兼容，不再成为 Provider 正式目录字段。
- 描述参与隐藏 activity/status 的目标相似度选择。

### 5.3 直接消费者迁移

- 对话系统提示改为引用 `states` 及其 `actions`，删除旧 `candidates` 压缩分支。
- 角色不可用降级目录改为有界 `identity + states: []`。
- 本地模型验收脚本、桌面 Main 相关测试、安全与集成测试夹具同步迁移到唯一正式层级路径。

## 6. 隐私与边界自审

- `publicBehaviorCatalogSchema` 使用严格对象，嵌套动作注入 `actionId` 会被拒绝。
- 公开目录序列化断言拒绝状态 ID、动作 ID、隐藏状态、asset、文件名、帧以及私有人设字段。
- 新增差异静态扫描未发现 `play_state`、Task 4 生命周期、最小阈值或 MCP 启用代码。
- 仓库中原有生命周期字段及 E2E 的 MCP 保留数据测试未被本任务修改；MCP 运行时仍保持既有禁用边界。
- 未执行大量删除；删除范围仅为旧公开目录接口、压缩分支及其测试夹具中的正式旧路径。

## 7. 未覆盖与关注点

1. 状态/动作详细描述输入的真实 Windows 窗口视觉、键盘输入和人工发布操作仍待用户人工确认；自动化已覆盖组件事件和持久化链路。
2. 首次 `verify:behavior` 受 3 项既有 5 秒超时影响而退出 `1`；精确重跑与后续 `verify:characters` 全量套件均通过，详细证据见第 4 节。
3. 本任务未实现 Task 4 的 `play_state`、行为生命周期、完成/中断语义或最小相似度阈值；后续任务应在独立 RED 契约下推进。
