# 聊天视觉细调验收记录

日期：2026-09-14。环境：Windows、Electron 43.5.0；原生窗口观测 DPI 为 144（150%）。

依据：[规格](../superpowers/specs/2026-09-14-chat-appearance-refinement-design.md)、[计划](../superpowers/plans/2026-09-14-chat-appearance-refinement.md)。

## 已实施范围

- 选项向左展开，712px 透明画布为菜单和阴影留空间；常规输入框宽度保持 360px、圆球 48px，360/528/712px 窗口均检查点击可达。
- 原生绘制裁区增加 16 DIP 余量，保留浏览器圆角与底部投影；原交互区域独立判断，重复鼠标移动及轮询不重复切换原生状态。
- 历史外层完全透明，消息自身增加投影；删除原生磨砂背板和专用协议、状态、提示及工厂。
- 普通回复最多四行，完整内容保留在滚动区，流式增长到四行后高度不再增加；保留当前宽度和授权详情的独立展示规则。
- 隐藏/重置清理按下状态，隐藏窗口关闭鼠标转发；保留已有低级鼠标观察器及其消息泵修复。
- 未修改模型、聊天处理、会话保存、文件执行、授权判定或桌宠行为决策；未执行 Git 写操作。

## 自动化结果

| 检查 | 结果 |
| --- | --- |
| `pnpm.cmd exec playwright test --config tests/playwright.config.ts chat-appearance.spec.ts` | 3 项通过；先确认菜单方向、历史白底、六行气泡的失败，再修改到通过 |
| 桌面 10 个定向测试文件（下列命令） | 95 项通过；涵盖展示桥、生命周期、原生布局、穿透、组件和重置 |
| `pnpm.cmd --filter @myself/desktop typecheck` | 通过 |
| `pnpm.cmd --filter @myself/desktop build` | 通过；沙盒 preload、生产 MCP 与本地模型边界构建检查完成 |
| `git -c core.safecrlf=false diff --check` | 通过 |

定向测试命令：

```powershell
pnpm.cmd --filter @myself/desktop test tests/chat-presentation-hit-testing.test.ts tests/chat-presentation-windows.test.ts tests/chat-native-presentation.test.ts tests/chat-presentation-bridge.test.ts tests/window-security.test.ts tests/presentation-layout.test.tsx tests/chat-island.test.tsx tests/chat-bubble-view.test.tsx tests/use-chat-presentation.test.tsx tests/use-chat-presentation-reset.test.tsx
```

评审曾发现隐藏窗口仍可能启用鼠标转发；已补回归、修复并经独立子智能体复核。500 次同区域鼠标事件、20 次不变轮询均不重复调用原生穿透切换。

## 原生观察与限制

运行 `pnpm.cmd exec playwright test --config tests/playwright.config.ts chat-visual-presentation.spec.ts`：

- 已通过的步骤：真实光标到顶边只显示提示；点击展开、菜单/历史切换和收起；Win32 裁区包含输入中心与底部阴影并排除画布透明角；真实光标位于输入内部时窗口接收鼠标、移到阴影处时穿透；气泡局部轮廓和尾部区域正确。
- 整条原生 E2E **未通过**：截图守卫返回 `FIXTURE_CAPTURE_NOT_OWNED`；改用只含自有 Renderer 的截图后，外部真实首击守卫返回 `FIXTURE_CLICK_NOT_OWNED`，没有执行该点击。未放宽归属检查，未将此项记为通过。
- 已检查 Renderer 截图：圆角连续、底部投影可见，历史外层没有底板。Renderer 截图不能证明 Windows 桌面合成效果。
- 证据保存在本地忽略目录 `.superpowers/sdd/2026-09-14-chat-appearance/`：`controlled-native-window-facts.json`、`renderer-only-chat.png`、`renderer-only-bubble.png`。
- 待用户人工确认：桌面合成观感、实际鼠标快速跨越控件边界、拖动选择后松开、外部首击收起及不同缩放比例。未运行无关模型、角色、官网或发布回归。
