# 网站 E2E 独立 CLI 进程隔离设计

**日期：** 2026-08-15

**修订：** 2026-08-20，加入“能不加就不加，能减则减”的严格替换门禁，并批准修正一个被截图阻塞污染的既有 E2E 用例。

**状态：** 已获用户书面批准

**适用范围：** 官网 Playwright E2E 调度、网站验证链、相关范围治理与验收记录

**不适用范围：** 网站产品运行时代码、桌面端、Electron E2E、Agent、文件工具、角色运行时、生产部署与远端数据

**替代关系：** 本规格替代 `2026-08-15-website-e2e-browser-process-isolation-design.md`；更早的双 worker 规格继续保持退役。

## 1. 背景与现状证据

阶段 0 网站链需要在 Windows 环境稳定运行 45 项官网 Playwright E2E。以下隔离层已经实际证伪：

1. 单 worker 复用浏览器：前序 WebGL 页面会使后续页面测试出现约 60 秒 GPU stall。
2. React 卸载、`pagehide` 与 `WEBGL_lose_context` 清理：锁定组合仍超时，试验实现已撤回。
3. 双 worker：锁定组合可通过，但完整 45 项仍出现多个约 60 秒失败，方案已撤回。
4. 每个请求 `page` 的测试独占 Chromium fixture：锁定组合 2/2 通过，但完整 E2E 在 15.6 分钟止损时为 `20 passed / 10 failed / 1 interrupted / 14 did not run`。失败继续集中在 WebGL、章节交互与视口页面测试，证明只隔离浏览器进程仍不足以形成稳定门禁。

最后一次失败运行没有遗留命令行指向当前工作区的 Node、Playwright 或 Chromium 进程。`verify:web:full` 因完整 E2E 已失败而没有运行，不得把 Phase 0 Task 4 记为完成。

## 2. 目标

1. 网站只构建一次，随后把全部 45 项测试逐项放入独立 Playwright CLI 进程。
2. 每项测试独占 Playwright driver、worker、随机端口静态服务器、BrowserContext、浏览器与 GPU 子进程。
3. 测试发现自动跟随 Playwright 当前清单，不维护人工标题数组、源码行号数组或固定测试数量。
4. 保持现有业务断言、串行语义、单 worker、零重试、60 秒测试超时、10 秒断言超时与失败 trace。
5. 一个测试失败后继续收集后续结果；总结果必须准确报告通过、失败、中断和未运行数量，并返回非零退出码。
6. 全部验证通过后删除已证伪且无人使用的自定义浏览器 fixture 路径，只保留一条正式 E2E 调度链。
7. 每次新增必须同时证明无法复用既有实现，并清除被替代的旧入口、旧实现与专用测试；不得以兼容、备用或历史原因保留第二条可运行路径。

## 3. 非目标

- 不修改网站组件、动画、WebGL 或业务 API 来迎合测试环境。
- 不提高 worker 数、重试次数或 Playwright 测试超时。
- 不拆分或重写 `tests/e2e/website.spec.ts` 中的业务测试。
- 不新增第三方依赖或第二套测试框架。
- 不修改桌面 E2E、桌宠业务代码或共享桌面契约。
- 不在本阶段执行正式网站部署，也不声明生产网站已经上线。

## 3.1 严格减法原则

本规格采用以下顺序裁决任何实现选择：

1. 能不加就不加：仅为解决已证明的缺陷、满足安全边界或形成可执行验收证据时允许新增。
2. 能复用就不新建：仓库已有入口、helper、状态机或协议能表达需求时，不新增同职责封装。
3. 能替换就不并存：新路径通过验收后，同一职责的旧入口、旧实现、别名与只服务旧实现的测试必须在同一计划内删除。
4. 能减则减：修改既有文件时优先用替换、合并和删除完成目标，不为局部方便增加永久兼容分支。
5. 不按净代码行数机械裁决：安全检查、失败清理与直接覆盖风险的测试不得为追求行数而删除；完成标准是正式路径唯一、运行引用无孤儿、重复职责为零。

本次修订后的 Tasks 3—4 报告必须包含“减法账本”：新增或扩展内容、复用内容、删除内容、删除后的引用扫描，以及仍保留内容的必要性。没有可删项时也必须给出只读引用证据，不能省略该栏目。

