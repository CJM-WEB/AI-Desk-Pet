# Task 2 实施报告：在原始日志采集时不可逆累计泄漏证据

## 交付结果

- 实现提交：`6cca547 test: 累计原始日志泄漏证据`
- 报告提交：见最终交付。
- 修改实现文件：`tests/fixtures/electron-app.ts`
- 修改验收文件：`tests/e2e/desktop.spec.ts`
- 未新增生产 preload 或 Main 测试探针；未修改、构建、启动或验证网站。
- 实施时未成功定位或读取任务要求的 `CONTEXT.md`；主控随后已确认该文件存在。

## 垂直 TDD 证据

### Slice 1：截断与 100 条缓存淘汰

先扩展现有直接 spawn 夹具场景，让哨兵位于单块 4,000 字符截断点之后，再写入 101 个无敏感信息块。所有公开断言只比较布尔值。

- 无效命令：`pnpm.cmd exec playwright test --config tests/playwright.config.ts tests/e2e/desktop.spec.ts -g "测试夹具直接 spawn 后连接 CDP"`
  - 结果：退出码 1，当前环境无法解析 `playwright`；这不是有效 RED，未计入 TDD 证据。
- RED：`node_modules\.bin\playwright.cmd test --config tests/playwright.config.ts tests/e2e/desktop.spec.ts -g "测试夹具直接 spawn 后连接 CDP"`
  - 结果：退出码 1，1 个测试失败，耗时约 1.7 秒。
  - 布尔证据：`apiKey`、`authorizedRoot`、`authorizationHeader`、`sentinels[0]` 均为 `false`，预期均为 `true`。
- GREEN：同一命令。
  - 结果：退出码 0，1/1 通过，测试运行 339 毫秒，总耗时 838 毫秒。
  - 实现：夹具在诊断块截断和滚动淘汰前先调用证据跟踪器；命中只会从 `false` 变为 `true`。

### Slice 2/3：同流跨块、跨流隔离与 Authorization

- RED：`node_modules\.bin\playwright.cmd test --config tests/playwright.config.ts tests/e2e/desktop.spec.ts -g "原始日志证据仅在同一流跨块匹配"`
  - 结果：退出码 1，1 个测试失败，耗时约 1.6 秒。
  - 布尔证据：实际 `[false, false, true, false]`，预期 `[true, false, true, true]`；准确暴露同一 stdout 跨块未命中和 JSON Authorization 未识别，同时跨 stdout/stderr 未误命中。
- GREEN：`node_modules\.bin\playwright.cmd test --config tests/playwright.config.ts tests/e2e/desktop.spec.ts -g "原始日志证据仅在同一流跨块匹配|测试夹具直接 spawn 后连接 CDP"`
  - 结果：退出码 0，2/2 通过，总耗时 843 毫秒。
  - 实现：stdout 与 stderr 各自保留有界尾部；扫描“该流上一尾部 + 当前完整块”后再截尾。尾长严格采用规格给定的 `Math.max(64, apiKey.length - 1, authorizedRootDirectory.length - 1, ...sentinels.map(value => value.length - 1))`。

### Slice 3：空哨兵、冻结快照与 dispose

- RED：`node_modules\.bin\playwright.cmd test --config tests/playwright.config.ts tests/e2e/desktop.spec.ts -g "原始日志证据拒绝空哨兵"`
  - 结果：退出码 1，1 个测试失败，耗时约 1.8 秒。
  - 稳定证据：构造器没有抛出预期标签 `EMPTY_LOG_SENTINEL`。
- GREEN：`node_modules\.bin\playwright.cmd test --config tests/playwright.config.ts tests/e2e/desktop.spec.ts -g "原始日志证据拒绝空哨兵|跨 chunk 拆分的动态 key"`
  - 结果：退出码 0，2/2 通过，总耗时 993 毫秒。
  - 实现：空哨兵在构造期稳定拒绝；快照对象与 `sentinels` 数组均冻结且只暴露布尔；`dispose` 清空两流尾部，之后迟到 `capture` 不改变快照。
  - 脱敏回归：既有跨块 API key、授权根和 Authorization 的公开日志、错误消息与堆栈仍只暴露脱敏结果；断言失败面已改为布尔泄漏标志。

