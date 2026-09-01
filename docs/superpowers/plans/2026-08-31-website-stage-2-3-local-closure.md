# 网站阶段 2—3 本地闭环实施计划

> 规格：`docs/superpowers/specs/2026-08-31-website-stage-2-3-local-closure-design.md`
> 方法：SDD、RED → GREEN → REFACTOR、子智能体实现后规格与质量双审查
> 超时：单一问题或命令超过 15 分钟即停止，保留证据并切换方案

## 0. 旧计划处置与阶段门

冲突时以 2026-08-31 差量规格和本计划为准。

| 旧条款 | 处置 |
| --- | --- |
| 阶段 2 Task 1 自定义 context 与 `accessKey` | 退役；使用已安装 V3 Node context 类型，API Key 只属于 PostgreSQL RPC |
| 阶段 2 Task 3/6 丢弃审核信号的新 DTO | 退役；保留受限 `jsonTexts`、`imageSignals` 并增加归档身份 |
| 阶段 2 Task 5 `apply-cloudbase-migrations*` | 整项退役；旧入口继续禁止，改用 manager SDK user migration Adapter |
| 阶段 2 Task 7 远程部署与开关 | 移至阶段 2C，当前不执行 |
| 阶段 3 Task 1 错误 message、可选 requestId | 退役；错误只保留 code/retry，requestId 必填 |
| 阶段 3 Task 2 宽回执 | 替换为 prepare=uploading+targets、finalize=system_reviewing、feedback=system_reviewing |
| 阶段 3 Task 5 修改 `tests/vitest.config.ts` | 退役；使用网站链专属配置和 catalog |
| 阶段 3 其余 endpoint 严格 Schema、双 Adapter 与验收文件 | 继续有效，由下列精确任务实施 |

恢复普通非投稿开发的联合门：阶段 2A 本地结构、阶段 2B 容器/临时 PostgreSQL 候选、阶段 3 契约均为 `pass`。任一为 `blocked`、`unverified` 或 `fail` 时继续冻结。阶段 2C 不阻塞普通非投稿开发，但始终阻塞投稿开启、远程 migration 和上线声明。

## Task 0：事实来源与精确范围门

> 状态：2026-08-31 已完成；定向范围测试 15/15，scope 通过，提交 `0f24373`。

**Files:**
- Modify: `tools/verification/website-scope-policy.mjs`
- Modify: `tools/verification/verify-website-scope.test.mjs`
- Modify: `tools/verification/web-chain-catalog.test.mjs`
- Modify: `docs/superpowers/plans/2026-08-15-website-optimization-index.md`

**依赖：** 无。

1. RED：只为本 Task 实际存在或新增的精确路径写范围期望。运行 `node --test tools/verification/verify-website-scope.test.mjs tools/verification/web-chain-catalog.test.mjs`，确认因阶段 2/3 文档和最小基础路径尚未登记而失败。
2. GREEN：历史策略中的 `apps/website/**`、`apps/cloudbase-api/**` 继续按网站业务域放行；Scanner、shared-types、contract、migration 工具等新增根目录必须由所属 Task 先写 scope RED，再增加精确文件或最小文件簇。禁止目录保持优先拒绝。
3. 时序约束：Task 0 不提前激活尚不存在的 `tests/website-contract` 目录或 catalog step；Task 7 在同一 GREEN 中创建合同测试、修改 `verify-web-test-ownership.mjs` 并登记活跃 owner/目录/step。
4. 完成标准：上述测试及 `pnpm.cmd verify:web-chain:scope` 通过；不修改任何桌面测试配置。

## Task 1：V3 SDK 与三函数最小配置

> 状态：2026-08-31 已完成；CloudBase API 210/210、typecheck、三函数 build、构建工具 3/3 与 scope 均通过。独立规格和质量复审无阻塞项。

**Files:**
- Modify: `apps/cloudbase-api/package.json`, `pnpm-lock.yaml`
- Modify: `apps/cloudbase-api/tsconfig.json`
- Modify: `apps/cloudbase-api/src/adapters/cloudbase-runtime.ts`
- Modify: `apps/cloudbase-api/src/adapters/tencent-content-moderation.ts`
- Modify: `apps/cloudbase-api/src/functions/api.ts`, `moderation-worker.ts`, `cleanup.ts`
- Modify: `apps/cloudbase-api/src/config.ts`
- Modify: `apps/cloudbase-api/tests/cloudbase-runtime.test.ts`, `config.test.ts`, `api.test.ts`, `moderation-worker.test.ts`, `cleanup-service.test.ts`, `submission-service.test.ts`, `build-output.test.ts`
- Modify: `apps/cloudbase-api/tests/support/cloudbase-production.ts`
- Modify: `tools/build-cloudbase-functions.mjs`, `tools/build-cloudbase-functions.test.mjs`

