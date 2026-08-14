# AI Pet 角色包导入 Journal 设计

> 文档状态：已批准（用户于 2026-08-15 确认执行）
> 日期：2026-08-15
> 上位规格：[AI Pet 桌宠架构优化与恢复开发门设计](./2026-08-15-ai-pet-desktop-architecture-optimization-design.md)
> 对应阶段：B2 `CharacterImportJournal`

## 1. 目标

为角色包导入建立独立、可 durable 发布、可逐 marker 隔离的 journal，使截断、未知版本、权限、冲突或所有权不匹配不会误删角色，也不会阻断其他 marker、应用或聊天。

## 2. 非目标

- 不拥有 CharacterStore 的 draft/publish journal 或其 phase。
- 不拥有 ZIP 路径安全、容量限制、source 安装、Store publish 或外层 import saga。
- 不以普通 `rename`、`copyFile` 或直接打开最终文件写入替代 exclusive 原子发布。
- 不删除不能证明由当前导入事务拥有的目录。

## 3. 当前证据

- Package marker 当前直接 `writeFile(final, {flag:'wx'})`，独占但最终文件写入期间可见。
- `recoverPendingRollbacks()` 的整轮恢复由一个 `try` 包围，单个坏 JSON 会停止后续 marker。
- v1 marker 被静默删除；v2 可凭物理字段走删除；损坏 marker 没有不覆盖的证据隔离。
- `atomicWriteText()` 使用 temp、`sync()` 和普通 `rename()`，不是 Windows exclusive publish。
- Store rollback 已验证 character ID、owner token，并在 rename 前后复核角色目录和 owner 文件的 `dev/ino`；应保留并把布尔结果细化。

## 4. 状态与接口

新增 `apps/desktop/src/main/characters/character-import-journal.ts`，只接受：

```ts
export type CharacterImportJournalRecord = Readonly<{
  version: 4;
  characterId: string;
  importTransactionId: string;
}>;

export type ImportedCharacterRollbackResult =
  | { kind: 'rolled-back' }
  | { kind: 'absent' }
  | { kind: 'ownership-mismatch' }
  | { kind: 'active-character' };

export type CharacterImportJournalEntryResult =
  | { kind: 'recovered'; characterId: string }
  | { kind: 'quarantined'; characterId: string; errorCode: 'CHARACTER_IMPORT_JOURNAL_INVALID' }
  | { kind: 'blocked'; characterId: string; errorCode:
      'CHARACTER_IMPORT_OWNERSHIP_MISMATCH' |
      'CHARACTER_IMPORT_EVIDENCE_PRESERVE_FAILED' };
```

公开给 PackageService 的方法为 `create(record)`、`complete(record)`、`recoverAll()`。Store 的 import rollback/complete 改为判别联合，禁止调用方把 `false` 当作安全成功。

## 5. Exclusive 文件原语

在 `atomic-file-coordinator.ts` 新增：

```ts
export async function atomicWriteTextExclusive(
  file: string,
  content: string
): Promise<void>;
```

实现顺序固定为：同目录唯一 temp → `open('wx', 0o600)` → write → `FileHandle.sync()` → close → `link(temp, final)` → 清理 temp。`EEXIST` 必须失败且不得覆盖；不支持 hard link 或跨卷时 fail closed，不回退普通 rename/copy。

损坏 marker 隔离使用同目录 exclusive hard-link 证据文件；复核源与 evidence 的物理身份后才能 unlink 原 marker。隔离失败保留原 marker 并返回 blocked。

## 6. 导入顺序与所有权

正式顺序：journal durable publish → Store create/owner → source install → draft save → Store publish → Store owner complete → journal complete。

回滚删除必须同时满足：marker 的 character ID 与 owner token 匹配，Store owner 文件匹配，角色目录和 owner 文件物理身份在移动前后保持一致。`absent` 可完成 marker；`ownership-mismatch` 和 `active-character` 必须保留证据且不得删除目录。

## 7. 恢复预算

- 活动角色相关 marker 优先；其余保持稳定文件名顺序。
- 最多关联并处理 256 个索引角色。
- 2000ms 软预算只在两个角色之间检查，不打断单角色 journal 恢复。
- 超限 marker 保持原文件并标记待后续恢复，不阻断应用或聊天。
- 每个 marker 独立捕获空文件、半截 JSON、未知版本、权限、名称冲突和恢复失败。

## 8. 安全与隐私

- v1/v2 等缺少当前 owner token 的 legacy marker 不得触发目录删除；只能不覆盖地隔离或标记 blocked。
- 隔离证据保留原始字节。
- 任一 evidence 保存失败不得报告该 marker 已恢复。
- Renderer 不接收 marker 文件名、路径、正文、哈希、token 或物理身份。
- Store 与 Package journal 只可共享安全读取、证据命名、exclusive 发布、物理身份比较和 fault injection；不得共享状态模型。

## 9. 测试与验收

失败矩阵覆盖 open/write/flush/publish、空/半截/未知版本、evidence 冲突、权限和磁盘满、owner/source/Store publish 中断、所有权身份变化、活动角色、同 ID 替代、多个 marker 隔离和预算超限。

Windows 真实测试必须证明 hard-link final publish 在并发下恰好一个 writer 成功、已有目标不变、最终正文完整；不能以 mock 结果替代该语义验证。

## 10. 旧路径删除条件

新 journal 单测、Package 集成测试和 Windows exclusive 测试通过后，删除 PackageService 内的 marker schema、直接读写、`writePendingImport()`、`recoverPendingRollbacks()`、`preserveRollback()` 以及 v1 静默删除/v2 无 token 删除路径。保留 Store owner 文件和物理身份复核，不合并两个 journal 状态机。
