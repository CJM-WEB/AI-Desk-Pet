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

## Fix round 1/5：日志证据生命周期边界

- 修复实现提交：`ef877ff test: 修复日志证据生命周期边界`
- 报告提交：见最终交付。
- 本轮仍只修改 `tests/fixtures/electron-app.ts` 与 `tests/e2e/desktop.spec.ts`；没有修改生产 preload、Main、网站或受控生产变异文件。

### Finding 1：cleanup 异常后的 tracker 封闭

> Electron cleanup 抛错时 tracker.dispose 在 throw 之后未执行，第一次失败与第二次 dispose 间迟到日志仍改变证据。补异常清理间隙写日志 RED；确保首次 dispose 调用即在 finally 封闭 tracker/清尾，即使资源清理错误仍抛出。

- 根因：夹具仅在 `cleanupErrors` 检查并抛错之后调用 tracker.dispose；首次清理失败会提前离开 dispose，证据流仍保持开放。
- RED：`node_modules\.bin\playwright.cmd test --config tests/playwright.config.ts tests/e2e/desktop.spec.ts -g "首次 dispose 进程清理失败后保留资源"`
  - 结果：退出码 1，1 个测试失败，总耗时约 1.8 秒。
  - 布尔证据：第一次 dispose 拒绝后、第二次重试前写入迟到日志，`sentinels[0]` 从 `false` 变为 `true`。
- GREEN：同一命令。
  - 结果：退出码 0，1/1 通过，总耗时 1.7 秒。
- 最小修复：用 `try/finally` 包围完整 dispose 清理体；首次调用无论成功或抛出资源清理错误，finally 都封闭 tracker 并清流状态。夹具资源的 `disposed` 仅在清理成功后置位，因此第二次 dispose 仍可重试进程和目录清理。

### Finding 2：restart 流 epoch 隔离

> restart 复用旧 stdout/stderr 尾部，旧进程尾+新进程首块可拼哨兵。布尔累计应跨 restart 保留，但每次 launch 前必须开启新流 epoch 清尾/解码状态。为 tracker 增加测试夹具级 `resetStreams(): void`（或等价明确方法），在 launch 边界调用；补 RED。

- 根因：tracker 的累计布尔和流尾部共用同一生命周期；restart 创建新进程时没有清除旧进程的 stdout/stderr 尾部。
- 测试接线更正：首次运行因变量被误插入相邻测试而出现 `ReferenceError`，不计有效 RED；修正测试位置后重新运行。
- RED：`node_modules\.bin\playwright.cmd test --config tests/playwright.config.ts tests/e2e/desktop.spec.ts -g "重启时复用隔离目录"`
  - 结果：退出码 1，1 个测试失败，总耗时约 1.7 秒。
  - 布尔证据：已在旧 epoch 完整命中的第一项保持 `true`，但跨旧/新进程拼接的第二项也误命中，实际 `[true,true]`，预期 `[true,false]`。
- GREEN：`node_modules\.bin\playwright.cmd test --config tests/playwright.config.ts tests/e2e/desktop.spec.ts -g "首次 dispose 进程清理失败后保留资源|重启时复用隔离目录"`
  - 结果：退出码 0，2/2 通过，总耗时 909 毫秒。
- 最小修复：为 `CapturedLogEvidenceTracker` 增加 `resetStreams(): void`，只清 stdout/stderr 的流尾和解码状态，不清累计布尔；每次 `launch` 的第一步开启新流 epoch。

### Finding 3：Buffer 的 UTF-8 增量解码

> Buffer UTF-8 字节中间拆分会产生 replacement char 假阴性。每个流使用 Node `StringDecoder('utf8')`，保持 stdout/stderr 独立；reset/dispose 同时重置 decoder；补中文哨兵、授权根或 API key 按字节中间拆分 RED。

- 根因：每个 Buffer 块独立执行 `String(chunk)`；多字节字符在字节中间拆分时，两块都会生成替换字符，后续字符串尾部无法恢复原字符。
- RED：`node_modules\.bin\playwright.cmd test --config tests/playwright.config.ts tests/e2e/desktop.spec.ts -g "UTF-8 多字节中间拆分 Buffer"`
  - 结果：退出码 1，1 个测试失败，总耗时约 1.7 秒。
  - 布尔证据：按字节中间拆分后，中文 API key、授权根和哨兵三项实际均为 `false`，预期均为 `true`。
- GREEN：`node_modules\.bin\playwright.cmd test --config tests/playwright.config.ts tests/e2e/desktop.spec.ts -g "UTF-8 多字节中间拆分 Buffer|重启时复用隔离目录"`
  - 结果：退出码 0，2/2 通过，总耗时 924 毫秒。
