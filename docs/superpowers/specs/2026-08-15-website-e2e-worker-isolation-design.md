# 网站 E2E Worker 隔离设计

**日期：** 2026-08-15

**状态：** 已证伪并退役

**退役说明：** 精确两用例在两个 worker 下 2/2 通过，但完整 45 项运行仍出现至少四项 60 秒超时；该方案不能作为正式网站发布门。替代设计见 `2026-08-15-website-e2e-browser-process-isolation-design.md`。

**适用范围：** `tests/playwright.website.config.ts`、网站 E2E 验证及阶段 0 网站链门禁

**不适用范围：** 桌面端、Electron E2E、Agent、文件工具、角色运行时及其验证配置

## 1. 背景与现状证据

阶段 0 的 `verify:web-chain` 已完成前 19 个步骤，最后的 45 项网站 Playwright E2E 在单 worker 模式中出现稳定的跨测试污染：

- `介绍章节桌面悬停与键盘聚焦同步玻璃交互` 单独运行时通过；
- `管理员写操作校验版本、理由和幂等键并拒绝错误 Bearer` 后接该用例时 2/2 通过；
- `安全共享包经系统与管理员审核后才在真实网页公开` 后接该用例时，前者约 3.6 秒通过，后者稳定耗尽 60 秒并失败；
- 关闭 Playwright trace、在组件 cleanup 主动释放 WebGL context、增加 `pagehide` 释放均不能消除失败，相关试验代码已全部撤回；
- `fullyParallel` 保持 `workers: 1` 时仍失败；
- 同一精确用例对使用 `fullyParallel` 与 `workers: 2` 时，由两个隔离 worker 执行，2/2 在 5.4 秒内通过。

失败 trace 证明页面 HTML 已完成加载，但 Chromium 在复用同一 worker 的 WebGL 运行期后出现 GPU stall，Playwright 对已存在 DOM 的读取也被阻塞。现有 E2E 把 worker 级浏览器、随机端口静态服务器和内存 API 生命周期绑定在一起，因此单 worker 顺序执行会把前序 GPU/页面运行期状态带入后续用例。

## 2. 目标

1. 让每个网站 E2E 用例获得独立的 Playwright worker 生命周期，消除跨测试浏览器、GPU、静态服务器和内存 API 状态污染。
2. 最多同时运行两个网站 worker，避免 45 项测试无界并行占用 CPU、GPU 和端口。
3. 保持每项测试的业务断言、失败超时、重试次数和测试专用随机端口协议不变。
4. 使完整 `verify:web-chain` 能以一次可复现命令得到明确退出码和完整 Playwright 汇总。

## 3. 非目标

- 不修改网站产品组件来掩盖测试运行期污染。
- 不改变匿名投稿、审核、共享资源或反馈业务行为。
- 不修改桌面 Playwright 配置或运行任何桌宠验证目标。
- 不通过提高单测超时、增加重试或从完整门删除 E2E 来隐藏失败。
- 不在本阶段增加依赖、拆分测试文件或重写 E2E 夹具。

## 4. 方案比较与决策

### 方案 A：Playwright 用例级隔离，最多两个 worker（采用）

在网站专属配置中设置 `fullyParallel: true`、`workers: 2`，保留 `retries: 0`。Playwright 将同一文件中的用例拆为独立并行组；最多两个 worker 同时运行，每个组使用现有 worker-scoped fixture 启动自己的随机端口静态服务器和内存 API。

优点是只改变测试调度，不改变业务代码或 runner；精确失败对已有 2/2 通过证据。代价是服务器会按用例隔离启动，日志顺序不再等同源码顺序，机器同时承受两个 Chromium worker。

### 方案 B：根 runner 分批启动多个串行 Playwright 子进程（不采用）

该方案能定期重启浏览器，但需要维护测试分组、聚合退出码和多套日志，验证入口会承担本应由 Playwright 调度器负责的职责。

### 方案 C：完整门暂时排除网站 E2E（拒绝）

该方案会让重新上线正式网站前缺少真实页面交互证据，与阶段 0 建立可信网站链门的目标冲突。

## 5. 执行模型与隔离边界

```text
verify:web-chain
  -> website-e2e
     -> Playwright 调度器（最多 2 个 worker）
        -> 用例 A worker -> 随机端口服务器 A -> 独立内存 API A
        -> 用例 B worker -> 随机端口服务器 B -> 独立内存 API B
```

- 每个服务器继续通过 `PORT=0` 获取随机回环端口，并使用独立 `WEBSITE_TEST_RUN_ID` 校验来源。
- `beforeEach` 的 `/__e2e/reset` 继续保留，作为单个 worker 内的防御性清理；它不再承担跨用例 GPU 或浏览器状态隔离。
- 现有人工截图文件名均按场景唯一命名，没有两个用例写同一路径；Playwright 失败产物继续写入各自用例目录。
- 任一 worker 用例失败仍使 Playwright 返回非零，`verify-web-chain.mjs` 保留该退出码并停止后续步骤。

## 6. 失败处理与资源控制

- 保持每项 `timeout: 60_000`、`expect.timeout: 10_000` 和 `retries: 0`，禁止用放宽时间预算替代隔离。
- 固定 `workers: 2`，不根据 CPU 自动扩大并行度，避免开发机与 CI 行为漂移。
- worker fixture 的现有 `finally` 继续精确终止自身静态服务器进程树；随机端口避免两个 worker 争用监听地址。
- 如果完整 45 项仍出现资源竞争，停止继续提高 worker 数；回到失败用例对和 worker 生命周期证据，另立规格，不在本变更中叠加重试或产品降级。

## 7. 实施范围

预计只修改：

- `tests/playwright.website.config.ts`：启用用例级完全并行，固定两个 worker，并同步中文结构性注释；
- 网站 E2E 配置契约测试或验证脚本：断言上述隔离值，防止后续退回共享单 worker；
- 阶段 0 计划、实施报告和验收记录：记录新增决策及实际命令结果。

不得修改 `tests/playwright.config.ts`、`tests/e2e/desktop.spec.ts` 或任何桌宠业务文件。

## 8. TDD 与验收

### RED

先增加配置契约测试，精确断言网站配置为 `fullyParallel: true`、`workers: 2`、`retries: 0`；当前配置应因 `fullyParallel: false`、`workers: 1` 失败。

保留已稳定复现的顺序失败对作为运行期 RED 证据，不把 60 秒超时改写为产品断言。

### GREEN

1. 配置契约测试通过。
2. 精确失败对在正式配置下 2/2 通过，不通过 CLI 临时覆盖 worker 参数。
3. 45 项网站 E2E 一次运行全部通过并输出完整汇总。
4. `pnpm.cmd verify:web-chain` 一次运行 20/20 步通过。
5. `git diff --check`、网站范围守卫和测试归属守卫通过。

### 人工边界

本变更只证明自动化 E2E 隔离和网站链门可复现，不替代正式网站重新部署后的浏览器人工验收，也不声明生产环境已经上线。

## 9. 替代关系

本规格只补充 `2026-08-15-website-architecture-optimization-and-production-relaunch-design.md` 的阶段 0 网站 E2E 执行边界，并在该范围内替代 `2026-08-15-website-verification-foundation.md` 中默认单 worker 顺序执行网站 E2E 的隐含假设。其他网站架构、CloudBase 顺序和桌宠硬边界保持不变。