## 4. 方案比较与决策

### 4.1 采用：`--list`、`--test-list` 与逐项 CLI

Playwright 1.61.1 已提供 `--list` 和 `--test-list <file>`。`--list` 输出的测试描述可直接作为 `--test-list` 输入，Playwright 自身负责按文件和完整标题路径匹配测试。

编排器先获取完整测试清单，再为每一项写入单项 test-list，顺序启动一个 Playwright CLI 子进程。该方式不依赖标题正则转义、不依赖当前源码行号，也不会因新增或删除测试而要求维护固定分片。

### 4.2 拒绝：逐项 `--grep`

测试标题包含中文、数字、斜杠和其他正则字符。`--grep` 需要自行转义，重复标题还可能多选，不能作为正式选择协议。

### 4.3 拒绝：拆分 spec 文件

把约 2500 行现有测试拆成几十个文件会制造大规模重构和共享 helper 迁移，不能证明比官方 test-list 更稳定，也违反最小修改原则。

### 4.4 拒绝：在同一 Node 进程调用 Playwright 内部 API

本方案的目的正是隔离 Playwright driver 与 worker 进程。复用同一编排进程中的内部 runner API 会重新引入共享状态，并依赖非公开接口。

## 5. 组件边界

### 5.1 根脚本

`test:e2e:website` 保持唯一正式入口，执行顺序为：

```text
pnpm build:website:e2e
  -> node tools/verification/run-website-e2e-process-isolation.mjs
```

构建失败时不得启动测试。编排器本身不重复构建，也不部署网站。

当前 `package.json` 同时存在 Phase 0 Task 4 的未提交验证脚本增量。实施时必须保留这些增量，并对 `test:e2e:website` 的独立 hunk 做精确暂存；不得用整文件暂存把两个计划混入同一提交。

### 5.2 编排器

新增 `tools/verification/run-website-e2e-process-isolation.mjs`，只承担：

1. 解析 Playwright 测试清单；
2. 为当前项写入官方 test-list；
3. 组装并启动独立 CLI 子进程；
4. 限时终止自己持有 PID 的当前子进程树；
5. 汇总状态并设置最终退出码。

它不得实现业务数据清理、浏览器 fixture、WebGL 清理、重试或测试断言。

建议稳定导出以下可测试边界，精确签名由实施计划在读取现有模块风格后锁定：

- 清单解析：标准输出字符串到只读测试描述数组；
- 单项命令构造：测试描述、序号和路径到命令参数；
- 顺序执行：依赖注入的子进程执行器与时钟到汇总结果；
- Windows 精确进程树终止：只接收当前子进程 PID。

不得导出只为测试存在的生产清理接口。

### 5.3 Playwright 配置与测试文件

`tests/playwright.website.config.ts` 继续保持：

```typescript
fullyParallel: false,
workers: 1,
retries: 0,
timeout: 60_000,
expect: { timeout: 10_000 }
```

`website.spec.ts` 除第 10.3 节批准的单一时序修正外保持现有正式内容。每个 CLI 只选择一项测试，因此现有 worker-scoped `websiteServerInfo`、`request`、`page` 和 `browser` 都天然只服务这一项测试，不需要自定义 fixture。

## 6. 数据流

```text
根 test:e2e:website
  -> 静态构建一次
  -> Playwright --list
  -> 校验并得到 N 项测试描述
  -> 对 i = 1..N 串行执行
       -> 临时文件只写第 i 项描述
       -> 独立 Playwright CLI --test-list <临时文件>
       -> 独立 worker + 随机端口服务器 + 浏览器/API 请求
       -> 独立产物目录
       -> 记录 passed / failed / interrupted
  -> 汇总 N 项；未启动项记为 not run
  -> 全部通过返回 0，否则返回 1
```

全部 45 项都使用该路径，包括 API-only 和不请求浏览器的 helper 测试。这样不会在两种调度模型间保留共享 Playwright driver 或服务器状态。

## 7. 清单与选择契约

