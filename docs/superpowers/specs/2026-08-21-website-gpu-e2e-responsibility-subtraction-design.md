# 网站 GPU E2E 职责再减法设计

> 文档状态：已实施并自动化通过；不构成 Chromium/GPU 阻塞已修复的证明
> 日期：2026-08-21
> 适用范围：网站 Playwright、网站液态玻璃组件测试、网站验证文档
> 替代关系：仅在“两条退役用例、E2E 数量及对应验收职责”范围内修订 `2026-08-20-website-e2e-responsibility-reduction-design.md` 第 3、6、7 节与 `2026-08-20-website-liquid-glass-deep-module-reduction-design.md` 第 6、9 节；其余安全边界和产品设计继续有效

## 1. 问题与证据边界

阶段 1 Task 11 的 `pnpm.cmd verify:web-chain` 已完成网站 E2E 之前的相关子门，但 E2E 得到 `14 passed / 2 failed`：

1. `普通滚轮吸附、隔离惯性并重计新手势` 在业务断言开始前的首个 `page.mouse.move(720, 450)` 耗尽 60 秒总预算；trace 显示进入该调用前首页已经运行约 22 秒。
2. `液态玻璃 WebGL 画布按性能比例建立缓冲区并响应指针` 耗尽 60 秒，随后清理阶段的 `context.close()` 因页面或上下文已关闭而报错；没有取得该次 DPR、缓冲尺寸或指针断言通过证据。

随后使用同一 Playwright 配置按标题精确运行这两项：滚轮用例约 5.9 秒通过，高 DPR 用例再次耗尽 60 秒，结果为 `1 passed / 1 failed`。因此滚轮失败具有序列相关的间歇性，高 DPR 专项即使近乎独立仍不稳定。

当前证据只能支持以下根因裁决：

- 两项都把可确定验证的组件/状态机职责绑定到真实 Chromium GPU 页面和 Playwright 鼠标输入，门禁结果受 GPU 页面运行状态影响；这是测试职责层级过高的问题。
- 滚轮失败发生在任何滚轮业务断言之前，高 DPR 失败也没有形成缓冲或指针断言证据，不能据此认定滚轮状态机、DPR 公式或指针实现发生产品回归。
- 阶段 1 从基线 `c3150c2` 到当前提交的文件差异不包含 `LiquidGlassHome.tsx`、章节控制器及这两条 E2E；2026-08-20 验收记录曾取得 16/16 通过。该事实降低了“阶段 1 改坏 GPU 产品代码”的可能性，但不证明 Chromium 内部阻塞的唯一机制。
- 关闭 trace 截图、增加隔离机制等历史尝试已经证伪或撤销。本轮禁止通过增加 timeout、retry、worker、runner、fixture 或关闭 trace 掩盖失败。

本设计不宣称已经修复浏览器或 GPU 阻塞，只把确定性职责放回能稳定证明它的最低测试层。

## 2. 目标与非目标

### 2.1 目标

1. 精确删除两条不稳定且职责重复的 E2E，正式清单从 16 项减为 14 项。
2. 滚轮状态机职责复用现有模型/控制器测试；唯一真实浏览器全局 wheel 接线断言合并到既有 reduced-motion E2E，不新增 E2E 条目。
3. 在现有 `apps/website/tests/magnetic-intro.test.tsx` 最多新增一项液态玻璃组件测试，承接 DPR 缓冲和指针数据流；不新增测试文件。
4. 保留真实浏览器仍有独有价值的 WebGL 初始化、返回恢复、窄屏画布和真实输入隔离接缝。
5. 最终测试代码净减少，不新增生产接口、产品分支、依赖或测试基础设施。

### 2.2 非目标

- 不修改 `LiquidGlassHome`、章节控制器、shader、CSS 或任何网站产品行为。
- 不诊断或修补 Chromium、ANGLE、显卡驱动及 Playwright 内部实现。
- 不删除其余 14 项 E2E，不放宽断言、超时、重试、worker、trace 或验证门。
- 不触碰桌面端、Agent、文件工具、角色业务或其测试。
- 不连接 CloudBase、Scanner、数据库或其他远端服务；不部署正式网站。
- 不把 2026-08-20 的历史 16/16 记录改写为未通过；在全部验收完成前，不把本次设计写成已通过。

## 3. 精确退役范围

