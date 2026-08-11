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

## 用户安全裁决与审查修复 round 2/5

### 用户裁决

1. 所有有效公共后缀裸名称默认 `chat`，包括 `example.museum` 与 `report.md`；只有 `./`、`.\\`、明确“文件/文件夹/目录”限定或 rename/copy/move 源目标强结构，才能把这类歧义名称作为本地对象。
2. `tldts@7.4.9` 可复用当前已安装的公共后缀数据，但必须作为 `apps/desktop` 直接依赖并最小更新 lockfile，不能依赖未声明的传递依赖。
3. 英文词内撇号不是引号；真正成对单引号仍屏蔽引用内容。
4. 未知礼貌动词必须绑定真实操作槽，不能借用句尾出现的其他操作词。
5. 对候选大正则只做必要的最小性能收敛，以适度长畸形 token 的行为测试保护，不使用脆弱墙钟阈值。

### 依赖理由

手工维护网络 TLD 集合无法完整、及时覆盖公共后缀，例如 `.museum` 与国家/地区后缀 `.md`。本轮采用已锁定版本 `tldts@7.4.9` 的公共后缀数据作为远程歧义判定权威，并在 desktop 的 `dependencies` 中直接声明，保证生产 Main 代码不依赖偶然存在的传递包。

### Fix round 2 垂直 TDD 记录

除特别注明的单例筛选外，各切片均使用根 Vitest：

```powershell
& .\node_modules\.bin\vitest.cmd run --config apps/desktop/vitest.config.ts apps/desktop/tests/explicit-file-intent-gate.test.ts
```

1. **公共后缀裸名称与本地强结构**
   - RED：新增 `read example.museum`、`read report.md` 两个聊天反例，以及 `read ./report.md`、`read file report.md`、`rename report.md to archive.md` 三个文件任务正例；结果 `2` 失败、`86` 通过，两个公共后缀裸名称均被错误提升。
   - 依赖安装：主控执行 `pnpm install --frozen-lockfile`，耗时 `35.6s`、退出码 `0`；根 Vitest 与 `apps/desktop/node_modules/tldts` 均存在。
   - 实现：desktop 直接声明 `tldts@7.4.9`，lockfile importer 同步锁定；公共后缀裸名称默认聊天，显式相对路径、文件限定词或 rename/copy/move 双目标结构可消除歧义。
   - 边界纠正：首次回归暴露五个旧正例与新规则冲突。`notes.md`、`README.MD`、`需要.md` 按裸公共后缀裁决迁为聊天；主控随后明确 `docs/guide`、`docs/permission` 的 `/` 多段结构本身是强本地结构，二者立即恢复为文件任务。实现以“路径首段无点号”区分本地多段路径与 `example.com/manual.pdf`，最终完整 Gate 回归通过。
2. **英文词内撇号**
   - RED：单例命令追加 `-t 撇号`；`1` 失败、`89` 跳过，`Can you read Bob's a.txt because it's ready?` 被误判为聊天。
   - GREEN：单引号扫描跳过两侧均为字母或数字的词内撇号，并在寻找真正闭合引号时同样跳过缩写撇号；真正的 `Read the phrase 'delete a.txt' aloud` 继续为聊天。完整 Gate 为 `90/90` 通过。
3. **礼貌请求操作槽绑定**
   - RED：单例命令追加 `-t 未知礼貌动词`；`1` 失败、`90` 跳过，`Can you please frobnicate a.txt while we discuss delete` 被错误提升为文件任务。
   - GREEN：礼貌壳捕获紧随请求前缀的真实动词槽，操作证据只接受与该槽完全重合的已知操作；执行结构仍独立描述“礼貌壳 + 目标”。完整 Gate 为 `91/91` 通过。
4. **适度长畸形 token**
   - RED：单例命令追加 `-t 畸形`；`1` 失败、`91` 跳过，`segment/` 重复 `128` 次的尾部分隔符 token 被候选正则截取前缀后误判为文件任务。
   - GREEN：目标范围拒绝“匹配结尾后仍紧邻 `/` 或 `\\`”的不完整候选，不增加墙钟断言，也不扩大候选大正则；完整 Gate 为 `92/92` 通过。

