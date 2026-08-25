# AI 桌宠内置本地模型 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Windows x64 AI Pet 增加默认开启、随安装包分发、强制非思考且可通过现有安全链调用真实工具的 Qwen3.5-4B 本地模型。

**Architecture:** Electron Main 私有的 `LocalModelRuntime` 托管固定 llama.cpp 子进程，`LocalModelProvider` 复用现有 OpenAI-compatible 协议，`LocalModelService` 用内存档案和路由覆盖接入既有 `ModelRouter`。云端 Provider 设置始终原样持久化；本地模型关闭时自然恢复，不创建第二套 Agent、工具或权限系统。

**Tech Stack:** Electron 43、React 19、TypeScript 5.9、Zod 3、Vitest 3、Playwright 1.61、Node `child_process`/`crypto`/`fs`、llama.cpp `b10516`、Qwen3.5-4B Q4_K_M GGUF。

## Global Constraints

- 规格来源：`docs/superpowers/specs/2026-08-25-ai-pet-built-in-local-model-design.md`。
- 只支持 Windows x64；模型默认开启；界面先出现，模型后台异步加载。
- 本地开启时不调用任何云 Provider，也不跨 Provider 回退；本地关闭后恢复原持久化路由。
- 本地档案只声明 `chat`、`tools`；视觉请求稳定拒绝，不打包 `mmproj`。
- 强制 `--reasoning off`、`reasoning_effort:"none"`、`enable_thinking:false`，拒绝泄漏思考内容。
- llama-server 内建 tools、agent、MCP、Shell、文件、媒体、RPC 与联网下载全部禁用。
- Renderer 不获得端口、Token、PID、绝对路径、命令行、哈希或原始 stderr。
- 所有真实工具调用继续经过现有 AgentLoop、授权、确认卡和 Electron Main 执行链。
- 模型锁定 Unsloth revision `e87f176479d0855a907a41277aca2f8ee7a09523`，GGUF SHA-256 `00fe7986ff5f6b463e62455821146049db6f9313603938a70800d1fb69ef11a4`。
- llama.cpp 锁定 `b10516` / `b95502ba9aa0eb73a2f4fc8878d7fbe6a847a0b9`；生产运行时自建，`GGML_RPC=OFF`、`GGML_OPENMP=OFF`。
- 文档和结构性注释使用中文；采用最小修改；每项任务先 RED、再 GREEN、再复审并提交。

---

## File Structure

### 新建文件

- `apps/desktop/src/shared/local-model-ipc.ts`：公开状态与严格 IPC Schema。
- `apps/desktop/src/main/local-model/local-model-route.ts`：内置档案、私有目录项和纯路由覆盖。
- `apps/desktop/src/main/local-model/local-model-manifest.ts`：manifest Schema、固定来源与资源解析。
- `apps/desktop/src/main/local-model/local-model-runtime.ts`：进程、端口、健康检查、后端降级与清理。
- `apps/desktop/src/main/local-model/local-model-service.ts`：设置、会话失效、路由覆盖和状态广播。
- `apps/desktop/src/main/providers/local-model-provider.ts`：本地 Provider 与非思考请求策略。
- `apps/desktop/src/renderer/src/settings/LocalModelSettingsCard.tsx`：模型开关和状态卡。
- `apps/desktop/scripts/stage-local-model.mjs`：维护者使用的固定下载/源码构建/暂存入口。
- `apps/desktop/scripts/verify-local-model-assets.mjs`：打包前资源 allowlist、哈希和许可证校验。
- `apps/desktop/resources/local-model/manifest.json`：不含 payload 的固定发行清单。
- `apps/desktop/resources/local-model/licenses/llama.cpp-LICENSE.txt`：MIT 文本。
- `apps/desktop/resources/local-model/licenses/Qwen3.5-4B-LICENSE.txt`：Apache-2.0 文本。
- `apps/desktop/resources/local-model/THIRD-PARTY-NOTICES.txt`：来源、revision、量化与修改说明。
- 对应 Desktop 单元测试、集成测试 fixture 和真实模型验收脚本。

### 重点修改文件