- decoder reset 变异 RED：临时移除 reset 中两流 decoder 的重建后，重新运行 UTF-8 测试；退出码 1，跨 reset 的第 4 项由预期 `false` 误变为 `true`，总耗时约 1.7 秒。
- decoder reset 恢复 GREEN：恢复两流 decoder 重建后，同一测试退出码 0，1/1 通过，总耗时 908 毫秒。
- 最小修复：stdout 与 stderr 各持有一个 `StringDecoder('utf8')`；Buffer 走增量 `write`，字符串块先结束当前 decoder；resetStreams 与 dispose 同时丢弃两流尾部和未完成字节。

### Finding 4：构造输入快照

> 构造后调用方突变 input/sentinels 会改变槽位和尾长。构造时复制 apiKey、root、`[...sentinels]`；补替换/追加外部数组后快照长度和原目标不变 RED。

- 根因：tracker 的 capture 闭包继续读取调用方传入的 input 和 sentinels 数组；构造后替换字段或修改数组会改变匹配目标及布尔槽位数量。
- RED：`node_modules\.bin\playwright.cmd test --config tests/playwright.config.ts tests/e2e/desktop.spec.ts -g "构造后不受输入对象与外部哨兵数组突变影响"`
  - 结果：退出码 1，1 个测试失败，总耗时约 1.8 秒。
  - 布尔证据：原 API key 与授权根均未命中，外部数组追加还把快照槽位扩为 `[false,false]`；预期固定为原配置的一项 `[true]`。
- GREEN：`node_modules\.bin\playwright.cmd test --config tests/playwright.config.ts tests/e2e/desktop.spec.ts -g "首次 dispose 进程清理失败后保留资源|重启时复用隔离目录|UTF-8 多字节中间拆分 Buffer|构造后不受输入对象与外部哨兵数组突变影响"`
  - 结果：退出码 0，4/4 通过，总耗时 914 毫秒。
- 最小修复：构造期复制 apiKey、授权根和 `[...sentinels]`；空值校验、尾长、槽位初始化和后续 capture 全部只使用内部配置快照。

### Fix round 1 最终验证

- 受影响边界：`node_modules\.bin\playwright.cmd test --config tests/playwright.config.ts tests/e2e/desktop.spec.ts -g "原始日志证据|首次 dispose 进程清理失败后保留资源|重启时复用隔离目录"`
  - 结果：退出码 0，6/6 通过，总耗时 1.1 秒。
- 命名 Electron 场景：`node_modules\.bin\playwright.cmd test --config tests/playwright.config.ts tests/e2e/desktop.spec.ts -g "测试夹具直接 spawn 后连接 CDP|默认聊天与设置浮层提示"`
  - 结果：退出码 0，2/2 通过，总耗时 12.7 秒。
- `pnpm.cmd test:integration`
  - 结果：退出码 0，4/4 测试文件、33/33 测试通过，Vitest 报告耗时 4.81 秒。
- `git diff --name-only -- apps/desktop/src/preload apps/website`
  - 结果：退出码 0、无输出。
- `git diff --check`
  - 结果：退出码 0。

### 自审更正

初版报告“自审确认 dispose 后无副作用、两流尾部不拼接”的结论覆盖过强：它只验证了成功 dispose 后的字符串块和同一进程内的 stdout/stderr 隔离，没有覆盖 cleanup 抛错间隙、restart 流 epoch、UTF-8 半码及调用方突变。Fix round 1 用四个独立 RED 补齐这些边界，并用 decoder-reset 变异证明 reset 不仅清字符串尾部，也清未完成字节。修复后公开快照仍只含冻结布尔对象/数组，命中累计仍不可逆，完整原始日志历史仍未进入 tracker 状态。

## Fix round 2/5：dispose 后重启门与旧 listener 隔离

- 修复实现提交：`086045c test: 修复日志证据重启隔离`
- 报告提交：见最终交付。
- 本轮只修改 `tests/fixtures/electron-app.ts` 与 `tests/e2e/desktop.spec.ts`；未修改生产 preload、Main 或网站。
- 按 `receiving-code-review` 对照当前代码核验后，两项 Important 均成立：资源 `disposed` 与证据 tracker 的 sealed 状态不同步；旧 child 的匿名 data listener 在 restart 后仍可调用共享 capture。

### Finding 1：失败 dispose 后禁止 restart