从 `tests/e2e/website.spec.ts` 删除以下两个完整测试块：

1. `普通滚轮吸附、隔离惯性并重计新手势`
2. `液态玻璃 WebGL 画布按性能比例建立缓冲区并响应指针`

同时只删除由第二项独占的专用 `browser.newContext({ deviceScaleFactor: 2 })`、`baseURL` 检查、五点鼠标轨迹与该 context 的 `finally` 清理。不得保留 `skip`、注释块、兼容别名或缩短后的同义 E2E。若删除后出现仅服务这两项的局部 import/helper，才可一并删除；共用 `baseURL` fixture 不属于本范围。

预计两块共毛减约 104 行。组件承接测试及替身增强上限为 60 行，既有 reduced-motion E2E 的接线断言新增上限为 4 行，目标净减少至少 40 行；实际以 `git diff --numstat` 为准。若实现需要新增生产代码、测试文件或超过合计 64 行新增上限，停止并重新审查职责，不继续做加法。

## 4. 滚轮职责承接

滚轮 E2E 的完整状态机职责已经由较低层证据覆盖；真实浏览器仍保留一个最小的全局接线正向证据：

| 原职责 | 既有测试证据 |
| --- | --- |
| `120px` 输入累计到 `240px` 后才释放 | `chapter-model.test.ts`：`同方向累计到 240px 才释放且只返回超过阈值的余量` |
| 方向反转后清空旧累计并重计 | `chapter-model.test.ts`：`解锁累计方向反转时清空旧方向并从新方向重新计算` |
| 显示进度逐帧追赶目标 | `website-controller.test.tsx`：`滚轮先更新目标且显示进度通过动画帧连续追赶` |
| 停止 `120ms` 后吸附并锁定 `800ms` 惯性 | `website-controller.test.tsx`：`停止 120ms 后用 380ms 吸附并锁住后续 800ms 惯性` |
| 解锁后必须静止并重新累计完整阈值 | `website-controller.test.tsx`：`锁定结束后必须静止并重新累计 240px 才能离开` |
| 硬边界不污染下一次反向手势 | `website-controller.test.tsx`：首页/末页越界滚轮两项 |
| 真实浏览器局部滚轮消费、冒泡隔离和章节保持 | 保留 E2E：`支付滚筒消费局部滚轮与键盘输入并显示映射正确的真实付款码` |
| 真实 `page.mouse.wheel` 已接到全局章节控制器并能从首页前进 | 合并进既有 E2E：`减少动态效果直接进入稳定首页`；保持 `reducedMotion: 'reduce'`，首页稳定断言后执行一次 `page.mouse.wheel(0, 360)` 并断言 `data-active-chapter="about"` |

删除该 E2E 不删除章节状态机、浏览器 wheel 监听或局部输入隔离。真实浏览器不再重复验证毫秒级吸附状态机，只在无 GPU 的 reduced-motion 路径证明全局 wheel 接线；阈值、吸附、锁定、反向重计仍由组件/模型测试证明。该断言合并到既有用例，不新增、复制或改名 E2E 条目，正式清单仍为 14 项。

## 5. 高 DPR 与指针职责承接

### 5.1 继续保留的真实浏览器证据

- `390 离开再返回首页后液态画布缓冲区保持可用`：证明 normal-motion 下真实 canvas/WebGL 能建立非零缓冲，章节离开再返回后仍可见且缓冲保持可用。
- `390 宽度液态玻璃首页无横向溢出`：证明真实画布在窄屏首页处于 active、可见且不制造横向溢出。
- `减少动态效果直接进入稳定首页`：证明 reduce 路径不依赖 GPU 动画仍可稳定进入首页。

### 5.2 最小新增组件契约

只在现有 `apps/website/tests/magnetic-intro.test.tsx` 增加一项 normal-motion 组件测试，并复用、最小增强该文件的 `createWebGlContext()` 与 canvas 替身：