- `apps/desktop/src/main/storage/settings-store.ts`：V4 设置与迁移。
- `apps/desktop/src/main/providers/openai-provider.ts`：抽取最小可复用请求策略 seam。
- `apps/desktop/src/main/providers/provider-registry.ts`：固定内置身份 factory。
- `apps/desktop/src/main/conversation/main-conversation-composition.ts`：Provider 就绪裁决。
- `apps/desktop/src/main/index.ts`：组合、状态广播和生命周期。
- `apps/desktop/src/shared/myself-api.ts`、`ipc-channels.ts`、`main/ipc/register-ipc.ts`、`preload/index.ts`：最小 IPC。
- `apps/desktop/src/renderer/src/settings/ProviderSettings.tsx`、`SettingsView.tsx`、`chat/ChatPanel.tsx`、`styles.css`：状态界面。
- `apps/desktop/electron-builder.yml`、`package.json`、`tests/package-config.test.ts`：asar 外资源与打包门禁。

---

### Task 1: 本地模型公开契约与 SettingsStore V4

**Files:**
- Create: `apps/desktop/src/shared/local-model-ipc.ts`
- Modify: `apps/desktop/src/main/storage/settings-store.ts`
- Test: `apps/desktop/tests/settings-store.test.ts`
- Test: `apps/desktop/tests/multi-provider-settings-store.test.ts`

**Interfaces:**
- Produces: `LocalModelPublicStatus`、`localModelPublicStatusSchema`、`LocalModelSettings { enabled:boolean }`。
- Produces: `SettingsStore.getLocalModelSettings()` 与 `saveLocalModelEnabled(enabled)`。

- [ ] **Step 1: 写公开状态严格 Schema 的失败测试**

```ts
expect(localModelPublicStatusSchema.parse({
  enabled: true,
  phase: 'ready',
  backend: 'vulkan',
  reasonCode: null
})).toEqual(expect.objectContaining({ phase: 'ready' }));
expect(() => localModelPublicStatusSchema.parse({
  enabled: true,
  phase: 'ready',
  backend: 'vulkan',
  reasonCode: null,
  port: 61234
})).toThrow();
```

- [ ] **Step 2: 写 V1/V2/V3 → V4 迁移 RED**

断言每个旧版本迁移后 `localModel.enabled === true`，并逐字段保留 Provider 档案、云路由、MCP 数据、角色位置、隐私与停止锁；保存 false 后重启仍为 false。

- [ ] **Step 3: 运行 RED**

Run: `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/settings-store.test.ts tests/multi-provider-settings-store.test.ts`

Expected: FAIL，缺少 V4 Schema、公开状态和访问器。

- [ ] **Step 4: 实现最小 V4 与原子开关写入**

```ts
export const localModelPublicStatusSchema = z.object({
  enabled: z.boolean(),
  phase: z.enum(['disabled', 'validating', 'loading', 'ready', 'faulted', 'stopping']),
  backend: z.enum(['vulkan', 'cpu']).nullable(),
  reasonCode: z.enum([
    'RESOURCE_MISSING', 'RESOURCE_HASH_MISMATCH', 'RUNTIME_INCOMPATIBLE',
    'VULKAN_UNAVAILABLE', 'CPU_START_FAILED', 'MODEL_LOAD_TIMEOUT',
    'PORT_CONFLICT', 'PROCESS_CRASHED', 'PROTOCOL_INCOMPATIBLE'
  ]).nullable()
}).strict();
```

V4 在 V3 shape 基础上增加 `localModel: { enabled: boolean }`；所有迁移通过 `defaultSettings()` 注入 true，不修改 `providerProfiles` 与 `modelRoute`。

- [ ] **Step 5: 运行 GREEN 与 typecheck**

Run: `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/settings-store.test.ts tests/multi-provider-settings-store.test.ts`

Run: `pnpm.cmd --filter @myself/desktop typecheck`

Expected: PASS。

- [ ] **Step 6: 提交**

```powershell
git add apps/desktop/src/shared/local-model-ipc.ts apps/desktop/src/main/storage/settings-store.ts apps/desktop/tests/settings-store.test.ts apps/desktop/tests/multi-provider-settings-store.test.ts
git commit -m "feat(desktop): 持久化本地模型开关"
```

