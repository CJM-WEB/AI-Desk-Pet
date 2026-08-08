# 移除匿名投稿 CAPTCHA 实施计划

> **执行要求：** 实施时使用测试驱动方式逐项完成；当前未获得 Git 写操作授权，因此本计划不执行提交、推送或分支操作。

**目标：** 完整移除资源包投稿与反馈／建议投稿的 CAPTCHA 依赖，同时保留 IP 限流、审核流程和管理员邮箱 OTP。

**架构：** 前端投稿组件直接调用仓库，仓库只发送业务字段；后端 HTTP 入口继续执行来源 IP 限流，然后把无 CAPTCHA 的业务输入交给投稿服务。删除不再使用的验证码客户端、验票适配器、接口类型和运行配置，生产数据库历史迁移保持不变。

**技术栈：** Next.js 15、React 19、TypeScript、Vitest、CloudBase SCF、CloudBase PostgreSQL。

## 全局约束

- 管理员邮箱 OTP 不做任何修改。
- `/api/v1` 路径、投稿回执、上传和审核状态不变。
- IP 限流、内容审核、资源包扫描和管理员审批保持启用。
- 不回滚或删除已经执行的数据库迁移和 `captcha_replays` 表。
- 文档和新增结构性注释使用中文。
- 只修改 CAPTCHA 相关代码，不处理其他部署缺口。
- 不执行任何 Git 写操作。

---

### 任务 1：用失败测试定义无 CAPTCHA 的后端投稿契约

**文件：**
- 修改：`apps/cloudbase-api/tests/api.test.ts`
- 修改：`apps/cloudbase-api/tests/submission-service.test.ts`
- 修改：`apps/cloudbase-api/tests/text-submission-service.test.ts`

**接口：**
- `SubmissionService` 构造函数目标签名：`new SubmissionService(store, storage, createId?)`
- `TextSubmissionService` 构造函数目标签名：`new TextSubmissionService(store, createId?)`
- `PrepareSharedPackageInput` 与 `TextSubmissionInput` 不再含 `captcha`

- [ ] 将“匿名 prepare 缺少 CAPTCHA 返回 400”改为“匿名 prepare 无 CAPTCHA 仍进入投稿服务”，请求正文只保留资源包业务字段，并断言 `submissions.prepare` 被调用。
- [ ] 修改反馈 API 测试，请求正文不传 `captcha`，断言仍执行 `submission_prepare` 限流并调用 `textSubmissions.submit`。
- [ ] 修改两个服务测试的 fixture，移除 `captcha.verify` mock，并断言合法业务输入能够创建投稿。
- [ ] 运行：

  ```powershell
  pnpm.cmd --dir apps/cloudbase-api exec vitest run --config vitest.config.ts tests/api.test.ts tests/submission-service.test.ts tests/text-submission-service.test.ts
  ```

  预期：测试因生产类型仍要求 `captcha`、构造函数仍要求验票器或 API 仍拒绝缺失字段而失败。

---

### 任务 2：最小化后端实现并删除验票运行链路

**文件：**
- 修改：`apps/cloudbase-api/src/functions/api.ts`
- 修改：`apps/cloudbase-api/src/services/submission-service.ts`
- 修改：`apps/cloudbase-api/src/services/text-submission-service.ts`
- 修改：`apps/cloudbase-api/src/config.ts`
- 修改：`apps/cloudbase-api/src/ports.ts`
- 修改：`apps/cloudbase-api/src/adapters/cloudbase-postgres.ts`
- 删除：`apps/cloudbase-api/src/adapters/tencent-captcha.ts`
- 删除：`apps/cloudbase-api/tests/tencent-captcha.test.ts`
- 修改：`apps/cloudbase-api/tests/config.test.ts`
- 修改：`apps/cloudbase-api/tests/cloudbase-runtime.test.ts`
- 修改：`apps/cloudbase-api/tests/cloudbase-postgres.test.ts`
- 修改：`apps/cloudbase-api/tests/support/cloudbase-production.ts`

**实现：**
- 从两个 API 分支删除 `captchaProofSchema.safeParse(body.captcha)`，保留 `requestRecord`、`requireSourceIp` 和 `abuseControl.consume`。
- 从两个投稿输入类型、验证函数、构造函数和执行流程删除 `CaptchaProof` 与 `CaptchaVerifier`。
- 从生产依赖装配中删除 `createTencentCaptchaClient` 与 `TencentCaptchaVerifier`，改为：

  ```ts
  submissions: new SubmissionService(store, storage),
  textSubmissions: new TextSubmissionService(store)
  ```

- 从 `CloudConfig` 和 `loadCloudConfig` 删除 `captchaAppId`、`captchaSecretKey` 以及两项必填读取。
- 删除只服务 CAPTCHA 的 `CaptchaVerifier`、票据防重放端口和 PostgreSQL 适配器方法；数据库迁移文件保持不变。
- 删除专用适配器与专用测试文件，清理所有相关 import。
- [ ] 实施上述最小代码变更。
- [ ] 运行任务 1 的测试，预期全部通过。
- [ ] 运行：

  ```powershell
  pnpm.cmd --filter @myself/cloudbase-api typecheck
  pnpm.cmd --filter @myself/cloudbase-api test
  ```

  预期：类型检查通过，后端完整测试零失败。

---

### 任务 3：用失败测试定义无 CAPTCHA 的前端投稿契约

**文件：**
- 修改：`apps/website/tests/shared-pet-chapter.test.tsx`
- 修改：`apps/website/tests/support-chapter.test.tsx`
- 修改：`apps/website/tests/cloud-shared-pet-repository.test.ts`
- 修改：`apps/website/tests/cloud-feedback-repository.test.ts`

