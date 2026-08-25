# Task 5：LocalModelService、就绪裁决与 Main 生命周期报告

## 状态

已完成。

## RED 证据

先新增 LocalModelService、Main 会话就绪裁决和生产生命周期测试，再运行 Task 5 定向命令：

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/local-model-service.test.ts tests/main-conversation-composition.test.ts tests/main-lifecycle.test.ts
```

初始结果为 5 项预期失败：生产 Service 模块尚不存在，Main 会话组合没有本地就绪裁决入口，生产 Main 也未构造 Runtime、注入本地 Provider factory 或在窗口 ready 后启动。

后续审查缺口继续遵循最小 RED → GREEN：

- 本地 loading、faulted、disabled 错误穿过真实 `ConversationCoordinator` 后原先被收敛为 `AGENT_INTERNAL_ERROR`；补测试后只增加四个固定、无内部详情的公开错误码。
- E2E 脚本化云 Provider 在默认本地路由接入后不再可达；先补生产边界断言，再让既有 E2E 边界显式关闭本地 Runtime，生产环境仍读取持久化默认值。
- disable 已 stop、但保存仍阻塞时并发 `start()` 会复活本地进程；先补竞态测试，再让启动等待完整切换事务并重新检查 enabled。
- 补充 Agent 路径的 loading、faulted、disabled 与 ready/no-secret 断言，并补充 reset、开启保存、关闭保存失败时的提交边界断言。

## 实现摘要

### LocalModelService

- 以单一串行队列管理开启和关闭事务；切换期间 `providerSettingsSnapshot()` 固定返回 `LOCAL_MODEL_SWITCHING`，冻结新请求。
- 每次切换先复用既有会话 reset/cancel；关闭严格执行 `reset → stop → save(false) → 云路由`，开启严格执行 `reset → save(true) → 本地路由 → start`。
- stop、start 或保存失败均不触发云端兜底；只有关闭设置完整提交后才恢复云路由，开启 start 失败则保留本地路由并暴露 Runtime faulted 状态。
- `start()` 等待在途切换完整结束后重新检查路由，避免关闭保存期间复活已停止进程。
- Runtime 状态只经 Main 内存发布端口传播；`close()` 立即触发 Runtime 取消/精确进程清理，并等待切换队列收敛，重复调用保持幂等。

### 就绪裁决与会话失效

- 云档案继续要求已保存 Secret；固定本地档案不伪造 `hasStoredSecret:true`，只接受 Main Runtime `ready` 状态。
- 本地 validating/loading、faulted、disabled/stopping 分别收敛为稳定的 `LOCAL_MODEL_LOADING`、`LOCAL_MODEL_FAULTED`、`LOCAL_MODEL_DISABLED`。
- Chat 与 Agent 共用同一 Main 私有就绪裁决；真实公开会话边界只放行固定错误码和固定中文消息，不携带 Runtime 内部详情。
- 本地开关复用 `resetForConfigurationChange()`，同时失效主动行为、旧请求、旧确认和旧 generation；切换期间的新请求被稳定拒绝。

### Main 生产组合与生命周期

- 使用应用资源目录、应用版本、用户数据缓存路径和临时 Token 根构造唯一 `LocalModelRuntime`。
- 将 Task 3 延后的生产 factory 正式注入 `ProviderRegistry`：固定本地目录项由 `LocalModelProvider(localModelRuntime)` 创建，云 Provider 路径保持原状。
- provider snapshot 改由 `LocalModelService` 提供；生产环境读取持久化 enabled，既有 E2E 脚本边界显式保持云 Provider。
- 四个首屏窗口 `loadRenderer` 完成后才后台调用 `localModelService.start()`；启动失败只记录稳定错误码，不回退云端。
- Service 在启动清理栈和正常 Main shutdown 服务中都注册 `close()`，因此窗口创建半途失败、正常退出和重复清理都能收敛 Runtime。

## 验证结果

最终 fresh 定向验证：

```powershell
pnpm.cmd exec vitest run apps/desktop/tests/local-model-service.test.ts apps/desktop/tests/main-conversation-composition.test.ts apps/desktop/tests/main-lifecycle.test.ts
pnpm.cmd --filter @myself/desktop typecheck
```

结果：3 个测试文件、38 项测试全部通过；桌面 `tsc --noEmit` 退出码为 0。

最终 fresh 桌面完整门禁：

```powershell
pnpm.cmd verify:desktop
```

结果：全 workspace typecheck 通过；unit 129 个文件、2919/2919 通过；security 23/23 通过；integration 70/70 通过；生产构建与产物边界校验通过；真实 Electron E2E 71 项通过、1 项按既有配置跳过。完整命令约 7 分钟，未触发 15 分钟时间盒。

```powershell
git diff --check
```

结果：退出码为 0；仅出现 Git 的 LF/CRLF 工作区提示，没有空白错误。SDD ledger 无差异。

## 自审

- 独立只读首轮审查指出 start/disable-save 竞态、Agent 路径覆盖和 reset/save 失败原子性三个 Important；均先补测试再修复或补证据。
- 独立只读复审确认上述三个 Important 全部关闭，未发现新的 Critical/Important；审查者未修改文件或 Git 状态。
- `conversation-coordinator.ts` 不在 Task 5 初始文件表内，但稳定本地错误必须穿过真实公开边界；父任务已明确授权最小修改。变更仅增加四个固定错误码与固定消息，不扩展权限或暴露内部详情。
- 未接入 Task 6 的 Settings IPC/UI，也未修改 ledger；本任务只产出 Service 接口、生产组合、就绪裁决和生命周期。
- 未下载或启动真实 2.55 GiB 模型，不把自动化夹具结果写成真实 CPU/Vulkan 或安装包人工验收通过。

## Concerns

无 Task 5 阻塞 concern。

本次真实 Electron E2E 继续使用既有脚本化云 Provider，并显式关闭本地 Runtime；真实模型 payload、CPU/Vulkan 启动、任务管理器残留进程和安装包资源仍属于后续资源集成与人工验收范围。Task 6 尚需把 `LocalModelService.setEnabled()` 接入受控 Settings IPC/UI，本任务未提前实现。

## 提交

本报告与实现使用同一个 Task 5 提交；最终 commit hash 以交付消息为准。
