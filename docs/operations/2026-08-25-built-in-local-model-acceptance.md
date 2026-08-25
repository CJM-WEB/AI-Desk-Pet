# 2026-08-25 内置本地模型验收

## 验收环境

- 系统：Windows 11 专业版，版本 `10.0.26200`，x64。
- CPU：Intel Core i7-14650HX。
- Vulkan 实际设备：`Vulkan0`，Intel RaptorLake-S Mobile Graphics Controller；同机还检测到 NVIDIA GeForce RTX 5060 Laptop GPU。
- 显卡驱动：Intel `32.0.101.7077`；NVIDIA `32.0.15.9219`。
- llama.cpp 固定 revision：`b95502ba9aa0eb73a2f4fc8878d7fbe6a847a0b9`。
- 模型：`Qwen3.5-4B-Q4_K_M.gguf`，固定大小 `2740937888` 字节；验收记录不保存模型绝对路径。

## 当前证据状态

真实验收入口组合生产 `LocalModelRuntime`、`LocalModelService`、`ProviderRegistry`、Main Coordinator、`AgentLoop`、确认链与 `FileToolService`；旧的验收专用进程启动、Token、health、argv 和清理实现已退役。

- `node apps/desktop/scripts/run-local-model-acceptance.mjs --backend cpu`：退出码 `0`；请求和实际 backend 均为 `cpu`，phase 为 `passed`。
- `node apps/desktop/scripts/run-local-model-acceptance.mjs --backend vulkan`：退出码 `0`；请求和实际 backend 均为 `vulkan`，phase 为 `passed`，Main 私有诊断观察到非零 GPU offload。
- 两个 backend 的白名单检查均全部为 `true`：中文聊天、禁用思考、创建/移动/删除、中文相对路径、结构化缺参澄清及紧邻路径续接、确认前后副作用、用户拒绝、受控工具失败恢复、工具结果总结、Provider Abort 恢复、本地开启时云调用为零、关闭本地后云路由恢复。
- 每轮退出后只读检查均为 `LLAMA_SERVER_COUNT=0`。验收输出未记录 Prompt、文件正文、Token、端口、绝对路径、PID 或原始进程日志。
- 上述真实矩阵通过后只修改了验收脚本的超时失败清理编排；正常生产链和 backend 路径未改变，该失败路径由完整生命周期单元测试覆盖。

## 本轮自动化契约证据

- `pnpm.cmd --filter @myself/desktop verify:local-model-assets`：退出码 `0`，固定 revision、模型大小、哈希和 allowlist 资源校验通过。
- `pnpm.cmd verify:desktop`：退出码 `0`；单元测试 132 个文件、2994/2994，通过安全测试 28/28、集成测试 73/73、E2E 75 通过且 1 项按配置跳过。
- `pnpm.cmd verify:behavior`：退出码 `0`；角色运行时 303/303、Agent Core 74/74、桌面 2420/2420、安全 28/28、集成 73/73、E2E 75 通过且 1 项按配置跳过。
- `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/local-model-acceptance.test.ts`：退出码 `0`，11/11 通过；覆盖超时取消、清理失败、清理悬空和完整生命周期不二次等待。
- `pnpm.cmd exec vitest run --config vitest.config.ts tests/agent-loop.test.ts`（在 `packages/agent-core` 执行）：退出码 `0`，50/50 通过；其中包括不严格工具参数、文本 JSON 澄清协议违约与单次修复边界。
- `pnpm.cmd exec vitest run --config vitest.config.ts tests/file-tool-service.test.ts`（在 `packages/file-tools` 执行）：退出码 `0`，46/46 通过；其中包括创建不覆盖、移动目标冲突、确认失效与删除失败边界。
- `pnpm.cmd exec vitest run --config tests/vitest.config.ts tests/integration/desktop-agent.test.ts -t "重复目标被拒绝且不覆盖原内容"`：退出码 `0`，1 条通过、58 条按筛选跳过；真实目标内容未被覆盖。
- `pnpm.cmd typecheck`：退出码 `0`，10 个存在脚本的 workspace 全部通过。
- CLI 契约同时覆盖参数失败、运行期失败和整体超时：失败记录只有单行白名单 JSON，stderr 为空。整体超时先取消正式 Coordinator 活动会话，再等待正式 Service/Runtime 清理；清理失败返回 `PROCESS_CLEANUP_FAILED`。

重复目标和非法 JSON 由生产 fixture、AgentLoop/FileToolService 单元测试及集成测试提供分层证据，不要求真实模型稳定生成错误协议。真实模型矩阵覆盖创建、移动、删除、中文相对路径、结构化缺目标澄清、用户拒绝及受控工具失败恢复；每项写操作都检查确认前无副作用和确认或取消后的真实文件状态。

## 未覆盖人工项

- 待用户人工确认：设置页启用、关闭内置本地模型后的真实界面状态和交互反馈。
- 待用户人工确认：真实 Electron 确认卡、取消与工具结果总结的可见交互。
- 待正式打包阶段确认：干净 Windows 环境安装、首次启动、退出、卸载及安装包体积。
- 待正式打包阶段确认：离线首启、反复启停、睡眠唤醒和异常退出后的进程清理。
- 待用户人工确认：不同 CPU、显卡、驱动和内存条件下的加载速度、生成速度与持续运行稳定性。
