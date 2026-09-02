# 网站业务链验证与人工验收记录

> 日期：2026-08-20
> 2026-08-20 当日状态：网站自动化完整门通过；人工视觉验收待用户确认
> 适用范围：网站业务链，不包含桌面端与正式部署
> 环境：Windows；Node.js `v24.18.0`；pnpm `11.9.0`

## 1. 自动化职责

网站自动化验证只保留可重复判定的业务与浏览器接缝：公开内容审核、匿名反馈、状态令牌清理、移动端关键布局、真实付款码资源、滚轮与触屏隔离、WebGL 缓冲区以及减少动态效果。

本轮使用以下现有入口验证，不新增截图脚本、隔离 runner、重试或超时：

| 验证项 | 命令 | 当前结果 |
| --- | --- | --- |
| 网站单元与组件测试 | `pnpm.cmd --filter @myself/website test` | 40 个文件、323/323 通过；总耗时 7.08 秒 |
| 网站类型检查 | `pnpm.cmd --filter @myself/website typecheck` | 通过；总耗时约 2.4 秒 |
| E2E 清单 | `node.exe node_modules/@playwright/test/cli.js test --config tests/playwright.website.config.ts --list` | 精确列出 16 项，与获批规格一致 |
| Task 4 前 6 项锁定门 | `pnpm.cmd exec playwright test --config tests/playwright.website.config.ts website.spec.ts:515 website.spec.ts:534 website.spec.ts:558 website.spec.ts:579 website.spec.ts:591 website.spec.ts:671` | 5/6；第 6 项连续进度断言失败：期望大于 `0.1071`，实际为 `0.0018`；总耗时 12.4 秒 |
| Task 4 固定采样减法后的精确单项 | `pnpm.cmd exec playwright test --config tests/playwright.website.config.ts website.spec.ts:671` | 0/1；删除已由 controller/chapter-model 单测承担的 32ms、24ms 固定采样后，立即读取的首帧仍为 `0`，未满足大于 `0`；测试耗时 2.9 秒 |
| Task 4 修复轮 2 精确单项 | `pnpm.cmd exec playwright test --config tests/playwright.website.config.ts website.spec.ts:671` | 1/1；删除前半中间帧采样和只服务该采样的首次 950ms 等待后通过；测试耗时 7.9 秒 |
| Task 4 修复轮 2 前 6 项锁定门 | `pnpm.cmd exec playwright test --config tests/playwright.website.config.ts website.spec.ts:515 website.spec.ts:534 website.spec.ts:558 website.spec.ts:579 website.spec.ts:591 website.spec.ts:671` | 6/6；总耗时 22.4 秒 |
| Task 4 修复轮 2 网站 E2E | `pnpm.cmd test:e2e:website` | 生产构建通过；第 6 项最终相邻章断言失败：期望 `download`，实际 `about`；停止时 10 项通过、1 项失败、5 项未运行 |
| Task 4 修复轮 3 精确单项 | `pnpm.cmd exec playwright test --config tests/playwright.website.config.ts website.spec.ts:671` | 1/1；删除重复的尾部相邻章推进链后通过；测试耗时 5.4 秒 |
| Task 4 修复轮 3 前 6 项锁定门 | `pnpm.cmd exec playwright test --config tests/playwright.website.config.ts website.spec.ts:515 website.spec.ts:534 website.spec.ts:558 website.spec.ts:579 website.spec.ts:591 website.spec.ts:671` | 6/6；总耗时 18.3 秒 |
| 网站 E2E | `pnpm.cmd test:e2e:website` | 生产构建通过；16/16 通过；测试总耗时 51.1 秒 |
| 网站链 runner 单元测试 | `node --test tools/verification/verify-web-chain.test.mjs` | 5/5 通过；覆盖 profile 展开、命令目录、失败短路、Windows `pnpm.cmd` 参数和非法参数 |
| Task 4 修复轮 3 网站业务链快速门 | `pnpm.cmd verify:web-chain:fast` | 失败：首个 scope 步骤把本阶段已批准的网站生产、测试、规格与配置文件报告为白名单外路径；未进入后续步骤 |
| 范围策略 TDD | `node --test tools/verification/verify-website-scope.test.mjs` | RED：6/7，通过项保持 CloudBase 为白名单外、桌宠为禁止；GREEN：7/7，耗时 77.8ms |
| 网站范围守卫 | `pnpm.cmd verify:web-chain:scope` | 通过；约 1 秒；未放行 CloudBase、桌宠、根桌面测试或其他 packages |
| 网站业务链快速门 | `pnpm.cmd verify:web-chain:fast` | 通过；约 75 秒；依赖审计为 0 error、8 个已批准历史 warning |
| 网站业务链完整门 | `pnpm.cmd verify:web-chain` | 通过；约 112 秒；包含构建产物、生产构建及 16/16 网站 E2E |
| 最终固定顺序：验证工具全测 | `node --test tools/verification/*.test.mjs` | 26/26 通过；退出 0 |
| 最终固定顺序：网站依赖审计 | `pnpm.cmd deps:audit:web` | 退出 0；250 个模块、646 条依赖、0 个 error、8 个既有 warning |
| 最终固定顺序：快速门 | `pnpm.cmd verify:web-chain:fast` | 退出 0；shared-types 23、website 323、cloudbase-api 193、package-scanner 64、release-tools 4 通过 |
| 最终固定顺序：完整门 | `pnpm.cmd verify:web-chain` | 退出 0；CloudBase build、构建产物 2/2、构建工具 1/1、Scanner build、网站静态构建及网站 E2E 16/16 通过；E2E 耗时 53.9 秒 |
| 最终固定顺序：独立范围守卫 | `node tools/verification/verify-website-scope.mjs` | 退出 0 |
| 最终固定顺序：差异检查 | `git diff --check` | 退出 0 |
| 最终固定顺序：工作树状态 | `git status --short --branch` | 仅列出本次五份目标文档；未执行 Git 写操作 |