1. 列表命令使用当前 `process.execPath` 调用仓库已安装的 `@playwright/test/cli.js`，显式传入网站配置和 `--list`。
2. 列表阶段关闭颜色输出，避免 ANSI 转义污染描述。
3. 只接受 Playwright 标准 `file:line:column › title path` 描述；忽略标题行与 `Total` 汇总行。
4. 空清单、无法解析的非空测试行、重复完整描述或列表命令非零退出都必须立即失败，不得使用 `--pass-with-no-tests`。
5. 单项 test-list 写入系统临时目录中的一个复用文件；每次启动子进程前覆盖为当前完整描述。
6. 选择使用 `--test-list`，不同时叠加 `--grep`、源码文件过滤或 shard。

## 8. 产物、日志与汇总

### 8.1 独立产物目录

每项 CLI 显式使用独立稳定目录：

```text
tests/.playwright-output/website-process-isolation/001/
tests/.playwright-output/website-process-isolation/002/
...
```

当前子进程只清理自己的序号目录，不删除整个产物根。测试删除或数量减少后可能留下旧的高序号目录；本轮汇总只引用实际运行序号，不把旧目录当作本轮证据。

### 8.2 日志

单项子进程的 stdout 与 stderr 实时转发，不缓存到无限内存。每项开始前输出序号和测试描述，结束后输出状态、耗时与产物目录。

### 8.3 最终汇总

最终必须输出：

- discovered；
- passed；
- failed；
- interrupted；
- not run；
- 总耗时；
- 每个失败或中断项的测试描述与产物目录。

只有 `passed === discovered` 且其余三类均为 0 时退出 0。

## 9. 超时与进程清理

1. Playwright 内部单测试超时继续为 60 秒。
2. 单个 CLI 子进程墙钟上限为 90 秒，覆盖进程启动、测试、报告和正常清理，但不改变 Playwright 断言语义。
3. 整轮编排墙钟上限为 15 分钟。启动每项前计算剩余预算；当前项上限取 90 秒与剩余预算的较小值。
4. 达到单项或整轮上限时，当前项记为 interrupted，剩余项记为 not run，最终退出 1。
5. Windows 只允许根据编排器刚启动并持有的 PID 终止该子进程树；不得扫描后批量终止所有 Node、Chrome 或 Playwright 进程。
6. 终止后必须等待子进程退出并记录退出/信号结果；清理失败本身也是明确失败，不能伪装为测试超时。
7. 临时 test-list 在 `finally` 中清理。它只包含一个短文本文件，不进行大量文件删除。

## 10. TDD 与自动化验收

### 10.1 单元 RED/GREEN

新增 `tools/verification/run-website-e2e-process-isolation.test.mjs`，至少覆盖：

1. 从真实形态的 `--list` 文本解析多项中文测试描述；
2. 拒绝空清单、重复描述和畸形测试行；
3. 每项命令只包含一个 test-list、相同网站配置和独立输出目录；
4. 全部 45 项严格串行，前一子进程结束后才启动下一项；
5. 单项失败后继续，最终汇总失败并退出 1；
6. 单项或全局超时只终止当前持有 PID 的子进程树，并正确计算 interrupted/not run；
7. 全部通过时汇总一致并退出 0。

测试使用可控 fake 子进程执行器和时钟验证编排器自身行为，不启动真实浏览器，也不只断言 mock 存在。

### 10.2 集成验收

1. 列表模式发现当前 45 项且不运行测试。
2. 用两个独立 CLI 进程分别执行先前稳定复现污染的“安全共享包……”和“介绍章节……”测试，两项均退出 0。
3. 正式 `pnpm.cmd test:e2e:website` 一次运行发现并完成 45 项，得到 `45 passed / 0 failed / 0 interrupted / 0 not run`，总时长小于 15 分钟。
4. 运行后没有命令行指向当前工作区的遗留 Node、Playwright、Chromium 或静态服务器进程。
5. `pnpm.cmd verify:web:full` 完成 20/20 步且网站 E2E 汇总仍为 45/45。
6. 全部 verification Node 测试、网站 typecheck、网站范围守卫、测试归属和 `git diff --check` 通过。

若逐项 CLI 仍出现同类 GPU stall，立即停止隔离层修改；不得再增加分批、重试、超时或产品清理。后续必须以 trace、系统 GPU 进程与单项重复运行证据重新判断是否属于页面或 Windows 图形栈问题。

### 10.3 截图阻塞污染的测试修正

真实逐项运行发现 `逐章节交接且快速输入不能跳过相邻章节` 可在独立 CLI 中稳定失败。诊断证据如下：

