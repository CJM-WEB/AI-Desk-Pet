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

## Fix Round 1（2026-08-29）

### 修复范围

1. `CharacterWorkshopView.tsx` 恢复“创建扩展状态”按钮的既有禁用门槛：空白名称时 `disabled`，输入非空名称后恢复可点击；提交阶段的空名称聚焦防御继续保留。
2. `character-workshop.css` 删除 `.character-workshop-shell dialog` 新增的全局 `margin: 0`，恢复原生 modal 自动居中布局。
3. `character-workshop-components.test.tsx` 增加扩展状态弹窗按钮空名称禁用、输入后启用的组件断言。
4. `tests/e2e/desktop.spec.ts` 删除“空名称时按钮 enabled”的错误预期，改为先断言禁用，再在输入名称后断言启用。

### RED 证据

1. `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/character-workshop-components.test.tsx -t "扩展状态对话框使用原生 showModal/close，保留焦点进入与返回语义"`
   - 结果：失败；`创建扩展状态` 按钮实际 `disabled === false`，与既有表单语义不符。
2. `pnpm.cmd exec playwright test --config tests/playwright.config.ts tests/e2e/desktop.spec.ts -g "V2 人设、皮肤和精确表现重启后保留且导出回导等价"`
   - 结果：失败；`创建扩展状态` 按钮在空名称下实际为 enabled。

### GREEN 验证

1. `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/character-workshop-components.test.tsx`
   - 结果：通过（37/37）
2. `pnpm.cmd --filter @myself/desktop typecheck`
   - 结果：通过
3. `pnpm.cmd exec playwright test --config tests/playwright.config.ts tests/e2e/desktop.spec.ts -g "V2 人设、皮肤和精确表现重启后保留且导出回导等价"`
   - 结果：通过（1/1）
4. `git diff --check`
   - 结果：通过，仅有工作区 LF/CRLF 警告，无 diff 格式错误

### 说明

- `pnpm.cmd test:e2e:desktop -- tests/e2e/desktop.spec.ts -g "V2 人设、皮肤和精确表现重启后保留且导出回导等价"` 会先重建桌面产物，但参数未收窄到单个用例；本轮以重建产物后直接执行的目标 Playwright 命令结果作为最终 E2E 证据。
