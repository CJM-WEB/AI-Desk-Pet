# Task 4：manifest 与 LocalModelRuntime 生命周期报告

## 状态

已完成。

## RED 证据

先新增 manifest、Runtime 和小型 llama-server 替身测试，在生产模块尚不存在时运行：

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/local-model-manifest.test.ts tests/local-model-runtime.test.ts
```

结果：两个测试文件均在模块解析阶段失败，分别缺少 `local-model-manifest` 与 `local-model-runtime`，符合预期 RED。

后续每个审查缺口均先用最小测试确认失败，再实现 GREEN：

- 端口冲突必须同时存在非零退出码与冲突日志；仅有日志时原实现错误重试 Vulkan。
- Vulkan 探针必须有超时；原实现会无限等待未退出探针。
- 64 KiB stderr 尾缓冲 mutation 为 128 KiB 后，旧冲突标记错误触发重试。
- stop 必须等待存活 child 退出后再删 Token；原实现先删 Token。
- spawn 边界同步 Abort 必须立即收敛；原实现等待探针 timeout。
- stop 期间排队的 start 在 close 后不得复活；原实现会继续启动并最终报端口错误。
- 崩溃清理必须捕获旧 Token 且作为重启 barrier；原共享槽设计存在误删新 Token 的竞态。
- 单个订阅者抛错不得阻断生命周期；原实现直接传播订阅者异常。

## 实现摘要

### manifest

- 使用严格 Zod Schema 解析固定 Windows x64 manifest，拒绝额外字段、错误平台、架构、runtime revision、模型/量化 revision 和固定模型大小或 SHA 偏差。
- 所有 manifest 路径只接受 `/` 分隔的根内相对路径；拒绝绝对路径、`..`、符号链接、Junction 逃逸、非普通文件、重复条目和额外文件。
- runtime、DLL 与许可证每次启动执行真实大小和 SHA-256 校验。
- GGUF 仅在应用版本、真实文件路径、大小、mtime、ctime、设备和 inode 元数据均匹配时复用完整哈希缓存；缓存失配、损坏或版本变化均重新计算，不把缓存当发布者签名。
- 生产默认策略锁定 Qwen3.5-4B GGUF 文件名、大小、SHA、来源 revision、量化 revision 和 llama.cpp commit；测试注入小文件策略并使用真实 SHA，不创建 2.55 GiB 文件。

### LocalModelRuntime

- 提供 `start/stop/close/getStatus/subscribe/getReadyConnection` 与可注入 `LocalModelProcessPort`。
- 进程固定使用分项 argv、`shell:false`、`windowsHide:true`、最小环境和 `--reasoning off`；未加入 llama.cpp tools、agent、MCP、媒体、URL 下载或 RPC 参数。
- Vulkan `--list-devices` 探针解析实际 `VulkanN` 设备，并受 timeout/Abort 约束；探针或 Vulkan server 在首个请求前失败时只降级一次 CPU。
- `/health` 仅接受 503 加载中或严格的 200 `{ status: "ok" }`；端口冲突只有在非零退出码与有界 stderr 标记同时成立时最多重试三次。
- generation 在启动和失效时推进；ready 崩溃立即撤销连接，旧清理作为重启/关闭 barrier，不能删除新 generation Token。
- stop、Abort、timeout、崩溃与 close 复用同一精确 PID 清理路径；自然退出不再操作旧 PID，存活进程在同一有界窗口内等待 `killTree` 与 child 退出后才删除 Token 和发布 disabled。
- `close` 与 `stop` 幂等；close 后已排队的 start 也会在执行前再次拒绝。
- stdout/stderr 分别只保留 64 KiB 环形尾缓冲；公开状态始终重新构造为四个白名单字段，订阅者异常被隔离且不会写日志。

## 验证结果

最终 fresh 验证：

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/local-model-manifest.test.ts tests/local-model-runtime.test.ts
```

结果：2 个测试文件、30 项测试全部通过。

```powershell
pnpm.cmd --filter @myself/desktop typecheck
```

结果：`tsc --noEmit` 退出码为 0。

泄露与禁止参数扫描未发现 `--tools`、`--agent`、MCP、媒体/远端模型参数、`shell:true`、`windowsHide:false`、调试 console 或临时诊断标记。

额外运行完整 desktop 测试：

```powershell
pnpm.cmd --filter @myself/desktop test
```

结果：99 个测试文件中 98 个通过；2312 项测试中 2310 项通过、2 项失败。失败均位于未被 Task 4 修改的 `provider-settings-migration.test.ts`：基线测试仍断言 Settings V3，而指定基线 `storage/settings-store.ts` 已输出 V4。Task 4 定向测试在同一次全量运行中全部通过；本任务未越界修改该既有迁移测试。

## 自审

- 修改范围只包含 Task 4 的 manifest、Runtime、两个测试、小型 fixture 与本报告；未修改 SDD ledger，未接入 Service、IPC、UI、Main 生产组合或后续 Provider 路由。
- 独立只读审查发现的 probe timeout、退出码判定、child close、旧 PID、queued start、Token generation、Abort 状态和订阅者异常问题均已补 RED 并修复。
- 没有启动真实大模型、下载 payload、占用真实推理端口或声称真实 CPU/Vulkan 性能通过。

## Concerns

无 Task 4 阻塞 concern。desktop 全测试存在上述 2 项与 Task 4 无关的基线断言失败，需由 SettingsStore 所属任务同步 V4 预期后才能恢复整包全绿。

后续资源打包任务加入 `THIRD-PARTY-NOTICES` 或来源说明时，必须与 manifest Schema、固定路径和精确 allowlist 在同一任务中原子扩展；本任务未提前实现 Task 5 及后续打包能力。真实 Windows CPU/Vulkan、任务管理器残留进程与安装包资源仍属于后续真实模型和人工验收范围。

## 提交

本报告与实现使用同一个 Task 4 提交；最终 commit hash 以交付消息为准。
