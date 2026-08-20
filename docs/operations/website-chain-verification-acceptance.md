# 网站业务链验证与人工验收记录

> 日期：2026-08-20
> 当前状态：网站自动化完整门通过；人工视觉验收待用户确认
> 适用范围：网站业务链，不包含桌面端与正式部署

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
| Task 4 修复轮 3 网站业务链快速门 | `pnpm.cmd verify:web-chain:fast` | 失败：首个 scope 步骤把本阶段已批准的网站生产、测试、规格与配置文件报告为白名单外路径；未进入后续步骤 |
| 范围策略 TDD | `node --test tools/verification/verify-website-scope.test.mjs` | RED：6/7，通过项保持 CloudBase 为白名单外、桌宠为禁止；GREEN：7/7，耗时 77.8ms |
| 网站范围守卫 | `pnpm.cmd verify:web-chain:scope` | 通过；约 1 秒；未放行 CloudBase、桌宠、根桌面测试或其他 packages |
| 网站业务链快速门 | `pnpm.cmd verify:web-chain:fast` | 通过；约 75 秒；依赖审计为 0 error、8 个已批准历史 warning |
| 网站业务链完整门 | `pnpm.cmd verify:web-chain` | 通过；约 112 秒；包含构建产物、生产构建及 16/16 网站 E2E |

命令结果只在实际运行后更新；失败、超时或未运行不得记录为通过。

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
