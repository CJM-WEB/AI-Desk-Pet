# 移动尺寸递增根因修复

日期：2026-09-12。依据用户本轮明确要求与[既有固定尺寸规格](../specs/2026-09-01-pet-startup-motion-regression-design.md)。目标是恢复单屏移动全程固定尺寸，不改变动作帧、锚点、三档运动、权限或角色素材。用户随后限定当前只考虑单屏，跨屏不属于本次验收。

实现、真实尺寸验证与独立审查已完成；实际门禁及未覆盖项以[验收记录](../../operations/2026-09-12-pet-movement-size-acceptance.md)为准。

## 证据与方案

当前 Electron 43.5.0 的 `NativeWindow::SetPosition` 先读取 `GetSize()`，再将该尺寸送入 `SetBounds()`。这台 Windows 的 150% 屏幕上，隐藏空白窗口按正式桌宠参数移动 80 次，客户区由约 180×220 增长至 260×294；移除 min/max 约束也不能消除。动作循环时几何布局又提交固定尺寸，从而构成放大、缩回的往复。源码证据：[固定版本实现](https://github.com/electron/electron/blob/v43.5.0/shell/browser/native_window.cc#L257)。

对照实验直接一次提交位置和配置中的 180×220，80 次移动的客户区始终为 180×220。该方式在移动入口切断实际尺寸的反馈，不先移动再缩小，不增加事后修复监听。原生 resize 事件仍会发生，事件次数不能代替实际尺寸测量。

复用 `window-manager.ts` 提供统一桌宠定位函数；Main 的自动运动和旧位置恢复使用该入口，拖拽及几何布局复用相同入口并删除重复构造。Renderer、Pixi 与作者帧保持现有语义，不引入原生桥或依赖。历史尺寸锁不是本次扩大源头，不凭猜测改写它。

## 执行步骤

1. RED：增强 `tests/e2e/character-motion-continuity.spec.ts`，在 resize 事件及每个绘制帧采集客户区与 Canvas，证明实际移动中存在尺寸递增；保留现有位移与三档断言。
2. GREEN：在 `apps/desktop/src/main/windows/window-manager.ts` 统一一次定位提交；`index.ts`、`pet-window-interaction-controller.ts`、`pet-geometry-coordinator.ts` 复用。测试覆盖 OS 返回膨胀尺寸仍不作为下一次输入，并确认一次定位只有一次原生提交。
3. 验证：真实 Electron 单屏全程采样、当前高 DPI 单屏的独立窗口实验；相关桌面单测、类型、构建及桌面/角色门禁，旧失败如实记录。
4. 独立审查与收口：检查所有桌宠位置写入口、删除范围与差异；更新实际验收记录。无 Git 写操作，无角色数据修改，无批量删除。

## 失败与验收边界

保持现有 Main 位置校验、事务失败及运动停止处理；不吞掉窗口原生异常，不变更权限和 IPC。真实客户区逐样本恒定才算通过，停止时变回原尺寸不算通过。测试只使用隔离窗口与临时数据，真实用户观感待人工确认，跨屏不在本次范围。