上述失败条目保留为诊断历史，后续通过条目不覆盖其首次失败事实。命令结果只在实际运行后更新；失败、超时或未运行不得记录为通过。2026-08-20 的最终固定顺序复跑已经完成，以上结果为阶段 0 自动化验证的新鲜证据。

## 2. 人工视觉验收（待用户确认）

以下项目涉及主观视觉层级、连续动画观感或跨章节整体构图，自动 DOM 断言和无像素基线截图不能替代人工观察。当前均未取得用户人工验收证据。

| 视口 | 人工检查重点 | 状态 |
| --- | --- | --- |
| `568x320` | 五章节主要内容、投稿编辑器、支持滚筒与移动导航无明显遮挡；按钮可见且易于操作 | 待用户人工确认 |
| `390x844` | 首页可直接交互；付款码弹层具有安全边距；离开并返回首页后液态背景仍正常 | 待用户人工确认 |
| `760x900` / `761x900` | 断点两侧导航形态切换自然；章节内容无突跳、截断或横向溢出 | 待用户人工确认 |
| `1440x900` | 五章节透明交接、内容层级、支持操作组景深与首页液态背景整体观感 | 待用户人工确认 |
| `1920x1080` | 大屏构图、文本可读性、章节切换与减少动态效果下的完整导航 | 待用户人工确认 |

人工验收时应使用真实浏览器逐项观察并记录日期、浏览器版本和结论。正式部署不在本轮范围内。

## 3. 2026-08-21 GPU E2E 职责再减法

> 当前状态：14 项网站 E2E 与阶段 1 Task 11 自动化门通过；人工视觉和正式部署不在本次自动化结论内
> 环境：Windows PowerShell；Node.js `v24.18.0`；pnpm `11.9.0`

2026-08-20 的 44→16 与最终 16/16 继续作为当日阶段 0 历史事实有效。2026-08-21 规格只在两条退役用例及其职责范围内接替当前清单，现为以下 14 项：

1. `法律页面公开披露匿名投稿边界并提供站内投诉入口`
2. `安全共享包经系统与管理员审核后才在真实网页公开`
3. `匿名反馈批准前隐藏且批准后进入真实网页列表`
4. `状态令牌只从 Fragment 查询并立即从真实页面地址栏清除`
5. `568x320 投稿编辑器可滚动到底部且所有操作按钮满足触控尺寸`
6. `支付滚筒消费局部滚轮与键盘输入并显示映射正确的真实付款码`
7. `付款码弹层隔离翻页、滚轮与触屏章节输入并由 Escape 关闭`
8. `付款码资源加载失败时显示稳定回退并保持关闭行为`
9. `390 付款码弹层保持安全边距并完整显示真实图片`
10. `390 离开再返回首页后液态画布缓冲区保持可用`
11. `390 宽度液态玻璃首页无横向溢出`
12. `760/761 断点提供移动章节导航且五章节不横向溢出`
13. `568x320 五章节主内容避让移动导航且保持完整可见`
14. `减少动态效果直接进入稳定首页`

