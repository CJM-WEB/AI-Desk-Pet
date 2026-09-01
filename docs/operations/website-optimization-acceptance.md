# 网站阶段四本地治理真实状态记录

> 日期：2026-09-01
> 分支：`WebsiteExtension`
> 固定实现基线：`3ce8303773477bde9f429bef87f662ab8912e5c9`
> Standards 最小代码修复：`3729da587120f1ffbb3a1e3904b7b508a6125096`
> 完整联合门基线：`f6978d0cec4108a1c168eded98b1ce5b9e512a1b`
> 总裁决：阶段四本地治理验收完成；八项治理实现、真实 Scanner 候选与完整 `verify:web-chain` 均通过
> 审查状态：最终 Spec 与 Standards 两轴 Approved；scoped 复审为 Critical 0、Important 0、Minor 0，无范围蔓延
> 适用范围：阶段四本地代码、分段门、完整联合门与外部未执行项；不替代 2026-08-20 的网站视觉验收记录，不证明阶段 2C 或正式生产已完成

## 1. 阶段裁决

| 项目 | 结论 | 实际证据与边界 |
| --- | --- | --- |
| 八项本地治理实现 | complete | keyset cursor、desired-state 点赞/互动幂等、下载成功签发计数、发布结构不变量/坏记录隔离、有界 RPC JSON、Release Manifest 单一契约、CloudBase 能力端口收窄和 i18n 单向权威已进入唯一正式路径。 |
| `LiquidGlassHome` 事件项 | 已接替 | 2026-08-20 减法规格已删除相关跨章节事件且不替换；阶段四未重建事件总线。 |
| 生产 Router | 等待阶段 2C | 本地证据不能裁决真实 CloudBase 网关是否带 `/api` 前缀；当前不记通过、失败或永久双轨。 |
| 最终代码 Spec 轴 | Approved | 固定实现差异审查为 Critical 0、Important 0、Minor 0。 |
| Standards 轴 | Approved | 初审的计划事实不同步和 `publicAssetSize()` 浅中转已按最小范围修复；scoped 复审为 Critical 0、Important 0、Minor 0。 |
| 完整 `verify:web-chain` | PASS | 在固定联合门基线上使用显式 PostgreSQL 17 runtime 运行，同次通过真实 `scanner-candidate` 与 website E2E 21/21，退出码 0。 |
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

## 3. 完整联合门通过事实

在 `f6978d0cec4108a1c168eded98b1ce5b9e512a1b` 上将 `AI_PET_POSTGRES_RUNTIME` 指向本地 PostgreSQL 17 runtime 后运行 `pnpm.cmd verify:web-chain`，同一次进程退出 0，并出现 `[web-chain] PASS website-e2e`。

同次结果为：scope PASS、ownership PASS、验证工具 74/74、shared-types 56/56、Website 单元测试 361/361、CloudBase 快速集 326/326、Scanner 单元测试 71/71、release-tools 4/4、migration 工具 36/36、PostgreSQL 17.11 顺序执行 13 个 migration 并通过 103 项行为断言、网站合同 30/30、依赖审查 274 modules/723 dependencies/0 error/8 个已知阶段五 orphan warning、CloudBase build output 2/2、build tool 3/3，以及 website E2E 21/21。

真实 `scanner-candidate` 通过：镜像 `ai-pet-package-scanner:stage2-candidate`，镜像 ID `sha256:a46bce60acd5c74baad0bc01cc9682f07a65c37850b36d22cd21ddbc8311628c`，Node `v22.23.2`，ClamAV `1.4.3`/病毒库 `28109`，UID `999`；EICAR 被阻断、超时返回 HTTP 503、健康检查通过。该证据是本地候选镜像验收，不表示 CloudBase Run Scanner 已部署或完成开发环境冒烟。

生产 Router 仍需阶段 2C 捕获真实 CloudBase 网关路径后裁决；该项不属于阶段四本地治理完成范围。

## 4. 外部未验证项

- CloudBase 开发环境、远端 migration、真实存量结构与索引计划均未执行或验证。
- cleanup 代码存在不等于已配置真实定时调度；互动账本 24 小时清理和隔离区清理均未在远端运行。
- 真实网关路径、认证请求头传递、RPC 压缩/流行为、私有对象存储与短期签名地址均未验证。
- 三个函数、Scanner、Hosting、域名、CORS/CSP、监控告警、发布、回滚与正式上线均未执行。
- 现在线上仍是旧测试版；本分支未上线，共享包投稿开关继续关闭。
