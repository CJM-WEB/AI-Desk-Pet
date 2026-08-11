# Task 1：文件意图门操作邻接语法修复报告

## 结果

- 状态：实现与聚焦验证完成。
- 实现提交：`66a99ef fix: 收紧本地文件意图语法`。
- 报告提交：见最终交付记录；报告不自指自身提交哈希。
- 修改范围：仅 Main 文件意图门及其单元测试；未修改 Renderer、权限链、Provider 或网站。

## 根因证据

基线聚焦测试在沙箱外运行后为 `58/58` 通过，但新增用例暴露了三处同源问题：

1. 执行语气正则只接受 `Can/Could/Would you` 后直接跟操作，不接受 `please`，也不识别中文 `你能/你能不能 + 帮我? + 操作`。
2. 旧文件对象正则会把点号 token 与紧邻的中文知识后缀一起吞掉，使 `是什么意思/为什么失败` 从知识检测文本中消失。
3. 旧点号 token 规则把裸域名、邮箱和纯数字版本都当成本地文件对象。

因此修复采用内部 `LocalObjectScan`：只遮蔽与文件操作同短句的合法本地目标，保留目标外语义，并按远程标识、邮箱、纯数字版本、本地形态的顺序验证候选。旧的宽泛对象替换逻辑已删除。

## 垂直 TDD 记录

三个切片均使用同一命令：

```powershell
& .\node_modules\.bin\vitest.cmd run --config apps/desktop/vitest.config.ts apps/desktop/tests/explicit-file-intent-gate.test.ts
```

### Slice 1：礼貌执行语气

- RED：加入四个礼貌文件任务用例后，`62` 个测试中 `3` 个失败、`59` 个通过。
- 预期失败：`你能帮我读取 a.txt 吗？`、`Can you please delete a.txt?`、`Would you please list .\drafts?` 被误判为聊天；`Could you read pyproject.toml?` 已由旧逻辑覆盖。
- GREEN：最小扩展中文 `你能/你能不能 + 帮我?` 与英文 `Can/Could/Would you + please?` 语气，结果 `62/62` 通过。

### Slice 2：文件对象保护与元语言

- RED：加入三个元语言聊天用例后，`65` 个测试中 `2` 个失败、`63` 个通过。
- 预期失败：`读取 a.txt是什么意思？` 与 `读取 a.txt为什么失败？` 被误判为文件任务；英文解释句已因无直接执行语气而保持聊天。
- GREEN：引入 `LocalObjectScan`，以等长空格只遮蔽目标本身，结果 `65/65` 通过。
- 回归：`读取 不要删除.txt` 的完整文件名仍受保护；`请把 report.md 重命名为 archive.md` 的源、目标均可识别。

### Slice 3：排除非本地点号 token

- RED：加入五个非本地点号 token 反例后，`70` 个测试中 `5` 个全部按预期失败、`65` 个通过。
- 失败范围：`www.example.com/manual.pdf`、`www.example.com`、`user@example.com`、`1.2`、`2.0.1` 均被旧候选逻辑误判为文件任务。
- GREEN：依次拒绝远程标识、邮箱与纯数字版本，结果 `70/70` 通过。
- 多点文件名回归：加入 `read report.v2.txt` 后 `71/71` 通过，文件接受逻辑未使用扩展名白名单。
- 三证据保护用例：加入 `关于 a.txt 的删除操作` 后 `72/72` 通过，用于证明实际执行语气不可省略。

## 三项证据受控变异

每次只修改一个返回条件，运行上述聚焦测试，确认 RED 后立即恢复：

| 证据 | 变异 | 结果 | 捕获示例 |
| --- | --- | --- | --- |
| 合法本地对象 | 恒真 | `12` 失败、`60` 通过 | `删除`、非本地点号 token 被错误提升 |
| 文件操作 | 恒假 | `30` 失败、`42` 通过 | `读取 a.txt` 等正例退回聊天 |
| 实际执行语气 | 恒真 | `2` 失败、`70` 通过 | `关于 a.txt 的删除操作` 被错误提升 |

三个变异均已恢复；恢复命令结果为 `72/72` 通过，且 `git diff --check` 退出码为 `0`。

## 最终验证

### 聚焦测试

```powershell
& .\node_modules\.bin\vitest.cmd run --config apps/desktop/vitest.config.ts apps/desktop/tests/explicit-file-intent-gate.test.ts apps/desktop/tests/conversation-coordinator.test.ts
```

输出摘要：

```text
Test Files  2 passed (2)
Tests       118 passed (118)
Duration    1.30s
```

### 桌面类型检查

```powershell
pnpm.cmd --filter @myself/desktop typecheck
```

输出：

```text
$ tsc --noEmit
exit code 0
```

### 权限字段与网站零差异

```powershell
rg -n "provider|generation|capability|authorizedRoot" apps/desktop/src/main/conversation/explicit-file-intent-gate.ts
git diff --name-only -- apps/website
```

- 权限字段检索无匹配，`rg` 退出码为 `1`。
- 网站差异输出为空。
- 未启动、构建或测试网站。

## 文件与耗时

| 阶段 | 文件 | 耗时 |
| --- | --- | ---: |
| 根因调查与基线 | Gate、Gate 测试、调用点 | 约 2 分钟 |
| Slice 1 | Gate、Gate 测试 | 约 1 分钟 |
| Slice 2 | Gate、Gate 测试 | 约 2 分钟 |
| Slice 3 | Gate、Gate 测试 | 约 1 分钟 |
| 变异、自审与最终验证 | Gate、Gate 测试、Coordinator 测试 | 约 3 分钟 |
| 合计 | 实现与验证 | 约 9 分钟 |

实现提交包含：

- `apps/desktop/src/main/conversation/explicit-file-intent-gate.ts`
- `apps/desktop/tests/explicit-file-intent-gate.test.ts`

本报告单独提交：

- `.superpowers/sdd/2026-08-11-ai-pet-intent-log-evidence-fix/task-1-report.md`

## 自审

- `ExplicitFileIntentGate.classify(text: string): ConversationRoute` 接口未变。
- 返回值仍复用冻结的 `{ kind: 'chat' | 'file_task' }`，未返回路径、正文或扫描证据。
- 文件操作、合法本地对象、实际执行语气三项证据仍需同时成立；证据不足默认聊天。
- 候选判断未使用用例字符串黑名单，也未使用文件扩展名白名单；`report.v2.txt` 有正例保护。
- `semanticText` 使用等长空格遮蔽目标；知识后缀、否定词和陈述词仍可被检测。
- 被替换的 `fileObjectPattern` 与 `removeFileObjectFragments` 已删除，没有保留双轨宽泛逻辑。
- 未修改 Renderer、授权、披露、确认、重置、迟到事件隔离、Provider 或网站。
- 未发现遗留关注项。
