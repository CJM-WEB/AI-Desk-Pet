# 聊天视觉细调计划

适用规格：[聊天视觉细调](../specs/2026-09-14-chat-appearance-refinement-design.md)。用户已明确要求执行。

1. 布局与气泡：先通过 `tests/e2e/chat-appearance.spec.ts` 重现向右展开、历史非透明与超过四行；再最小修改 `chat-presentation.css`，窗口画布留白同步到 `chat-presentation-windows.ts`；以几何、点击、滚动断言验收。
2. 原生背板退役：独立子任务在 `index.ts`、`window-manager.ts`、展示协议及消费者中删除历史磨砂专用路径；先修改定向测试确认失败，再以纯透明历史窗口验收。
3. 圆角与阴影：独立子任务先验证 `chat-presentation-windows.test.ts` 中紧裁区与命中问题，再给绘制裁区留余量并复用原交互区域处理穿透；保证拖动和状态缓存。
4. 收口：执行定向测试、桌面类型检查及构建、正式视觉 E2E，检查中文编码和 `git diff --check`；单独记录运行结果和待人工确认项。不进行 Git 写操作。
