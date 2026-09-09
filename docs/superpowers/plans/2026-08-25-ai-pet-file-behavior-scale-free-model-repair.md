# AI 桌宠文件、行为、固定尺寸与匿名免费模型修复计划

规格：`../specs/2026-08-25-ai-pet-file-behavior-scale-free-model-repair-design.md`

## 任务 1：解除文件提交与动画耦合

- RED：在 `apps/desktop/tests/agent-service.test.ts` 和真实组合测试加入无 carry 角色确认删除失败复现。
- GREEN：让 `apps/desktop/src/main/agent/agent-service.ts` 的全部文件写确认直接复用可信执行路径。
- REFACTOR：删除文件事务协调器、播放提交 IPC 接线及只服务旧路径的测试。
- 完成标准：四种写操作确认后均以本地结果为事实；删除仍进入回收站。

## 任务 2：删除缩放并固定 100%

- RED：新增 wheel 无副作用、preload 无缩放 API、旧 scale 被归一为 1.0 的测试。
- GREEN：删除 Renderer/preload/IPC 缩放入口，Main 固定 tick 10。
- REFACTOR：删除缩放探针与专用请求状态；保留必要的旧数据兼容读取。
- 完成标准：运行时尺寸不可变，拖拽、alpha 命中和单屏边界不回归。

## 任务 3：修复停止与距离协议

- RED：覆盖“停止不动”、30 秒自主调度为 0、local-idle 双重拦截、“跑远一点”的 far 结构和最小位移。
- GREEN：扩展 `motionPlan`、系统提示、显式 Gate 和单屏目标采样。
- REFACTOR：保持一个 MotionService 和一个 Scheduler，不新增第二套运动状态机。
- 完成标准：停止持久有效；单次、持续、时长、目标和距离均可由受限结构表达；自定义动作仍按公开候选裁决。

## 任务 4：接入匿名免费模型

- RED：覆盖无密钥档案、严格 allowlist、工具调用、429/401/退役以及 Provider 切换后确认失效。
- GREEN：在共享 Provider 目录、Settings、Registry 和设置页接入固定 Zen 匿名 Provider。
- 回归：新增选项与现有 Provider/自定义配置并存，往返切换不修改原档案。
- REFACTOR：复用现有 OpenAI-compatible adapter，不引入 OpenCode Agent 运行时或第二套文件工具。
- 完成标准：用户可直接选择匿名免费模型；限额与隐私边界清楚；文件能力仍只由 Main 执行。

## 任务 5：纵向验证与减法收口

- 运行各 package 定向测试与 typecheck。
- 运行 `pnpm verify:desktop`、`pnpm verify:behavior`、`git diff --check`。
- 真实 Electron 验证文件实际结果、停止锁、远距离目标和固定尺寸；免费模型实网只记录当时可用性。
- 独立复核规格符合性、安全边界、旧路径删除和脏工作区越界修改。
