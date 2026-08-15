# B1 Task 3 实施报告

## 结果

`CharacterTransactionRecovery` 已接入真实 `CharacterStore`。恢复改为按角色、按 draft/publish 分面隔离；覆盖恢复证据前由协调器能力门裁决；坏 marker、Junction、权限替代故障和预算延后不再中止其他角色或整个 Store。旧全量恢复方法和公开方法中的重复恢复调度已删除，底层 draft/publish 事务恢复算法、schema、marker 字节和 delete tombstone 算法保持不变。

## 修改范围

- `apps/desktop/src/main/characters/character-store.ts`
- `apps/desktop/tests/character-store.test.ts`
- 本报告

未修改 Package journal、`character-package-service.ts`、网站、CloudBase 或 package scanner。

## RED 证据

### 首轮恢复矩阵

命令：

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/character-store.test.ts -t "事务恢复协调|事务中间目录为 Junction"
```

结果：8 项失败。主要失败栈均落在旧 `loadIndex()` 调用 `recoverAllCharacterTransactions()` 后，由单个坏 marker 抛出 `CHARACTER_TRANSACTION_INVALID` 并中止整轮；另外暴露缺少 `getTransactionRecoveryReport()` 和 Junction 返回原始 `CHARACTER_PATH_UNSAFE`。失败原因与预期一致，不是 fixture 错误。

### 未发布角色 summary

命令：

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/character-store.test.ts -t "未发布角色的坏 publish"
```

结果：1 项按预期失败，坏 publish 角色错误显示为 `incomplete`，证明 runtime gate 必须位于 summary 的 compiled 分支判断之前。

### review 只读索引缺口

命令：

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/character-store.test.ts -t "坏草稿下健康 V1 compiled"
```

结果：1 项按预期失败。`list()` 清除了预置 `migrationErrorCode`，使 index Buffer 改变，证明 draft blocked 时 summary 仍存在索引持久化缺口。

## GREEN 与实现

- Store 构造单一 `CharacterTransactionRecovery`，动态读取当前活动角色 ID，并通过可选 `recoveryNow` 测试 2000ms 预算。
- `loadIndex()` 对有效索引构造候选 closure；每个 draft/publish closure 独立执行路径核验和既有底层恢复，协调器捕获并转换为稳定分面码。
- 空、缺失或损坏索引清空上一轮活动角色、协调器结果和权威 report。
- 新增同步只读 `getTransactionRecoveryReport()`，返回结构化克隆；内容仅含角色 ID、稳定码、分面状态与预算状态，不包含路径、marker 正文或原异常。
- `saveDraft()`、`publishCompiled()` 和所有 runtime 入口在批准位置调用对应能力门；`getDraft()` 保持只读可用；`delete()`、`rollbackImportedCharacter()` 和 delete tombstone 未增加分面门或改变算法。
- blocked/deferred 下 V1 draft/compiled 只做内存 V2 投影；不安装迁移事务、不覆盖 marker、不写 index。summary 仅在 draft 分面 healthy 时清理迁移错误字段。
- `summary()` 在任何 runtime 路径探测前执行 runtime gate；单角色 blocked 返回既有 `broken` 表现，其他角色继续。

最终定向恢复矩阵包含 11 项，覆盖：

- active/non-active × bad draft/bad publish/both；
- draft/publish/runtime 三类稳定 gate；
- 健康 V2 draft 读取和 V1 draft/compiled 只读投影；
- 活动角色优先与 2000ms deferred；
- Junction 不触碰目标、`removePath` 注入 `EACCES` 的权限替代证据；
- 连续索引集合变化、空/缺失/坏索引清理 report；
- 坏分面下显式 delete 仍可执行。

## 旧路径删除扫描

扫描：

```powershell
rg -n "recoverAllCharacterTransactions|await this\.recover(Draft|Publish)Transaction" apps/desktop/src/main/characters/character-store.ts
```

结果：`recoverAllCharacterTransactions` 为零命中；仅有协调器候选 closure 中各一处底层 `recoverDraftTransaction()` / `recoverPublishTransaction()` 调用。`saveDraft()`、`getDraft()`、`publishCompiled()`、`getRuntimeManifest()`、`getPublishedManifest()` 中无重复无条件恢复调用。底层两项恢复方法、事务 schema 和 marker 写入/恢复逻辑均保留。

## 最终门禁

| 命令 | 结果 |
| --- | --- |
| 三文件定向 Vitest | 3 files，87 tests 全部通过 |
| `pnpm.cmd --filter @myself/desktop typecheck` | 通过 |
| `pnpm.cmd --filter @myself/desktop test` | 87 files；1759 passed，14 skipped |
| `pnpm.cmd test:security` | 20/20 通过 |
| `pnpm.cmd test:integration` | 46/46 通过 |
| `git diff --check` | 提交前执行，结果见交付记录 |

desktop 全量测试仍输出既有 jsdom canvas 与角色播放器预期 stderr，但命令 exit code 为 0，未出现测试失败。

## 自审

- 需求逐项与 brief 对照；能力门位置、只读迁移、报告清理和旧路径删除均有行为测试或静态扫描证据。
- 独立只读 review 提出的 `migrationErrorCode` 索引改写问题已通过新增 RED 复现并修复；权限替代注入和活动角色预算顺序测试也已补齐。
- 工作差异限定于两项获批代码/测试文件和本报告；禁止范围差异为空。
- 未新增依赖，未复制 V1 转换逻辑，未改变 Package journal、rollback 或 tombstone 状态模型。

## 提交

本报告与实现、测试共同进入同一本地提交；最终提交哈希由任务交付消息记录为权威值。

## Concerns

- Windows ACL 权限错误无法在所有开发机上稳定构造，因此按 brief 使用现有 `removePath` 依赖 seam 注入 `EACCES`；真实 Junction 测试另行覆盖不跟随、不触碰链接目标。
- 本任务不涉及真实窗口或部署，无需新增人工 UI 验收；desktop 全量中的 14 项既有跳过项未由本任务改变。