**依赖：** Task 0。

1. 调查：读取 V3 `index.node.d.ts/core.node.d.ts`，锁定 `eventID`、`extendedContext.tmpSecret`；不得臆造 context。
2. RED：测试三个入口传递真实收窄 context；三个 loader 各自只要求所需变量；缺省投稿开关关闭；源码不含 Node SDK/accessKey。
3. RED 命令：`pnpm.cmd --filter @myself/cloudbase-api test -- tests/cloudbase-runtime.test.ts tests/config.test.ts tests/api.test.ts tests/moderation-worker.test.ts tests/cleanup-service.test.ts`，预期因旧 SDK、入口未传 context 和聚合 loader 失败。
4. GREEN：保留单一 `config.ts` 作为内部读取模块，并从该文件导出三个函数专属 loader；迁移 V3。
5. REFACTOR：删除 `@cloudbase/node-sdk`、旧初始化与聚合配置测试。
6. 构建门：直接 V3 ESM 入口必须可 bundle/load；按实际动态加载只补必要的直接依赖，不依赖旧 Node SDK 的传递依赖。
7. 完成标准：CloudBase API test/typecheck/build 与 `node --test tools/build-cloudbase-functions.test.mjs` 全通过。

## Task 2：唯一 ScannerProtocol

> 状态：2026-08-31 已完成；shared-types 37/37、Scanner 69/69、CloudBase API 211/211，三包 typecheck、CloudBase build、scope 与依赖审查通过。独立规格和质量复审无阻塞项。

**Files:**
- Create: `packages/shared-types/src/scanner-protocol.ts`, `packages/shared-types/tests/scanner-protocol.test.ts`
- Modify: `packages/shared-types/package.json`, `.dependency-cruiser.mjs`, `.dependency-cruiser.web.mjs`
- Modify: `apps/package-scanner/package.json`, `apps/package-scanner/README.md`
- Modify: `apps/package-scanner/src/server.ts`, `request-signature.ts`, `scan-package.ts` 及对应测试
- Modify: `apps/cloudbase-api/src/adapters/scanner-client.ts`, `apps/cloudbase-api/src/ports.ts`, `apps/cloudbase-api/tests/scanner-client.test.ts`
- Modify: `tools/verification/web-dependency-audit.test.mjs`

**依赖：** Task 1。

1. RED：严格协议/规则版本、submissionId、完整归档身份、审核信号、错误响应、canonical 签名与临时 socket 往返。
2. RED 命令：`pnpm.cmd --filter @myself/shared-types test -- tests/scanner-protocol.test.ts`，预期公共子路径不存在。
3. GREEN：导出 `@myself/shared-types/scanner-protocol` 并迁移两端。
4. REFACTOR：删除客户端重复 Schema、服务端手写 body 判断和重复签名格式。
5. 完成标准：shared-types、Scanner、CloudBase API 的 test/typecheck 全通过，角色 owner 零差异。

## Task 3：Node 22 容器候选（阶段 2B 第一门）

> 状态：2026-08-31 已完成；Scanner 71/71、候选验证器 7/7、typecheck、build、scope 与独立复审通过。修复探针归档身份后，真实不可变 Node 22 镜像以 UID 999 通过 Docker HEALTHCHECK、EICAR 与 timeout 门；阶段 2B 第一门 PASS。

**Files:**
- Modify: `apps/package-scanner/vite.build.config.ts`, `apps/package-scanner/Dockerfile`
- Create/Modify: `apps/package-scanner/tests/build-output.test.ts`, `dockerfile.test.ts`
- Create: `tools/verification/verify-scanner-candidate.mjs`, `verify-scanner-candidate.test.mjs`
- Modify: `package.json`, `tools/verification/web-chain-catalog.mjs`

**依赖：** Task 2；需要 Docker 或等价容器运行时。

1. RED：Node target、bundle 可加载、非 root UID、health、EICAR、timeout 和镜像 ID 报告。
2. GREEN：target 改 Node 22，建立 `verify:scanner-candidate`；真实行为测试接管后删除重复静态文本断言。
3. 命令：`pnpm.cmd --filter @myself/package-scanner build`、`pnpm.cmd verify:scanner-candidate`。
4. 完成标准：两命令通过；没有容器运行时时记录 `blocked`，阶段 2B 与恢复开发门不得写成通过。

## Task 4：受控 migration Adapter

> 状态：2026-08-31 已完成；CloudBase 工具 34/34、Adapter/编排器 15/15、快速网站链、scope、ownership 与独立安全复审通过。仅验证本地编排和 SDK 边界，未调用任何远端环境。

