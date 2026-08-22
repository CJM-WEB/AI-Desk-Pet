# AI Pet 桌宠非复现稳定性准入例外设计

> 文档状态：已批准待执行
> 日期：2026-08-21
> 目标分支：`AgentCoreExtension`
> 可执行基线：`55bd05898dca055cc4ed239e82072e30f1848de3`
> 上位规格：[AI Pet 桌宠恢复常规开发门收口设计](./2026-08-21-desktop-development-gate-closure-design.md)
> 关联账本：[Desktop 变更测试唯一 owner 清单](../../operations/desktop-test-owner-inventory.md)
> 适用范围：仅限上述可执行基线已经以 `NO_RED` 收口的本次偶发 5000ms 超时
> 明确排除：网站、CloudBase、包扫描器、网站 E2E、代码修复、测试修改、配置调整和新的减法

## 1. 目的与已知事实

原开发门要求先复现 5000ms 超时、定位根因并完成 TDD 修复。有限诊断已经完成：单文件隔离、固定四文件并行压力和完整 Desktop unit 三个 seam 各运行 5 轮，共 15/15 GREEN；目标超时为 0/15，最高目标耗时 1729.7ms。诊断期间没有改变 timeout、retry、skip、worker、断言或生产代码。

这些结果不能证明偶发超时已经修复。因为没有合格 RED，也不能诚实声称已经定位根因。继续制造诊断工具或无限换 seam，反而违反“单点不超过 15 分钟”和“能不加就不加，能减则减”。因此，本规格只提供一次最窄的稳定性准入：不改可执行内容，在同一冻结 HEAD 上把五条正式门各执行一次，用真实执行结果决定是否恢复常规开发。

测试 owner 账本保持 `+1956/-1294`、净增 `662`。本规格既不要求为归零继续硬删，也不宣称安全减法已经穷尽。

## 2. 覆盖关系与退役设计

本规格只对本次固定可执行基线和本轮冻结的 `GATE_HEAD` 生效，并限域替代：

1. 上位规格第 5.1 节“没有 RED 必须保持开发门关闭”的本次终局；
2. 上位规格第 10 节第 1、2 项“必须先定位并修复根因”作为本次准入的绝对前置条件；
3. 原计划 `NO_RED` 分支禁止进入正式五门的路径；
4. 上位规格与旧计划中和本例外提交拓扑、最终文档 allowlist 冲突的条款。

此前为本例外设计的自制 worker、supervisor、validator、fixture、hash manifest、ACK、PID/StartTime 恢复、原子 JSON schema 和相关自测全部退役，不实施、不修补，也不作为准入证据。仓库不新增 runner、脚本、fixture、依赖或测试。

除上述全部限域替代外，上位规格继续有效，特别是 C1–C10 触达规则、单一 owner、保护路径、Windows 人工待验、禁止永久双轨和后续功能按影响范围验证。

## 3. 不作出的结论

- 15/15 GREEN 不等于 `fixed`，也不证明历史 5000ms 超时是误报。
- 五门全绿仍不能写成“超时已修复”“根因已解决”“问题已消失”或同义表述。
- `maxWorkers: 4` 保持不变；不允许降低 worker、增加 timeout/retry、跳过测试或放宽断言。
- 本例外不能复用于其他 HEAD、其他失败测试、其他门失败或未来再次出现的偶发问题。
- 任一环境失败、工具中断或证据缺失都不能折算为通过。

## 4. 冻结执行树与只读守卫

本轮文档修订经独立复审并提交后，以当时 `git rev-parse HEAD` 的完整值冻结 `GATE_HEAD`。它只允许相对可执行基线存在文档差异，不得包含新的可执行变化。

正式门开始前、每一门开始前和每一门结束后，都必须用只读命令确认：

1. `git branch --show-current` 精确等于 `AgentCoreExtension`；
2. 当前完整 HEAD 与 `GATE_HEAD` 逐字一致；
3. 普通 `git status --short` 无输出；
4. 相对 `55bd05898dca055cc4ed239e82072e30f1848de3`，`docs/` 之外无 tracked 差异；
5. 下列保护路径相对该基线无差异：`apps/website`、`apps/cloudbase-api`、`apps/package-scanner`、`cloudbase`、`tests/e2e/website.spec.ts`、`tests/playwright.website.config.ts`。

任一守卫不成立，立即裁决 `CLOSED`。从第一门开始到第五门结束或首个失败结束之间，主控不得主动修改文件，tracked 与 non-ignored 内容不得变化。正式脚本自身产生的 ignored 构建、测试输出属于允许的运行副作用，但不得作为通过证据；ignored 报告只能在门阶段结束后创建。

## 5. 唯一执行事实与固定五门

### 5.1 唯一事实来源