1. 固定 `window.innerWidth=1440`、`window.innerHeight=900`、`window.devicePixelRatio=2`。
2. 渲染现有 `LiquidGlassHome`，断言 canvas 后备缓冲为 `1296 × 810`，且 WebGL `viewport` 使用同一尺寸；这直接锁定 1440 档 `resolutionScale=0.9` 与 `Math.min(DPR, scale)` 的现行契约。
3. 用现有 Testing Library 事件向 `window` 派发画布内部的 pointer move，并向 canvas 派发 pointer down；使用命名 WebGL spy 与捕获的 ticker render 回调，断言 pointer uniform 收到归一化坐标，ripple uniform 收到该次点击数据。
4. 不新增 pointer/resize 监听、ticker 或资源卸载断言：原高 DPR E2E 未持有这些生命周期职责，本次职责下沉不得扩大替代测试范围；生命周期释放继续由既有 `运行期切换动态偏好会释放 WebGL 并可重新初始化` 测试承担。

该测试只观察公开 DOM、现有副作用和 WebGL 调用，不向生产组件新增导出、测试钩子、data 属性或辅助函数。若 jsdom 无法稳定表达 pointer uniform/ripple 数据流，停止并报告缺口；不得为测试可见性修改生产接口。

## 6. 测试先行与 mutation/RED 证据

本任务是测试职责迁移而非产品行为修复。新增组件特征测试针对当前正确行为，初次可能直接 GREEN；为避免“没有证明测试能捕获回归”，实施时使用临时 mutation 取得 RED，并在任何正式 GREEN 或提交前完整恢复生产文件：

1. **滚轮状态机既有测试敏感性**：临时将 `apps/website/components/home-experience/config.ts` 的 `wheelUnlockDelta` 从 `240` 改为 `360`，运行 `chapter-model.test.ts` 与 `website-controller.test.tsx`；至少一项阈值/追赶契约必须因未释放滚轮输入而失败。立即恢复为 `240`，同一命令必须 GREEN。
2. **浏览器全局 wheel 接线敏感性**：先把最小接线断言合并到 `减少动态效果直接进入稳定首页` 并观察 GREEN；再临时停用 `use-website-controller.ts` 中 `registerWindowListener('wheel', handleWheel, { passive: false })`，精确运行该 E2E，必须因章节仍停在 `home` 而 RED。立即恢复监听注册，同一 E2E 必须 GREEN。不得用组件 `fireEvent.wheel` 代替这项真实浏览器 mutation 证据。
3. **DPR 测试敏感性**：临时将 `LiquidGlassHome.tsx` 的 1440 档比例从 `0.9` 改为 `1`，新增组件测试必须因 `1296 × 810` 契约失败。立即恢复为 `0.9`。
4. **指针测试敏感性**：临时把 `handleCanvasPointerDown` 对 `updatePointer(event, true)` 的调用改为 `false`，新增组件测试必须因 ripple 数据未写入而失败。立即恢复为 `true`。
5. 使用 `git diff` 核对上述三个生产文件最终零差异，再运行目标组件/控制器测试与 reduced-motion E2E 取得 GREEN。只有 mutation 的失败原因与预期一致，才能删除两个 E2E。

mutation 只用于本地短时验证，不提交、不形成产品改动。任一 mutation 没有使目标断言失败，说明替代测试不敏感，停止删除并重新设计测试；不得继续叠加外围等待。

## 7. 实施顺序与删除门

1. 在 `magnetic-intro.test.tsx` 写最小组件契约并完成 DPR/指针 mutation RED/GREEN。
2. 把最小全局 wheel 接线断言合并到既有 `减少动态效果直接进入稳定首页`，完成监听注册 mutation RED/GREEN；该用例始终使用 reduce，不得启动 WebGL。
3. 运行既有滚轮目标测试并完成阈值 mutation RED/GREEN。
4. 核对三个临时生产 mutation 均已恢复，且 `git diff` 中没有生产文件差异。
5. 使用 `apply_patch` 精确删除两条 E2E，运行 Playwright `--list`；清单必须为 14 项且不存在两个退役标题。
6. 先运行合并后的 reduced-motion 接线 E2E 与保留的两条 normal-motion 390 E2E，再运行完整 14 项 E2E。
7. 更新第 8 节列出的有效文档；历史失败和历史 16/16 结果继续保留并标注日期。
8. 执行完整网站链、范围守卫和格式检查。只有全部实际通过后，Task 11 才能从“失败”更新为“自动化通过”。

删除恢复依赖独立 Git 提交的父版本；不删除用户文件、远端数据或部署资源。

## 8. 单一事实来源同步

实施通过后必须同步以下有效文档，避免 14/16 两套当前清单并存：