### Task 2: 内置档案与无损路由覆盖

**Files:**
- Create: `apps/desktop/src/main/local-model/local-model-route.ts`
- Test: `apps/desktop/tests/local-model-route.test.ts`
- Test: `packages/agent-core/tests/model-router.test.ts`

**Interfaces:**
- Produces: `BUILTIN_LOCAL_PROFILE_ID = 'builtin-local'`。
- Produces: `createLocalModelRoutingSnapshot(cloud, enabled): ProviderSettingsSnapshot`。

- [ ] **Step 1: 写纯函数 RED**

```ts
const cloud = structuredClone(fixture);
const enabled = createLocalModelRoutingSnapshot(cloud, true);
expect(enabled.route).toMatchObject({
  primaryProfileId: 'builtin-local',
  chatProfileId: 'builtin-local',
  agentProfileId: 'builtin-local',
  visionProfileId: 'builtin-local',
  fallbackProfileIds: [],
  allowCrossProviderFallback: false
});
expect(cloud).toEqual(fixture);
expect(createLocalModelRoutingSnapshot(cloud, false)).toEqual(cloud);
```

另断言本地档案只有 `chat/tools`，视觉选择抛出 `MODEL_CAPABILITY_REQUIRED`，聊天与 Agent 选择成功且 fallback 为空。

- [ ] **Step 2: 运行 RED**

Run: `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/local-model-route.test.ts`

Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现内存档案、私有目录项和覆盖**

使用既有 `preset` 形状，`hasStoredSecret:false`；不得写 SettingsStore、不得加入公开 `providerCatalog`、不得接受调用者传入 URL/模型 ID。

- [ ] **Step 4: 运行 GREEN**

Run: `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/local-model-route.test.ts`

