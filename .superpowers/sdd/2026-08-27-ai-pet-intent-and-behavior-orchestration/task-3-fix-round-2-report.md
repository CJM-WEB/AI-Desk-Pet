# Task 3 Review Fix Round 2 报告

## 1. 基本信息

- 日期：2026-08-28
- 修复基线：`f1274277ddd9ae72e1770030876190cf4f7a65fd`
- Finding：公开复合键会合并公开字段完全相同的不同私有动作，使公开合法性检查错误放行。
- 策略：Task 3 采用保守 fail-closed，不公开私有 ID，不提前引入 `play_state`。

## 2. RED

在 `behavior-target-resolver.test.ts` 增加并调整以下契约：

1. 两个不同私有动作的 `name`、`semantic`、`description`、`tags` 完全相同时，仍按两个公开项处理，`action_name` 与共享标签均返回 `false`。
2. 同一个私有动作归属多个状态时，公开层级中仍出现多次；原始目录与 `structuredClone` 后的合法目录都返回 `false`，不依赖对象别名。
3. 同一 `action_name` 只出现一次时保持 `true`。

命令：

```powershell
pnpm.cmd exec vitest run packages/character-runtime/tests/behavior-target-resolver.test.ts
```

- 退出码：`1`
- 结果：18 项中 2 项失败
- 失败原因：复合键把两类重复公开项合并，均错误返回 `true`。

## 3. GREEN 实现

- 删除 `publicCandidateKey`、`publicKey` 和 `uniquePublicCatalogCandidates`。
- `publicCatalogCandidates` 直接保留状态与嵌套动作的实际出现次数。
- `isPublicBehaviorTarget` 延续既有唯一计数规则：名称或标签匹配数必须恰好为 1；多次出现一律失败关闭。
- 本地兼容候选不再携带描述；描述仍完整保留在 Provider 的 `identity + states[].actions[]` 公开目录中。
- `selectPublicBehaviorTarget` 仍只按 Task 3 前已有的名称、语义、标签与目录顺序选择，不使用描述。

该方案无法在不公开私有 ID 的前提下区分“同一动作跨状态复用”和“两个动作公开字段完全相同”，因此 Task 3 统一保守拒绝。Task 4 后续可在独立契约中使用状态与动作上下文恢复精确选择。

## 4. 验证结果

| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| `pnpm.cmd exec vitest run packages/character-runtime/tests/behavior-target-resolver.test.ts` | 18 项通过 | `0` |
| `pnpm.cmd --filter @myself/character-runtime test` | 15 个文件、314 项通过 | `0` |
| `pnpm.cmd --filter @myself/character-runtime typecheck` | 通过 | `0` |
| 8 个桌面直接消费者定向测试 | 8 个文件、478 项通过 | `0` |
| `pnpm.cmd typecheck` | 10 个 workspace 通过 | `0` |
| `pnpm.cmd test:security` | 28 项通过 | `0` |
| `git diff --check` | 通过，仅显示仓库既有 LF/CRLF 提示 | `0` |

所有命令均未超过 15 分钟。

## 5. 边界确认

- 未向 Provider 公开 `stateId`、`actionId` 或其他私有标识。
- 未实现 Task 4 的 `play_state`、最低相似度阈值、生命周期、完成或中断语义。
- 未启用 MCP。
- 本轮只修改解析器、定向测试与本修复报告。
