# 角色运动原生边界修复实施计划

> **供智能体执行：** 必须使用 `subagent-driven-development` 或 `executing-plans` 按任务实施；每项任务严格执行 RED → GREEN → REFACTOR。

**目标：** 防止 `-0`、非法坐标和 timer 异常进入 Electron 原生窗口 API，从根源消除角色运行期间的主进程 JavaScript 错误弹窗。

**架构：** 在 `CharacterMotionService` 的唯一原生提交边界规范化和校验坐标；timer guard 捕获同步/异步 tick 异常、停止定时器并只上报一次稳定错误，不改变合法多显示器负坐标行为。

**技术栈：** TypeScript、Electron Main、Vitest

## 全局约束

- 规格来源：`docs/superpowers/specs/2026-08-28-ai-pet-agent-workshop-stability-design.md`。
- 必须保留 `-1`、`-200` 等合法负整数坐标。
- 不把 Electron 堆栈、绝对路径或底层错误文本投影给 Renderer。
- 先复现 RED，再修改生产代码。

---

### Task 1：规范化原生坐标并增加 timer 错误边界

**文件：**
- 修改：`apps/desktop/src/main/characters/character-motion-service.ts`
- 修改：`apps/desktop/tests/pet-geometry-coordinator.test.ts`
- 修改：`apps/desktop/tests/character-motion-controller.test.ts`

**接口：**

```ts
type NativePositionResult =
  | { ok: true; position: CharacterMotionPoint }
  | { ok: false; code: 'CHARACTER_POSITION_INVALID' };
```

现有公开 `CharacterMotionService.tick()` 返回契约保持不变；错误通过现有稳定错误报告端口投影，timer guard 只报告一次并停止自身。

- [ ] **步骤 1：写负零与坐标校验失败测试**

添加字面输入：`{x: -0.1, y: 2}` 与 `{x: 2, y: -0.1}`，断言 fake `setPosition` 收到的 0 满足 `Object.is(value, 0)`；`-1/-200` 原样保留；NaN、Infinity、非整数来源和 Int32 越界不调用 `setPosition`。

- [ ] **步骤 2：验证 RED**

```powershell
pnpm.cmd --filter @myself/desktop test -- pet-geometry-coordinator.test.ts character-motion-controller.test.ts
```

预期：至少负零被传入 fake window，当前测试失败。

- [ ] **步骤 3：最小实现坐标边界**

在现有 `integerPosition()` 中用 `Object.is(rounded, -0) ? 0 : rounded` 规范化；在唯一原生调用前验证有限、整数、Int32 范围。非法坐标返回稳定错误且不调用 Electron。

- [ ] **步骤 4：写 timer 抛错失败测试**

让 fake `setPosition` 同步抛错，驱动真实 guard timer 回调，断言：回调不向事件循环抛出未捕获异常、timer 被清理、稳定错误只报告一次、第二次 tick 不再调用窗口；窗口销毁和服务停止后也不调用原生 API。

- [ ] **步骤 5：验证 RED**

重复步骤 2，预期 fake 原生异常仍逃逸或被重复调用而失败。

- [ ] **步骤 6：最小实现 timer 边界并验证 GREEN**

在 guard 边界以单一 `try/catch/finally` 收口同步与 Promise 异常，先停止相关 timer，再调用脱敏错误端口；使用布尔闩锁防止重复报告，不吞掉直接调用 `tick()` 的测试可观察稳定错误。

```powershell
pnpm.cmd --filter @myself/desktop test -- pet-geometry-coordinator.test.ts character-motion-controller.test.ts
pnpm.cmd --filter @myself/desktop typecheck
```

预期：全部通过。

- [ ] **步骤 7：提交**

```powershell
git add apps/desktop/src/main/characters/character-motion-service.ts apps/desktop/tests/pet-geometry-coordinator.test.ts apps/desktop/tests/character-motion-controller.test.ts
git commit -m "fix: 收口角色运动原生坐标异常"
```

### Task 2：行为与桌面门禁及验收记录

**文件：**
- 新增：`docs/operations/character-motion-native-boundary-acceptance.md`

- [ ] **步骤 1：运行门禁**

```powershell
pnpm.cmd verify:behavior
pnpm.cmd verify:desktop
git diff --check
```

预期：全部通过且无主进程未捕获异常输出。

- [ ] **步骤 2：更新验收记录**

记录自动化证明的负零规范化、合法负坐标、非法坐标拒绝和 timer 错误收口；真实 Windows 长时间运行标记为待用户人工确认。

- [ ] **步骤 3：提交**

```powershell
git add docs/operations/character-motion-native-boundary-acceptance.md
git commit -m "docs: 记录角色运动原生边界验收"
```
