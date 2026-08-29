# 角色运动原生边界验收记录

## 验收元数据

- 日期：2026-08-29
- 环境：Windows，`AgentCoreExtension` 分支，本地 pnpm workspace
- 最终代码 HEAD：`bf062497c7aff916786a45729d43804e2c1b06d5`
- 规格：`docs/superpowers/specs/2026-08-28-ai-pet-agent-workshop-stability-design.md`
- 计划：`docs/superpowers/plans/2026-08-28-character-motion-native-boundary.md`
- 生产实现：`46180c34adcec5726304f633ed3fb43275a6f85f`
- timer 测试修正：`a487b8835dac879eef6eb5a0cb2caae19bd31730`

## 范围与状态

本记录只验收角色运动进入 Electron 原生窗口前的坐标规范化、Int32 拒绝和 timer 异常收口，不扩展到所有运动策略，不启用 MCP，也不改变 Renderer 权限。

当前状态：**`verify:behavior` 通过，`verify:desktop` 失败；运动定向边界自动化通过，但 Task 2 的完整桌面门未通过，不宣称完整自动化验收通过。真实 Windows 长时间运行仍待用户人工确认。**

## TDD 证据

### RED

Task 1 在实现前以直接 Vitest 定向命令得到两个符合预期的失败：

1. `{-0.1, 2}` 舍入后把 `-0` 交给 fake 原生窗口，`Object.is(value, 0)` 为假。
2. fake `setPosition()` 同步抛出 `NATIVE_POSITION_PRIVATE_DETAIL` 时，异常从 timer 回调逃逸。

计划中的 `pnpm.cmd --filter @myself/desktop test -- ...` 会被当前 workspace 脚本包装为额外的 `--`，无法形成可判定的定向终态；Task 1 因此使用：

```powershell
pnpm.cmd --filter @myself/desktop exec vitest run --config vitest.config.ts tests/pet-geometry-coordinator.test.ts tests/character-motion-controller.test.ts
```

### GREEN 与变异复核

- 实现后两个文件 93/93 通过，Desktop typecheck 通过。
- 临时移除 timer guard 的 `stop()` 后，`character-motion-controller.test.ts` 中新增回归测试失败，后续 `setPosition()` 从预期 1 次增长为 6 次；恢复正式实现后 93/93 重新通过。该变异未进入提交。
- 首次独立审查指出旧测试用 `destroyed = true` 掩盖 timer 是否真实清理；`a487b88` 改为窗口持续存活并推进多个 tick/idle 周期，限定复审确认 finding 已解决，且没有新的 Critical/Important。

## 已证明的自动化不变量

- `-0.1` 舍入后向原生窗口交付 `+0`，x/y 两轴均覆盖。
- `-1`、`-200` 等合法负整数坐标原样保留，不误伤多显示器负坐标。
- NaN、Infinity 与舍入后仍越出 Int32 的坐标不调用 `setPosition()`。
- 原生同步异常和 Promise reject 均由 timer guard 收口；tick 与 idle timer 停止。
- 同一故障只上报一次 `CHARACTER_MOTION_TIMER_FAILED`；底层异常正文、Electron 堆栈和绝对路径不投影给 Renderer。
- 窗口销毁或服务停止后不继续调用原生窗口 API。

## 最终门禁结果

所有最终结论绑定同一代码 HEAD `bf062497c7aff916786a45729d43804e2c1b06d5`。

