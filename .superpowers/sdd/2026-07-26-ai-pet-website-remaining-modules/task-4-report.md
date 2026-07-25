# Task 4 实施报告：共享视觉层

## 状态

已完成。首页光场、文件粒子群和预览挂载点已提升为官网根级单例 `SharedVisualLayers`；首页使用灰色主题 `[180, 180, 180]`，捐款章节使用黄色主题 `[255, 255, 0]`。未实现下载或捐款 UI。

## RED

1. 先新增 `tests/shared-visual-model.test.ts`，未创建生产模块。
2. 运行：

   ```powershell
   .\node_modules\.bin\vitest.cmd run --config vitest.config.ts tests/shared-visual-model.test.ts
   ```

3. 结果：失败。Vitest 无法解析 `../components/website-experience/shared-visual-model`，1 个测试文件失败、0 个测试执行，失败原因与简报预期一致。
4. 在修改 `FileSwarm` 前，先把粒子门禁测试改为显式 `generating/maxActive` 契约。
5. 运行 `tests/swarm-model.test.ts`，结果为 1 项失败、19 项通过；旧实现仍读取 `phase`，导致首个允许生成断言收到 `false`，符合预期。

说明：简报中的 `pnpm --filter ... exec vitest` 在当前 Windows 环境先被 PowerShell 执行策略拦截，改用 `pnpm.cmd` 后又无法从 filtered exec 解析 `vitest`。因此 RED/GREEN 测试均直接调用同一 workspace 安装的 `apps/website/node_modules/.bin/vitest.cmd`。

## GREEN

- 共享主题测试：2/2 通过。
- 粒子模型测试：20/20 通过。
- 简报聚焦测试：

  ```powershell
  .\node_modules\.bin\vitest.cmd run --config vitest.config.ts tests/shared-visual-model.test.ts tests/swarm-model.test.ts tests/pointer-model.test.ts tests/page.test.tsx
  ```

  结果：4 个测试文件、51 项测试全部通过。

## 全量测试

```powershell
.\node_modules\.bin\vitest.cmd run --config vitest.config.ts
```

结果：10 个测试文件、74 项测试全部通过。

## 类型检查

```powershell
pnpm.cmd --filter @myself/website typecheck
```

结果：`tsc --noEmit` 通过。

## 变更文件

- `apps/website/components/website-experience/shared-visual-model.ts`
- `apps/website/components/website-experience/SharedVisualLayers.tsx`
- `apps/website/components/website-experience/WebsiteExperience.tsx`
- `apps/website/components/home-experience/CursorField.tsx`
- `apps/website/components/home-experience/FileSwarm.tsx`
- `apps/website/components/home-experience/HomeExperience.tsx`
- `apps/website/components/home-experience/config.ts`
- `apps/website/components/home-experience/types.ts`
- `apps/website/components/home-experience/home-experience.module.css`
- `apps/website/tests/shared-visual-model.test.ts`
- `apps/website/tests/swarm-model.test.ts`
- `apps/website/tests/progress-model.test.ts`
- `.superpowers/sdd/2026-07-26-ai-pet-website-remaining-modules/task-4-report.md`

`home-experience.module.css` 仅把首页自身背景改为透明并更新中文层级注释，避免根级 Canvas 被首页章节不透明背景遮挡；官网根容器仍提供原灰色背景。`progress-model.test.ts` 仅移除已迁移到共享 profile 的旧配置断言。

## 自审

- `CursorField` 和 `FileSwarm` 在组件树源码中各只有一个挂载点，均位于 `SharedVisualLayers`。
- `CursorField` 颜色由 `RgbColor` 参数生成 RGBA，不再写死首页灰色。
- `FileSwarm` 使用显式 `running`、`generating`、`exitProgress`、`maxActive` 和 `safeZoneRatio`。
- `FileSwarm` 通过 `key={profile.id}` 在 home/donation profile 变化时重置粒子、随机源、预览保持状态和失败类型集合。
- 原有预览 portal、pointer/focus 保持、按文件类型失败隔离、单 RAF、单生成 timer 及卸载清理逻辑保留。
- 首页退场继续通过 `exitProgress` 控制光场透明度和粒子缩放；捐款章节使用独立黄色 profile。
- 初始化失败时共享层整体卸载，由既有 effect cleanup 取消 RAF 和 timer，不遗留冻结粒子。
- 未修改实施计划或 SDD 账本，未实现下载或捐款 UI。

## 疑虑

- 本任务未运行浏览器端视觉截图或网站 E2E；当前验证覆盖主题模型、粒子/指针模型、静态页面语义、全量 website 单元测试和 TypeScript 类型检查。
- 当前环境的 `pnpm --filter ... exec vitest` 命令解析异常，已使用 package-local Vitest 二进制完成等价验证；该环境问题不涉及源码。
