# AI Pet 角色包导入恢复设计

> 文档状态：已批准（用户于 2026-08-20 确认方案 1，并授权自主复审后执行）
> 日期：2026-08-20
> 上位规格：[AI Pet 桌面架构优化减法收口设计](./2026-08-20-desktop-code-subtraction-design.md)
> 原始上位规格：[AI Pet 桌宠架构优化与恢复开发门设计](./2026-08-15-ai-pet-desktop-architecture-optimization-design.md)
> 对应阶段：B2 角色包导入恢复

本规格原位替代本文 2026-08-15 版本中“新增 `CharacterImportJournal`、升级 marker v4”的设计。它受 2026-08-20 减法规格覆盖：保留现有 v3 磁盘语义，原位深化 `CharacterPackageService`，不建立第二个 marker owner；未被本文改写的角色包导入安全边界继续有效。

## 1. 为什么处理这项业务

角色包的正常导入、发布和启用路径当前基本可用。本阶段不重做这些功能，只收敛断电、进程崩溃、磁盘写入失败或文件被替换时的恢复路径。

当前实现存在可由代码直接证明的风险：

- `writePendingImport()` 直接向正式 marker 使用 `writeFile(..., { flag: 'wx' })`；写入期间正式文件已可见，异常中断可留下半截 JSON。
- `recoverPendingRollbacks()` 用一层外部 `try` 包住整轮循环；一张空文件、坏 JSON 或权限异常可阻止后续健康 marker 恢复。
- v1 会被静默删除；v2 只凭旧物理摘要即可调用普通 `store.delete()`，二者都没有当前导入事务令牌，不能证明目录归本次导入所有。
- 导入失败路径调用普通 `store.delete()`，绕过现有 `rollbackImportedCharacter(characterId, importTransactionId)` 的 owner token 和目录身份复核。
- marker 的读取、判断和删除之间缺少同一文件身份复核；检查后路径被替换时可能清理错误文件。

因此，B2 修复的是低频但可能误删角色、丢失恢复证据或阻断启动的异常路径，不扩大角色包业务范围。

## 2. 目标

1. 保留并严格化现有 v3 marker；不增加没有新语义的 v4 和迁移代码。
2. 使正式 marker 只在正文完整落盘后排他可见，已有目标永不被覆盖。
3. 每张 marker 独立恢复；单项损坏、冲突或权限失败不阻断其他角色、桌宠启动或普通聊天。
4. 只有角色 ID、导入事务令牌和 Store 目录所有权全部匹配时才允许回滚。
5. 无法安全恢复时保留原始字节证据，并只向后续 B3 提供最小、脱敏的问题列表。
6. 新路径通过后删除旧 marker owner、危险回退和只服务旧实现的重复测试，使正式运行时仍只有一个 owner 和一条恢复路径。

## 3. 非目标

- 不新建 `character-import-journal.ts`、`CharacterImportJournal` 或同义浅模块。
- 不升级 v3 marker，不迁移、改写或补齐 v1/v2 marker。
- 不拥有 `CharacterStore` 的 draft/publish transaction recovery、ZIP 路径安全、容量限制、source 安装、编译或发布规则。
- 不改变正常角色导入的包格式、编辑器、播放器、启用流程或网站投稿链。
- 不把 I/O fault injection、文件句柄、物理身份或内部恢复阶段扩散为公开产品接口。
- 威胁模型只覆盖本进程导入队列，以及测试可复现的非恶意外部文件竞态；不承诺抵御同一 Windows 用户下具有任意权限、主动绕过检查的恶意本机进程。

## 4. 深模块与 owner 裁决

### 4.1 唯一 owner

`CharacterPackageService` 继续是角色包导入 saga 和 package marker 的唯一 owner。v3 Schema、创建、完成、启动恢复、问题汇总和隔离都留在其私有实现中；调用者只使用已有导入接口和收敛后的 `initialize()` 结果。

不新增独立 Journal，原因是目前只有 `CharacterPackageService` 一个真实调用者。删除假想 Journal 后复杂度只会回到这个调用点，不会散落到多个调用者，无法通过 deletion test，只会增加一层转发、一个接口和第二套测试。

