# Task 4：共享包发布数据库防线报告

日期：2026-08-20
范围：CloudBase PostgreSQL 前向迁移、内存测试适配器与契约测试。

## RED → GREEN 记录

1. 新增“待人工共享包缺少当前扫描证据”测试后，`apply_admin_action` 在 `MemoryRdb` 中错误返回发布结果，未返回 `P1003`。
2. 新增前向迁移契约测试后，因迁移文件不存在而失败。
3. 最小实现加入精确的投稿、包对象键、实际包大小、状态版本和扫描码匹配；无匹配时返回 `P1003`，由已有仓储映射为 `TECHNICAL_SCAN_REQUIRED/409`。
4. 复核时新增“未完成资产伪造 `packageSizeBytes: "null"`”测试。该测试在适配器将空值字符串化时失败；最小修复要求 `actual_size` 非空后通过，与 PostgreSQL 的 `NULL` 比较语义一致。

## SQL 安全核对

- 新迁移以 `BEGIN;`/`COMMIT;` 包裹，并使用 `CREATE OR REPLACE FUNCTION apply_admin_action(...)`。
- 保留 service_role 校验、advisory transaction lock、幂等旧结果优先返回、清理栅栏、状态版本 fence、审计写入和公开互动幂等写入。
- 扫描门仅收紧为：所有非 `published` 的 `shared_package` 批准动作均要求当前隔离扫描证据；证据同时绑定投稿 ID、包对象键、实际大小、请求版本和扫描成功码。
- 函数执行权限重新收回 `PUBLIC`、`anon`、`authenticated`，仅授予 `service_role`。
- 未连接数据库、未执行迁移、未部署。历史迁移 `20260730000000_moderation.sql`、`20260807000000_public_like_kinds.sql`、`20260808000000_direct_manual_review.sql` 的 Git 差异为空。

## 验证结果

```powershell
pnpm.cmd --filter @myself/cloudbase-api test -- cloudbase-postgres.test.ts
# 19 个测试文件、210 项测试通过

pnpm.cmd --filter @myself/cloudbase-api typecheck
# tsc --noEmit 通过

git diff --check
# 通过
```

验收状态：仓库契约自动化通过；CloudBase PostgreSQL 运行待阶段 2 开发环境确认。

## 文件与提交

- `apps/cloudbase-api/tests/cloudbase-postgres.test.ts`
- `cloudbase/migrations/20260815000000_shared_package_publication_guard.sql`
- `.superpowers/sdd/2026-08-15-website-publication-stopgap-and-migration-freeze/task-4-report.md`
- 净新增 399 行：测试 155 行、前向迁移 203 行、报告 41 行；提交信息：`feat: 增加共享包发布数据库防线`。

## 修复轮次 1

- RED：数值形式的 `packageSizeBytes` 与 `submissionStatusVersion` 虽满足 PostgreSQL `jsonb ->>` 的文本比较语义，却被 MemoryRdb 的严格类型比较错误拒绝为 `P1003`。
- GREEN：测试适配器仅将字符串或有限数值 JSON 标量转换为文本；缺失值、对象、数组、布尔值和非有限数值均不匹配。新增成功路径验证数值证据可将共享包发布。
- 验证：`pnpm.cmd --filter @myself/cloudbase-api test -- cloudbase-postgres.test.ts` 通过（19 个测试文件、211 项测试）；`pnpm.cmd --filter @myself/cloudbase-api typecheck` 与 `git diff --check` 通过。
- 提交：仅 `apps/cloudbase-api/tests/cloudbase-postgres.test.ts` 纳入 `test: 对齐数据库扫描证据语义`；本报告不纳入该修复提交。
