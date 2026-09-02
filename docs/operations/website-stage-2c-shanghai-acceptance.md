# 网站阶段 2C 上海阻断验收记录

> **历史快照（已被后续状态取代）：** 本记录保存 2026-09-01 的 `blocked` 事实。2026-09-02 零费用方案已形成后续状态，当前入口为 [`website-stage-2c-zero-cost-manual-review-acceptance.md`](website-stage-2c-zero-cost-manual-review-acceptance.md)，远端状态为 `remote: in_progress`；真实 OTP 管理员登录与完整业务 smoke 仍未完成。

## 范围与结论

- 日期：2026-09-01。
- 范围：记录阶段 2C 的零费用前置门、上海单地域本地收窄、适用本地门禁和状态文档收敛。Task 11 本身未再次访问浏览器或腾讯云，未执行远端操作；本文引用 Task 1 已有的只读控制台与官方文档证据。
- 最终状态：`blocked`。
- 此结论不表示已创建上海 PostgreSQL 环境、已执行远端 migration、已部署函数、Scanner、网关或 Hosting，也不表示生产已上线。线上仍是旧测试版，`SHARED_PACKAGE_SUBMISSIONS_ENABLED=false` 继续生效。

## 提交范围

- 本次验收的代码基线为 `ca19fb2`。
- 首次交付提交为 `9eaff5c`（`docs(web): 记录上海阶段2C验收结果`）。
- 该交付仅包含以下六个文档：`docs/operations/cloudbase-deployment.md`、`docs/operations/content-moderation.md`、`docs/operations/website-stage-2c-shanghai-acceptance.md`、`docs/superpowers/plans/2026-08-15-website-optimization-index.md`、`docs/superpowers/plans/2026-08-31-website-stage-2-3-local-closure.md`、`docs/superpowers/plans/2026-09-01-website-stage-2c-shanghai-rebuild.md`。
- 本次边界修正仅改动本验收记录与阶段 2–3 闭环计划，不改代码、配置、依赖、migration 或桌宠路径。

## 远端阻断依据

当前只读核验到的旧上海免费体验环境为 `ai-pet-scanner-dev`（环境 ID：`ai-pet-scanner-dev-d8cqh04af371e`），属于传统/MySQL 模式，不是所需 PostgreSQL 环境。控制台显示免费体验有效期至 2027-02-01、不支持自动续费，且超限按量当前未开启；函数页面显示执行时间上限 15 分钟、内存上限 3 GB，因此函数目标超时不是本次阻断项。

[CloudBase Run 使用限制](https://docs.cloudbase.net/run/limitation) 明确 CloudBase Run 的 CPU、内存不包含在环境套餐中，运行需要开启超限按量计费；这与不得产生额外费用的约束冲突。官方 [CloudBase Run CLI 文档](https://cloud.tencent.com/document/product/1243/76108) 和已登录控制台均未观察到可保存“单实例并发 1”的设置。以上两项使远端部分保持 `blocked`。

## 本地完成项与验证

- Task 1 提交：`14541a8`、`3c07ab9`。精确网站范围已锁定，零费用门禁经过两次独立审查。
- Task 2 提交：`374371b`、`ca19fb2`。现行 API、服务端 SDK、网站 SDK、Scanner IMS、migration Adapter 和候选容器统一为 `ap-shanghai`，网站 SDK 的 `intl` 启用项已删除；新加坡仅保留于失败关闭测试或已说明替代关系的历史正文。
- 本地只读运行 `pnpm.cmd plan:cloudbase-migrations`，生成 13 个 migration 的 checksum plan，`planSha256` 为 `ae6095d471e0f7056b25cec286694a1706fe851538ec6adce4f12debf851ee09`。该本地 plan 未提交到远端，没有创建远端 migration 任务或 TaskId。
- Task 4 已完成本地门禁：`verify:cloudbase`（CloudBase API 329 项、Scanner 71 项）、`verify:website`（网站 361 项单测、静态构建和 E2E 21/21）、`test:cloudbase-tools`（36/36）均通过。
- 在既有 PostgreSQL 17.11 runtime 上以进程级 `AI_PET_POSTGRES_RUNTIME` 运行 `verify:web-chain:fast` 后退出 0：13 个 migration、103 项 PostgreSQL 行为、网站合同 30/30、依赖审计 274 modules/723 dependencies/0 error/8 个已批准历史 warning。第一次 fast 门因未设置该进程级变量而在行为门前失败；只读核验后按既有验收方式设置并重跑通过，未进行代码修复。
- Task 11 的完整 `verify:web-chain` 首次在 Scanner 候选拉取 Docker Hub 匿名令牌时因 TLS 握手超时退出 1；未修改代码，只重试一次后退出 0。通过结果包含范围与 ownership 检查、13 个 migration、103 项 PostgreSQL 行为、网站合同 30/30、Scanner 候选与网站 E2E 21/21；依赖审计为 274 modules/723 dependencies/0 error/8 个已批准历史 warning。该网络重试不是代码修复。
- scope、ownership、`git diff --check 880502c..HEAD` 与 `git diff --check` 已通过；独立规格复核为 PASS，代码质量为 Approved。最终审查无阻断 finding，并接受一项 Scanner 测试名称未完整表达凭据透传行为的 Minor；该命名问题不影响行为正确性，关闭前不修改测试代码。

## 未执行项、费用与密钥风险

Task 3 与 Task 5–10 按阻断裁剪：未删除旧环境，未创建上海 PG 环境，未执行远端 migration，未创建远端 migration 任务或 TaskId，未把本地 checksum plan 提交到远端，未创建 Bucket、Key 或管理员，未部署函数、Scanner、网关、触发器或 Hosting，未启停服务，未开通内容安全或按量服务，也未发布或上线。

没有启动会产生远端用量的步骤，因此不进入 48 小时资源点与费用统计等待；不得伪造资源点、账单、TaskId、版本、PG 或 smoke 证据。只读核验发现旧 Scanner 配置保存长期腾讯云访问凭据，但未记录、迁移或撤销任何值。环境删除不等于账号级密钥撤销；若重启远端方案，必须先完成独立的账号级密钥轮换或删除门禁，并在实际撤销时再次确认。

## 未验证项与恢复条件

尚未验证真实 PG 环境的 migration、对象存储、TMS/IMS、cleanup、网关认证、函数与 Scanner 部署、触发器、完整 smoke、资源点和账单。恢复远端工作前，必须先取得可证明为零费用且满足强制能力的上海 PG 环境路径，或者取得经批准的新规格以处理 CloudBase Run 按量计费与单实例并发限制；随后按独立远端授权、真实证据和费用门重新裁决，不能以本地通过替代远端部署或生产上线证据。
