# Task 1 状态快照

## 时间

- 日期：2026-08-28
- 任务：角色工作台布局稳定性 Task 1

## 结果

- RED：已完成
- GREEN：已完成
- 剩余项：无
- 阻塞：无

## RED 证据

1. 组件测试新增断言后，扩展状态弹窗与发布要求弹窗都未调用原生 `showModal()`。
2. 真实 Electron E2E 改为鼠标点击预览覆盖区域内的“创建扩展状态”按钮后，点击被预览 Canvas 截获，无法创建状态。

## GREEN 实现

1. 新增 `use-modal-dialog.ts`，统一托管原生模态对话框的打开、关闭与焦点归还生命周期。
2. `IncompleteCharacterDialog.tsx` 复用统一 hook，删除重复的弹窗生命周期代码。
3. `CharacterWorkshopView.tsx` 中“发布要求尚未满足”“新建扩展状态”两个弹窗改为 `ref + showModal()/close()` 路径，不再使用 `<dialog open>`。
4. “新建扩展状态”弹窗改为常驻节点与原生表单读取，避免输入过程把模态态退化成普通打开态，同时保留 Escape、表单提交和焦点返回语义。
5. 保留最小样式调整，只让弹窗继续使用既有视觉样式，不再依赖额外定位 hack。

## 验证

1. `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/character-workshop-components.test.tsx`
   - 结果：通过（37/37）
2. `pnpm.cmd --filter @myself/desktop typecheck`
   - 结果：通过
3. `pnpm.cmd --filter @myself/desktop build`
   - 结果：通过
4. `pnpm.cmd exec playwright test --config tests/playwright.config.ts tests/e2e/desktop.spec.ts -g "V2 人设、皮肤和精确表现重启后保留且导出回导等价"`
   - 结果：通过（1/1）
5. `git diff --check`
   - 结果：通过，仅有工作区 LF/CRLF 警告，无 diff 格式错误

## 说明

- 真实 E2E 依赖 `apps/desktop/out` 构建产物；中途确认过一次旧构建假阴性，最终结果以上述重建后的验证为准。
