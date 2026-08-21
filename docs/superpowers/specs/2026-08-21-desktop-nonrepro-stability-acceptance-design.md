# AI Pet 桌宠非复现稳定性准入例外设计

> 文档状态：已批准待执行（用户已明确授权“不要卡死、允许放宽审核”，并要求继续以最小改动恢复开发）
> 日期：2026-08-21
> 目标分支：`AgentCoreExtension`
> 固定候选可执行 HEAD：`55bd05898dca055cc4ed239e82072e30f1848de3`
> 上位规格：[AI Pet 桌宠恢复常规开发门收口设计](./2026-08-21-desktop-development-gate-closure-design.md)
> 关联账本：[Desktop 变更测试唯一 owner 清单](../../operations/desktop-test-owner-inventory.md)
> 适用范围：仅限上述 HEAD 上已经以 `NO_RED` 收口的本次偶发 5000ms 超时
> 明确排除：网站、CloudBase、包扫描器、网站 E2E、代码修复、测试修改、配置调整和新的减法

## 1. 为什么需要这个例外

原开发门要求先复现 5000ms 超时、定位根因并完成 TDD 修复，才允许执行最终五门。实际有限诊断已经按批准方案结束：

- 单文件隔离、固定四文件并行压力和完整 Desktop unit 三个 seam 各运行 5 轮，共 15/15 轮 GREEN；
- 目标用例 `TARGET_FIXED_TIMEOUT` 为 0/15，最高目标耗时 1729.7ms；
- 诊断没有 timeout、retry、skip、worker、断言或生产代码变化；
- 因为没有合格 RED，无法诚实定位根因，也没有进入猜测性修复；
- owner inventory 已对 20 个变更测试文件和 259 个原始 hunk 完成对账，最终仍为 `+1956/-1294`、净增 `662`，本轮裁决为“零安全删除”。

这组证据不能证明偶发超时已经修复，但能证明它在三种固定强度下没有复现。继续无限换 seam 会违反用户的 15 分钟单点限制和“不要卡死”要求。因此，本规格建立一次性、最窄的稳定性准入例外：不改代码，用同一候选可执行 HEAD 的五条正式门做最后一次全量判断。

## 2. 覆盖关系与有效边界

### 2.1 仅覆盖本次 `NO_RED` 分支

本规格只在固定候选可执行 HEAD `55bd05898dca055cc4ed239e82072e30f1848de3` 上，限域替代上位开发门规格以下要求：

1. 第 5.1 节“未建立 RED 必须保持开发门关闭”的本次终局；
2. 第 10 节第 1、2 项“必须先定位并修复根因”作为本次恢复常规开发的绝对前置条件；
3. 原计划 `NO_RED` 分支禁止进入正式五门的路径约束。

除上述三点外，上位规格继续有效，特别是：C1–C10 触达规则、单一 owner、保护路径、Windows 人工待验、禁止永久双轨和后续功能按影响范围验证。

### 2.2 本规格不作出的结论

- 15/15 GREEN **不等于**根因修复，也不证明历史 5000ms 超时是误报。
- 五门全绿也不能把结论写成“超时已修复”“根因已解决”或“问题不存在”。
- `maxWorkers: 4` 保持不变；本规格不授权降低 worker、增加 timeout/retry、跳过测试或放宽断言。
- `+662` owner 账本原样保留；本规格不要求继续硬删，也不宣称安全减法已经穷尽。
- 本例外不能复用于其他 HEAD、其他失败测试、其他门失败或未来再次出现的偶发问题。

## 3. 固定事实与候选树

执行前必须同时证明：

1. `git rev-parse 55bd058^{commit}` 得到完整 hash `55bd05898dca055cc4ed239e82072e30f1848de3`；
2. tracked 工作树与暂存区干净；
3. 本规格与实施计划提交相对 `55bd058` 只有这两份纯文档变化，`docs/` 之外零差异；
4. 根 `package.json` 仍存在以下脚本，展开值与执行基线报告逐字一致：
   - `verify:desktop`
   - `verify:characters`
   - `verify:behavior`
   - `test:security`
   - `test:integration`
5. 以下受保护路径相对 `55bd058`、工作树和暂存区均零差异：
   - `apps/website`
   - `apps/cloudbase-api`
   - `apps/package-scanner`
   - `cloudbase`
   - `tests/e2e/website.spec.ts`
   - `tests/playwright.website.config.ts`

若 `55bd058` 之后出现任何 `docs/` 之外的 tracked 变化，本例外立即失效；不得把新可执行树冒充固定候选树。

## 4. 一次性稳定性准入门

### 4.1 固定命令与顺序

只按根 `package.json` 的现行脚本，依次执行：

```powershell
pnpm.cmd verify:desktop
pnpm.cmd verify:characters
pnpm.cmd verify:behavior
pnpm.cmd test:security
pnpm.cmd test:integration
```

每条顶层命令在本次例外中只能启动一次。每条必须在 15 分钟内自然结束并退出 0；五条均在同一个固定候选可执行树上运行，不能拼接历史绿色、verify 内部重复步骤或其他 HEAD 的结果。