### Fix round 2 三证据恒真/恒假变异

每次只修改最终合取中的一个证据，执行 Gate `92` 项测试，取得 RED 后立即恢复：

| 证据 | 恒真结果 | 恒假结果 | 代表捕获用例 |
| --- | --- | --- | --- |
| 合法本地对象 | `15` 失败、`77` 通过 | `31` 失败、`61` 通过 | 公共后缀、URL、邮箱、版本；全部文件任务正例 |
| 文件操作 | `2` 失败、`90` 通过 | `31` 失败、`61` 通过 | 两条 `frobnicate`；全部文件任务正例 |
| 执行结构 | `2` 失败、`90` 通过 | `31` 失败、`61` 通过 | 元语言与跨句目标；全部文件任务正例 |

六次变异均有效，证明对象、操作和执行结构三项证据仍能独立改变路由结果。恢复后重新执行 Gate 与 Coordinator：

```text
Test Files  2 passed (2)
Tests       138 passed (138)
Duration    1.45s
```

### Fix round 2 类型、依赖与静态验证

- `pnpm.cmd --filter @myself/desktop typecheck` 首次发现 `tldts.parse(...).isIcann` 为 `boolean | null`；以 `=== true` 明确收敛为布尔值后，重跑输出 `$ tsc --noEmit`、退出码 `0`。
- `rg -n -F tldts apps/desktop/package.json pnpm-lock.yaml` 显示 desktop 直接依赖与 importer 均为 `7.4.9`，并复用已锁定的 `tldts-core@7.4.9`。
- 权限字段检索无匹配，`rg` 退出码 `1`；没有把 Provider、能力或授权根逻辑放入意图门。
- `git diff --name-only -- apps/website` 输出为空；未启动、构建或测试网站。
- `git diff --check` 退出码 `0`。
- 变更文件仅为 Gate、Gate 测试、desktop 依赖清单、lockfile 与本报告；未修改 Renderer、权限链或 Provider。

### Fix round 2 自审、耗时与提交

- `ExplicitFileIntentGate.classify` 公共接口与冻结返回对象未变；歧义仍默认聊天。
- 公共后缀依据来自 PSL，不是文件扩展名白名单；实现未加入测试字符串黑名单。
- `docs/guide` 等无点号首段的多段路径保持本地，`example.com/manual.pdf` 等域名路径保持远程。
- 成对引号继续统一屏蔽对象、操作和执行结构证据，词内撇号只影响引号边界识别。
- 礼貌壳中的操作槽与句尾讨论词分离，三证据变异仍全部有效。
- 安装约 `0.6` 分钟，四个垂直切片、变异、类型与最终验证约 `9` 分钟；每个单点均在 `10` 分钟内收敛。
- Fix round 2 实现提交：`fec7ed5 fix: 明确裸域名与本地文件边界`。
- Fix round 2 报告提交：见最终交付记录；报告不自指自身提交哈希。
- 本代理尝试按批准约定提交时，审批器以“未从可信用户消息识别 Git 写授权”为由拒绝；未绕过审批，已交主控完成两笔精确提交。

## 审查修复 round 3/5

### Finding 原文与结论

- **Important 原文**：`hasStrongFileStructure` 只数同句候选，`Rename is different from copy when comparing example.com and archive.com` 实际 `file_task`，预期 `chat`。强结构必须验证真实源→目标连接，而非操作词+两个候选。
- **结论**：同句邻近与候选数量不能证明源目标关系。强结构必须验证操作、源、连接词、目标四个连续槽位；公共后缀裁决、引用屏蔽与已 deferred 的候选正则性能 Minor 均不在本轮扩展范围。

### 垂直 TDD

先加入英文、中文讨论反例，并补齐四个真实连接正例：