### 4.2 允许新增的通用原语

唯一允许增加的外部能力位于现有 `atomic-file-coordinator.ts`：一个排他发布完整字节文件的通用原语，接口固定为：

```ts
export async function atomicWriteFileExclusive(
  file: string,
  content: Uint8Array
): Promise<void>;
```

它隐藏同目录临时文件、完整写入、`FileHandle.sync()`、关闭、hard-link 排他发布和临时文件清理。现有 `atomicWriteText()` 的 replacement 语义不变，不能借机改写其他存储模块。

这个原语通过 deletion test：删除它后，同一套“不暴露半成品、目标存在即失败、失败清理临时文件”的文件协议会重新散落到 marker 创建和证据保留等多个调用点。它只提供文件发布语义，不拥有导入状态。

## 5. 磁盘契约

### 5.1 正式格式

正式 marker 继续使用当前 v3：

```ts
type CharacterPackageImportMarkerV3 = Readonly<{
  version: 3;
  characterId: string;
  importTransactionId: string;
}>;
```

- `characterId` 必须同时通过安全 ID Schema 和严格 marker 文件名提取校验，且正文与文件名一致。
- `importTransactionId` 必须是当前接受的 UUID v4；它与 Store owner 文件中的令牌完全相等时才形成删除授权。
- Schema 严格拒绝额外字段、未知版本、类型错误和超限正文。
- v3 已包含安全回滚所需的全部语义；不得为了版本号变化创建 v4。

### 5.2 完整、排他发布

`atomicWriteFileExclusive()` 的顺序固定为：

1. 在最终文件同目录创建不可预测的唯一临时文件，使用 `open('wx', 0o600)`；
2. 写入全部字节并执行 `FileHandle.sync()`；
3. 关闭句柄；
4. 使用 `link(temp, final)` 排他发布完整文件；
5. 无论成功或失败都尽力清理临时文件。

`EEXIST` 必须原样表示目标冲突且不得覆盖。hard link 不支持、跨卷或发布失败时 fail closed，不回退到普通 `rename()`、`copyFile()` 或直接写最终路径。本原语保证发布前内容已完整刷入且最终路径不会观察到本次半成品；JSON 调用者自行编码 UTF-8，损坏证据直接传入读取到的原始字节。不得把它宣传成超出 Node/Windows 文件系统保证的完整断电事务。

### 5.3 legacy 与损坏证据

- 候选 inventory 接受当前角色根目录下以 `.package-import-rollback-` 开头、以 `.json` 结尾的普通目录项，再用严格格式解析可选角色 ID；`.tmp`、`.corrupt-*` 与内部移走后留下的 `.complete-*` 永远只是不可执行证据，不得进入恢复 inventory。目录项名称本身不得作为路径片段越出角色根。
- v1、v2、空文件、半截 JSON、未知版本、Schema 不匹配和正文/文件名角色 ID 不一致均不得触发角色目录删除。
- 能从严格 marker 文件名安全取得角色 ID 时，原字节不覆盖地隔离，并为该角色返回稳定 blocked 问题码。
- 文件名也无法可靠给出角色 ID 时，只隔离并保留原字节，在 Main 记录固定诊断码 `CHARACTER_IMPORT_RECOVERY_UNATTRIBUTED`；不伪造角色 ID，不把该项加入面向 Renderer 的问题列表。
- 隔离目标必须使用唯一且排他的名称。只有原字节已经完整发布为证据、并再次确认 marker 路径仍指向读取时的同一普通文件后，才可移除原 marker。
- 证据发布或身份复核失败时保留正式 marker，记录固定诊断码并视为 blocked；不得报告已恢复。正式 marker 已原子移为 `.complete-*` 后，若单独清理失败但能用 hard link 排他恢复正式名，则由正式名支持下次重试；若清理与恢复正式名同时失败，只保留不可执行的 `.complete-*` 原字节证据并记录一次 `CHARACTER_IMPORT_RECOVERY_DETACHED_EVIDENCE`，不得把该证据重新执行，也不得为其生成角色 issue 或宣称下次可重试。