**Files:**
- Create: `tools/cloudbase-user-migrations.mjs`, `cloudbase-user-migrations.test.mjs`
- Create: `tools/cloudbase-user-migration-adapter.mjs`, `cloudbase-user-migration-adapter.test.mjs`
- Modify: `tools/cloudbase-migration-inventory.mjs`, `cloudbase-migration-inventory.test.mjs`
- Modify: `package.json`, `tools/verification/website-scope-policy.mjs`
- Must remain absent: `tools/apply-cloudbase-migrations.mjs`, `apply-cloudbase-migrations.test.mjs`

**依赖：** Task 0；已核对 manager SDK 5.6.5 的 preview/push/describe task API。

1. RED：只接受显式 development；映射 inventory SQL；冲突失败；Accepted/Running 轮询；Failed 失败；Succeed 完成；再次调用走预览的续跑编排；只读 CLI 不加载 manager SDK。
2. RED 命令：`node --test tools/cloudbase-user-migrations.test.mjs tools/cloudbase-user-migration-adapter.test.mjs`，预期模块不存在。
3. GREEN：纯计划模块与远端 Adapter 分离；不创建默认远端 CLI，不连接环境。
4. REFACTOR：复用现有 inventory，删除重复排序/checksum 代码。
5. 完成标准：上述测试和旧只读 dry-run 测试通过；只声称本地编排可审计，真实锁/事务/续跑留给 2C。

## Task 5：状态流、完整 ZIP 证据与临时 PostgreSQL（阶段 2B 第二门）

> 状态：2026-08-31 已完成并通过独立复审。随后获批的管理员覆盖规格只替代管理动作边界：`move_to_manual` 可直接进入 `manual_review_pending`，`force_publish` 独立于技术扫描结论；普通 `approve` 的当前归档、状态版本与 24 小时证据 TTL 仍保持不变。最终数据库基线为 7 个不可变前向 migration、42 项真实行为验证。

**Files:**
- Create: `cloudbase/migrations/20260831000000_restore_scanned_submission_flow.sql`
- Modify: `packages/shared-types/src/moderation.ts`, `packages/shared-types/tests/moderation.test.ts`
- Modify: Scanner 的 `server.ts`, `scan-package.ts` 及对应测试
- Modify: CloudBase API 的 `ports.ts`、Scanner/PostgreSQL Adapter、submission/moderation/admin service 及对应测试
- Modify: website 的 cloud shared repository、submission status 及对应测试
- Modify: `tests/memory-website-api.mjs`, `tests/e2e/website.spec.ts`
- Create: `tools/test-cloudbase-migrations.mjs`, `test-cloudbase-migrations.test.mjs`
- Modify: `docs/operations/content-moderation.md`

**依赖：** Tasks 2、4；用户提供 TTL 正整数与单位；本地 PostgreSQL 或等价容器。

1. RED：uploading→system_reviewing→manual/auto；完整 ZIP SHA-256；证据逐字段、TTL、状态版本拒绝；临时失败隐藏。
2. RED 命令：Scanner、CloudBase API、website 三组定向测试；预期当前直接 manual、弱证据和伪造 memory 状态失败。
3. GREEN：实现流式归档身份、服务状态机和不可变前向 SQL。
4. 数据库 RED/GREEN：临时 PostgreSQL 从全部历史 migration 顺序执行，验证函数、约束、批准拒绝和事务失败回滚；不得用字符串包含代替。
5. REFACTOR：删除直接人工审核、弱证据和旧断言；历史 migration 不改。
6. 完成标准：四个 package 定向门和临时 PostgreSQL 行为门通过；缺 TTL/PostgreSQL 时为 `blocked`。

## Task 6：共享 HTTP 信封与逐 endpoint 契约

> 状态：2026-08-31 已完成；实现范围 `334f7dc..9d35815`，规格与工程标准双审查均为 PASS、0 个 finding。最终门禁为 shared-types 50/50、website 348/348、CloudBase API 269/269、Scanner 71/71、浏览器 E2E 21/21；PostgreSQL 17.11 顺序执行 7 个 migration 并通过 42 项行为验证。旧本地 Envelope、`request<unknown>` 与重复 endpoint DTO/Schema 已删除；未执行 Docker full、远端 migration 或部署。

**Files:**
- Create: `packages/shared-types/src/website-http.ts`, `packages/shared-types/tests/website-http.test.ts`
- Modify: `packages/shared-types/package.json`, `.dependency-cruiser.mjs`, `.dependency-cruiser.web.mjs`
- Modify: `tools/verification/web-dependency-audit.test.mjs`, `website-scope-policy.mjs`, `verify-website-scope.test.mjs`
- Modify: website 的 `api-client.ts`, `submission-status.ts`, `admin-api-client.ts`、两个 cloud repository 及对应测试
- Modify: CloudBase API 的 `functions/api.ts`, `errors.ts` 及对应测试