### Slice 4：受控生产泄漏变异

在 `apps/desktop/src/main/conversation/conversation-chat-adapter.ts` 的 Provider 文本回复边界临时输出回复，然后立即恢复；临时变异未进入提交。

- 变异构建：首次沙箱内构建被 esbuild 目录读取权限拒绝；按授权在沙箱外执行 `pnpm.cmd --filter @myself/desktop build`，退出码 0，约 7.2 秒。
- RED：`node_modules\.bin\playwright.cmd test --config tests/playwright.config.ts tests/e2e/desktop.spec.ts -g "默认聊天与设置浮层提示"`
  - 结果：退出码 1，1 个测试失败，场景耗时 16.5 秒，总耗时约 17.5 秒。
  - 布尔证据：`sentinels` 中 6 个索引由预期 `false` 变为实际 `true`；失败消息只含字段名、布尔值和数组索引，没有 Provider 正文。
- 恢复证明：删除临时输出后执行 `git diff --exit-code -- apps/desktop/src/main/conversation/conversation-chat-adapter.ts`，退出码 0。
- 清洁重建：`pnpm.cmd --filter @myself/desktop build`，退出码 0，约 6.7 秒。
- 恢复 GREEN：再次运行同一命名场景，退出码 0，1/1 通过，场景耗时 11.2 秒，总耗时 11.7 秒。

## 最终验证

- `node_modules\.bin\playwright.cmd test --config tests/playwright.config.ts tests/e2e/desktop.spec.ts -g "测试夹具直接 spawn 后连接 CDP|默认聊天与设置浮层提示"`
  - 结果：退出码 0，2/2 通过，总耗时 14.1 秒。
- `node_modules\.bin\playwright.cmd test --config tests/playwright.config.ts tests/e2e/desktop.spec.ts -g "捕获日志时清除|跨 chunk 拆分|原始日志证据"`
  - 结果：退出码 0，4/4 通过，总耗时 906 毫秒。
- `pnpm.cmd test:integration`
  - 首次沙箱内启动被 esbuild 权限拒绝；按授权在沙箱外重跑。
  - 结果：退出码 0，4/4 测试文件、33/33 测试通过，Vitest 报告耗时 4.82 秒。
- `git diff --name-only -- apps/desktop/src/preload apps/website`
  - 结果：退出码 0、无输出，生产 preload 与网站零差异。
- `git diff --exit-code -- apps/desktop/src/main/conversation/conversation-chat-adapter.ts`
  - 结果：退出码 0，受控生产变异已完全恢复。
- `git diff --check`
  - 结果：退出码 0。

## 正文零持久化与自审

- 新跟踪器没有新增完整原始日志历史：持久状态仅为四类布尔命中、冻结的布尔哨兵数组，以及 stdout/stderr 各自的有界尾部。
- 用户正文、Provider 回复、文件正文、API key、授权根和哨兵正文均未写入本报告；RED/GREEN 输出记录只保留稳定标签、布尔值、索引与计数。
- 夹具仍通过既有有界诊断缓存提供脱敏日志；证据更新严格发生在该缓存的单块截断、100 条淘汰和公开脱敏之前。
- 自审确认命中不可逆、两流尾部不拼接、空哨兵稳定拒绝、dispose 后无副作用、快照对象与数组冻结、公开快照无原始正文。
- 静态差异只包含 `tests/fixtures/electron-app.ts` 与 `tests/e2e/desktop.spec.ts`；无生产 preload、无网站、无永久生产变异。
- 各单点命令均未超过 10 分钟；最长单场景约 17.5 秒。
