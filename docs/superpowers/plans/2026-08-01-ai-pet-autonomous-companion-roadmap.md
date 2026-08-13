# AI 桌宠自主陪伴演进 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不替换现有 Electron/TypeScript 主体系的前提下，逐步交付自主角色行为、文件实体交互、Explorer 动态层级、本地长期记忆、主动陪伴、动态模型目录和可选语音能力。

> **2026-08-10 路线修订：** 目录藏身已经退役；不再采集 Explorer 目录路径，也不提供目录空间设置、托盘命令或角色表现。阶段 3 默认使用无路径、非 topmost 的 Explorer 动态相邻层级，并增加默认关闭的可选陪伴置顶偏好。该偏好是独立窗口行为，不是 Agent 隐私、数据披露或主动性能力。历史详细计划的未验收项目不因本修订追认为通过。

**Architecture:** 以现有 `agent-core`、`character-runtime`、`character-assets`、`file-tools` 和桌面端 Main/Preload/Renderer 为稳定边界，每个阶段交付一个可独立验收的纵向切片。总体设计只定义跨阶段契约；每个独立子系统在进入实施前使用当前代码基线生成自己的详细计划，避免提前写出的文件位置和接口在数个阶段后失效。

**Tech Stack:** Electron 43、React 19、TypeScript 5.9、PixiJS 8、Zod 3、Zustand 5、Vitest 3、Playwright 1.61、pnpm 11、Windows 10/11。

## Global Constraints

- 目标分支固定为 `AgentCoreExtension`，不合并到 `main`。
- 以自有体系为主；参考项目只用于设计吸收、接口兼容和许可证允许的局部复用。
- 文档、用户可见文案和结构性代码注释使用中文。
- 采用最小修改、TDD、频繁提交；不进行推倒重写或无关重构。
- 角色包不能携带任意脚本、命令或系统权限。
- 文件删除默认移入 Windows 回收站，第一阶段不开放永久删除。
- 长期记忆保存在本机；文件内容、路径、截图和剪贴板默认不进入长期记忆。
- MCP 保留源码与持久化数据，但运行时、Agent 和 Renderer 均保持禁用。
- 不持续截图，不让模型参与逐帧状态判断。
- 任一可选模块关闭或失败时，基础桌宠和普通文字聊天仍然可用。
- 单个问题超过约定时间仍无实质进展时切换实现路线，不静默跳过。

---

## 1. 计划套件与执行顺序

| 顺序 | 子项目 | 输出 | 进入条件 |
| --- | --- | --- | --- |
| 0 | 当前分支基线收尾 | [阶段 0 详细计划](./2026-08-01-agentcoreextension-baseline-completion.md) | 可立即执行 |
| 1 | 角色包 V2 与自主行为 | 独立详细计划 | 阶段 0 验收后，以当时代码为基线 |
| 2 | 文件实体交互与 Explorer 动态层级 | 独立详细计划 | 行为契约和任务动作协议稳定后 |
| 3 | 陪伴聊天、记忆与主动性 | 独立详细计划 | 角色作用域和行为事件契约稳定后 |
| 4A | 动态模型目录 | 独立详细计划 | 确认生产目录签名公钥与发布位置后 |
| 4B | 语音适配 | 独立详细计划 | 确认首个 ASR/TTS 引擎后 |
| 5 | Windows 桌面自动化 | 新安全设计与独立计划 | 另行完成 UIA/视觉执行安全设计后 |

后续计划不是阶段 0 的并行任务。每个计划必须读取前一阶段的真实提交和测试结果后再锁定文件结构，避免同一核心文件被多个过早计划同时假设不同接口。

## 2. 已确认的现有复用点

- `packages/character-runtime/src/character-schema.ts` 已提供 V1 角色、扩展状态、动作帧、锚点和命中区域契约。
- `packages/character-runtime/src/state-arbiter.ts` 已提供核心任务状态与扩展状态仲裁。
- `packages/character-runtime/src/action-selector.ts` 已提供方向、最近动作和权重选择。
- `apps/desktop/src/main/characters/character-motion-service.ts` 已持有移动、动作播放令牌和用户拖拽状态。
- `packages/file-tools/src/file-tool-service.ts` 已提供预览—确认后执行所需的不可伪造 `VerifiedWriteAction`。
- `apps/desktop/src/main/memory/local-memory-store.ts` 已提供本地原子写、损坏隔离和会话授权骨架。
- `apps/desktop/src/main/agent/proactivity-policy.ts` 已提供可信事件、主动性模式和高风险确认策略。
- `apps/desktop/src/main/agent/agent-service.ts` 已提供任务阶段、确认卡、继续令牌和文件披露控制。
- `packages/shared-types/src/provider-catalog.ts` 与 `ProviderRegistry` 已提供模型目录和协议适配基础。

## 3. 子项目边界

### 3.1 角色包 V2 与自主行为

该子项目负责角色语义、皮肤覆盖、状态共存、动作约束、Agent 行为意图和本地动作调度。它不实现真实文件删除、资源管理器观察、记忆数据库或语音引擎。

### 3.2 文件实体交互与 Explorer 动态层级

该子项目复用已经稳定的任务动作协议，保留回收站适配器、动画提交点，并通过不含目录路径的 Explorer 实例观察建立默认非 topmost 的动态相邻层级。用户可显式开启默认关闭的陪伴置顶偏好；开启时暂停动态层级，关闭后恢复。目录藏身、空间状态、目录授权和托盘呼唤已经退役；窗口置顶偏好不扩大 Agent 的文件授权或隐私能力范围。

### 3.3 陪伴聊天、记忆与主动性

该子项目先解除普通聊天对授权目录的错误依赖，再把现有 MemoryStore 升级为共享档案与角色关系作用域，最后接入可查看、修正、遗忘的隐私界面和受冷却约束的主动建议。

### 3.4 动态模型目录与语音

模型目录先实现服务商发现、未知模型保守能力和手动 ID；签名更新必须使用确定的生产公钥和发布地址。语音接口与具体引擎分开，未选定首个 ASR/TTS 引擎前不写假实现。

### 3.5 Windows 桌面自动化

该子项目在当前路线中只保留设计门。任何 UIA、Win32/COM、截图、视觉定位和鼠标键盘执行都必须在新的安全规格批准后规划；不得借 MCP、Shell 或角色包绕过该门。

## 4. 全局验证门

每个子项目结束时至少执行：

```powershell
pnpm typecheck
pnpm test:unit
pnpm test:security
pnpm test:integration
```

涉及桌面窗口、Preload 或 IPC 的阶段再执行：

```powershell
pnpm test:e2e:desktop
```

涉及角色包、播放器和角色工作室的阶段优先执行完整角色门禁：

```powershell
pnpm verify:characters
```

## 5. 提交与验收

- 每个任务只提交该任务的测试、实现和必要中文文档。
- 每个子项目使用独立验收记录，不把多个阶段压成一个提交。
- 自动测试通过不替代 Windows 上的窗口层级、拖拽、资源管理器和托盘人工验收。
- 未满足子项目进入条件时停止在该门，不以临时代码假装完成。