两条退役 E2E 为 `普通滚轮吸附、隔离惯性并重计新手势` 与 `液态玻璃 WebGL 画布按性能比例建立缓冲区并响应指针`。前者的阈值、反向重计、追赶、吸附、惯性锁定与边界由既有模型/控制器测试承担，真实 wheel 接线合并到第 14 项；后者的 1440×900、DPR 2、1296×810 缓冲/viewport、pointer uniform 与点击 ripple 数据由 `magnetic-intro.test.tsx` 的唯一新增组件契约承担。第 10、11 项继续保留真实 normal-motion WebGL 接缝。

### 3.1 Mutation 敏感性与 Task 1 证据

| 临时 mutation | 预期且实际 RED | 恢复 GREEN |
| --- | --- | --- |
| 1440 档 `resolutionScale: 0.9 → 1` | canvas 期望 1296、实际 1440；1 项失败、326 项通过，约 11.43 秒 | 恢复后 40 文件、327/327，约 11.32 秒 |
| `updatePointer(event, true) → false` | ripple 实际 `[0, 0, -100]`，未达到 `[0.25, 0.75, 0]`；1 项失败、326 项通过，约 10.67 秒 | 恢复后 40 文件、327/327，约 11.32 秒 |
| 删除全局 wheel listener | 重新构建 mutation 静态导出后真实 wheel 未离开 `home`；1/1 失败，约 11 秒 | 恢复并重建后 1/1，约 1.4 秒 |
| `wheelUnlockDelta: 240 → 360` | 7 项滚轮推进/240px 重计契约失败；320/327 通过，约 10.62 秒 | 恢复后 40 文件、327/327，约 12.14 秒 |

监听 mutation 第一次复用 mutation 前静态导出得到的假 GREEN 已排除。最终三个临时生产文件零差异；没有修改 Playwright 配置、timeout、retry、worker、runner、fixture 或 trace。

| Task 1 验证 | 实际结果 |
| --- | --- |
| `magnetic-intro.test.tsx` / 三文件职责承接 Vitest | 仓库参数转发实际运行网站 40 文件、327/327，通过约 12.02 秒 |
| 网站 typecheck | exit 0 |
| Playwright `--list` | 1 文件精确 14 项；两个退役标题零命中 |
| 两条 390 WebGL 接缝与 reduced-motion wheel 接线 | 3/3，通过约 8.8 秒 |
| `pnpm.cmd test:e2e:website` | 生产构建成功；14/14；Playwright 约 58.2 秒，整条约 1 分 27 秒 |
| 净减法 | `magnetic-intro.test.tsx` +59/-6，`website.spec.ts` +2/-106；合计 +61/-112，净减少 51 行 |

### 3.2 阶段 1 Task 11 新鲜复验

以下结果来自 2026-08-21 固定顺序重跑，不复用 Task 1 或首轮失败数值：

| 验证 | exit | 计数 | 耗时 |
| --- | ---: | --- | ---: |
| CloudBase 定向命令 | 0 | 19 文件、211/211 | Vitest 19.16 秒 |
| Website 管理端定向命令 | 0 | 40 文件、327/327 | Vitest 10.46 秒 |
| migration inventory / plan CLI 定向 | 0 | 10/10；5/5 | 92.8 ms；463.8 ms |
| shared-types | 0 | 2 文件、23/23 | 503 ms |
| CloudBase 全测 / typecheck / build | 0 | 19 文件、211/211；类型与构建通过 | 1.62 秒；约 3.38 秒；约 1.73 秒 |
| Website 全测 / typecheck | 0 | 40 文件、327/327；类型通过 | 10.11 秒；约 2.26 秒 |
| `pnpm.cmd verify:cloudbase` | 0 | CloudBase 211/211；Scanner 64/64 | 约 12.25 秒 |
| `pnpm.cmd test:cloudbase-tools` | 0 | 16/16 | 2.23 秒 |
| `pnpm.cmd verify:web-chain:fast` | 0 | Website 327、CloudBase fast 209、Scanner 64、shared-types 23、release 4、verification 30 | 工具 wall 汇总约 30 秒 |
| `pnpm.cmd verify:web-chain` | 0 | 全部子门通过；网站 E2E 14/14 | 工具 wall 汇总约 82 秒；Playwright 54.6 秒 |
| `pnpm.cmd verify:web-chain:scope` | 0 | 精确网站范围通过 | 0.83 秒 |
| migration dry-run | 0 | 4 条既有迁移的脱敏计划 | 0.63 秒 |
| 两项旧入口/无扫描语义 `rg` | 1 | 均零输出，符合负向预期 | 0.39 秒；0.37 秒 |

