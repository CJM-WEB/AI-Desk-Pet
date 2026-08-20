# Task 2：SubmissionService 投稿止血报告

日期：2026-08-20

## 范围

- `SubmissionService.prepare()` 在任何输入校验、状态令牌生成、投稿持久化和上传签名之前检查共享包投稿开关。
- 生产 API 显式装配 `CloudConfig.sharedPackageSubmissionsEnabled`。
- 覆盖关闭时的零持久化、零上传签名，以及 API 的稳定 503 失败信封。

未涉及管理端、SQL、UI、部署或真实外部调用。

## RED

先调整测试 fixture，使成功路径显式传入 `sharedPackageSubmissionsEnabled: true`，并新增关闭路径测试。执行：

```powershell
pnpm.cmd --filter @myself/cloudbase-api test -- submission-service.test.ts
```

结果：退出码 1。关闭测试收到 `this.createId is not a function`，既有成功路径同样失败，原因是生产构造函数尚未接收新 options，第三个参数仍被当作 `createId`。这证明测试能够捕获缺失的构造函数和门禁实现。

## GREEN 与回归

最小实现新增 `SubmissionServiceOptions`，并在 `prepare()` 的第一项业务动作中抛出 `SHARED_PACKAGE_SUBMISSIONS_PAUSED/503`；生产组合显式传入配置开关。

执行：

```powershell
pnpm.cmd --filter @myself/cloudbase-api test -- submission-service.test.ts api.test.ts cloudbase-postgres.test.ts
pnpm.cmd --filter @myself/cloudbase-api typecheck
git diff --check
```

结果：测试退出码 0，19 个测试文件、202 项测试通过；类型检查退出码 0；`git diff --check` 无输出。测试进程仍打印 Node `punycode` 弃用警告，来自现有依赖，未改变测试结果。

## 净变更与自审

- 源码和测试净变更：新增 89 行，删除 15 行，净增 74 行（不含本报告）。
- 关闭检查位于 `validatePrepareInput()`、`createStatusToken()`、`createSubmission()` 和上传签名调用之前。
- 关闭测试断言没有创建记录且没有签发上传地址；API 测试断言 `data: null`、错误码和 503。
- 两个直接测试构造器和全部服务测试成功路径均显式传入 `true`；生产装配从配置读取，未依赖隐式默认值。
- 未发现需要重构的重复逻辑。

## 独立审查

审查曾发现 fixture 默认开启投稿会掩盖装配契约的问题。已删除默认参数，并逐一显式传入开启选项；随后重新运行上述测试、类型检查和差异检查，均保持通过。

## 提交

提交消息：`feat: 关闭无授权共享包投稿`。
