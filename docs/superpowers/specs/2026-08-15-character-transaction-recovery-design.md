# AI Pet 角色 Store 事务分面恢复设计

> 文档状态：已批准（用户于 2026-08-15 确认执行）
> 日期：2026-08-15
> 上位规格：[AI Pet 桌宠架构优化与恢复开发门设计](./2026-08-15-ai-pet-desktop-architecture-optimization-design.md)
> 对应阶段：B1 `CharacterTransactionRecovery`

## 1. 目标

把 `CharacterStore` 的 draft/publish journal 调度提取为独立的分面恢复模块，使一个角色或一个 marker 的失败不会阻断其他角色、应用启动或普通聊天，同时保留现有 Store 事务算法与原始证据。

## 2. 非目标

- 不接管 `CharacterPackageService` 的 import journal、ZIP 校验、source 安装或导入 saga。
- 不改变角色草稿、运行清单、索引和 Store journal 的磁盘格式。
- 不修复损坏正文，不自动删除角色目录，不把失败恢复伪装成成功。
- 不扩大 Renderer、Preload 或 Provider 的本地权限。

## 3. 当前证据

- `CharacterStore.recoverAllCharacterTransactions()` 顺序调用每个角色的 draft/publish 恢复，任一异常会退出整轮。
- `loadIndex()`、`list()` 和多个公开方法直接触发恢复，缺少按角色缓存的权威结果。
- 损坏 marker 当前抛出 `CHARACTER_TRANSACTION_INVALID`；原文件通常仍在，但没有分面结果和能力门。
- Store 已有成熟的 prepared/installed/rolling-back 恢复、固定 next/backup 路径、路径和链接检查；本规格复用这些算法。

## 4. 已批准恢复预算

- 活动角色优先处理，其余角色保持索引顺序。
- 每轮最多处理 256 个索引角色。
- 使用 2000ms 软预算，仅在两个角色之间检查。
- 不得在单个角色的 draft 或 publish 事务执行中途因预算到期而打断。
- 超过数量或时间预算的角色保留原文件，标记为待后续恢复；不得阻断应用或普通聊天。
- 下一次显式 Store 访问或下一次启动可以继续恢复待处理角色，但必须遵守同一预算。

## 5. 模块与接口

新增 `apps/desktop/src/main/characters/character-transaction-recovery.ts`：

```ts
export type CharacterTransactionRecoveryKind =
  | 'healthy'
  | 'draft-recovery-blocked'
  | 'publish-recovery-blocked'
  | 'draft-and-publish-recovery-blocked';

export type CharacterTransactionRecoveryErrorCode =
  | 'CHARACTER_DRAFT_RECOVERY_BLOCKED'
  | 'CHARACTER_PUBLISH_RECOVERY_BLOCKED'
  | 'CHARACTER_RECOVERY_DEFERRED';

export type CharacterTransactionRecoveryResult = Readonly<{
  characterId: string;
  kind: CharacterTransactionRecoveryKind;
  draftErrorCode: CharacterTransactionRecoveryErrorCode | null;
  publishErrorCode: CharacterTransactionRecoveryErrorCode | null;
  deferred: boolean;
}>;

export type CharacterTransactionRecoveryReport = Readonly<{
  characters: readonly CharacterTransactionRecoveryResult[];
  budgetExceeded: boolean;
}>;
```

模块提供：

```ts
recoverAll(candidates: readonly CharacterRecoveryCandidate[]):
  Promise<CharacterTransactionRecoveryReport>;
resultFor(characterId: string): CharacterTransactionRecoveryResult;
assertDraftSaveAllowed(characterId: string): void;
assertPublishAllowed(characterId: string): void;
assertRuntimeAllowed(characterId: string): void;
```

`CharacterRecoveryCandidate` 只包含 `characterId`、`recoverDraft()` 和 `recoverPublish()` 三个字段。模块不读取 marker schema，不拥有 Store 或 Package 的 phase。

## 6. 分面规则

| 结果 | 草稿读取 | 草稿保存 | 发布 | 运行读取/启用 |
| --- | --- | --- | --- | --- |
| `healthy` | 允许 | 允许 | 允许 | 允许 |
| `draft-recovery-blocked` | 允许读取现存健康草稿 | 拒绝 | 拒绝 | 现存健康运行版本允许 |
| `publish-recovery-blocked` | 允许 | 允许 | 拒绝 | 拒绝该角色 |
| `draft-and-publish-recovery-blocked` | 允许读取现存健康草稿 | 拒绝 | 拒绝 | 拒绝该角色 |

draft 失败后仍必须尝试同角色 publish；一个角色失败后仍必须尝试后续角色。活动角色 publish 受阻只形成权威结果，是否切换官方默认角色由 B3 决定。

## 7. 安全与失败处理

- 损坏 marker 的原始字节不得被覆盖、规范化或删除。
- 路径、Junction、权限和解析异常只归属相应角色与分面。
- deferred 不是 healthy；其原文件保持不动，公开层只得到稳定码。
- Store 公开写方法在覆盖证据前检查分面能力门。
- 恢复结果留在 Electron Main；绝对路径、marker 正文和内部异常不进入 Renderer。

## 8. 测试与验收

自动化覆盖：active/non-active × bad draft/bad publish/both、多个坏角色与健康角色混合、原字节保留、能力门、活动角色优先、256 数量边界、2000ms 角色间软预算、Junction/权限失败。

验收要求：

- 单个失败不停止其余恢复。
- 健康活动角色继续运行。
- draft 受阻不破坏健康 compiled runtime。
- 超限不退出应用或聊天。
- 既有 Store 成功恢复、迁移、回滚和路径安全测试保持通过。

## 9. 旧路径删除条件

新分面矩阵和 Store 回归测试通过后，删除 `recoverAllCharacterTransactions()` 及公开方法中重复的无条件恢复调用。保留底层 `recoverDraftTransaction()`、`recoverPublishTransaction()` 算法；不得把 Package import journal 合并进本模块。
