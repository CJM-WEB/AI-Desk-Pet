# AI Pet 角色恢复公开反馈与降级设计

> 文档状态：已批准（用户于 2026-08-15 确认执行）
> 日期：2026-08-15
> 上位规格：[AI Pet 桌宠架构优化与恢复开发门设计](./2026-08-15-ai-pet-desktop-architecture-optimization-design.md)
> 前置规格：[角色 Store 事务分面恢复设计](./2026-08-15-character-transaction-recovery-design.md)、[角色包导入 Journal 设计](./2026-08-15-character-import-journal-design.md)
> 对应阶段：B3 恢复体验与降级

## 1. 目标

把 B1/B2 的 Main 内部恢复结果映射为最小、稳定、可解释的公开快照。非活动角色故障不得影响健康活动角色；活动角色 publish/runtime 不可用时才切换官方默认角色；所有角色恢复故障下普通聊天仍可用。

## 2. 非目标

- 不在 Renderer 修复 journal、读取路径或决定本地删除。
- 不把恢复快照扩展为第二套 Store、Package 或会话状态机。
- 不自动上传角色包或恢复证据。
- 不改变官方默认角色与用户角色的存储边界。

## 3. 公开契约

`character-ipc.ts` 增加封闭 Schema：

```ts
type CharacterAffectedCapability =
  | 'draft-save'
  | 'publish'
  | 'runtime-load'
  | 'package-import';

type CharacterRecoverySuggestion =
  | 'open-character-workshop'
  | 'recompile-and-publish'
  | 'retry-import'
  | 'use-official-default';

type CharacterRecoveryIssueDto = Readonly<{
  characterId: string;
  errorCode:
    | 'CHARACTER_DRAFT_RECOVERY_BLOCKED'
    | 'CHARACTER_PUBLISH_RECOVERY_BLOCKED'
    | 'CHARACTER_DRAFT_AND_PUBLISH_RECOVERY_BLOCKED'
    | 'CHARACTER_IMPORT_JOURNAL_INVALID'
    | 'CHARACTER_IMPORT_OWNERSHIP_MISMATCH'
    | 'CHARACTER_IMPORT_EVIDENCE_PRESERVE_FAILED'
    | 'CHARACTER_RECOVERY_DEFERRED';
  affectedCapabilities: readonly CharacterAffectedCapability[];
  suggestion: CharacterRecoverySuggestion;
}>;

type CharacterRecoverySnapshotDto = Readonly<{
  fallbackActive: boolean;
  fallbackErrorCode: string | null;
  issues: readonly CharacterRecoveryIssueDto[];
}>;
```

严格 Schema 拒绝绝对路径、marker 正文、哈希、owner token、物理身份、evidence 文件名和额外字段。

## 4. 启动裁决

- 活动角色优先恢复。
- 活动角色只有 draft blocked 且 compiled 健康时继续运行。
- 活动角色 publish blocked、runtime 校验失败或索引整体不可用时切换官方默认角色。
- 非活动角色任何分面失败只进入 issues，不触发 fallback。
- Package marker quarantined/blocked 只限制受影响导入能力，不阻断桌宠和普通聊天。
- 256 个角色和 2000ms 软预算超限时保留文件、发布 deferred issue，并继续启动；预算只在角色之间检查。

## 5. Main、IPC 与 Renderer 职责

- `CharacterActions.getCharacterRecoverySnapshot()` 汇总 Store、Package 和 startup 结果并完成内部到公开 DTO 的白名单映射。
- `registerCharacterIpc()` 只接受空输入，通过固定通道返回严格结果。
- Preload 只暴露 `getCharacterRecoverySnapshot()`，并再次以 Zod 校验 Main 返回值。
- Pet 只展示活动 fallback；非活动问题不得替换当前宠物。
- Character Workshop 按角色展示受影响能力和恢复建议；不得显示内部证据。
- Chat 的初始化与提交不依赖角色恢复成功。

## 6. 稳定错误与建议

draft blocked 映射为草稿保存与发布受限；publish blocked 映射为重新编译发布；both 显示两类能力；import invalid/ownership/evidence 失败映射为重新导入或打开工作室；deferred 说明将在后续访问或重启继续恢复。未知异常统一映射 `CHARACTER_OPERATION_FAILED`，不回显原文。

## 7. 测试与人工验收

自动化覆盖启动 active/non-active 矩阵、结构化 IPC、防额外字段、Renderer 文案与按钮、工作室能力提示、聊天独立可用，以及真实 Electron 重启后的坏 Store/Package marker 场景。

真实 Windows E2E 必须验证：健康活动角色不因非活动 marker 损坏而回退；活动 publish 损坏后显示官方默认角色；原 marker 字节仍在；聊天可打开并提交；公开快照不含路径、正文或 token。窗口层级和人工可读性没有人工证据时记录为“待用户人工确认”。

## 8. 旧路径删除条件

新结构化快照贯穿 Actions、IPC、Preload、Pet 和 Workshop 且测试通过后，删除 `startupRecoveryErrorCode` 标量、`registerCharacterIpc()` 的 recovery callback、旧 `{errorCode}` Schema 和只服务旧单错误横幅的测试。不得删除 B1/B2 内部详细结果，也不得把公开 DTO 反向用作 journal 状态。