`verify:web-chain:fast` 的第一次尝试在 scope 首错停止，因为两份新获批规格/计划尚未进入精确白名单；最小 TDD 修复 `aea8e03` 只增加两条精确路径及其测试，独立 scope exit 0 后才执行上表重跑。该失败没有通过通配符、timeout、retry 或放宽范围掩盖。

人工视觉项目继续维持第 2 节的“待用户人工确认”。CloudBase PostgreSQL 实际防线待阶段 2 开发环境确认；事务型 migration runner、Scanner 协议/镜像/完整扫描证据、共享包投稿生产开启、正式部署与上线均不在本次范围，共享包投稿继续关闭。

## 4. 2026-09-02 最终视觉恢复 Task 6

> 当前状态：五章结构门与 mutation 敏感性通过；CloudBase、ownership、scope 门通过；网站完整门被单 worker 浏览器跨用例失去响应阻断
> 环境：Windows PowerShell；Node.js `v24.18.0`；pnpm `11.9.0`

### 4.1 正常动效五章结构门

唯一新增 E2E `正常动效五章节液态视觉职责` 固定 `1440×900`、`zh-CN`、`no-preference` 和 `seed=42`，按 `home/about/download/community/feedback` 进入五章。每章检查活动章节、液态层持续活动、初始化未失败、Canvas 可见、缓冲区非零和 CSS 边界覆盖视口；同时检查介绍章三块玻璃、下载平台组与安装提示、社区上传入口、反馈与付款两组以及六个非零按钮边界。测试在导航前注册控制台与 `pageerror` 收集器，五章结束时要求运行时错误数组为空；不包含 WebGL 像素快照、固定 sleep、额外 timeout、retry 或 worker 配置。

恢复版定向构建成功；单项首次为 1/1、测试 8.0 秒、命令 9.6 秒。mutation 将 `HomeExperience.tsx` 的 `exitProgress < 4.08` 临时改为 `exitProgress < 1.08` 并重建静态导出后，单项在进入 About 后失败：液态层 `data-active` 期望 `true`、实际 `false`，1 项失败、测试 15.6 秒。恢复 `4.08` 后生产文件 `git diff` 为空，重新构建并复跑为 1/1、测试 7.7 秒、命令 9.2 秒；后续独立复验为 1/1、测试 5.9 秒、命令 7.3 秒；最终交付前新鲜复验为 1/1、测试 7.8 秒、命令 9.4 秒。

审查补强先临时在导航前注入一条 `console.error`，新门于末尾精确收到 `["console.error: Task 6 runtime error sensitivity"]`，空数组断言 RED，1 项失败、测试 8.0 秒、命令 11.1 秒。移除临时注入后复跑为 1/1、测试 8.3 秒、命令 10.3 秒；临时错误文本未进入最终差异。

### 4.2 完整门与范围守卫

| 验证 | 实际结果 |
| --- | --- |
| `pnpm.cmd verify:website` 首轮 | typecheck、44 文件 403/403 单元测试及两次生产构建通过；E2E 15/20，五项在无条件 `getAttribute/evaluate` 处统一撞到 60 秒测试上限，Playwright 总耗时 6.5 分钟，命令 exit 1 |
| 五项失败用例分组 | 3/5；第 1 项通过、第 2 项浏览器失去响应、worker 重启后第 3 项通过、第 4 项失去响应、worker 重启后第 5 项通过，总耗时 2.5 分钟 |
| 两项最小分组 | 清理同机临时视觉服务与标签后仍为 1/2；第一项 6.0 秒通过，第二项在 `enterChapter` 首个 `getAttribute` 处 60 秒超时 |
| 五项独立新进程复验 | 5/5：共享包 4.0 秒、付款滚筒 8.0 秒、付款码失败回退 6.9 秒、新增五章门 5.9 秒、390 宽度 3.1 秒 |
| `pnpm.cmd verify:cloudbase` | exit 0；CloudBase 16 文件 280/280，Scanner 5 文件 67/67 |
| scope policy TDD | RED 42/43：三条新批准路径均被分类为 `outside`；GREEN 43/43，且同名 `.txt`、相邻日期证据目录仍为 `outside`，`apps/desktop` 仍为 `forbidden` |
| `pnpm.cmd verify:web-chain:scope` | 精确加入两份获批文档和 `docs/operations/evidence/website-final-visual-restoration-2026-09-02/**` 后 exit 0 |
| `pnpm.cmd verify:web-chain:ownership` | exit 0 |