### 4.2 成功裁决

只有五条命令均满足“实际启动一次、耗时小于 15 分钟、exit 0”，独立审查确认事实与范围无误，且执行前后均无可执行差异，才可恢复常规新功能开发。

成功结论必须逐字保留以下语义：

> 稳定性准入通过，已知偶发超时根因未定位。

可以同时说明“桌宠恢复常规新功能开发”，但禁止使用 `fixed`、`根治`、`根因已解决`、`问题已消失` 或等价表述。

### 4.3 失败裁决

任一门出现非零退出、达到 15 分钟、无法启动、被终止或执行期间发生可执行差异时：

1. 立即裁决 `CLOSED`，停止尚未启动的后续门；
2. 不重跑、不 retry、不增加 timeout、不 skip、不降低 worker、不改代码、不改测试、不改配置；
3. 只记录失败门、退出/终止类别、耗时和已完成门，不保存敏感日志正文；
4. 后续诊断或修复必须另立独立规格，本规格不得继续追加第二轮。

环境失败与产品失败可以分类，但都不能写成通过。

## 5. 证据、隐私与执行方式

本例外不创建 runner、fixture、脚本或其他临时工具。执行证据只保存在本计划专属 ignored 目录：

```text
.superpowers/sdd/2026-08-21-desktop-nonrepro-stability-acceptance/
```

允许的证据文件只有 `progress.md`、`baseline.md`、`gate-report.md`、`review.md` 和成功后的 `docs-successor-report.md`。报告只记录候选 hash、脚本展开值、开始/结束时间、耗时、exit/终止类别、保护路径计数和裁决；不得记录完整绝对路径、命令 stdout/stderr 正文、用户文件、token、hash 以外的私有标识、API Key 或 Authorization。

每条命令使用独立执行调用，单条达到 15 分钟即按精确进程树终止。不得用一条长命令包住五门，使外层执行超过 15 分钟而失去单门边界。

## 6. 独立复审

五门结束后由未执行命令的新鲜独立审查者只读检查：

- 候选可执行 HEAD 是否严格为 `55bd05898dca055cc4ed239e82072e30f1848de3`；
- 五门是否按固定顺序各启动且至多一次；
- 成功时是否五条均 exit 0 且各小于 15 分钟；失败时是否在首个失败后停止；
- 是否出现 retry、timeout/skip/worker/断言或代码配置变化；
- `docs/` 之外和受保护路径是否零差异；
- 报告是否诚实保留“根因未定位”和 `+662` owner 账本；
- 报告是否不含敏感正文。

Critical/Important 未清零时不得发布成功结论，也不得通过重跑门来消除审查问题。

## 7. 成功后的唯一纯文档后继

五门全绿且独立复审 Ready 后，只允许一个纯文档后继提交，同步：

1. 本规格：记录五门结果、固定候选可执行 HEAD 和最终限语；
2. `2026-08-21-desktop-development-gate-closure-design.md`：把原 `NO_RED/CLOSED` 历史与本例外的当前准入结论并列，明确根因仍未定位；
3. `2026-08-20-desktop-code-subtraction-design.md`：保留 `+662` 与 owner inventory，不新增硬删要求；
4. `docs/operations/character-workshop-acceptance.md`：记录五条命令、exit、耗时、同一候选可执行 HEAD 和 Windows 人工待验；
5. `2026-08-15-ai-pet-desktop-architecture-optimization-design.md`：只更新上位状态摘要和链接。

该提交不得修改计划、`apps/`、`packages/`、`tests/`、根 `package.json`、锁文件、测试/构建配置或脚本。正式文档只记录固定候选可执行 HEAD，不回写承载自身的文档提交 hash；ignored `docs-successor-report.md` 在提交后记录实际文档提交 hash，并证明相对候选 HEAD 只有“本规格/计划首次提交 + 上述五份状态文档”的文档差异，`docs/` 之外为零。

失败时不创建该后继提交；现有开发门保持 `CLOSED`，执行报告写明需另立规格。

## 8. 恢复开发后的约束

准入成功只解除“是否可以继续常规开发”的总门，不清除已知风险：

- 历史偶发超时继续登记为“根因未定位”；未来再次出现时按新失败独立诊断；
- 新功能若触及上位规格 C1–C10 区域，仍先完成或同切片完成对应治理与旧路径删除；
- 每个新功能仍按实际影响范围运行质量门；不能引用本次绿色替代未来验证；
- Windows 窗口层级、焦点、拖拽、托盘、安装卸载等保持“待用户人工确认”。

## 9. 完成标准

### 通过

- 固定候选可执行 HEAD 与脚本事实已复核；
- 五门按顺序各一次、全部 exit 0、每条小于 15 分钟；
- `docs/` 之外及受保护路径零差异；
- 独立复审 Critical/Important 为零；
- 唯一纯文档后继完成事实同步；
- 对外结论为“稳定性准入通过，已知偶发超时根因未定位”。

### 关闭

除上述完整通过组合外，状态一律为 `CLOSED`。本规格没有“部分通过”“等价通过”或第二轮。