## 6. 恢复算法与安全不变量

### 6.1 调度与预算

1. 读取全部严格候选后先排序：活动角色的正式 marker（若存在）排在最前，其余按稳定文件名顺序排列；随后只截取活动项加最多其余 255 项，若无活动项则截取前 256 项，形成本轮有界 inventory。
2. 排序后第 257 项及以后不进入本轮 inventory，保持原字节和原路径；本轮不得读取或逐项处理它们，不得为其生成 issue 或逐项日志，只记录一次固定聚合诊断码 `CHARACTER_IMPORT_RECOVERY_LIMIT_REACHED`。
3. 2000ms 是软预算，只覆盖已经进入本轮的至多 256 个 inventory 项，并只在两项之间检查；已经开始的单项恢复不得在中途打断。
4. 达到预算后，已入 inventory 但尚未开始的正式 marker 保持原字节和原路径；可识别角色返回 deferred，下一次初始化或导入前继续处理。`deferred` 不得用于第 257 项及以后。
5. 每张 marker 有自己的错误隔离。单项解析、读取、隔离、回滚或清理失败不终止后续项。

数量与时间预算只限制本轮恢复工作，不得被误用为“删除剩余 marker”或“整体初始化失败”。

### 6.2 v3 安全回滚

有效 v3 只能调用 Store 的带令牌回滚：

```ts
store.rollbackImportedCharacter(characterId, importTransactionId)
```

Store 必须继续验证：

- 角色 ID 合法；
- owner 文件是普通文件且内容中的角色 ID、导入事务令牌匹配；
- 角色目录不是链接或 Junction；
- 目录与 owner 文件在移动前后物理身份一致；
- 当前活动角色不得被自动回滚。

回滚返回值不能再被调用方解释成模糊成功。现有 Store 接口原位收敛为以下判别结果，不得为此新建包装模块：

```ts
type ImportedCharacterRollbackResult =
  | Readonly<{ kind: 'rolled-back' }>
  | Readonly<{ kind: 'absent' }>
  | Readonly<{ kind: 'ownership-mismatch' }>
  | Readonly<{ kind: 'active-character' }>;
```

- `rolled-back`：目录已按所有权规则安全移除后，才能删除对应 marker。
- `absent`：目标目录和当前导入 owner 均不存在时可完成 marker；存在不一致残留时不得当作 absent。
- `ownership-mismatch`、`active-character` 或异常：保留/隔离证据并返回 blocked，不删除角色目录。

### 6.3 正常导入与失败回滚

正式顺序保持：v3 marker 完整排他发布 → Store create/owner → source 安装 → draft 保存 → Store publish → Store owner complete → marker complete。

导入异常且已经取得 `characterId + importTransactionId` 时，只能调用同一带令牌安全回滚。删除普通 `store.delete()` 回退；安全回滚失败时保留 v3 marker 作为下一次恢复证据，不得退回 v2 物理摘要 marker。

完成 marker 前必须复核该路径仍是本次读取/创建的同一普通文件。检查后路径被替换、变成链接或身份不一致时 fail closed，不得 unlink 替代文件。

## 7. 最小初始化结果

`initialize()` 从 `Promise<void>` 收敛为只包含实际问题的不可变报告：

```ts
type CharacterPackageRecoveryIssue = Readonly<{
  characterId: string;
  errorCode:
    | 'CHARACTER_IMPORT_RECOVERY_BLOCKED'
    | 'CHARACTER_IMPORT_RECOVERY_DEFERRED';
}>;

type CharacterPackageRecoveryReport = Readonly<{
  issues: readonly CharacterPackageRecoveryIssue[];
}>;
```

约束如下：