诊断期间依次验证 `about:blank`、显式 `page.close()`、`WEBGL_lose_context + page.close()` 三种测试边界清理，均未消除两项分组的第二项失去响应；所有实验 hook 已撤回，没有进入最终差异。当前证据指向 Playwright 单 worker 复用 browser 进程时的跨用例浏览器/GPU 资源问题。由于 Task 6 禁止修改 timeout、retry、worker、runner 或生产业务断言，本轮不以放宽门禁掩盖，`verify:website` 保持失败状态。网站 typecheck、单元测试与生产构建通过，且 20 个 E2E 功能场景均有通过证据；其中受阻五项使用独立原生 Playwright 新进程取得 5/5。

真实 Windows 浏览器中的动态 WebGL 像素观感仍属第 2 节人工验收，当前为“待用户人工确认”。

## 5. 2026-09-02 最终视觉恢复 Task 7

> 当前状态：五章最终视觉、源码／运行时数值门、两种减少动效视口和最终两轴复审通过；上海测试站尚未覆盖
> 候选提交：`f765cb8e28dbb044b590bcfde42a967e162ad4de`
> 历史视觉基线：`963df613e35f8cafc1a9ea076ab878f0bae782d6`

### 5.1 真实浏览器视觉证据

在候选提交上执行 `pnpm.cmd build:website:e2e`，静态导出 build marker 为 `e5deceda216bdfc9`。七个场景分别由七次独立的 headed Chromium `149.0.7827.55` 进程采集，避免复用已知会在单 worker 跨用例运行中失去响应的浏览器进程。正常动效固定 `1440×900`、`zh-CN`、DPR 1、缩放 100%、`no-preference` 和 `?seed=42`；减少动效固定 `390×844`、`568×320` 与 `reduce`。每次均等待字体、静态回退就绪、章节整数吸附和交互态，再等待两个动画帧；正常场景同时确认 WebGL drawing buffer 为 `1296×810` 且 context 未丢失。

| 证据 | 实际观察与运行状态 | SHA-256 |
| --- | --- | --- |
| `home-1440x900-normal.png` | 首页大字、中心 AP 标志、液态光场与历史基线一致 | `e172f99254823f0dd495be3c2292ad374eb9bb0afd9e239b995fc9de176536c6` |
| `about-1440x900-normal.png` | `AI / PET / YOUR / AGENT`、三块能力玻璃及两侧说明齐全；鼠标安全点不命中玻璃，`data-hovered=-1`，detached 标题无模糊 | `f92183d85c63541d788b91d5a72d7b7cf00f3a8d39d7a019cb51b437c89495a7` |
| `download-1440x900-normal.png` | 平台选择、安装须知、版本信息与历史构图一致；当前 3D 设备模型已进入 `ready`，不回退到历史加载中状态 | `e1d68b2fcf0aa3a0cd2e34a7fd06d2a252b4b33cfd24d5662866d8326857d804` |
| `community-1440x900-normal.png` | 液态标题、页码与卡片槽位恢复；本地 E2E memory API 返回 200、分页 idle、3 张合约夹具卡片可见，未把本地夹具表述为上海真实内容 | `dada8902a5e010894984d44731a1276dd95b9cea6287863ad906cd3b0e9c0a87` |
| `feedback-1440x900-normal.png` | 两组三项景深按钮与历史基线一致，共 6 个按钮具有非零边界 | `22c4bbae95e6d135533fb47b9204337a9096bdfda899c24a5bb551b0ade3c687` |
| `feedback-390x844-reduced.png` | 减少动效开启；反馈与付款两组共 6 个按钮仍可见，页面宽度无横向溢出 | `fa359c82ef7baa873dd8992f887559839ea523799560e2c170ef4c5dedcfad16` |
| `website-568x320-reduced.png` | 减少动效开启；首页核心内容、章节状态和上下导航保持可用 | `186b0286bfaf21efc6f0a97f0c01e60836cd713135a5e1cd655293bd58efbc4e` |

证据目录为 `docs/operations/evidence/website-final-visual-restoration-2026-09-02/`，`manifest.sha256` 保存七张图的同一组哈希。主智能体已逐张查看七张候选图，并逐对查看历史五章基线；恢复后的视觉骨架一致，Download 的已就绪模型和 Community 的本地合约卡片属于当前代码路径相对历史失败／加载状态的预期差异。上海真实内容留到 Task 8 线上复验。