**接口：**
- `SharedPetRepository.submit(input, onProgress?)`
- `FeedbackRepository.create(input)`

- [ ] 删除测试组件注入的 `captcha`，断言点击资源包或反馈提交后仓库仍被调用。
- [ ] 修改云端仓库请求断言，要求 JSON 正文不包含 `captcha`。
- [ ] 运行：

  ```powershell
  pnpm.cmd --dir apps/website exec vitest run --config vitest.config.ts tests/shared-pet-chapter.test.tsx tests/support-chapter.test.tsx tests/cloud-shared-pet-repository.test.ts tests/cloud-feedback-repository.test.ts
  ```

  预期：测试因组件和仓库接口仍要求 CAPTCHA 而失败。

---

### 任务 4：移除前端 CAPTCHA 模块与参数传递

**文件：**
- 修改：`apps/website/components/website-experience/chapter-registry.tsx`
- 修改：`apps/website/components/website-experience/community/SharedPetChapter.tsx`
- 修改：`apps/website/components/website-experience/community/shared-pet-types.ts`
- 修改：`apps/website/components/website-experience/community/cloud-shared-pet-repository.ts`
- 修改：`apps/website/components/website-experience/community/indexed-db-shared-pet-repository.ts`
- 修改：`apps/website/components/website-experience/support/SupportChapter.tsx`
- 修改：`apps/website/components/website-experience/feedback/feedback-types.ts`
- 修改：`apps/website/components/website-experience/feedback/cloud-feedback-repository.ts`
- 删除：`apps/website/lib/captcha.ts`
- 删除：`apps/website/tests/captcha.test.ts`

**实现：**
- 注册表不再创建或注入 `CaptchaClient`。
- 两个章节删除 `captcha` prop、ref 和 `verify()` 调用，直接调用：

  ```ts
  await repository.submit(validation.value, setUploadProgress);
  await repository.create(validation.value);
  ```

- 两类仓库接口和实现删除 CAPTCHA 参数，请求正文只序列化业务输入。
- IndexedDB 测试适配器同步调整签名，避免保留无意义占位参数。
- 删除浏览器验证码模块、脚本加载逻辑和专用测试。
- [ ] 实施上述最小代码变更。
- [ ] 运行任务 3 的测试，预期全部通过。
- [ ] 运行：

  ```powershell
  pnpm.cmd --filter website typecheck
  pnpm.cmd --filter website test
  ```

  预期：类型检查通过，前端完整测试零失败；管理员 OTP 测试仍通过。

---

### 任务 5：删除共享类型、更新声明并证明没有残留

**文件：**
- 修改：`packages/shared-types/src/moderation.ts`
- 修改：`packages/shared-types/tests/moderation.test.ts`
- 修改：`docs/operations/cloudbase-deployment.md`
- 修改：`apps/website/public/legal/privacy.html`

**实现：**
- 删除 `captchaProofSchema` 与 `CaptchaProof` 导出及测试。
- 部署文档删除 CAPTCHA 开通、前后端变量、域名和验票要求；明确匿名投稿依靠 IP 限流、审核与管理员审批。
- 隐私说明删除 CAPTCHA 结果处理声明，保留 IP／设备风控派生标识说明。
- [ ] 修改共享类型、测试与文档。
- [ ] 运行残留扫描：

  ```powershell
  rg -n "CaptchaClient|CaptchaVerifier|CaptchaProof|captchaProofSchema|NEXT_PUBLIC_CAPTCHA|CAPTCHA_APP_ID|CAPTCHA_SECRET_KEY|TCaptcha.js|body\.captcha|captcha:" apps/website apps/cloudbase-api/src packages/shared-types docs/operations/cloudbase-deployment.md
  ```

  预期：生产代码和部署文档零命中；数据库历史迁移及历史设计文档不纳入扫描范围。
- [ ] 运行：

  ```powershell
  pnpm.cmd --filter @myself/shared-types test
  pnpm.cmd --filter @myself/shared-types typecheck
  pnpm.cmd --filter website typecheck
  pnpm.cmd --filter @myself/cloudbase-api typecheck
  ```

  预期：全部通过。

---

### 任务 6：生产构建、部署和线上验收

**文件：**
- 构建产物：`apps/cloudbase-api/dist/**`
- 构建产物：`apps/website/out/**`

**步骤：**
- [ ] 使用现有环境 ID、`ap-singapore` Publishable Key 和 `/api/v1` 构建网站，不再注入 `NEXT_PUBLIC_CAPTCHA_APP_ID`。
- [ ] 执行：

  ```powershell
  pnpm.cmd build:cloudbase
  pnpm.cmd --filter website build
  ```

- [ ] 部署 `ai-pet-api`，不启用自动审核 worker；保留其他函数现状。
- [ ] 部署 `apps/website/out` 到当前 CloudBase 静态托管。
- [ ] 从三个云函数环境变量中删除 `CAPTCHA_APP_ID` 与 `CAPTCHA_SECRET_KEY`，再确认函数配置可正常加载。
- [ ] 线上验证公开列表返回 200、管理员接口未登录返回 401、管理员 OTP 请求仍能返回 challenge。
- [ ] 提交一条内容明确标注为验收测试的合法反馈，确认不弹出 CAPTCHA、接口返回投稿回执且状态为待审核；验收后由管理员删除该测试投稿，不公开。
- [ ] 重新扫描线上 JavaScript，确认没有 `TCaptcha.js`、CAPTCHA App ID 或 CAPTCHA 错误码。
