# Task 3 Review Fix Round 1 报告

## 1. 基本信息

- 日期：2026-08-28
- 修复基线：`346fcf993ae1ec85e2ad4c3863258d972d14521f`
- 范围：处理 review 的两个 Important，不处理 Minor，不实现 Task 4。

## 2. Important 1：描述不得提前改变运行时选择

### RED

在 `behavior-target-resolver.test.ts` 增加回归契约：状态与动作的既有公开名称、语义、标签完全相同，仅动作描述命中 activity/status 时，Task 3 仍按既有目录顺序选择状态，不使用描述改变选择。

命令：

```powershell
pnpm.cmd exec vitest run packages/character-runtime/tests/behavior-target-resolver.test.ts
```

- 退出码：`1`
- 与 Important 2 合计：17 项中 2 项失败
- 本项实际结果：错误选择 `action_name`，预期为稳定顺序中的 `state_name`。

### GREEN

- 从相似度评分中移除 `candidate.description`。
- activity/status 继续只匹配 Task 3 之前已有的公开名称、语义和标签。
- 描述仍保留在 Provider 公开层级目录，不被删除。
- 未增加最低相似度阈值、`play_state`、完成/中断语义或生命周期。

## 3. Important 2：目录克隆后不得依赖对象引用去重

### RED

将同一动作挂到两个公开状态后，通过 `structuredClone` 打散对象别名，并用严格公开目录 Schema 证明克隆结果仍合法。

- 当前引用 `Set<PublicBehaviorAction>` 无法识别克隆后的同一公开动作。
- `isPublicBehaviorTarget` 返回 `false`，预期为 `true`。

### GREEN

- 删除按对象引用去重。
- 使用稳定公开复合键去重：目标种类、NFKC/大小写规范化名称、语义、可选描述、规范化并排序的标签。
- 复合键不包含或派生任何私有 `stateId`、`actionId`、资源路径、帧或脚本。
- 描述只参与公开目标同一性判定，不参与运行时相似度评分。
- 私有解析器仍负责最终唯一性检查；不同私有动作同名或同标签时继续失败关闭。

## 4. 验证结果

| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| `pnpm.cmd exec vitest run packages/character-runtime/tests/behavior-target-resolver.test.ts` | 17 项通过 | `0` |
| `pnpm.cmd --filter @myself/character-runtime test` | 15 个文件、313 项通过 | `0` |
| `pnpm.cmd --filter @myself/character-runtime typecheck` | 通过 | `0` |
| 8 个桌面直接消费者定向测试 | 8 个文件、478 项通过 | `0` |
| `pnpm.cmd typecheck` | 10 个 workspace 通过 | `0` |
| `pnpm.cmd test:security` | 28 项通过 | `0` |
| `git diff --check` | 通过，仅显示仓库既有 LF/CRLF 提示 | `0` |

中间首次包类型检查退出码为 `1`，原因是移除引用 Set 时遗漏仍用于 `satisfies` 的类型导入，以及 Zod 输出在 `exactOptionalPropertyTypes` 下不能直接赋给只读契约。随后保留类型导入，并使用类型安全的 `structuredClone` 加 Schema 合法性断言，最终包与全仓类型检查均通过。

所有命令均未超过 15 分钟。

## 5. 自审结论与关注点

- 描述已不参与 Task 3 运行时评分，避免只做“描述评分但没有最低阈值”的半套 Task 4。
- 去重不依赖对象身份，合法目录经克隆后保持相同判定。
- 没有修改 Provider 公开目录的隐私字段集合，没有启用 MCP。
- Review 提及的相似度注释和限额重复属于 Minor，本轮按要求暂不处理，留待最终减法审查。
