# Task 3 Fix Round 2 报告：稳定工作台耦合宽度提交

## 复审核验

复审指出的横向跳变真实存在：大屏偏好 `leftWidth=900/rightWidth=600` 在 `1120×659` 边界渲染为 `396/328` 后，若把左栏 rendered 目标 388 直接覆盖 preferred，重新收敛会得到约 `313/411`；右栏同类操作会从目标 320 跳到约 272。根因是左右栏共享宽度预算，rendered 值不是可以直接持久化的独立 preferred 值。

## RED 证据

- 新增左右两方向的纯函数与 DOM 回归，首次执行共 15 项、4 项按预期失败。
- 两项纯函数用例因反解函数尚不存在失败。
- 左栏小幅提交预期 rendered 388，实际 313；右栏小幅提交预期 rendered 320，实际 272。

## 最小修复

- 新增固定整数域 `1..4096` 的单调二分反解：以用户最终 rendered 宽度为目标，只求解本次交互侧的 preferred 值。
- 每次二分最多约 13 轮；命中取整平台后再做有界左右边界搜索，并在平台内选取最接近旧 preferred 的值，保证确定性且不存在无界循环。
- 对基准 `900/600`：左目标 388 反解为 preferred `816/600`，再次收敛为 `388/336`；右目标 320 反解为 preferred `900/548`，再次收敛为 `404/320`。未交互侧 preferred 均保持原值。
- `sidebarTopHeight` 与 `stageHeight` 不共享预算，继续只直接合并本次交互字段。
- 同步 preload 公开 API 精确白名单测试中的 `getWorkshopLayout` 与 `saveWorkshopLayout`；完整 Vitest 揭示该测试此前仍停留在新增布局 API 前的旧清单。

## GREEN 与验证

- 布局纯函数与 DOM：15/15 通过。
- preload API、布局 DOM、工作台组件联合定向回归：82/82 通过。
- Desktop typecheck：退出 0。
- Desktop build：退出 0；Main、Preload、Renderer 与生产边界检查通过。
- 目标真实 Electron E2E：1/1 通过；过预算偏好下左右栏各缩小 8px 后均保持在目标 ±1px，并继续通过重开恢复、窄屏最小尺寸与恢复桌面布局断言。
- `git diff --check`：退出 0，仅有既有行尾转换提示。

## 非本任务门禁观察

一次参数转发错误意外运行了完整 Desktop Vitest：2865 项中 2863 项通过。除已在本次同步并转绿的 preload API 白名单外，`character-package-service.test.ts` 的“同一存储根目录的并发导入严格串行且不会回滚活跃事务”在 5000ms 超时；该文件与本次修改无交集，未在本任务内扩大修复范围。

## 剩余边界

真实 Electron 自动化已覆盖默认缩放下的拖动、释放、重开与窄屏切换。不同 Windows DPI 下的视觉手感仍属于待用户人工确认范围。