**依赖：** Task 5 的最终状态与 admin evidence 形状。

1. RED：必填 requestId；data/error 互斥；extra key、畸形 data、非 JSON、错误 HTTP+畸形信封均失败关闭。
2. 精确请求与响应：共享子路径同时提供 prepare、feedback、status 的 strict 请求 Schema，删除双重断言；prepare=`uploading+cover/package targets`；finalize=`system_reviewing`；feedback=`system_reviewing`；status=公开状态；公开 list/detail/like/download 与 admin queue/detail/action（含独立 `force_publish` 风险确认和 `publicationBasis`）全部 strict。
3. GREEN：唯一 `ApiClient.request(path, schema, init)`；服务端发送前 strict parse，失败经 `normalizeError` 返回不泄露原对象的 500 `INTERNAL_ERROR`。
4. REFACTOR：删除本地 Envelope、`request<unknown>`、重复 DTO/Schema、无消费者 error message 和手工 wire 投影。
5. 完成标准：shared-types、website、CloudBase API test/typecheck 通过，残余检索为零。

## Task 7：生产与内存双 Adapter 行为契约

> 状态：2026-08-31 已完成；实现范围 `51f6d0e..0c111de`，规格与工程标准双审查均为 PASS、0 个 finding。唯一共享套件在生产 `createApi` 与真实 localhost Memory driver 上共 12/12 通过；合同专属严格 TypeScript 门已进入 fast/full。Memory 旧 `Authorization` 与 `ADMIN_*` 兼容路径已删除，并删除一组被共享合同接管的重复 CloudBase 成功案例。最终官网 348/348、CloudBase API 268/268、Scanner 71/71、浏览器 E2E 21/21，PostgreSQL 17.11 的 7 个 migration/42 项行为验证通过。

**Files:**
- Create: `tests/website-contract/website-api-contract.ts`, `production-driver.test.ts`, `memory-driver.test.ts`
- Create: `tests/vitest.web-chain.config.ts`
- Modify: `tests/memory-website-api.mjs`, `tests/e2e/website.spec.ts`, `package.json`
- Modify: `tools/verification/web-chain-catalog.mjs`, `web-chain-catalog.test.mjs`
- Modify: `tools/verification/verify-web-test-ownership.mjs`, `verify-website-scope.test.mjs`, `website-scope-policy.mjs`, `verify-web-chain.test.mjs`

**依赖：** Task 6。

1. RED：两 driver 共用信封、回执、状态、公开内容、`x-ai-pet-admin-token`、401/403、版本和幂等案例。
2. `reset(): ContractFixtureRefs` 建立同构种子并返回已上传投稿 ID、公开内容 IDs、token、version；不暴露数据库 port。
3. GREEN：memory 只增加 reset/固定种子，socket 由测试 driver 管；统一错误码和 requestId。
4. 登记 `WEB_AUDIT_INPUTS`、`WEB_TEST_OWNERS`、scope test directories/exact files、catalog step 和三类验证测试；contract step 只加入 fast，full 继承 fast。
5. REFACTOR：删除 memory 的 Authorization 分支、旧 ADMIN_* 错误码和重复案例。
6. 完成标准：`pnpm.cmd test:website-contract` 与 fast 网站链通过；不修改 `tests/vitest.config.ts`。

## Task 8：总验收与条件裁决

> 状态：2026-08-31 已完成验收与条件裁决；验收记录、运维描述清理与探针修复均经过独立复审。阶段 2A、2B 与阶段 3 PASS，联合门满足，普通非投稿网站功能开发资格恢复；生产未部署且投稿关闭。
>
> 截至 2026-09-01：阶段 2C 本地收窄与验证完成、远端 `blocked`。

**Files:**
- Create: `docs/operations/website-optimization-acceptance.md`
- Modify: 总索引、`docs/operations/cloudbase-deployment.md`, `content-moderation.md`

**依赖：** Tasks 0—7。

1. 运行全部定向门、`verify:cloudbase`、`verify:website`、`verify:scanner-candidate`、临时 PostgreSQL 门、`verify:web-chain`、scope、残余检索和 `git diff --check`。
2. 独立规格审查与代码质量审查均无阻塞项。
3. 分别记录阶段 2A、2B、3，以及截至 2026-09-01 的阶段 2C 本地收窄与验证完成、远端 `blocked`、生产未部署、投稿关闭。
4. 只有 2A/2B/3 全 `pass` 才写“允许恢复普通非投稿网站开发”；否则列出失败项并写“继续冻结”。

## 阶段 2C 后置远程门（不在本轮执行）

CloudBase 开发环境 migration、函数/Scanner 部署、真实事务/锁/续跑、对象身份、网关认证和完整扫描 smoke 全部后置。通过后才可另行决定开发环境投稿开关；生产仍需独立上线计划。
