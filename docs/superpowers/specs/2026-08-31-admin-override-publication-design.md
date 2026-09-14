# 网站管理员强制发布设计

> 2026-09-11 展示层修订：用户明确要求移除公开卡片、详情和下载入口的风险提示，见[角色包显示精简规格](2026-09-11-shared-package-display-design.md)。本文件有关公开提示组件的要求仅在该范围内被替代；后台确认、发布依据、审计及 API 契约保持不变。

> 日期：2026-08-31
> 状态：已批准
> 适用范围：官网投稿审核、CloudBase API、内存网站 Adapter 与网站管理/公开界面
> 替代关系：替代“共享包只有系统检查通过才能公开”以及“共享包转人工必须先回系统重扫”的旧约束；不改变 Scanner 证据真实性、匿名投稿私有存储和唯一管理员认证边界

## 1. 目标与非目标

目标是让唯一管理员拥有最终发布裁决权，同时让技术扫描事实、人工裁决和公众风险提示彼此独立、可审计。管理员可以把 `system_reviewing` 或 `auto_rejected` 的任意投稿转入 `manual_review_pending`；共享包即使没有有效扫描通过证据，也可通过独立的 `force_publish` 动作发布。

本规格不关闭 Scanner、不伪造扫描通过、不允许匿名用户调用管理员动作、不放宽管理员认证、不改变私有对象与公开下载的存储边界，也不执行远端部署或生产开关变更。

## 2. 领域规则

### 2.1 三类事实

1. **技术扫描结论**：等待、通过或危险，只由 Scanner 和审核 worker 写入；管理员不能修改为通过。
2. **管理员裁决**：普通批准或强制发布，由管理员动作和审计记录证明。
3. **发布依据**：`standard` 或 `admin_override`。共享包走强制发布时必须为 `admin_override`；公开 API 和页面必须披露该值。

三类事实不得共用一个布尔值，也不得用修改扫描证据的方式实现强制发布。

### 2.2 状态转换

```text
system_reviewing ──move_to_manual──> manual_review_pending
auto_rejected ─────move_to_manual──> manual_review_pending
manual_review_pending ──approve────> published (standard)
manual_review_pending ──force_publish──> published (admin_override)
published (admin_override) ──late scan result──> published (admin_override)
```

- `move_to_manual` 对反馈、建议和共享包一致可用，必须填写理由并执行版本与幂等检查。
- 共享包普通 `approve` 继续要求当前归档、当前状态版本和 24 小时 TTL 内的有效扫描通过证据。
- `force_publish` 是独立动作，仅用于共享包缺少当前有效扫描通过证据的情况；若证据有效，应使用普通 `approve`，避免错误标记。
- `force_publish` 只接受 `manual_review_pending`，不能从 `system_reviewing`、`auto_rejected` 或隔离态一步发布，确保“转人工”和“强制发布”是两个独立审计步骤。
- 后到扫描结果可以更新审核结果和风险摘要，但不得自动改变 `published`、`publicationBasis` 或管理员审计记录。

## 3. 请求、确认与审计

共享 `AdminAction` 使用可辨识联合：普通动作保持现有字段；`force_publish` 额外且必须携带字面量 `riskAcknowledgement: "ADMIN_OVERRIDE_ACCEPTED"`。服务端不能只相信前端弹窗，缺失或错误确认值必须按严格 Schema 拒绝。

管理界面第一次点击“强制发布”只打开内联确认区，显示“该文件未通过安全扫描，发布后用户可能下载危险文件”；第二次确认才发送请求。理由继续必填，提交期间禁止重复操作。

数据库管理员审计必须保存：管理员标识、动作、投稿 ID、期望版本、前后状态、理由、幂等键、风险确认、动作时可见的最新扫描结论和首次结果快照。重复的相同请求回放首次结果；相同幂等键配不同输入必须失败。

## 4. 数据和公开契约

- 新增不可变前向 migration；不得修改历史 migration。
- 投稿保存 `publication_basis`，允许 `standard`、`admin_override`，未发布记录为 `NULL`。
- 普通 `approve` 写入 `standard`；`force_publish` 写入 `admin_override`；删除和恢复不得把旧发布依据伪装成新扫描结论。
- 管理员详情返回发布依据和原始审核结果。
- 公开共享包列表、详情和下载前响应返回 `publicationBasis`。值为 `admin_override` 时，页面和下载入口附近显示“管理员人工放行，未通过系统安全验证”。
- 普通反馈和建议没有角色包 Scanner，沿用标准发布依据；它们可以从 `system_reviewing` 手动转人工并普通批准，不显示共享包下载风险提示。

## 5. 后到扫描结果

审核 worker 若已领取共享包，而管理员随后强制发布，worker 完成后仍应原子追加有限扫描结果并更新风险摘要。该专用分支只接受 `published + admin_override`，不得签发新的发布动作，不得修改状态版本、发布依据或管理员审计。危险结论应使管理界面持续显示高风险警告，但不能自动隔离、删除或下架。

## 6. 失败处理与安全

- 管理员身份、版本、幂等键、理由或风险确认任一无效时失败关闭。
- 普通批准缺少有效证据时继续返回 `TECHNICAL_SCAN_REQUIRED`；客户端不得自动降级为强制发布。
- 强制发布事务必须同时写投稿状态、发布依据和审计；任一写入失败全部回滚。
- 公开风险标记来自数据库发布依据，不从当前扫描结果临时推断，避免后到结果改变历史裁决含义。
- 日志和公开 DTO 不包含管理员邮箱、私有对象键、签名 URL、原始密钥或完整内部错误。

## 7. 减法与替代

- 删除“共享包 `move_to_manual` 必须回 `system_reviewing`”的旧分支和测试。
- 不给 `approve` 增加可选绕过布尔值，不保留两种强制发布入口。
- 不增加第二套审核状态机；仍复用既有管理员动作 RPC、状态版本、幂等键和审计表。
- 管理端不再以禁用普通批准作为唯一处理方式；缺证据时明确提供独立强制发布流程。

## 8. 验收

1. 共享契约拒绝缺少/错误风险确认的 `force_publish`，也拒绝普通动作携带额外确认字段。
2. 反馈、建议和共享包都可从 `system_reviewing` 转人工；共享包从 `auto_rejected` 转人工后不重写危险扫描结论。
3. 普通批准仍验证完整归档身份、24 小时 TTL 和状态版本。
4. 共享包可在无有效通过证据时通过两步操作强制发布，并保存 `admin_override` 与完整审计。
5. 后到危险扫描结果不会改变已强制发布状态，但会出现在管理员风险信息中。
6. 公开列表、详情和下载响应及页面都显示管理员人工放行标记。
7. 生产 PostgreSQL 与内存 Adapter 对状态、版本、幂等、错误码、发布依据和后到结果行为一致。
8. 临时 PostgreSQL 从全部历史 migration 顺序执行，事务回滚与重复请求行为通过真实 SQL 验证。
9. 相关 package 测试、typecheck、网站 E2E、fast 网站链、scope、ownership 和 `git diff --check` 通过；Docker 与远端部署继续按真实环境状态记录。
