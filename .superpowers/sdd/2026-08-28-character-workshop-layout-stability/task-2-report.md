# Task 2 状态快照

## 时间

- 日期：2026-08-29
- 任务：角色工作台布局稳定性 Task 2

## 现有模式

1. `SettingsStore` 通过 `enqueue()` 串行化读取与写入，并用 `atomicWrite()` 把 `settings.json.tmp` 原子替换为正式文件。
2. Main 侧高级设置 IPC 统一复用 `registerAdvancedSettingsIpc()` 的白名单注册和 `parseInput()` 严格 `zod` 解析模式。
3. preload 只暴露最小 `MyselfApi` 方法，并在跨进程边界对返回 payload 做二次 Schema 解析。

## 结果

- RED：已完成
- GREEN：已完成
- 剩余项：无
- 阻塞：无

## RED 证据

1. `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/settings-store.test.ts tests/settings-ipc.test.ts tests/character-workshop-close-preload.test.ts`
   - 结果：失败。
   - 证据：三组测试都因缺少 `apps/desktop/src/shared/workshop-layout-ipc.ts` 模块而失败，说明共享契约与对应 IPC/preload 接线尚不存在。
2. 失败点精确集中在：
   - `settings-store.test.ts` 无法导入布局默认值与 Schema；
   - `settings-ipc.test.ts` 无法导入布局默认值，无法验证 Main 端输入解析；
   - `character-workshop-close-preload.test.ts` 无法导入布局默认值，无法验证 preload 暴露与 payload 解析。

## GREEN 实现

1. 新增 `apps/desktop/src/shared/workshop-layout-ipc.ts`，定义 `WorkshopLayoutSettings`、`DEFAULT_WORKSHOP_LAYOUT` 与严格 `workshopLayoutSettingsSchema`，统一布局像素值契约。
2. `SettingsStore` 新增 `workshopLayout` 持久化字段与 `getWorkshopLayout()/saveWorkshopLayout()`，继续复用现有 `enqueue` 和 `atomicWrite` 原子写队列。
3. `ipc-channels.ts`、`register-ipc.ts` 与 `DesktopSettingsService` 新增工作台布局读取/保存通道，沿用高级设置白名单注册模式，不新增 Renderer 文件写入口。
4. `MyselfApi` 与 preload 新增且只新增 `getWorkshopLayout()`、`saveWorkshopLayout()` 两个方法；preload 在调用前后都使用同一布局 Schema 解析 payload。
5. 三组目标测试补齐了缺失旧设置默认、合法原子保存/重载、NaN/Infinity/负值/超预算拒绝，以及 preload 最小暴露与返回值解析断言。
6. 为通过 `@myself/desktop` 全量 TypeScript 检查，最小补齐了现有 `advanced-settings-ipc.test.ts`、`desktop-settings-service.test.ts` 的测试桩类型，不改变生产行为。
7. 两个既有旧迁移测试在手工降级到 v5 夹具前显式删除 `workshopLayout` 字段，避免构造“历史版本带未来字段”的不真实输入，同时保持生产侧 strict Schema 不放宽。

## 验证

1. `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/settings-store.test.ts tests/settings-ipc.test.ts tests/character-workshop-close-preload.test.ts`
   - 结果：通过（3 个文件，66 项通过）
2. `pnpm.cmd --filter @myself/desktop typecheck`
   - 结果：通过
3. `git diff --check`
   - 结果：通过，仅有工作区 LF/CRLF 警告，无 diff 格式错误

## 说明

- 本任务严格限定在共享契约、`MyselfApi`、preload、Main 侧设置存储/IPC 与测试支撑，没有改动 Renderer 布局或拖拽保存逻辑。