Run: `pnpm.cmd --filter @myself/agent-core test -- model-router.test.ts`

Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add apps/desktop/src/main/local-model/local-model-route.ts apps/desktop/tests/local-model-route.test.ts packages/agent-core/tests/model-router.test.ts
git commit -m "feat(desktop): 注入本地模型路由覆盖"
```

### Task 3: 可复用 OpenAI 请求 seam 与 LocalModelProvider

**Files:**
- Create: `apps/desktop/src/main/providers/local-model-provider.ts`
- Modify: `apps/desktop/src/main/providers/openai-provider.ts`
- Modify: `apps/desktop/src/main/providers/provider-registry.ts`
- Test: `apps/desktop/tests/local-model-provider.test.ts`
- Test: `apps/desktop/tests/provider-contract.test.ts`

**Interfaces:**
- Consumes: `BUILTIN_LOCAL_PROFILE_ID`。
- Produces: `LocalModelConnection { generation:string; baseUrl:string; token:string; modelId:string }`。
- Produces: `LocalModelConnectionPort.getReadyConnection(): LocalModelConnection`。
- Produces: `LocalModelProvider implements ModelProvider`。

- [ ] **Step 1: 写非思考和工具调用 RED**

捕获请求 JSON，断言包含：

```ts
expect(body).toMatchObject({
  stream: false,
  reasoning_effort: 'none',
  chat_template_kwargs: { enable_thinking: false },
  parallel_tool_calls: false,
  parse_tool_calls: true
});
```

模拟一个 OpenAI `tool_calls` 返回并断言内部工具名正确解码；模拟 `reasoning_content` 或 `<think>` 后断言 `LOCAL_MODEL_REASONING_LEAK`；connection generation 改变或未 ready 时断言没有 fetch。

- [ ] **Step 2: 运行 RED**

Run: `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/local-model-provider.test.ts tests/provider-contract.test.ts`

Expected: FAIL，LocalModelProvider 与请求策略 seam 不存在。

- [ ] **Step 3: 抽取最小 OpenAI transport seam**

保留现有远端 Provider 行为不变，只允许构造器内部选项增加固定请求字段与响应后置校验；不要开放到 Renderer 可写 `additionalParameters`。

```ts
interface OpenAIRequestPolicy {
  body: Readonly<Record<string, unknown>>;
  validateResponse(raw: unknown): void;
}
```

- [ ] **Step 4: 实现 LocalModelProvider 与固定 Registry factory**

Provider 每次调用读取 ready connection、强制 `reasoningMode:'disabled'`，使用当前 Token；ProviderRegistry 只在固定 `providerId === 'builtin-local'` 时调用 Main 注入 factory，其余路径保持原协议解析。

- [ ] **Step 5: 运行 GREEN 与回归**

Run: `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/local-model-provider.test.ts tests/provider-contract.test.ts`

Run: `pnpm.cmd --filter @myself/desktop typecheck`

Expected: PASS，既有 Provider 测试不变。

- [ ] **Step 6: 提交**

```powershell
git add apps/desktop/src/main/providers/local-model-provider.ts apps/desktop/src/main/providers/openai-provider.ts apps/desktop/src/main/providers/provider-registry.ts apps/desktop/tests/local-model-provider.test.ts apps/desktop/tests/provider-contract.test.ts
git commit -m "feat(desktop): 接入非思考本地模型 Provider"
```

### Task 4: manifest 与 LocalModelRuntime 生命周期

**Files:**
- Create: `apps/desktop/src/main/local-model/local-model-manifest.ts`
- Create: `apps/desktop/src/main/local-model/local-model-runtime.ts`
- Create: `apps/desktop/tests/fixtures/fake-llama-server.ts`
- Test: `apps/desktop/tests/local-model-manifest.test.ts`
- Test: `apps/desktop/tests/local-model-runtime.test.ts`

**Interfaces:**
- Produces: `LocalModelRuntime.start/stop/close/getStatus/subscribe/getReadyConnection`。
- Produces: `LocalModelProcessPort`，测试注入 spawn、端口和时间。

- [ ] **Step 1: 写 manifest RED**

覆盖严格字段、平台 x64、模型固定大小/哈希、路径越界、额外文件、缺许可证和错误 runtime revision；fixture 使用小文件及其真实 SHA，不使用 2.55 GiB 模型。

- [ ] **Step 2: 写生命周期 RED**

表驱动覆盖：Vulkan ready、Vulkan probe 失败后 CPU ready、Vulkan server 加载失败后 CPU ready、双失败、503→200、端口占用三次、加载超时、进程崩溃、Abort、幂等 close、会话密钥删除、stdout/stderr 有界与公开状态脱敏。

- [ ] **Step 3: 运行 RED**

Run: `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/local-model-manifest.test.ts tests/local-model-runtime.test.ts`

Expected: FAIL，模块不存在。

- [ ] **Step 4: 实现 manifest 解析和资源校验**

所有路径用 manifest 根内相对路径解析并拒绝逃逸；小型 runtime 每次 SHA；GGUF 依据应用版本和元数据缓存完整校验结果，缓存失配即重新计算，不把缓存当发布者签名。

- [ ] **Step 5: 实现状态机与进程清理**

状态只允许：`disabled → validating → loading → ready → stopping → disabled`，任意启动错误进入 `faulted`。启动使用 `spawn(exe, args, {shell:false, windowsHide:true})`；清理复用现有已验证的精确 PID 子进程树策略，不使用进程名。

- [ ] **Step 6: 运行 GREEN 与泄露扫描**

Run: `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/local-model-manifest.test.ts tests/local-model-runtime.test.ts`

Run: `pnpm.cmd --filter @myself/desktop typecheck`

Expected: PASS；公开状态 JSON 不含 fixture 的端口、Token、路径、PID 或 stderr 标记。

- [ ] **Step 7: 提交**

```powershell
git add apps/desktop/src/main/local-model apps/desktop/tests/local-model-manifest.test.ts apps/desktop/tests/local-model-runtime.test.ts apps/desktop/tests/fixtures/fake-llama-server.ts
git commit -m "feat(desktop): 托管本地模型运行时"
```

### Task 5: LocalModelService、就绪裁决与 Main 生命周期

**Files:**
- Create: `apps/desktop/src/main/local-model/local-model-service.ts`
- Modify: `apps/desktop/src/main/conversation/main-conversation-composition.ts`
- Modify: `apps/desktop/src/main/settings/session-preflight.ts`
- Modify: `apps/desktop/src/main/index.ts`
- Test: `apps/desktop/tests/local-model-service.test.ts`
- Test: `apps/desktop/tests/main-conversation-composition.test.ts`
- Test: `apps/desktop/tests/main-lifecycle.test.ts`

**Interfaces:**
- Consumes: Task 1 Settings、Task 2 routing、Task 4 Runtime。
- Produces: `LocalModelService.setEnabled(enabled)`、`providerSettingsSnapshot()`、`close()`。
- Produces: `assertProviderReady(profile)` Main 私有裁决。

- [ ] **Step 1: 写默认启动和切换 RED**

断言窗口 ready 回调先完成，随后才调用 runtime.start；enabled true 时读取覆盖路由；切 false 顺序为 cancel/reset → stop → 云路由；切 true 顺序为 cancel/reset → 覆盖生效 → start；任一步失败不伪造 ready。

- [ ] **Step 2: 写就绪裁决 RED**

云档案继续要求 Secret；本地档案在 loading/faulted/disabled 分别抛稳定错误，在 ready 成功；不得把本地档案改为 `hasStoredSecret:true`。

- [ ] **Step 3: 运行 RED**

Run: `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/local-model-service.test.ts tests/main-conversation-composition.test.ts tests/main-lifecycle.test.ts`

Expected: FAIL。

- [ ] **Step 4: 实现服务与 Main 组合**

LocalModelService 采用串行事务队列，切换先冻结新请求并复用现有 reset/cancel；状态广播发生在 Main，Runtime 错误不触发云 fallback。Main shutdown 注册 `close()`，启动半途失败也执行清理。

- [ ] **Step 5: 运行 GREEN**

Run: `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/local-model-service.test.ts tests/main-conversation-composition.test.ts tests/main-lifecycle.test.ts`

Run: `pnpm.cmd --filter @myself/desktop typecheck`

Expected: PASS。

- [ ] **Step 6: 提交**

```powershell
git add apps/desktop/src/main/local-model/local-model-service.ts apps/desktop/src/main/conversation/main-conversation-composition.ts apps/desktop/src/main/settings/session-preflight.ts apps/desktop/src/main/index.ts apps/desktop/tests/local-model-service.test.ts apps/desktop/tests/main-conversation-composition.test.ts apps/desktop/tests/main-lifecycle.test.ts
git commit -m "feat(desktop): 管理本地模型切换与生命周期"
```

### Task 6: 严格 IPC 与 Preload 状态订阅

**Files:**
- Modify: `apps/desktop/src/shared/myself-api.ts`
- Modify: `apps/desktop/src/shared/ipc-channels.ts`
- Modify: `apps/desktop/src/main/ipc/register-ipc.ts`
- Modify: `apps/desktop/src/preload/index.ts`
- Modify: `apps/desktop/src/main/settings/desktop-settings-service.ts`
- Test: `apps/desktop/tests/advanced-settings-ipc.test.ts`
- Test: `apps/desktop/tests/preload-production-boundary.test.ts`
- Test: `apps/desktop/tests/desktop-settings-service.test.ts`

**Interfaces:**
- Produces: `setLocalModelEnabled(enabled): Promise<SettingsDashboardDto>`。
- Produces: `onLocalModelStatus(listener): () => void`。
- Dashboard 增加 `localModel: LocalModelPublicStatus`。

- [ ] **Step 1: 写 IPC RED**

断言只接受严格 `{enabled:boolean}`；事件在 preload 经 Schema 解析；Dashboard 与事件拒绝 `port/token/path/pid/stderr`；取消订阅移除精确 listener。

- [ ] **Step 2: 运行 RED**

Run: `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/advanced-settings-ipc.test.ts tests/preload-production-boundary.test.ts tests/desktop-settings-service.test.ts`

Expected: FAIL。

- [ ] **Step 3: 实现最小白名单 API**

新增两个 channel：`settings:local-model-enabled-set`、`local-model:status`。DesktopSettingsService 只组合公开状态与开关动作，不获得 connection、进程或 Token。

- [ ] **Step 4: 运行 GREEN 与生产 preload 校验**

Run: `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/advanced-settings-ipc.test.ts tests/preload-production-boundary.test.ts tests/desktop-settings-service.test.ts`

Run: `pnpm.cmd --filter @myself/desktop build`

Expected: PASS。

- [ ] **Step 5: 提交**

```powershell
git add apps/desktop/src/shared/myself-api.ts apps/desktop/src/shared/ipc-channels.ts apps/desktop/src/main/ipc/register-ipc.ts apps/desktop/src/preload/index.ts apps/desktop/src/main/settings/desktop-settings-service.ts apps/desktop/tests/advanced-settings-ipc.test.ts apps/desktop/tests/preload-production-boundary.test.ts apps/desktop/tests/desktop-settings-service.test.ts
git commit -m "feat(desktop): 公开本地模型安全状态"
```

### Task 7: 设置卡与聊天加载状态

**Files:**
- Create: `apps/desktop/src/renderer/src/settings/LocalModelSettingsCard.tsx`
- Modify: `apps/desktop/src/renderer/src/settings/ProviderSettings.tsx`
- Modify: `apps/desktop/src/renderer/src/settings/SettingsView.tsx`
- Modify: `apps/desktop/src/renderer/src/chat/ChatPanel.tsx`
- Modify: `apps/desktop/src/renderer/src/styles.css`
- Test: `apps/desktop/tests/multi-provider-settings.test.tsx`
- Create: `apps/desktop/tests/chat-panel.test.tsx`

**Interfaces:**
- Consumes: Task 6 Dashboard、setEnabled、onStatus。

- [ ] **Step 1: 写 Renderer RED**

断言卡片默认开启、无需 API Key、云档案仍可编辑；loading 禁止发送；ready 恢复；CPU 显示兼容提示；faulted 显示原因和设置入口；视觉暂不可用文案存在；事件卸载后不更新 state。

- [ ] **Step 2: 运行 RED**

Run: `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/multi-provider-settings.test.tsx tests/chat-panel.test.tsx`

Expected: FAIL。

- [ ] **Step 3: 实现状态卡与订阅**

卡片置于模型页顶部，不进入 Provider 表单、已保存档案、删除或密钥槽。聊天按钮禁用条件增加 `localModel.enabled && phase !== 'ready'`，但不替代 Main 校验。

- [ ] **Step 4: 运行 GREEN**

Run: `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/multi-provider-settings.test.tsx tests/chat-panel.test.tsx`

Expected: PASS；720×620 与 640×520 的真实布局由 Task 9 的 Electron E2E 覆盖。

- [ ] **Step 5: 提交**

```powershell
git add apps/desktop/src/renderer/src/settings/LocalModelSettingsCard.tsx apps/desktop/src/renderer/src/settings/ProviderSettings.tsx apps/desktop/src/renderer/src/settings/SettingsView.tsx apps/desktop/src/renderer/src/chat/ChatPanel.tsx apps/desktop/src/renderer/src/styles.css apps/desktop/tests/multi-provider-settings.test.tsx apps/desktop/tests/chat-panel.test.tsx
git commit -m "feat(desktop): 增加本地模型设置与加载反馈"
```

### Task 8: 固定资源、可复现暂存与打包门禁

**Files:**
- Create: `apps/desktop/resources/local-model/manifest.json`
- Create: `apps/desktop/resources/local-model/licenses/llama.cpp-LICENSE.txt`
- Create: `apps/desktop/resources/local-model/licenses/Qwen3.5-4B-LICENSE.txt`
- Create: `apps/desktop/resources/local-model/THIRD-PARTY-NOTICES.txt`
- Create: `apps/desktop/scripts/stage-local-model.mjs`
- Create: `apps/desktop/scripts/verify-local-model-assets.mjs`
- Modify: `.gitignore`
- Modify: `apps/desktop/electron-builder.yml`
- Modify: `apps/desktop/package.json`
- Test: `apps/desktop/tests/package-config.test.ts`
- Test: `apps/desktop/tests/local-model-assets.test.ts`

**Interfaces:**
- Produces: `resources/local-model/payload/model/...gguf`、`runtime/cpu`、`runtime/vulkan`。
- Produces: `pnpm stage:local-model` 与 `pnpm verify:local-model-assets`。

- [ ] **Step 1: 写资源 verifier RED**

用临时 fixture 验证：正确 allowlist 通过；错 SHA、错 revision、缺许可证、存在 `llama-cli.exe`、`llama-rpc-server.exe`、mmproj、第二模型或额外 EXE 均失败。

- [ ] **Step 2: 写打包配置 RED**

断言 `extraResources` 新增 `resources/local-model` 到 `local-model`；`package:win` 在 electron-builder 前执行 verifier；普通 `build` 不运行下载脚本。

- [ ] **Step 3: 运行 RED**

Run: `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/package-config.test.ts tests/local-model-assets.test.ts`

Expected: FAIL。

- [ ] **Step 4: 实现固定 manifest 与维护者暂存脚本**

脚本只接受仓库内固定常量，不接受用户 URL；模型从固定 resolve URL下载到 `.partial`，校验 2,740,937,888 bytes 与固定 SHA 后原子改名。llama.cpp 从固定 commit 源码构建 CPU/Vulkan，显式关闭 RPC/OpenMP，仅暂存 server 和实际 DLL。

- [ ] **Step 5: 实现打包门禁与忽略 payload**

只忽略 `apps/desktop/resources/local-model/payload/`；manifest、许可证和脚本必须提交。package config 测试由“恰好三个资源”改为精确必需资源与禁止源扫描。

- [ ] **Step 6: 运行 GREEN**

Run: `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/package-config.test.ts tests/local-model-assets.test.ts`

Run: `pnpm.cmd --filter @myself/desktop typecheck`

Expected: PASS。

- [ ] **Step 7: 提交**

```powershell
git add .gitignore apps/desktop/resources/local-model apps/desktop/scripts/stage-local-model.mjs apps/desktop/scripts/verify-local-model-assets.mjs apps/desktop/electron-builder.yml apps/desktop/package.json apps/desktop/tests/package-config.test.ts apps/desktop/tests/local-model-assets.test.ts
git commit -m "build(desktop): 固定本地模型发行资源"
```

### Task 9: 自动纵向、安全与 Electron 生命周期验收

**Files:**
- Modify: `tests/integration/desktop-agent.test.ts`
- Modify: `tests/security/permission-boundary.test.ts`
- Modify: `tests/e2e/desktop.spec.ts`
- Modify: `tests/e2e/desktop-settings-layout.spec.ts`
- Modify: 必要的本地 Provider fixture 文件

**Interfaces:**
- Consumes: Tasks 1–8 完整运行链。

- [ ] **Step 1: 写本地工具纵向 RED**

从用户自然语言开始，通过真实环回 fake llama-server 返回 `tool_calls`，覆盖创建、移动、删除、工具结果回填；确认前无副作用，确认后检查真实文件；开启本地时云 fixture 调用次数严格为 0。

- [ ] **Step 2: 写安全 RED**

断言 Runtime/Provider 构造依赖中不存在 FileToolService、PowerShellPort、授权根或 shell；公开事件与日志扫描不含 Token、端口、路径、Prompt、正文和 stderr canary。

- [ ] **Step 3: 写 Electron RED**

覆盖窗口先出现、loading 禁发、ready 可发、CPU 状态、关闭恢复云路由、切换失效确认、退出无残留 fixture 子进程和两种设置尺寸。

- [ ] **Step 4: 运行 RED 并确认只缺接线或 fixture**

Run: `pnpm.cmd test:security`

Run: `pnpm.cmd test:integration`

Run: `pnpm.cmd test:e2e:desktop`

Expected: 新增用例在对应能力缺口失败，不因不稳定 sleep 或真实 GGUF 缺失失败。

- [ ] **Step 5: 最小修正组合与 fixture**

只修复纵向暴露出的接线、状态或协议缺口；不在测试中绕过 Provider、AgentLoop、确认或真实 FileToolService。

- [ ] **Step 6: 运行 GREEN 与桌面门禁**

Run: `pnpm.cmd test:security`

Run: `pnpm.cmd test:integration`

Run: `pnpm.cmd verify:desktop`

Expected: 全部 PASS。

- [ ] **Step 7: 提交**

```powershell
git add tests/integration tests/security tests/e2e apps/desktop/tests
git commit -m "test(desktop): 验收本地模型安全工具闭环"
```

### Task 10: 真实 Qwen CPU/Vulkan 工具调用与最终验收

**Files:**
- Create: `apps/desktop/scripts/run-local-model-acceptance.mjs`
- Create: `docs/operations/2026-08-25-built-in-local-model-acceptance.md`
- Modify: `docs/operations/lightweight-agent-acceptance.md`
- Modify: `apps/desktop/resources/local-model/manifest.json`（只写入本次自建产物实际 SHA）

**Interfaces:**
- Consumes: 固定 GGUF、CPU/Vulkan runtime 和完整应用链。
- Produces: 去标识化 acceptance JSON 与中文验收记录。

- [ ] **Step 1: 执行固定资源暂存**

Run: `pnpm.cmd --filter @myself/desktop stage:local-model`

Expected: 固定模型下载/复用后 SHA 匹配；CPU/Vulkan 从固定 commit 构建；payload 仅含 allowlist 文件。

- [ ] **Step 2: 运行资源校验**

Run: `pnpm.cmd --filter @myself/desktop verify:local-model-assets`

Expected: PASS，并输出 runtime 文件哈希清单；不得输出模型绝对路径。

- [ ] **Step 3: 运行 CPU 真实模型 RED/GREEN 探针**

Run: `node apps/desktop/scripts/run-local-model-acceptance.mjs --backend cpu`

验收必须通过：中文普通聊天、无 reasoning、创建文件 tool_call、确认后真实落盘、工具结果回填后真实总结、取消恢复。失败时保留稳定错误码并修复最小协议/版本问题后重跑，不允许关键词模拟工具。

- [ ] **Step 4: 运行 Vulkan 真实模型探针**

Run: `node apps/desktop/scripts/run-local-model-acceptance.mjs --backend vulkan`

Expected: 有 Vulkan 设备时同 CPU 验收；无设备时稳定记录 `VULKAN_UNAVAILABLE` 并验证应用 CPU 兼容模式，不把该机器写成 Vulkan 通过。

- [ ] **Step 5: 运行最终自动门禁**

Run: `pnpm.cmd verify:desktop`

Run: `pnpm.cmd verify:behavior`

Run: `git diff --check`

Expected: 全部 PASS；真实模型记录与 mock/fixture 结果分开。

- [ ] **Step 6: 更新验收记录**

只记录实际命令、退出码、backend、phase、工具名、本地副作用布尔值和未覆盖人工项；不记录 Prompt、文件正文、绝对路径、Token 或原始日志。

- [ ] **Step 7: 提交**

```powershell
git add apps/desktop/scripts/run-local-model-acceptance.mjs apps/desktop/resources/local-model/manifest.json docs/operations/2026-08-25-built-in-local-model-acceptance.md docs/operations/lightweight-agent-acceptance.md
git commit -m "test(desktop): 记录内置本地模型验收"
```

---

## Final Review

- [ ] 逐项核对规格第 1–12 节均有实现任务与验收证据。
- [ ] 检查正式运行链只有一个 AgentLoop、一个 ToolRegistry 和一套确认执行协议。
- [ ] 检查本地开启期间所有云 Provider 调用计数为零，视觉请求不出站。
- [ ] 检查 `reasoning_content`、`<think>`、Token、端口、绝对路径和原始 stderr 均未进入 Renderer 或普通日志。
- [ ] 检查关闭本地后云档案与路由逐字段等于开启前快照。
- [ ] 检查 payload 被 Git 忽略，发行 manifest、许可证、来源和哈希已提交。
- [ ] 请求独立代码复审，处理 Critical/Important 问题后重跑最终门禁。
