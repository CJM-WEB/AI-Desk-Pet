# 2026-08-27 桌宠统一结构化控制修复验收

## 验收范围

本记录覆盖两条正式运行链：

1. 用户自然语言经 Main 高置信 Gate 或模型严格 `capabilityPlan` 转为本地 Agent 任务，再经过任务级授权、逐动作确认和文件或 PowerShell 工具执行。
2. 用户自然语言经严格 `movementControl` 转为 `0` 持续静止、`1` 持续运动、`2` 间歇运动或一次移动，并驱动用户角色包中语义最相近的状态与动作。

MCP 运行时、Agent 与 Renderer 保持禁用，不在本次验收中启用。

## 环境与版本

- 日期：2026-08-27。
- 系统：Windows 11 x64。
- 分支：`AgentCoreExtension`。
- 验收提交：`e1c184a`；文档提交位于其后。
- 基线提交：`16189b2`。
- 本地模型：`Qwen3.5-4B-Q4_K_M.gguf`，CPU backend，思考模式关闭。

## 自动化与真实执行结果

### 类型、单元、安全与集成

- `pnpm.cmd typecheck`：通过，10 个含脚本 workspace 全部通过。
- `pnpm.cmd test:unit`：通过，134 个测试文件、3314/3314。
- `pnpm.cmd test:security`：通过，28/28。
- `pnpm.cmd test:integration`：通过，4 个测试文件、80/80。
- Agent Core 最终定向：96/96。
- Provider、Adapter 与 LocalModelProvider 最终定向：239/239。
- Main 多步生产链定向：创建后第一张确认真实落盘，第二张移动确认继续有效并改变真实磁盘位置，1/1。

集成测试使用隔离临时授权根，实际覆盖创建、读取、文件名匹配、正文搜索、精确编辑、移动和删除。测试删除使用可恢复的回收站端口模拟；工具返回值而非模型正文是成败事实来源。

### 生产构建与 Electron E2E

- `pnpm.cmd test:e2e:desktop`：最终退出码 `0`；77 通过、1 项按配置跳过、0 失败，耗时约 8.4 分钟。
- 通过项包括固定桌宠尺寸、三轮 Win32 系统光标拖拽尺寸恒定、五方向真实运动 delta、停止跨重启与显式解锁、本地模型到云路由恢复、任务授权、真实文件创建/编辑/移动/回收站删除、PowerShell 成功/失败/取消、跨 Provider 历史披露和 MCP 禁用边界。
- 首轮完整 `verify:desktop` 在严格控制契约落地后有 14 个旧 E2E fixture 失败；失败均为脚本响应缺少新必填控制字段。产品契约没有降级，fixture 迁移后先定向 14/14 通过，再完成上述完整 E2E 77/1/0。

### 真实 CPU/GGUF

- 正式命令：`node apps/desktop/scripts/run-local-model-acceptance.mjs --backend cpu`。
- 退出码：`0`。
- 耗时：`490.284` 秒。
- 通过矩阵：中文聊天、关闭思考、任务级授权、确认前无副作用、创建、读取、glob、grep、编辑、移动、删除、中文相对路径、缺参澄清与紧邻续接、用户拒绝、受控工具失败恢复、工具结果总结、本地开启时零云调用、关闭本地后恢复云路由。
- 采集封装吞掉了 runner 原始 JSON stdout；本记录依据正式 runner 的逐项失败门和退出码记录结果，不伪造原始输出。
- 验收后未发现残留 `llama-server` 进程，仓库没有被临时验收目录污染。

CPU runner 不执行 PowerShell；PowerShell 证据来自真实 Electron E2E。2026-08-27 改造后的 Vulkan GGUF 未重跑，不记为通过。

## 独立复审

独立复审最终结论：实现层无 Critical、无 Important。复审确认：

- 云 Provider 与本地模型均拒绝缺少 `capabilityPlan` 或 `movementControl` 的纯文本或半结构响应。
- 多步任务在第一张确认后保留同一任务所有权，第二张确认不会 `ACTION_EXPIRED`。
- 工具名或参数错误使用合法的 assistant tool request 与 tool result 配对，OpenAI-compatible、Anthropic 与 Gemini 序列化均通过。
- 旧文件/PowerShell 双轨、复制提前失败、旧运动双入口、未调用运动转换路径与被覆盖的运行时代码均已删除。
- `git diff --check 16189b2...e1c184a` 与最终工作区检查均无错误。

## 待用户人工确认与未覆盖项

- 待用户人工确认真实角色素材的主观动画匹配、移动距离观感和 10–30 秒间歇节奏。
- 待用户人工确认设置页、任务级授权卡和逐动作确认卡的实际交互文案与操作感受。
- 2026-08-27 改造后的 Vulkan GGUF、不同硬件性能和长时间稳定性未覆盖。
- 干净 Windows 的安装、首次启动、卸载和安装包体积留到正式打包阶段。
- 代码复审记录了一个不扩大权限的 Minor：跨 Provider 回退时，幻觉工具名与 OpenAI 点号名称编码存在理论别名碰撞；当前正式主链和验收用例未触发，留作后续鲁棒性测试。

## 结论

本次范围内的文件与 PowerShell 控制链、Provider/本地模型严格意图协议和三态运动控制已通过自动化、真实 Electron 与 CPU/GGUF 验收。真实动画观感、Vulkan 和打包环境仍明确标为待验收，不作为本记录的通过项。