- `docs/superpowers/specs/2026-08-20-website-e2e-responsibility-reduction-design.md`：注明本规格在两条用例与当前计数范围内接替旧第 3、6、7 节。
- `docs/superpowers/specs/2026-08-20-website-liquid-glass-deep-module-reduction-design.md`：将 normal-motion 专项从四条改为保留的两条 390 E2E，并引用组件 DPR/指针契约。
- `docs/superpowers/plans/2026-08-20-website-e2e-responsibility-reduction.md` 与 `docs/superpowers/plans/2026-08-20-website-liquid-glass-deep-module-reduction.md`：历史实施结果保留，追加本次职责再减法的接替说明，不把过去的 16/16 改写为 14/14。
- `docs/operations/website-chain-verification-acceptance.md`：保留 2026-08-20 历史表，新增 2026-08-21 当前清单、命令和实际结果；自动化职责改为 14 项 E2E 加组件 DPR/指针契约。
- `docs/superpowers/plans/2026-08-15-website-publication-stopgap-and-migration-freeze.md`、对应 `progress.md` 与 `task-11-report.md`：只在重新验证后写入真实 Task 11 结果。

不得修改历史 specs 中用于解释已退役方案的原始失败事实。工具与配置中当前没有硬编码 E2E 数量或这两个标题，无需新增计数常量。

## 9. 验收命令

先执行定向门：

```powershell
pnpm.cmd --filter @myself/website test -- magnetic-intro.test.tsx chapter-model.test.ts website-controller.test.tsx
pnpm.cmd --filter @myself/website typecheck
node.exe node_modules/@playwright/test/cli.js test --config tests/playwright.website.config.ts --list
pnpm.cmd exec playwright test --config tests/playwright.website.config.ts --grep "390 离开再返回首页|390 宽度液态玻璃|减少动态效果直接进入稳定首页"
```

清单必须精确为 14 项，两个退役标题必须零命中。随后执行：

```powershell
pnpm.cmd test:e2e:website
pnpm.cmd --filter @myself/website test
pnpm.cmd verify:web-chain:fast
pnpm.cmd verify:web-chain
pnpm.cmd verify:web-chain:scope
git diff --check
```

最终还必须按阶段 1 Task 11 既定顺序补跑其余 CloudBase、Scanner、migration 工具和旧入口检查；本规格不改变那些门禁。

## 10. 15 分钟止损与失败处理

- 任一命令或单一问题累计达到 15 分钟，立即终止当前命令及其相关子进程，记录最后通过项、首错和产物路径，改用更小的目标命令定位。
- 完整 E2E 或网站链出现首错时，不增加 timeout、retry、worker、浏览器隔离、trace 调整或固定等待。
- 若保留的任一 390 E2E 失败，先判断真实 WebGL 接缝是否回归；不得继续删除该接缝。
- 若组件 mutation 未产生预期 RED，撤销新增测试与删除方案，报告职责缺口。
- 若 14 项门仍出现同类 GPU stall，停止继续做 E2E 数量减法，记录新首错并重新审查仍保留用例的独有浏览器职责。
- 未完成全部验收时只能写“待验证”或“失败”，不得声称 Task 11、阶段 1 或 GPU 问题已修复。

## 11. 2026-08-21 实施证据

- 测试职责减法提交：`d602d87`。正式代码差异只有 `magnetic-intro.test.tsx` 与 `website.spec.ts`；合计新增 61 行、删除 112 行，测试代码净减少 51 行。
- 四项 mutation 均因指定断言取得 RED，恢复后 GREEN；三个临时生产文件最终零差异。监听 mutation 首次因复用旧静态导出得到的假 GREEN 已明确排除，不计入证据。
- Playwright 当前清单为 14 项；两条退役标题零命中；两条 390 WebGL 接缝与 reduced-motion wheel 接线定向 3/3 通过；Task 1 完整 E2E 为 14/14。
- 阶段 1 Task 11 固定顺序于同日重新执行：定向与包级门、`verify:web-chain:fast`、`verify:web-chain`、`verify:web-chain:scope`、migration dry-run 与两项负向检索全部通过；完整门内 E2E 为 14/14，Playwright 报告 54.6 秒。
- 本结论只证明职责迁移后的自动化门稳定通过；没有修改或宣称修复 Chromium、ANGLE、显卡驱动或 Playwright 内部阻塞。
