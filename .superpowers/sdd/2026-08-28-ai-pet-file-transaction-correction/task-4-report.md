# Task 4 报告：清理旧字段并完成门禁

## 状态快照

- 日期：2026-08-28
- 起始基线：6301a6b
- 当前状态：已完成旧测试夹具清理、全门禁复跑、验收文档同步与提交前差异审查。

## 清理范围

- `apps/desktop/tests/main-agent-session-factory.test.ts`：删除输入夹具中的 `fileDisclosureAllowed`，并把读取端口用例名称改为现行契约表述。
- `apps/desktop/tests/agent-service.test.ts`：删除 `createHarness` 中只服务旧文件披露 gate 的布尔参数、会话扩展字段与分支；同步改写相关调用点与用例名称。
- `apps/desktop/tests/capability-transaction.test.ts`：复核后未发现 `providerId`、`authorizationRootId` 或 `fileDisclosureAllowed` 旧字段，因此保持不变。
- `docs/operations/lightweight-agent-acceptance.md`：新增“2026-08-28 文件事务纠偏最终收口验收”小节，只记录本轮实际命令、计数、环境与未覆盖项。

## 保留项说明

- `apps/desktop/tests/agent-service.test.ts` 仍保留 1 处 `ProviderProfileV2.providerId`。该字段是 `packages/shared-types/src/contracts.ts` 中现行 `providerProfileV2Schema` 的 `preset` profile 必填字段，用于构造内置本地模型 profile，不属于要删除的旧测试夹具字段。
- 本轮未修改任何生产兼容契约来迁就测试，也未触碰 Task 3 已登记的两个 deferred Minor。

## 验证结果

- 定向复核：`pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/main-agent-session-factory.test.ts tests/agent-service.test.ts tests/capability-transaction.test.ts`：退出码 `0`，3 个测试文件、133 项通过。
- `pnpm.cmd --filter @myself/agent-core test`：退出码 `0`，4 个测试文件、100 项通过。
- `pnpm.cmd --filter @myself/agent-core typecheck`：退出码 `0`。
- `pnpm.cmd --filter @myself/desktop test`：退出码 `0`，107 个测试文件、2830 项通过。
- `pnpm.cmd --filter @myself/desktop typecheck`：退出码 `0`。
- `pnpm.cmd test:security`：退出码 `0`，1 个测试文件、28 项通过。
- `pnpm.cmd test:integration`：退出码 `0`，4 个测试文件、92 项通过。
- `pnpm.cmd verify:desktop`：退出码 `0`；workspace typecheck 覆盖 10/11 个存在脚本的项目，单元测试 136 个测试文件、3546 项通过，安全测试 28/28，集成测试 92/92，生产构建与边界校验通过，Electron E2E 77 通过、1 跳过、0 失败。
- `git diff --check`：提交前最终执行，退出码 `0`；仅有 LF/CRLF 提示，没有 whitespace error。

## 自审

- 清理严格限定在测试夹具与验收文档，没有扩大到生产实现、共享契约或权限边界。
- 所有门禁均为本轮新鲜运行结果；报告没有把真实外部 Provider 网络、真实 GGUF 推理或人工窗口观察写成通过。
- 角色包恢复码与 jsdom canvas 提示继续作为既有测试中的受控 stderr 存在，但相关 suite 与门禁最终均退出 `0`。

## Concerns

- 无功能性阻塞。
- 待用户人工确认：真实外部 Provider 网络、真实本地 GGUF/CPU/Vulkan 模型、真实 Windows 窗口交互/观感、真实回收站恢复与用户目录人工文件操作。
