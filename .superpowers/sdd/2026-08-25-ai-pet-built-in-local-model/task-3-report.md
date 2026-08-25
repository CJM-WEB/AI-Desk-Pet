# Task 3：非思考本地模型 Provider 报告

## 状态

已完成。

## RED 证据

先新增本地请求、工具解码、思考泄漏、连接失效与 Registry 固定 factory 测试，运行：

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/local-model-provider.test.ts tests/provider-contract.test.ts
```

结果：失败。`local-model-provider.ts` 尚不存在；Registry 的 `builtin-local` 档案仍走公开目录并抛出 `PROVIDER_CATALOG_ENTRY_NOT_FOUND`。其余 120 项既有契约通过，证明失败来自 Task 3 能力缺失。

独立复审发现 generation 变化时，网络异常、HTTP 503 与发送前转为未 ready 的失败路径仍可能保留可重试错误。补充三个竞态测试后单独运行 `local-model-provider.test.ts`，结果为 3 项预期失败、7 项通过；实际错误分别为 `LOCAL_MODEL_NOT_READY`、`PROVIDER_NETWORK_ERROR` 与 `PROVIDER_SERVER_ERROR`。

## 实现

- 在既有 `OpenAICompatibleProvider` 增加仅由 Main 构造器注入的 `OpenAIRequestPolicy`，用于附加固定请求字段和在响应归一化前校验原始响应；未配置策略的云 Provider 路径保持不变。
- 新增 `LocalModelConnection`、`LocalModelConnectionPort` 与 `LocalModelProvider`。每次调用读取当前 ready 连接，使用该连接的 Base URL、Token、模型 ID 和 generation。
- 本地请求强制 `reasoningMode: 'disabled'`、`stream:false`、`reasoning_effort:'none'`、`enable_thinking:false`、`parallel_tool_calls:false` 与 `parse_tool_calls:true`。
- 复用既有 OpenAI 消息序列化、工具名 codec、响应 Schema、错误归一化与响应契约，不复制工具协议。
- 在归一化前按字段存在性稳定拒绝 `reasoning_content` 与 `<think>` 区块；`reasoning_content` 只要存在，无论为空字符串、`null` 或非字符串都返回不可重试的 `LOCAL_MODEL_REASONING_LEAK`，错误不携带原始思考正文。
- 初次未 ready 时不发起 fetch；取得初始连接后，在发送前、成功响应后及所有失败完成路径复核同一 generation。连接转为未 ready 或 generation 改变时统一返回不可重试的 `LOCAL_MODEL_CONNECTION_STALE`，不接受迟到结果，也不允许上层把旧请求重试到新连接。
- `ProviderRegistry` 仅在档案与 Main 固定 `builtin-local` 身份逐字段一致时使用注入 factory；伪造 id、providerId、mode、modelId、capabilities 或密钥契约均不会调用 factory。factory 不接收档案 URL、Secret 或 fetch 参数，其余 Provider 继续按原目录协议创建。

## 测试命令与结果

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/local-model-provider.test.ts tests/provider-contract.test.ts
通过：2 个测试文件，142 项测试

pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/local-model-route.test.ts tests/openai-provider.test.ts
通过：2 个测试文件，25 项测试

pnpm.cmd --filter @myself/desktop typecheck
通过：tsc --noEmit 退出码为 0

git diff --check
通过：未报告空白错误，仅有 Git 的 LF/CRLF 提示
```

## 提交

提交信息：`feat(desktop): 接入非思考本地模型 Provider`；最终 commit hash 以提交后的 `git log` 为准。

## 自审

- 三重关闭思考中的请求级两道约束已固定；进程级 `--reasoning off` 属于后续 Runtime 任务，不在本任务提前实现。
- `reasoning_content` 按自有字段存在性判断，与值的真假、类型无关；字段不存在时普通文本保持兼容。`reasoning_content` 与 `<think>` 的稳定错误对象、消息、堆栈及可枚举字段不包含 canary 原始响应。
- 工具定义、历史续传和响应解码仍使用单次请求的既有 `OpenAIToolNameCodec`。
- generation 在 fetch 前变化时不发送；fetch 期间变化时无论返回成功、网络异常或 HTTP 错误，都以不可重试的失效连接结束。
- 请求策略不是 `ProviderProfileV2.additionalParameters`，Renderer 或自定义 Provider 不能写入；策略仅由本地 Main Provider 构造。
- Registry 复用 `local-model-route` 的唯一固定身份谓词，检查完整键集合、显示名、id、providerId、mode、modelId、capabilities 与 `hasStoredSecret`，不接受档案携带的本地 URL、Token 或伪造模型身份；普通 Provider 契约和 OpenAI 精确回归均保持通过。
- 修改范围仅包含 Task 3 Provider、测试与本报告，以及为 Registry 提供单一事实来源所需的 `local-model-route` 固定身份谓词；未修改 SDD ledger，未实现 Runtime、Service、IPC 或 UI。

## concerns

无阻塞 concern。进程启动参数中的 `--reasoning off`、真实 Runtime ready 状态及 Abort HTTP 生命周期由后续 Runtime/Service 任务接入。按计划，Main index 要到 Task 5 才注入本地 factory；在 Task 5 生产组合接线完成前，内置本地 Provider 尚不可从生产路由选用，本任务不提前伪造连接。

## 修复轮 1

最终独立复审要求收紧固定档案身份与思考字段协议。先补充反例后运行 Task 3 定向测试，观察到 8 项预期失败：伪造 id、modelId、capabilities、`hasStoredSecret` 仍调用 factory；空字符串、`null`、数字和对象形式的 `reasoning_content` 被接受为普通文本。

修复内容：

- 在 `local-model-route.ts` 导出 `isBuiltinLocalProviderProfile`，以同一固定档案为事实来源，严格比较完整键集合、显示名及固定身份字段；Registry 不再只判断 providerId。
- `assertNoReasoningLeak` 改为检查响应 message 是否自有 `reasoning_content` 字段，不读取或拼接其值；补充缺失字段的正常文本对照和错误对象 canary 脱敏断言。
- 明确 Main 生产 factory 注入属于 Task 5，本轮未提前实现 Runtime 或伪造连接。

本轮验证：

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/local-model-provider.test.ts tests/provider-contract.test.ts tests/local-model-route.test.ts tests/openai-provider.test.ts
pnpm.cmd --filter @myself/desktop typecheck
git diff --check
```

结果：4 个测试文件、167 项测试全部通过；`tsc --noEmit` 退出码为 0；`git diff --check` 未报告空白错误。
