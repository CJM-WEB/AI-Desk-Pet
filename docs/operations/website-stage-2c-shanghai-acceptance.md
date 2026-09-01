# 网站阶段 2C 零费用人工审核验收记录

## 结论

- 日期：2026-09-01。
- 范围：阶段 2C 零费用人工审核的本地实现、自动化验证、真实 Docker 候选与运维文档收敛。
- 远端状态：`remote: unverified`。
- 本记录不表示已创建上海 PostgreSQL 环境、执行远端 migration、部署 API/cleanup、创建 Bucket、配置身份/网关/静态托管，也不表示正式生产上线。

## 已执行的本地事实

| 项目 | 实际结果 |
| --- | --- |
| PostgreSQL 行为门 | 本地 PostgreSQL 17.11，顺序执行 15 个 migration，74 项行为验证通过。 |
| 网站 | 362 项单测通过；生产构建通过；Playwright E2E 18/18 通过。 |
| CloudBase API | 258 项测试通过；构建与 typecheck 通过；构建产物只含 `api`、`cleanup`。 |
| 包扫描器 | 67 项测试通过；typecheck 通过。 |
| Scanner candidate verifier | 19/19 通过。 |
| 真实 Docker 候选 | Node `v22.23.2`、ClamAV `1.4.3`、UID `999`；无网络、只读根文件系统、只读输入与 `mode=1777` tmpfs 条件下，干净包完成检查、EICAR 阻断、非法包拒绝。 |

本地行为已收敛为：新共享包和反馈/建议直入 `manual_review_pending`；反馈可普通 `approve` 并记录 `standard`；新共享包没有有效系统证据时普通批准失败关闭，只能经风险确认执行 `force_publish`，并记录 `admin_override` 与公开风险提示。

本地 Docker CLI 不是云端服务：构建阶段 `freshclam` 使用网络更新病毒库，运行阶段固定 `--network none`；候选病毒库超过 7 天必须重建并复验。报告要求人工查看图片，且不能作为系统扫描通过证据。

## 已退役的云端自动审核入口

现行 CloudBase 最小部署面仅为 PostgreSQL、私有 Bucket、`ai-pet-api`、`ai-pet-cleanup`、身份、网关和静态托管。CloudBase Run Scanner、腾讯 TMS、腾讯 IMS、`ai-pet-moderation-worker`、Scanner HTTP/HMAC 和 Scanner Secret 已退役，禁止部署。

## 未验证项

以下均为 `remote: unverified`：上海 PG 免费环境及费用门、远端 migration、私有对象存储、函数部署、cleanup 调度、身份认证、网关、静态托管、远端 smoke、资源点、账单、监控、告警和正式生产发布。

共享包投稿开关继续保持 `SHARED_PACKAGE_SUBMISSIONS_ENABLED=false`。远端工作只能在获得独立授权、环境实际为上海 PostgreSQL 且金额为 0 元、按量与自动续费关闭后恢复；任何远端验证成功也不自动等于正式生产上线。
