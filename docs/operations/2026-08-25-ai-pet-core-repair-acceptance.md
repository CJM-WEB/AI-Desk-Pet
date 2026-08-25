# AI 桌宠核心修复自动验收记录

## 1. 范围与现行结论

- 日期：2026-08-25（Asia/Shanghai）。
- 规格：`docs/superpowers/specs/2026-08-25-ai-pet-file-behavior-scale-free-model-repair-design.md`。
- 范围：文件确认执行、停止与远距离行为、固定默认尺寸。
- 当前状态：实现、独立复审和最终自动门禁均完成；真实 Windows 主观体验仍待用户人工确认。
- MCP runtime、Agent 与 Renderer 继续禁用；本轮没有制作安装包。

## 2. 实现边界

- 文件：模型只提出严格工具请求；确认后由 Electron Main 直接执行受控写入。carrying 动画只是尽力反馈，Renderer、播放令牌和提交帧没有执行授权。
- 行为：隐藏计划固定包含 `behaviorPlan` 与 `motionPlan.mode/durationSeconds/target/distance`；停止锁由本地 Gate 与 Director 双层执行，`far` 只在当前单屏可达范围选点。
- 尺寸：桌宠固定为 100%；wheel 监听、preload 缩放 API、Main 缩放 IPC 与缩放专用探针已删除，旧持久化 scale 归一为 1.0。

## 3. TDD 与定向证据

- 文件：无 carry 角色确认删除的 RED 证明执行次数为 0；GREEN 后 Desktop 文件相关 164 项通过，真实 Electron 单场景确认前无副作用、确认后隔离回收站仅执行一次。
- 行为：缺少 `distance`、停止词未命中、停止锁可被 local-idle 绕过与 far 近点均先形成失败；GREEN 后 character-runtime 303 项、Desktop 核心行为 189 项通过。
- 固定尺寸：wheel 无副作用、preload 无缩放能力与旧 scale 归一测试先失败；GREEN 后相关 8 文件 168 项通过。
- 全仓类型检查：`pnpm.cmd typecheck` 退出 0。

## 4. 完整门禁过程

- 第二次 `verify:desktop`：类型检查、单元 2805/2805、安全 23/23 通过；集成 69/70，持续运动夹具缺少新必填 `behaviorPlan/distance` 而失败，因此构建与 Electron E2E 未由该次命令执行。夹具补齐后该纵向用例定向 1/1 通过。
- 最终 `pnpm.cmd verify:desktop` 退出 0：全仓类型检查通过，单元 2805/2805、安全 23/23、集成 70/70、正式构建与 preload/MCP 生产边界校验通过；Electron E2E 70 通过、1 条既有五分钟长时场景按配置跳过、0 失败。
- 最终 `pnpm.cmd verify:behavior` 退出 0：character-runtime 303/303、agent-core 72/72、Desktop typecheck 与 Desktop 单元 2244/2244、安全 23/23、集成 70/70、正式构建通过；Electron E2E 70 通过、1 跳过、0 失败。
- 独立复审初次发现持续运动旧夹具等 Important；修复后复核为 Critical 0、Important 0。

## 5. 人工与实网边界

- 自动 E2E 使用隔离 userData、临时授权根和隔离回收站端口，不替代真实 Windows 回收站恢复验证。
- 真实窗口动画观感、鼠标拖拽、默认尺寸肉眼确认与真实回收站恢复仍为“待用户人工确认”。