> 首次 dispose 清理失败后 tracker 已永久关闭但 fixture.disposed 仍 false，restart 可启动而 capture 永久静默；补 RED，修为失败 dispose 后不得 restart（或等价保持证据可靠且不破坏二次 dispose 资源清理）。

- 根因：fix round 1 在 dispose 的 finally 中永久封闭 tracker，但 `restart()` 只检查资源是否已完全 `disposed`。首次清理失败时资源标志仍为 `false`，所以 restart 会启动新进程，而 tracker.capture 永久无副作用。
- RED：`node_modules\.bin\playwright.cmd test --config tests/playwright.config.ts tests/e2e/desktop.spec.ts -g "首次 dispose 进程清理失败后保留资源"`
  - 结果：退出码 1，1 个测试失败，总耗时约 1.7 秒。
  - 稳定证据：首次 dispose 拒绝后，`restart()` 实际正常 resolve，预期稳定拒绝 `ELECTRON_FIXTURE_DISPOSED`。
- GREEN：同一命令。
  - 结果：退出码 0，1/1 通过，总耗时 887 毫秒。
- 最小修复：新增独立 `disposeStarted` 生命周期门。首次 dispose 调用立即置位；restart 只要观察到该门就稳定拒绝。dispose 本身仍以资源 `disposed` 判断，因此首次清理失败后的第二次 dispose 仍可重试并完成进程、目录回收。

### Finding 2：旧 child data listener 不得进入新 epoch

> restart 只 resetStreams，旧 child 匿名 data listener/迟到块仍可进入新 epoch；补旧进程在 reset 后迟到发块的 RED，以 epoch token 或解绑 listener 做最小隔离，确保同一 epoch 跨块仍工作。

- 根因：每次 launch 都在 child stdout/stderr 注册匿名 listener，cleanup 没有解绑。resetStreams 只清 tracker 状态；旧 child 在新 launch 后迟到发块仍通过共享 capture 写入新 epoch。
- RED：`node_modules\.bin\playwright.cmd test --config tests/playwright.config.ts tests/e2e/desktop.spec.ts -g "重启时复用隔离目录"`
  - 结果：退出码 1，1 个测试失败，总耗时约 1.7 秒。
  - 布尔证据：旧 child 在 reset 后发送前半、新 child 发送后半，实际快照 `[true,true,true]`，预期 `[true,false,true]`；第三项同时证明新 child 在同一 epoch 的两块仍可正常拼接命中。
- GREEN：`node_modules\.bin\playwright.cmd test --config tests/playwright.config.ts tests/e2e/desktop.spec.ts -g "首次 dispose 进程清理失败后保留资源|重启时复用隔离目录"`
  - 结果：退出码 0，2/2 通过，总耗时 971 毫秒。
- 最小修复：每次 launch 递增 `logStreamEpoch`，stdout/stderr listener 捕获其创建时 epoch；只有与当前 epoch 相等才调用共享 capture。旧 listener 在进入证据跟踪器和诊断缓存之前被丢弃，新 child 的同 epoch 跨块行为保持不变。

### Fix round 2 最终验证

- 受影响边界：`node_modules\.bin\playwright.cmd test --config tests/playwright.config.ts tests/e2e/desktop.spec.ts -g "原始日志证据|首次 dispose 进程清理失败后保留资源|重启时复用隔离目录"`
  - 结果：退出码 0，6/6 通过，总耗时 943 毫秒。
- 命名 Electron 场景首次合并运行：直接夹具通过，真实 Provider 场景因设置页在点击期间关闭而失败；失败点不经过本轮夹具生命周期差异。按系统化调试窄化运行真实 Provider 场景，1/1 通过，未修改场景、未增加超时或 sleep。
- 命名 Electron 场景最终新鲜合并运行：`node_modules\.bin\playwright.cmd test --config tests/playwright.config.ts tests/e2e/desktop.spec.ts -g "测试夹具直接 spawn 后连接 CDP|默认聊天与设置浮层提示"`
  - 结果：退出码 0，2/2 通过，总耗时 11.8 秒。
- `pnpm.cmd test:integration`
  - 结果：退出码 0，4/4 测试文件、33/33 测试通过，Vitest 报告耗时 4.81 秒。
- `git diff --name-only -- apps/desktop/src/preload apps/website`
  - 结果：退出码 0、无输出。
- `git diff --check`
  - 结果：退出码 0。
- 静态差异仅为 `tests/fixtures/electron-app.ts` 与 `tests/e2e/desktop.spec.ts`；公开证据快照结构、冻结布尔语义、脱敏缓存上限和生产代码均未改变。