### 5.2 源码与运行时数值门

对 `94785ee91b0ed88f7aa2b1023bb7a4cd662b86d3` donor 与候选执行源码数值对比。排除明确修复的 Community 网格 uniform／坐标表达式后，fragment shader 的 `630/630` 个数值字面量顺序完全一致，忽略空白后的 shader 文本也完全一致；生命周期阈值均为 `4.08`，资源规模均为 7 个纹理、2 个 shader、1 个 buffer、1 个 program 和 4 类视觉事件。没有仅凭截图接受其他未知数值漂移。

Community 首轮真实测量发现 donor 的固定中心会让前三张 WebGL 玻璃比 DOM 基础中心统一高约 `16.20px`，欧氏误差占卡片较小边 `5.11%–5.18%`，因此该轮没有通过。最终实现改为在初始与 resize 时镜像桌面 CSS 网格公式：`padding=clamp(18px, 2.4vw, 46px)`、`gap=clamp(10px, 1.4vw, 26px)`、中央行 `clamp(120px, 20vh, 210px)`，再计算四列与上下弹性行中心并转换 DOM／WebGL Y 轴。

在 `1440×900` 最终候选中，computed CSS 为 padding `34.56px`、gap `20.16px`、四列约 `327.60px`、上下行约 `305.28px`、中央行 `180px`；生产 helper 得到 columns `0.13775 / 0.37925 / 0.62075 / 0.86225`、WebGL rows `0.792 / 0.208`，与实际上传 uniform 六位小数一致。前三张卡的 DOM／WebGL 基础中心欧氏误差为 `0.006188 / 0.005796 / 0.005429 CSS px`，computed CSS 与 helper 的最大序列化差为 `0.0195px`，通过不超过 1 CSS px 的门。

`900px` 正常动效边界另行实测：`reduced=false`、3 张 DOM 卡片保留、WebGL context 正常，卡片玻璃 count 为 0；永久单测还验证窄屏期间继续接收最新快照，返回桌面宽度后恢复最新 count。这样没有为可滚动 2／1 列 DOM 另造一套猜测式 shader 布局，也不会显示错位幽灵玻璃。

### 5.3 生命周期复审与修复

最终独立复审先发现四项有效问题：About 多玻璃回位共享布尔值会产生交叉竞争；WebGL／Shader／Logo 初始化失败没有驱动父级静态回退；暂停状态只停止 render 而没有释放 GPU 与监听器；视觉事件快照会在暂停或重建时丢失。修复后又补齐卸载提交到 passive cleanup 之间的迟到 Logo error 门闩，并将重复的 GSAP 测试替身收敛为文件内 helper。

TDD 证据包括：About A/B 交错回位；WebGL null、同步纹理异常和异步 Logo 失败；精确释放 7 texture、1 buffer、2 shader、1 program；暂停释放、恢复时单次重建；暂停期间接收 About／Community／Support 最新快照且不回放 ripple；卸载窗口迟到 Logo error 在旧实现中使完整单测为 410/411，加入 layout mounted guard 后为 411/411。生命周期独立复审复跑定向 34/34、完整 website 411/411、typecheck 与 `git diff --check`，Critical、Important、Minor 均为零；后续数值门增加两项永久回归测试，最新完整 website 为 413/413。

最终规格轴与质量轴分别重新读取 `bb5fd90..f765cb8`、本节文档与七张证据，独立复算 shader 数值、CSS／helper／uniform、截图哈希、移动断点和资源清理，并复跑 website 413/413、typecheck、scope、ownership 与 `git diff --check`。两轴均为 Critical、Important、Minor 零项，结论 Approved；Community 首轮审查发现的问题及两轮修复没有被旧的通过结论覆盖。

### 5.4 已知非阻断项

当前静态候选没有声明 favicon。headed Chromium 会附带请求 `/favicon.ico`；采集脚本只对该精确路径回复 204，其他请求、`console.error` 和 `pageerror` 继续作为阻断条件。这不表示 favicon 已修复；由于图标资产和品牌选择没有获批，本轮没有为了消除一条 404 而新增资源。

Task 6 记录的单 browser 串行 E2E 失去响应仍未通过放宽 timeout、retry、worker 或 runner 掩盖。Task 7 的七个场景使用独立原生 Playwright 进程取得通过证据；本节不把 `pnpm.cmd verify:website` 的一次性非零状态改写为全绿，也不表示上海测试站已经覆盖。
