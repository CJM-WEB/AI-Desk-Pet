# 网站阶段 2C 零费用人工审核验收记录

## 结论

- 日期：2026-09-01。
- 范围：阶段 2C 零费用人工审核的本地实现、自动化验证、真实 Docker 候选与运维文档收敛。
- 提交范围：`5c914ef`（不含）至本次阶段 2C 整分支终审修复提交（含，本记录所在提交）。
- 远端状态：`remote: unverified`。
- 本记录不表示已创建上海 PostgreSQL 环境、执行远端 migration、部署 API/cleanup、创建 Bucket、配置身份/网关/静态托管，也不表示正式生产上线。

## 已执行的本地事实

| 项目 | 实际结果 |
| --- | --- |
| PostgreSQL 行为门 | 本地 PostgreSQL 17.11，顺序执行 15 个 migration，76 项行为验证通过。 |
| 自动化测试 | 共 940 项通过：门禁测试 107、共享契约 42、网站单测 364、CloudBase API 265、包扫描器 67、发行工具 4、migration 工具 36、网站合同 30、CloudBase 构建产物 2、CloudBase 构建工具 5、Playwright E2E 18。 |
| 网站 | 364 项单测通过；生产构建通过；Playwright E2E 18/18 通过。 |
| CloudBase API | 265 项单元测试通过；构建与 typecheck 通过；另有 2 项构建产物测试通过，产物只含 `api`、`cleanup`。 |
| 包扫描器 | 67 项测试通过；typecheck 通过。 |
| 依赖审查 | 260 个模块、683 条依赖；0 个错误，8 个已批准历史 warning。 |
| 真实 Docker 候选 | imageId `sha256:1e1bd204ecdeb6c640358597e04b6e1732b1a39152e0106fe8cfb6d18dd81280`；Node `v22.23.2`、ClamAV `1.4.3`、UID `999`；ClamAV DB `28110`，更新时间 `2026-09-01T11:10:23.000Z`，裁决时年龄 0 天；无网络、全部 capability 移除、只读根文件系统、只读输入与 `mode=1777` tmpfs 条件下，干净包进入人工审核、EICAR 阻断、非法包拒绝。 |

Task 7 最终复验实际执行：

```powershell
$env:AI_PET_POSTGRES_RUNTIME='C:\Users\Administrator\AppData\Local\Temp\ai-pet-pg17-stage2\runtime'
pnpm.cmd verify:web-chain
pnpm.cmd verify:web-chain:scope
pnpm.cmd verify:web-chain:ownership
git diff --check 5c914ef..HEAD
git status --short
```

完整网站链、范围门、测试所有权门和提交差异检查均返回 0；`git status --short` 在记录提交前只列出本轮已解释的管理员 ZIP E2E、Memory API 地址、退役策略与测试、现行规格/计划、两本运维手册、优化索引、旧验收历史恢复和本验收记录。

本地行为已收敛为：新共享包和反馈/建议直入 `manual_review_pending`；反馈可普通 `approve` 并记录 `standard`；新共享包没有有效系统证据时普通批准失败关闭，只能经风险确认执行 `force_publish`，并记录 `admin_override` 与公开风险提示。restore 的旧幂等 key 在恢复后的后续发布、驳回、隔离或清理生命周期中仍回放首次快照；同 key 改管理员原始输入继续冲突，新 key 不能绕过当前状态与版本门。

管理员详情提供 5 分钟待审 ZIP 地址；该地址不进入公开 DTO，真实 E2E 下载返回 `application/zip`，且不会增加公开下载计数。本地 Docker CLI 不是云端服务：构建阶段 `freshclam` 使用网络更新病毒库，运行阶段固定 `--network none`；候选病毒库超过 7 天必须重建并复验。报告要求人工查看图片，且不能作为系统扫描通过证据。

## 已退役的云端自动审核入口

现行 CloudBase 最小部署面仅为 PostgreSQL、私有 Bucket、`ai-pet-api`、`ai-pet-cleanup`、身份、网关和静态托管。CloudBase Run Scanner、腾讯 TMS、腾讯 IMS、`ai-pet-moderation-worker`、Scanner HTTP/HMAC 和 Scanner Secret 已退役，禁止部署。对应的 17 个旧自动审核与远程 Scanner 源码/测试路径由范围门同时拒绝工作树与 Git 索引恢复。

## 未验证项

以下均为 `remote: unverified`：上海 PG 免费环境及费用门、远端 migration、私有对象存储、函数部署、cleanup 调度、身份认证、网关、静态托管、远端 smoke、资源点、账单、监控、告警和正式生产发布。

共享包投稿开关继续保持 `SHARED_PACKAGE_SUBMISSIONS_ENABLED=false`。远端工作只能在获得独立授权、环境实际为上海 PostgreSQL 且金额为 0 元、按量与自动续费关闭后恢复；任何远端验证成功也不自动等于正式生产上线。