Codex `exec_command` 和其持续 session 返回的真实 `exit_code`、`wall_time_seconds` 是命令是否完成、退出状态和耗时的唯一原始证据。命令直接结束时使用该次返回值；进入持续 session 时，必须保留初始调用与后续全部 `write_stdin` 返回的 `wall_time_seconds`，任何一次都不能省略。命令正文、人工转述、ignored 报告和子智能体总结都不能替代工具返回。

正式命令使用 `tty:true`，初始 `exec_command` 的 `yield_time_ms` 固定为 30000。若命令返回持续 session，主控使用 `write_stdin` 轮询，任意两次工具调用之间的间隔不得超过 60 秒。为覆盖工具调用之间未计入返回值的时间，本门使用保守上界：`全部工具返回的 wall_time_seconds 之和 + write_stdin 调用次数 × 60 秒`。每次新的 `write_stdin` 等待前，必须为下一次最多 60 秒的调用间隔预留预算，其 `yield_time_ms` 不得超过 60000，也不得超过 `900 秒 - 当前保守上界 - 60 秒` 的剩余毫秒；剩余值不大于 0 时立即发送 `Ctrl-C`。发送后若未得到最终返回，则使用当前执行 session 提供的终止能力结束；若该能力不可用或无法取得最终 `exit_code`，裁决 `CLOSED`。达到保守 15 分钟上界、session 丢失、执行中断或工具状态含义不明确，同样立即 `CLOSED`，且不重跑。

### 5.2 固定顺序

五条命令必须前台串行、按以下顺序各启动一次：

1. `pnpm.cmd verify:desktop`
2. `pnpm.cmd verify:characters`
3. `pnpm.cmd verify:behavior`
4. `pnpm.cmd test:security`
5. `pnpm.cmd test:integration`

只有前一门取得最终 `exit_code=0`、上述保守耗时上界小于 900 秒，并通过门后只读守卫，才可启动下一门。任一非零退出、超时、终止、session 丢失、缺少最终退出码或守卫失败，都在首个失败处停止；不 retry、不补跑、不拼接历史绿色。

## 6. 最小镜像报告

门阶段结束后，主控可以仅用 `apply_patch` 创建 ignored `.superpowers/sdd/2026-08-21-desktop-nonrepro-stability-acceptance-gate-report.md`。其父目录已存在，因此不需要创建目录或辅助文件。报告只镜像本次 Codex 任务工具返回中的：

- `GATE_HEAD` 与可执行基线；
- 每个实际启动门的固定序号、命令、`exit_code` 和 `wall_time_seconds`；
- 每门前后守卫结果；
- 首个失败类别或五门全零；
- `+662` 账本和“根因未定位”。

该报告不是原始证据，不保存 stdout/stderr 正文、完整绝对路径、用户文件、token、API Key、Authorization 或 Provider 私有内容。报告与工具返回不一致、遗漏中断或自行推导退出码时，裁决 `CLOSED`。

## 7. 独立复审与裁决

五门全零后，由未执行命令的新鲜独立审查者只读检查本 Codex 任务的工具调用记录、ignored 报告和当前 HEAD。审查者必须确认：

- 五门确实按固定顺序各启动一次；
- 每门存在工具返回的最终 `exit_code=0`，且由全部工具 `wall_time_seconds` 与调用次数计算的保守耗时上界小于 900 秒；
- 轮询间隔不超过 60 秒，没有 retry 或第二次启动；
- 每门前后 HEAD、普通 status、非 docs 差异和保护路径守卫均成立；
- 报告只是准确镜像，结论仍保留“根因未定位”和 `+662`。

审查者无法读取完整工具记录、发现事实不一致，或 Critical/Important 不为零，都裁决 `CLOSED`。不得为了修复证据或审查问题重跑正式门。

只有五门全部满足要求且独立复审 Ready，状态才是 `PASS`。成功限语固定为：

> 稳定性准入通过，已知偶发超时根因未定位。

其他任何组合均为 `CLOSED`。

## 8. 成功后的唯一后继

`PASS` 后只允许一个纯文档后继提交，同步本规格、旧开发门规格、旧减法规格、角色验收和上位架构状态。正式文档记录 `GATE_HEAD`、五门真实结果、`+662` 和固定限语，不写“已修复”。该后继不得修改计划、应用代码、包、测试、配置、依赖、锁文件或脚本；提交后仍须确认分支为 `AgentCoreExtension`。

失败时没有后继提交；开发门保持 `CLOSED`，后续处理必须另立规格。

后继提交完成后，对本次准入的交付窗口关闭。以后正常功能提交不会追溯使本次准入失效，但必须按上位规格 C1–C10 和实际影响范围执行自己的验证。

## 9. 恢复开发后的边界

- 历史偶发超时继续登记为“根因未定位”；未来再次出现时作为新失败独立诊断。
- 本次绿色不能替代未来功能验证。
- Windows 窗口层级、焦点、拖拽、托盘、安装卸载继续标记为“待用户人工确认”。
- 网站、CloudBase、包扫描器和网站 E2E 始终不在本次范围内。
