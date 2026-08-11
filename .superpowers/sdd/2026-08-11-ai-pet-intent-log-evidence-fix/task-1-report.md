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

## 审查修复 round 1/5

### Findings 原文与结论

1. **Important 1 原文**：英文句号未被视为短句边界，`Delete nothing. a.txt` 实际 `file_task`；操作不得与下一句目标误配。
   **结论**：当前同句判断只识别中英文问号、感叹号等分隔符，没有区分文件名点号与英文句号，必须增加独立句界词法扫描。
2. **Important 2 原文**：裸域名只排除 `www`；`read example.com`、`read example.com/manual.pdf`、`read ftp.example.com` 应 `chat`。
   **结论**：远程资源识别不能依赖 `www.` 前缀，必须在本地候选之前保守识别网络 TLD 与多标签域名；歧义默认聊天。
3. **Important 3 原文**：引号内引用仍被扫描；`Read the phrase "delete a.txt" aloud` 应 `chat`。中文/英文引号内容中的操作和对象都不得成为执行证据。
   **结论**：对象、操作与执行结构扫描前必须先以等长空格屏蔽成对中英文引号，防止引用内容贡献任何执行证据。
4. **Important 4 原文**：三证据逻辑不独立：当前对象扫描先依赖 `operationRanges`，执行语气也内含操作，导致 `hasFileOperation` 冗余；把操作证据恒真不会 RED。
   **结论**：对象词法扫描必须与操作扫描解耦；操作与对象的同短句绑定归入执行结构证据，最终仍独立要求 `object && operation && execution`。
5. **Minor 原文**：`delete version=1.2` 应 `chat`；避免继续扩大单个贪婪大正则。
   **结论**：版本检测需要识别等号等标签连接形式，并把候选、句界、引号与远程资源拆为小词法函数和明确 token 边界。

### Fix round 1 垂直 TDD 记录

各切片聚焦命令：

```powershell
& .\node_modules\.bin\vitest.cmd run --config apps/desktop/vitest.config.ts apps/desktop/tests/explicit-file-intent-gate.test.ts
```

1. **英文句界**
   - RED：新增 `Delete nothing. a.txt`，`73` 个测试中 `1` 个失败、`72` 个通过；实际错误结果为 `file_task`。
   - GREEN：新增独立 `hasSentenceBoundary`，英文点号仅在后接空白或句尾时分句，结果 `73/73` 通过。
2. **一般裸域名**
   - RED：新增 `example.com`、`example.com/manual.pdf`、`ftp.example.com`、`report.com`，`77` 个测试中 `4` 个失败、`73` 个通过。
   - GREEN：以主机标签和保守网络 TLD 小词法识别远程资源，结果 `77/77` 通过。
   - 安全取舍：`report.com` 同时可能是本地文件名和裸域名；遵循“歧义默认聊天”，将其保守降级为 `chat`。`report.v2.txt` 继续保持本地文件任务正例。
3. **成对引号屏蔽**
   - RED：新增 `Read the phrase "delete a.txt" aloud` 与 `读取“删除 a.txt”这句话`，`79` 个测试中 `2` 个失败、`77` 个通过。
   - GREEN：扫描成对中英文单双引号并用等长空格屏蔽引号及内容，对象、操作、执行结构统一读取屏蔽文本，结果 `79/79` 通过。
4. **三证据解耦**
   - RED：新增仅对象 `删除.txt`、`read.txt`，`81` 个测试中 `2` 个失败、`79` 个通过；文件名内部操作词被错误当成操作和直接请求。
   - GREEN：对象词法先独立扫描并遮蔽，操作词法只扫描遮蔽后的语义文本；执行结构负责同句绑定，加入未知操作礼貌壳 `Can you please frobnicate a.txt?` 后结果 `82/82` 通过。
   - 操作恒真检查：变异后 `frobnicate` 反例 `1` 个 RED，证明文件操作证据已能独立影响结果；恢复后 `82/82` 通过。
5. **等号版本号**
   - RED：新增 `delete version=1.2`，`83` 个测试中 `1` 个失败、`82` 个通过。
   - GREEN：用小词法函数解析等号后的点分数字段，没有扩展候选大正则，结果 `83/83` 通过。

### Fix round 1 三证据恒真/恒假变异

对象恒真首次仍为 `83/83`，暴露执行结构继续依赖“已验证本地对象”的剩余冗余。随即缩窄为单一数据流假设：执行结构绑定未引用的目标槽，本地对象证据独立过滤远程、邮箱和版本；修正后重新执行六次变异：

| 证据 | 恒真结果 | 恒假结果 | 代表捕获用例 |
| --- | --- | --- | --- |
| 合法本地对象 | `11` 失败、`72` 通过 | `30` 失败、`53` 通过 | 裸域名/邮箱/版本；全部文件任务正例 |
| 文件操作 | `1` 失败、`82` 通过 | `30` 失败、`53` 通过 | `frobnicate`；全部文件任务正例 |
| 执行结构 | `2` 失败、`81` 通过 | `30` 失败、`53` 通过 | 元语言与跨句目标；全部文件任务正例 |

六次变异均在取得 RED 后恢复；恢复后的 Gate 为 `83/83` 通过。

### Fix round 1 最终验证

```powershell
& .\node_modules\.bin\vitest.cmd run --config apps/desktop/vitest.config.ts apps/desktop/tests/explicit-file-intent-gate.test.ts apps/desktop/tests/conversation-coordinator.test.ts
```

最后一次代码修改后的输出摘要：

```text
Test Files  2 passed (2)
Tests       129 passed (129)
Duration    1.15s
```

类型检查首次发现 `text[index]` 为 `string | undefined`，以显式判空最小修复后重新验证：

```powershell
pnpm.cmd --filter @myself/desktop typecheck
```

```text
$ tsc --noEmit
exit code 0
```

静态与范围验证：

```text
权限字段检索：无匹配，rg exit 1
网站差异：空
git diff --check：exit 0
```

- 本轮未修改或运行网站，也未修改 Renderer、权限链或 Provider。
- 本轮用时约 `10` 分钟；每个单一切片均在 `10` 分钟内收敛。
- Fix round 1 实现提交：`83c699e fix: 修正文件意图词法边界`。
- Fix round 1 报告提交：见最终交付记录。