- 同一角色只返回一个当前裁决；blocked 优先于 deferred，结果按角色 ID 稳定排序。
- 不返回 `recovered` 成功项、数量统计、`budgetExceeded`、恢复阶段、内部原因或可由 `issues` 推导的字段。
- 无法安全识别角色 ID 的 marker 不进入该报告；`CharacterPackageService` 在 Main 进程内直接记录固定诊断码且不附带 marker 名称、路径或正文，不新增公开 callback 或诊断接口。
- 报告不承担 UI 文案。后续 B3 只读取 `characterId + errorCode`，本地映射提示。
- 初始化报告发布前一次性构造；调用者不能观察逐项处理中间态。

## 8. 失败处理与可用性

- 角色根目录无法读取时，`CharacterPackageService` 在 Main 进程内只记录固定诊断码 `CHARACTER_IMPORT_RECOVERY_SCAN_FAILED`；`initialize()` 不伪造角色 issue，也不让该诊断细节跨进程。活动角色是否降级继续由 B1/B3 的运行版本校验决定。
- 单项 blocked 只限制该角色的导入恢复，不阻断其他 marker、基础桌宠或普通文字聊天。
- deferred 不是成功或错误吞并；它只表示已进入本轮 256 项 inventory、但因 2000ms 软预算尚未开始的正式 marker，原 marker 保持未触碰，后续运行继续恢复。
- 新的导入在进入 saga 前仍先执行恢复；若目标角色存在 blocked marker，不得覆盖 marker 或目录，应以稳定错误结束该次导入。
- 所有日志只写固定错误码和必要的脱敏角色 ID，不写 marker 正文、绝对路径、令牌、哈希或文件物理身份。

## 9. 竞态与隐私

- Renderer、Preload、Provider 和普通日志不得接收 marker 文件名、绝对路径、原始字节、哈希、`importTransactionId`、`dev/ino` 或原生句柄。
- marker 读取使用有上限的字节读取；在解析、回滚、隔离和清理前后复核普通文件类型与身份。
- 列目录得到的名称不等于删除授权；正文合法也不等于目录归本次事务所有。只有 Store owner token 与身份复核共同授权回滚。
- 符号链接、Junction、重解析点、路径越界或身份变化全部 fail closed。
- 恢复结果是 Main 的本地事实。模型不得根据 marker 文本或口头推断声明恢复成功。

## 10. 替换与删除清单

新路径的定向测试通过后，在同一 B2 任务删除或替换以下旧内容，不保留双轨兼容：

- `CharacterPackageService` 中 v1 静默删除、v2 物理摘要恢复和 v2 marker 回写分支；
- `CharacterOwnership`、`captureCharacterOwnership()`、`sameCharacterOwnership()` 及只服务 v2 package rollback 的 SHA-256/物理摘要代码；若仍有导出安全真实消费者，只删除 package rollback 专用部分；
- 直接写正式文件的旧 `writePendingImport()` 实现，替换为 v3 exclusive publish；
- 整轮失败的旧 `recoverPendingRollbacks()` 实现，替换为逐 marker 隔离和预算调度；
- `preserveRollback()` 及回退生成 v2 marker 的路径；
- 导入 catch 中普通 `store.delete()` 回滚；
- 旧布尔回滚结果及把 `false` 当作同一种失败的调用逻辑；
- 只验证 v1/v2 删除、旧物理摘要或整轮抛错的测试脚手架和重复矩阵。

不得删除 Store owner 文件、带令牌回滚、移动前后身份复核、活动角色保护或已有 ZIP/导出安全逻辑。完成后必须在 `character-package-service.ts` 的限定范围内用 `rg` 证明 `CharacterOwnership`、`captureCharacterOwnership`、`sameCharacterOwnership`、`preserveRollback` 和导入 catch 中的 `store.delete(` 零引用，并在 `apps/desktop/src/main/characters` 内证明 `CharacterImportJournal` 与 `character-import-journal` 零引用。v3 Schema、创建、完成和恢复 owner 由最终差异审查确认全部位于 `CharacterPackageService`，不使用会误命中其他合法 v2 数据的宽泛字符串扫描。

## 11. TDD 与 replace-don't-layer

测试从现有模块接口进入，不为私有 helper 建立第二套表面：

