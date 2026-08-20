# 网站 E2E 职责减法实施计划

> **执行前置：** 使用 subagent-driven-development 与 TDD；必须先取得对应规格第 4—6 节大量删除的用户二次批准。

**Goal:** 把网站 E2E 从 44 项收敛为 16 项真实浏览器接缝，删除重复测试职责，并恢复阶段 0 完整网站门。

**Architecture:** 不改变 Playwright 配置和正式入口。组件/控制器状态回归下沉到既有 Vitest 文件；真实页面业务链、浏览器地址栏、事件冒泡、CSS 断点、真实资源加载与 WebGL 接缝保留在 Playwright；主观视觉检查进入既有人工验收文档。

## 全局约束

- 只修改本计划列出的网站测试、网站验证文档和必要的范围策略；不修改产品运行时代码。
- 不新增 runner、fixture、依赖、worker、retry、timeout、跳过标记或第二条 E2E 入口。
- 不触碰任何桌宠、Agent、文件工具、角色代码或测试。
- 产品行为修复仍执行 RED → GREEN。本计划四项仅迁移既有测试证据，按获批规格采用“先观察等价特征测试 GREEN，再删除旧 E2E”的例外流程，不制造虚假失败。
- 大量删除未获用户二次批准前不得执行。
- 任一命令或问题达到 15 分钟立即停止并保存证据。

### Task 1：下沉四项组件/控制器状态

**Files:**

- Modify: `apps/website/tests/support-chapter.test.tsx`
- Modify: `apps/website/tests/website-controller.test.tsx`
- Modify: `apps/website/tests/magnetic-intro.test.tsx`
- Modify: `tests/e2e/website.spec.ts`

1. 在三个既有测试文件中分别写草稿焦点恢复、主触屏所有权、暂停期间触屏结束清理、Logo 错误回退的最小断言。
2. 运行三个目标测试文件，观察新增的等价特征测试 GREEN，并逐项核对其职责与旧 E2E 相同；不得为制造 RED 修改产品行为。
3. GREEN 后删除四个对应 E2E 测试块，运行 website 全部 323 项预期测试。

### Task 2：删除 24 项重复或人工视觉 E2E

**Files:**

- Modify: `tests/e2e/website.spec.ts`
- Create: `docs/operations/website-chain-verification-acceptance.md`（复用 foundation Task 5 已规划的唯一验收入口）

1. 按规格第 5 节逐项核对标题仍存在，并建立删除前清单证据。
2. 使用 `apply_patch` 精确删除 24 个测试块，不使用脚本批量重写文件。
3. 删除只服务已移除测试的 helper、类型、常量、导入和截图路径；每删除一组后运行 TypeScript 或 Playwright `--list`，避免一次性制造大量孤儿。
4. 在既有人工验收文档记录 568x320、390x844、760/761、1440x900、1920x1080 的视觉检查职责；不新增自动截图脚本。
5. `--list` 必须精确得到规格第 3 节的 16 项，标题或数量不符立即停止。

### Task 3：阶段 0 验证与减法审查

**Files:**

- Read: `tests/playwright.website.config.ts`
- Read: `package.json`
- Read: `tools/verification/web-chain-catalog.mjs`

1. 验证 Playwright 仍为 `fullyParallel: false`、`workers: 1`、`retries: 0`，没有超时变化。
2. 运行 website 全部单元/组件测试和 typecheck。
3. 后台运行 `pnpm.cmd test:e2e:website`，必须 16/16 通过；15 分钟止损。
4. 运行 `verify:web-chain:fast`、`verify:web-chain`、`verify:web-chain:scope`。
5. 使用 `rg` 确认已删除标题和孤儿 helper 零运行引用，使用 `git diff --check` 检查差异。
6. 报告新增、复用、删除、保留理由和净行数；提交前请求独立代码审查。

### Task 4：阶段 0 状态收敛

完整网站链通过后，更新 foundation Task 4 报告、进度台账与网站优化总索引。只提交真实通过证据；正式部署继续保持不在范围。