| 命令 | 时间与耗时 | 结果 | 实际证据 |
| --- | --- | --- | --- |
| `pnpm.cmd verify:behavior` | 10:33:32–10:44:39，666.6 秒 | 退出码 0 | character-runtime 341/341；Agent Core 100/100；Desktop typecheck 通过、108 个文件 2858/2858；security 28/28；integration 92/92；生产构建与边界检查通过；Electron E2E 79 通过、1 个既有长时场景按配置跳过 |
| `pnpm.cmd verify:desktop` | 10:44:46–10:46:42，116.3 秒 | 退出码 1 | 全仓 10 个 workspace typecheck 通过；root unit 为 136 个文件通过、1 个失败，3573 项通过、1 项失败；唯一失败是未修改的 `V1 角色包在 staging 内统一转换为 V2 后安装` 达到固定 5000ms 超时，后续 security、integration 与 Electron E2E 未由本命令执行 |
| 一次精确定向诊断 | 10:46:57–10:47:00，3.5 秒 | 退出码 0 | 同一 V1 staging 用例 1/1 通过、72 项跳过；用例本体 895ms。本次隔离执行未复现完整门中的超时，只表明失败可能与时序或负载相关，细根因未证实；该结果不覆盖完整 `verify:desktop` 失败事实 |
| `git diff --check` | 10:47:07，0.1 秒 | 退出码 0 | 无 whitespace error |

两道门中 `pet-geometry-coordinator.test.ts` 36/36 与 `character-motion-controller.test.ts` 57/57 均已通过。`verify:behavior` 的完整真实 Electron 链没有输出主进程未捕获异常；测试过程出现的 `CHARACTER_IMPORT_RECOVERY_*`、JSDOM Canvas 未实现和构建 `use client` 提示均属于既有、由对应测试断言或环境产生的受控诊断。

因为 `verify:desktop` 退出 1，本记录不会用随后定向 1/1 或已通过的行为门把它改写成通过。本轮按简报只进行一次精确定向诊断，没有重跑完整门；首次失败必须永久保留，但后续完成根因修复后仍必须在稳定的同一最终 HEAD 重新运行完整 `verify:desktop`，这是完成计划而不是掩盖历史。

## 预备轮历史诊断

正式冻结 `bf06249` 前曾在 `318436d` 启动一轮门禁：

- `verify:behavior` 退出 0，Desktop 单元 2857/2857，Electron E2E 79 通过、1 跳过。
- `verify:desktop` 运行期间共享工作树前进到工作台提交，因工作台测试按错误 cwd 读取 CSS 而出现 6 个 ENOENT；该混合快照门退出 1。随后 `bf06249` 仅修正测试夹具路径，根目录与 Desktop 包目录定向测试均为 30/30。

该预备轮只作为并发提交污染与 cwd 回归诊断历史，不参与最终 HEAD 的通过结论。

## 独立复审

- Task 1 首审的唯一 Important 已由 `a487b88` 修正并在限定复审中清零。
- Task 2 已对文档提交 `763393e` 完成独立证据一致性复审，结论为 Critical 0 / Important 1 / Minor 2。
- 本文档正按该复审修正“复审状态失实”“隔离通过被误写为并发根因”和“后续完整门重跑会掩盖首次失败”三项问题；修正后的限定复审尚未执行，不能写成审查全绿。
- `verify:desktop` 仍为失败，因此无论文档 finding 是否清零，Task 2 都不能标记 complete。

## 待用户人工确认

自动化使用 fake `BrowserWindow.setPosition()` 精确证明参数和异常边界，但不能替代真实 Windows 的长期系统表现。以下项目仍待人工确认：

1. 桌宠长时间自主或命令运动期间不再出现 “A JavaScript error occurred in the main process” 弹窗。
2. 桌宠靠近单屏顶部和边缘、运动路径产生接近零的负小数时不弹错且运动连续。
3. 存在负坐标的多显示器布局中，合法负整数位置仍可使用，没有被错误钳制到主屏。
4. 主观运动连续性、跨显示器观感和长时间稳定性。

## 最终裁决

- 运动原生参数和 timer 边界：自动化通过。
- `verify:behavior`：通过。
- `verify:desktop`：失败；完整门中的目标用例达到 5000ms 超时，一次隔离执行未复现，细根因未证实且不改变完整门结果。
- 真实 Windows 长时间运行：待用户人工确认。
- Task 2 总体：**未完成。当前未达到“两道完整门均通过”的计划预期；后续修复后必须在保留本轮失败历史的前提下重新运行完整 `verify:desktop`。**