1. 原用例单独运行两次均在第二次滚轮后停留 `home`。
2. 第二次 `wheel(deltaY=5000)` 已到达页面，窗口仍为 focused/visible，但进度约为 `0.0002`，证明输入进入控制器后被锁定分支丢弃。
3. 仅移动鼠标或等待 `950ms` 均失败；移除截图或在截图后等待覆盖回吸动画与锁定期的 `1400ms` 均通过。
4. 根因是 Playwright 截图阻塞首轮回吸的 RAF；截图返回后仍需完成约 `380ms` 回吸，再进入 `800ms` 锁定。该失败不是产品行为回归，也不是 CLI 进程隔离失败。

批准的最小修正只修改该用例：保留交接帧断言和截图，把截图后原有的四行 `data-active-chapter="home"` 断言替换为既有 `enterInteractive(page)`。该 helper 重新加载同一固定 seed 并等待交互阶段，使后续“大输入最多进入相邻章节”从干净页面验证。不得新增 sleep、helper、fixture、重试、产品分支或新测试项；替换后该处净减少三行。

## 11. 迁移与删除

1. 先用 TDD 实现编排器并直接调用它完成定向与完整 E2E。
2. 完整 E2E 通过后，更新根 `test:e2e:website` 指向编排器。
3. 正式入口复验通过后删除已证伪且不再引用的：
   - `tests/website-isolated-browser-fixture.ts`；
   - `tools/verification/website-isolated-browser-fixture.test.mjs`。
4. 保留对应提交和退役规格作为历史证据，不重写 Git 历史。
5. 更新网站范围守卫，精确允许新规格、计划、编排器和相关网站测试；同时补齐两个已提交退役 worker 文档与当前退役 browser-process 文档，不允许任何桌宠路径。
6. 完整门通过后，把 Phase 0 Task 4 回交原 foundation 计划所有者更新报告并提交 runner；当前计划不读写其 SDD 工作区。
7. 删除前后都运行引用扫描；删除后运行代码中不得再出现 `website-isolated-browser-fixture`、`useIsolatedBrowser` 或 `useIsolatedPage`。历史退役文档可以描述这些名称，但不能提供仍可执行的入口。
8. 本阶段不新增“临时兼容”脚本或第二个根命令；`test:e2e:website` 切换后旧批量 Playwright 命令必须从 `package.json` 正式入口消失。
9. `WEBSITE_E2E_OUTPUT_ROOT` 只在编排器内部消费，不属于外部契约；Task 3 将其从导出常量收回为模块私有常量，不保留无人使用的公开接口。

## 12. 文件边界

预计新增：

- `tools/verification/run-website-e2e-process-isolation.mjs`；
- `tools/verification/run-website-e2e-process-isolation.test.mjs`；
- 对应实施计划。

预计修改：

- `package.json` 的 `test:e2e:website` 独立 hunk；
- `tests/e2e/website.spec.ts` 中一个截图后状态重置点，复用既有 `enterInteractive(page)` 且净减少三行；
- `tools/verification/website-scope-policy.mjs` 及其测试；
- 当前与已退役的网站 E2E 隔离规格、计划；
- `docs/superpowers/plans/2026-08-15-website-verification-foundation.md` 的实际状态说明。

验证通过后删除两个失败 fixture 文件。除第 10.3 节批准的单一替换外，`tests/e2e/website.spec.ts` 不修改；`tests/playwright.website.config.ts` 始终不修改。任何其他测试或配置变化必须先修订并重新批准本规格。

始终禁止修改：

- `apps/desktop/**`；
- `tests/e2e/desktop.spec.ts`、`tests/e2e/agent-mcp-flow.spec.ts`、`tests/playwright.config.ts`；
- `packages/agent-core/**`、`packages/file-tools/**`、`packages/character-runtime/**`、`packages/character-assets/**`。

## 13. 文档、部署与人工边界

- 双 worker 与测试级独立 Chromium fixture 文档保留，但状态必须明确为已证伪并退役。
- 验收记录只写实际命令、环境、计数、退出码和未覆盖项。
- 本规格解决本地自动化门，不替代生产环境浏览器验收。
- 正式网站重新部署、域名/CDN、CloudBase 生产数据和上线后人工验收继续作为后续独立阶段。