1. **RED：exclusive 文件原语。** 证明直接正式路径写入不满足完整排他发布；覆盖并发两个 writer 恰好一个成功、已有目标字节不变、write/sync/link 失败不出现正式半成品、临时文件尽力清理。
2. **GREEN：最小原语。** 只实现 hard-link publish，不改变 `atomicWriteText()` replacement 语义。
3. **RED：`CharacterPackageService.initialize()`。** 覆盖坏 marker 不阻断后续有效 v3、v1/v2 只隔离、无法归属不伪造 ID、所有权不匹配/活动角色不删除、marker 替换竞态不误清理、`.complete-*` 不执行、清理双故障只留证据和固定诊断、活动优先、256 截断与 2000ms deferred 边界、报告最小化。
4. **GREEN：原位恢复。** 在现有模块内实现最小逻辑，并把导入 catch 改为同一带令牌回滚。
5. **REFACTOR：删除旧 owner。** 删除第 10 节清单和被新接口测试替代的旧测试；不叠加新旧矩阵。

完整错误矩阵由 `atomic-file-coordinator` 与 `CharacterPackageService` 接口测试拥有。`CharacterStore` 只保留 owner token、活动角色、路径/Junction 和移动前后身份的边界证据；Electron E2E 最多保留一个“多 marker 中一坏一好仍可启动”的纵向场景，B3 可与界面提示场景合并，不重复纯算法矩阵。

## 12. 验收标准

### 12.1 自动化

- v3 marker 正文完整后才在最终路径可见，目标存在时永不覆盖。
- v1/v2、空/截断/未知版本和无法归属 marker 均保留原始字节证据且不删除角色。
- 一项 open/read/write/sync/link、证据冲突、权限、磁盘满、所有权变化或清理失败不阻断后续 marker；`.complete-*` 不进入恢复 inventory，清理与正式名恢复双故障只留不可执行原字节证据和固定诊断。
- 只有 token 与目录身份匹配的非活动角色可回滚；导入失败路径不调用普通删除。
- 活动角色优先；排序后只取活动项加最多其余 255 项；第 257 项及以后不读取、不逐项 issue/log，只产生一次固定聚合诊断；2000ms 只在已入 inventory 的项目之间检查，deferred 仅用于其中尚未开始的 marker 且字节不变。
- `initialize()` 只返回稳定排序的 `{ characterId, errorCode }`，无路径、正文、令牌、哈希、物理身份和可推导统计。
- 旧 owner 与旧符号零正式引用，新增和删除行数按生产代码、测试分别记录；正式 owner 数不增加。
- 定向测试、Desktop typecheck、`pnpm.cmd verify:desktop` 和 `pnpm.cmd verify:characters` 通过；涉及授权/日志/边界时追加 `pnpm.cmd test:security` 与 `pnpm.cmd test:integration`。
- `apps/website`、`apps/cloudbase-api`、`apps/package-scanner` 及其测试零差异。

### 12.2 Windows 真实语义

真实 Windows 测试必须证明：

- hard-link final publish 并发时恰好一个 writer 成功；
- 已存在目标字节保持不变；
- 成功目标正文完整；
- 不支持 hard link 或权限拒绝时 fail closed，不回退覆盖语义。

自动化不能替代真实断电、进程强制终止和非恶意外部程序竞态的人工观察；没有证据时记录为“待用户人工确认”，不得写成通过。同一 Windows 用户下主动绕过检查的恶意进程不在本阶段威胁模型内。

## 13. 停止条件与恢复方式

出现以下任一情况立即停止当前路线并缩小问题，不靠新增层继续补洞：

- 新旧 marker owner 同时存在；
- 为测试而新增公开 I/O seam 或第二个 Journal；
- v4 没有新增磁盘语义却被引入；
- 无 token 的 legacy marker 能触发目录删除；
- 问题报告加入可推导统计、内部路径或恢复实现细节；
- 单点排障或命令超过 15 分钟仍未收敛。

实现按原语、恢复、删除门分成可独立审查的小提交。任何删除都只限第 10 节已批准范围，可通过 Git 单提交恢复；不得使用破坏性 reset，也不得触碰网站业务代码。