- `Rename is different from copy when comparing example.com and archive.com` → `chat`
- `重命名和复制有什么区别，例如 example.com 和 archive.com` → `chat`
- `rename/copy/move report.md to archive.md` → `file_task`
- `把 report.md 重命名为 archive.md` → `file_task`（既有回归）

RED 命令：

```powershell
& .\node_modules\.bin\vitest.cmd run --config apps/desktop/vitest.config.ts apps/desktop/tests/explicit-file-intent-gate.test.ts -t 双目标操作
```

输出为 `1` 失败、`1` 通过、`94` 跳过。英文讨论句被错误提升为 `file_task`；中文讨论句已是 `chat`，作为近邻保护继续保留。

最小实现删除“同句两个候选”计数规则，改为：

- 英文只接受 `rename/copy/move + source + to/as/into + target` 的连续槽位；
- 中文只接受 `把/将 + source + 重命名/复制/移动 + 为/到/至 + target` 的连续槽位；
- 操作、源、目标必须同短句，且所有扫描仍基于引用屏蔽后的文本。

GREEN 使用完整 Gate 命令，输出 `96/96` 通过。

### 三证据恒真/恒假变异

每次只修改一个最终证据，执行 Gate `96` 项测试并在取得 RED 后立即恢复：

| 证据 | 恒真结果 | 恒假结果 | 代表捕获用例 |
| --- | --- | --- | --- |
| 合法本地对象 | `16` 失败、`80` 通过 | `33` 失败、`63` 通过 | 新英文讨论句、公共后缀与全部正例 |
| 文件操作 | `2` 失败、`94` 通过 | `33` 失败、`63` 通过 | 两条 `frobnicate` 与全部正例 |
| 执行结构 | `2` 失败、`94` 通过 | `33` 失败、`63` 通过 | 元语言、跨句目标与全部正例 |

### 最终验证、自审与提交

```text
Gate + Coordinator：2 files passed；142/142 passed；Duration 1.18s
desktop typecheck：$ tsc --noEmit；exit 0
权限字段检索：无匹配；rg exit 1
website diff：空
git diff --check：exit 0
```

- 修改仅涉及 Main Gate、Gate 测试与本报告；未修改公共后缀规则、Renderer、权限链、Provider 或网站。
- 强结构基于明确连接关系，不再用词数或候选数替代语法；英文/中文讨论近邻均保持聊天。
- 四个真实连接正例全部通过；引用内容仍不能贡献连接槽位。
- 候选大正则性能 Minor 按 ledger 保持 deferred，本轮没有扩大处理。
- RED、GREEN、六次变异与最终验证约 `4` 分钟；单点均在 `10` 分钟内收敛。
- Fix round 3 实现提交：`f4fbc37 fix: 约束双目标文件操作结构`。
- Fix round 3 报告提交：见最终交付记录；报告不自指自身提交哈希。
- Git 审批器上一轮已明确拒绝本代理的 Git 写，禁止绕过；本轮继续交主控完成两笔精确提交。

## 全分支最终审查集中修复

### Findings 与核验结论

1. **Critical**：`read example.com. a.txt` 会借用后句 `objectRanges`，将前句被排除裸域名的执行结构与后句文件对象拼成 `file_task`。
   - 核验结论：属实。对象验证只影响最终布尔值，执行结构仍读取全部候选 `targetRanges`，导致三项证据没有绑定同一已验证对象范围。
2. **Important**：双目标结构对 operation/source/target 做全组合与字符串切片，候选多时可能阻塞 Main。
   - 核验结论：属实。有界约 `3.7K` 输入使聚焦 Vitest 同步阻塞超过 `10s`，连测试超时计时器也无法执行，已安全中止。
3. **Minor**：候选大正则存在最坏形态，应补不依赖脆弱墙钟的有界长输入行为测试。
   - 核验结论：重复点段后接 `@` 时，候选正则会截取畸形 token 的合法前缀并错误提升；无需重写大正则，只需收紧匹配尾边界。

### Critical：跨句已验证对象绑定

RED：

