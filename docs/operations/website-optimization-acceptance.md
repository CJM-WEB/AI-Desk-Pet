# 网站阶段四本地治理真实状态记录

> 日期：2026-09-01
> 分支：`WebsiteExtension`
> 固定实现基线：`3ce8303773477bde9f429bef87f662ab8912e5c9`
> Standards 最小代码修复：`3729da587120f1ffbb3a1e3904b7b508a6125096`
> 总裁决：阶段四整体未通过；八项本地治理代码已完成，但完整 `verify:web-chain` 在 Docker `scanner-candidate` 环境门失败
> 审查状态：最终 Spec 轴 Approved；Standards 初审发现 1 个 Important 与 1 个 Minor，修复已落地，仍待 scoped 复审
> 适用范围：阶段四本地代码、分段门、完整门失败事实与外部未执行项；不替代 2026-08-20 的网站视觉验收记录

## 1. 阶段裁决

| 项目 | 结论 | 实际证据与边界 |
| --- | --- | --- |
| 八项本地治理实现 | complete | keyset cursor、desired-state 点赞/互动幂等、下载成功签发计数、发布结构不变量/坏记录隔离、有界 RPC JSON、Release Manifest 单一契约、CloudBase 能力端口收窄和 i18n 单向权威已进入唯一正式路径。 |
| `LiquidGlassHome` 事件项 | 已接替 | 2026-08-20 减法规格已删除相关跨章节事件且不替换；阶段四未重建事件总线。 |
| 生产 Router | 等待阶段 2C | 本地证据不能裁决真实 CloudBase 网关是否带 `/api` 前缀；当前不记通过、失败或永久双轨。 |
| 最终代码 Spec 轴 | Approved | 固定实现差异审查为 Critical 0、Important 0、Minor 0。 |
| Standards 轴 | 待 scoped 复审 | 初审的计划事实不同步和 `publicAssetSize()` 浅中转已按最小范围修复；本记录不把待复审写成 Approved。 |
| 完整 `verify:web-chain` | FAIL（环境门） | 同次运行在 `scanner-candidate` 连接 Docker Desktop Linux engine 时失败；后续 website build/E2E 未执行，不能以分段门替代。 |
| 阶段 2C / 正式生产 | 未执行 / 未部署 | 未连接 CloudBase 开发环境；未执行远端 migration、cleanup 调度、真实网关与对象存储验证、函数/Scanner/Hosting 部署、发布或正式上线。 |

## 2. 2026-09-01 分段真实证据

下表除“Standards 最小修复复验”外，均来自 2026-09-01 Task 9 预检批次；这里按原批次登记，不冒充为完整门同次结果。

| 命令或门 | 结果 |
| --- | --- |
| `pnpm.cmd deps:audit:web` | PASS；274 modules、723 dependencies、0 error、8 个阶段五 orphan warning。 |
| `pnpm.cmd test:website-contract` | PASS；Production/Memory 2 个 driver，30/30。 |
| `pnpm.cmd verify:web-chain:scope` | PASS；阶段四路径按精确白名单放行，桌宠黑名单零差异。 |
| `pnpm.cmd verify:web-chain:ownership` | PASS。 |
| `pnpm.cmd verify:cloudbase` | PASS；CloudBase API 21 个文件、328/328；Scanner 6 个文件、71/71；构建与 typecheck 通过。 |
| `pnpm.cmd verify:website` | PASS；Website 41 个文件、361/361；两次 production build；E2E 21/21。 |
| PostgreSQL 17 行为门 | PASS；PostgreSQL 17.11 顺序执行 13 个前向 migration，通过 103 项行为验证。 |
| migration 工具门 | PASS；`tools/test-cloudbase-migrations.test.mjs` 与 inventory 合计 16/16，inventory 固定为 13 个前向 migration。 |
| `pnpm.cmd typecheck` | PASS；10 个适用 workspace 全部通过。 |
| Standards 最小修复复验 | 改前与改后同一 CloudBase 定向命令均为 21 个文件、328/328；独立 CloudBase typecheck 与 `verify:cloudbase` 通过，Scanner 71/71。 |

## 3. 完整门失败事实

使用显式本地 PostgreSQL 17 runtime 执行的完整 `verify:web-chain` 退出 1。失败关闭前，同一次进程已通过 scope、ownership、验证工具 74/74、shared-types 56/56、Website 361/361、CloudBase 快速集 326/326、Scanner 71/71、release-tools 4/4、migration 工具 36/36、PostgreSQL 17.11 的 13 个 migration/103 项行为、网站合同 30/30、依赖审查以及 CloudBase 构建相关目标。

唯一失败点是 `scanner-candidate` 无法连接 `npipe:////./pipe/dockerDesktopLinuxEngine`。诊断指向工作区外陈旧 `sailor-ingest.sock` reparse socket 导致 Docker Desktop backend 崩溃；清理该外部 socket 被执行策略阻止。仓库明确禁止以静态报告或无 Docker 模式替代真实候选镜像门，因此没有绕过或伪造通过。该次完整门在失败后没有执行后续 website build/E2E。

后续必须先恢复 Docker Desktop Linux engine，再从头重跑完整 `verify:web-chain`。只有同一次完整门退出 0，且 Standards scoped 复审无阻塞项，才能把阶段四整体改为通过。

## 4. 外部未验证项

- CloudBase 开发环境、远端 migration、真实存量结构与索引计划均未执行或验证。
- cleanup 代码存在不等于已配置真实定时调度；互动账本 24 小时清理和隔离区清理均未在远端运行。
- 真实网关路径、认证请求头传递、RPC 压缩/流行为、私有对象存储与短期签名地址均未验证。
- 三个函数、Scanner、Hosting、域名、CORS/CSP、监控告警、发布、回滚与正式上线均未执行。
- 现在线上仍是旧测试版；本分支未上线，共享包投稿开关继续关闭。
