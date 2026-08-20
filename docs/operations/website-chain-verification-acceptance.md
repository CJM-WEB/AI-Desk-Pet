# 网站业务链验证与人工验收记录

> 日期：2026-08-20
> 当前状态：网站自动化完整门通过；人工视觉验收待用户确认
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