```powershell
& .\node_modules\.bin\vitest.cmd run --config apps/desktop/vitest.config.ts apps/desktop/tests/explicit-file-intent-gate.test.ts -t 前句远程对象
```

输出为 `1` 失败、`96` 跳过；`read example.com. a.txt` 实际返回 `file_task`。

GREEN：执行结构从读取全部 `targetRanges` 改为读取已通过本地验证的 `objectRanges`，使操作、直接执行结构与本地对象绑定同一范围、同一短句。完整 Gate 为 `97/97` 通过。

### Important：双目标相邻槽位线性扫描

RED 输入由 `rename ` 重复 `240` 次、`a.md ` 重复 `400` 次构成，总长约 `3.7K`，没有任何真实源目标连接。测试只断言结果为 `chat`，未写墙钟阈值。旧三重组合运行 `10s` 仍无结果，手动安全中止，退出码 `1`。

GREEN：分别保留已有中英文连接验证函数，仅将强结构调度改为：

- 线性合并已按文本排序的 operation 与 target 槽；
- 单次扫描相邻三个槽位；
- 英文只检查 `operation-target-target`，中文只检查 `target-operation-target`；
- 删除 operation/source/target 三重全组合。

聚焦有界用例为 `1` 通过、`97` 跳过，测试体 `10ms`；完整 Gate 为 `98/98` 通过。中英文 rename/copy/move 正例与讨论反例均保持原结果。

### Minor：有界畸形 token 尾边界

RED 输入为 `a.` 重复 `512` 次后接 `@`，总长约 `1K`；只断言普通聊天，不设置耗时阈值。输出为 `1` 失败、`98` 跳过，实际错误结果为 `file_task`。

首次只拒绝匹配后直接出现 `@` 未收敛；缩窄检查发现正则停在倒数第二点段，后继先是 `.`、再后才是 `@`。最终最小 GREEN：

- 匹配后紧邻 `/`、`\\`、`@` 时拒绝该不完整候选；
- 匹配后紧邻 `.` 时，仅当该点号位于句尾或后接空白才视为合法句号；
- 不修改候选大正则主体。

完整 Gate 为 `99/99` 通过。

### 六证据变异与最终验证

对象验证与执行结构现共享已验证范围，因此对象恒真/恒假在范围输出处变异为全部 `targetRanges` / 空范围；操作和执行结构仍分别变异最终布尔证据：

| 证据 | 恒真结果 | 恒假结果 | 代表捕获用例 |
| --- | --- | --- | --- |
| 已验证对象范围 | `19` 失败、`80` 通过 | `33` 失败、`66` 通过 | 新跨句 Critical、远程/版本/畸形 token、全部正例 |
| 文件操作 | `2` 失败、`97` 通过 | `33` 失败、`66` 通过 | 两条 `frobnicate`、全部正例 |
| 执行结构 | `3` 失败、`96` 通过 | `33` 失败、`66` 通过 | 元语言、英文跨句与新 Critical、全部正例 |

六次变异均取得 RED 后恢复。自审等价重构后重新执行最终验证：

```text
Gate + Coordinator：2 files passed；145/145 passed；Duration 1.42s
desktop typecheck：$ tsc --noEmit；exit 0
权限字段检索：无匹配；rg exit 1
website diff：空
git diff --check：exit 0
```

- 修改仅包含 Main Gate、Gate 测试与本报告；未修改网站、Renderer、权限链或 Provider。
- 公共后缀、引用屏蔽和中英文连接语法未改变。
- 强结构调度由三重组合降为合并与相邻槽位扫描；候选正则仅收紧不完整尾边界，没有大重写。
- 三个切片、变异与最终验证约 `7` 分钟；各单点均在 `10` 分钟内收敛。
- 集中修复实现提交：`16a5e94 fix: 绑定文件意图对象并线性扫描`。
- 集中修复报告提交：见最终交付记录；报告不自指自身提交哈希。
- Git 审批器已明确禁止本代理重试 Git 写；继续交主控完成实现与报告两笔精确提交。
