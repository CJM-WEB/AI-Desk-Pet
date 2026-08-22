# 桌宠行为导演终验记录

## 验收环境与边界

- 验收日期：2026-08-23（Asia/Shanghai）。
- 操作系统：Windows 11 专业版，版本 `10.0.26200`，构建号 `26200`。
- 分支与起始提交：`AgentCoreExtension`，Task 7 开始时 HEAD 为 `ef8d704`。
- Provider：真实窗口验收确认公开设置路由为 DeepSeek `deepseek-v4-flash`；自动化使用仅监听随机回环地址的脚本化 OpenAI-compatible Provider，不访问公网。
- 范围：行为导演 B1–B7、真实桌宠动作与相对位移、主动性、停止锁、反思边界及既有聊天/文件安全回归。
- MCP：源码与保留数据未删除，但运行时、Agent 和 Renderer 继续禁用；本任务没有启动或恢复 MCP。
- 网站：未修改、构建或启动 `apps/website`。

## 自动化结果

| 门禁或场景 | 结果 | 事实边界 |
| --- | --- | --- |
| 全仓类型检查 | 通过，退出码 `0` | `pnpm.cmd typecheck`；Task 7 开发期及 `verify:desktop` 内均通过 |
| 角色运行时 | 15 个测试文件、263 项通过 | `pnpm.cmd --filter @myself/character-runtime test` |
| Agent Core | 71 项通过 | `pnpm.cmd --filter @myself/agent-core test` |
| Desktop 单元测试 | 94 个测试文件、2041 项通过 | `pnpm.cmd --filter @myself/desktop test`；全仓单元门内合计 2550 项通过 |
| 安全测试 | 24 项通过 | 覆盖 chat/reflection 零工具、文件/PowerShell/MCP 零越权调用、停止锁与诊断脱敏 |
| 集成测试 | 4 个测试文件、61 项通过 | 覆盖 JSON Output、行为上下文、显式指令、Provider 切换与文件/PowerShell 既有链 |
| Task 7 快速 Electron | 6 项通过，约 1.3 分钟 | 四向与左上区域真实相对位移；缺动作不伪装 idle；停止锁跨重启；停止期间原地聊天动作保留 |
| Task 7 长时 Electron | 1 项通过，最终复跑约 7.1 分钟 | `AI_PET_LONG_BEHAVIOR_E2E=1`；真实墙钟验证三档主动性、聊天/拖拽/文件确认阻塞、2–5 分钟反思与 close-late 隔离；原始 Provider 请求显式携带 `tool_choice: none` |
| `pnpm.cmd verify:desktop` | 通过，退出码 `0` | 类型检查；2550 项单元；24 项安全；61 项集成；Electron 69 项通过、1 项长时链按设计跳过，约 5.8 分钟 |
| `pnpm.cmd verify:behavior` | 通过，退出码 `0` | 角色运行时、Agent Core、Desktop、安全、集成；Electron 69 项通过、1 项长时链按设计跳过，约 5.7 分钟 |

默认完整门禁不重复执行 9–12 分钟长时链，以满足单命令十五分钟时间盒；该链已通过以下独立命令取得真实墙钟证据：

```powershell
$env:AI_PET_LONG_BEHAVIOR_E2E='1'
pnpm.cmd exec playwright test --config tests/playwright.config.ts tests/e2e/desktop.spec.ts --grep "B7 长时"
```

## 受控进程与退出证据

| 门禁 | 受控根进程与时间 | 基线与退出结果 |
| --- | --- | --- |
| Task 7 长时 Electron 最终复跑 | PowerShell PID `20536`；`04:31:23`–`04:38:28` | 启动前除根进程外无本项目 Electron/Node/Pnpm；退出码 `0`；结束后本项目 Electron/Node/Pnpm 列表为空 |
| `verify:desktop` | PowerShell PID `13284`；`04:38:37`–`04:46:06` | 启动前除根进程外无本项目 Electron/Node/Pnpm；退出码 `0`；结束后本项目 Electron/Node/Pnpm 列表为空 |
| `verify:behavior` | PowerShell PID `7852`；`04:46:15`–`04:53:32` | 启动前除根进程外无本项目 Electron/Node/Pnpm；退出码 `0`；结束后本项目 Electron/Node/Pnpm 列表为空 |

三次命令均由 Codex 受控 PTY 直接捕获标准输出、标准错误与退出码，没有创建额外临时日志文件，因此不存在待删除日志。Electron fixture 依其精确可执行文件路径和 PID 完成自然退出或受限清理；门禁结束后未执行宽泛进程终止。

## 真实桌宠窗口观察

| 里程碑 | 实际观察 | 结论 |
| --- | --- | --- |
| 被动档 | 连续超过 60 秒未出现自主动作或位移 | 通过 |
| 辅助档 | 三个观察窗口内未移动；当时角色只有一个 idle 动作，连续重复被抑制 | 通过；不能据此声称所有角色都会频繁做不同动作 |
| 自主档 | 桌宠窗口由约 `(1866, 1196)` 移至 `(2007, 1181)`，并观察到 `behavior-action` | 通过 |
| 真实 Provider 路由 | 公开设置显示 DeepSeek `deepseek-v4-flash` | 通过 |
| 静默反思 | 观察到 `BEHAVIOR_REFLECTION_STARTED`，约 6753ms 后为 `BEHAVIOR_REFLECTION_DROPPED(NO_PLAN)`，无用户可见反思正文 | 通过；`DROPPED(NO_PLAN)` 是允许的有限结果，不写成已执行动作 |
| 持久停止锁 | “停下”后约 65 秒保持 `(2261, 1151)`；“继续活动”后收到恢复确认 | 通过 |
| 聊天与拖拽 | Electron 快速链验证真实像素命中左键拖拽；长时链在 25 秒真实拖拽期间保持阻塞，未触发 30 秒安全超时 | 通过；完整调度区间由 fake timer 单元测试补足 |
| 文件确认 | 长时链让确认卡持续超过 60 秒，期间无主动动作或位移，取消后恢复 | 通过 |

## 关键安全与回归结论

- 普通聊天与反思请求均固定 `tools: []`、`toolChoice: 'none'`；fixture 另行记录原始字段是否存在，集成与长时 Electron 均证明不是由 fixture 缺省补值伪造；行为 JSON 不能获得文件、PowerShell 或 MCP 权限。
- 明确方向、区域、停止和恢复在 Provider 前由 Main 识别；Provider 或反思返回的 stop/resume 不得持久修改停止锁。
- E2E 运动探针只在 `--myself-e2e-probe` 下公开累计 `{ moved, horizontal, vertical }`，不返回绝对坐标、目标、时间戳、路径、正文、私有 ID 或令牌，也没有坐标写接口。
- DeepSeek/OpenAI-compatible JSON Output 中经本地校验的 `behaviorPlan.emotion` 会继续投影为既有 `character_emotion` 事件；完整 Electron 套件已验证聊天阶段、情绪、错误降级与角色切换闭环。
- 两条完整门禁及长时复跑结束后，本项目路径限定的 Electron、桌宠、测试 Node 与 Pnpm 枚举均为空。验收期间未观察到 Windows 崩溃或重复错误报告弹窗。

## 诊断过程中的已处理问题

- `official-default-character` 的真实磁盘 I/O 用例在四 worker 的 Windows 全套负载下连续两次超过默认 5 秒，但隔离运行约 0.5 秒。只把该用例局部上限调整为 15 秒，未改变断言、生产代码或全局超时；最终完整门禁通过。
- 首轮完整 Electron 在旧情绪脚本上稳定复现 `happy` 事件缺失。RED 证明 JSON Output 内已验证的情绪未投影到既有事件；最小修复后适配器单元测试和真实 Electron 纵向用例均通过。
- 审查发现 E2E 相对运动探针允许 `moved: false` 与非零差值同时出现。RED 在其余 2040 项通过时准确失败；Schema 增加一致性约束后定向 10/10、两条完整门禁均通过。
- 首次重跑长时链在 3.4 分钟处发现：拖拽开始时的可见像素经过 25 秒动画后可能已变透明，释放后合法恢复穿透，但测试错误地固定要求非穿透。代码、既有 E2E、18/18 定向单测和独立只读复核均证明产品语义正确；只把长时断言收窄为验证 `dragging: false`，最终从头复跑 1/1 通过，未修改生产拖拽逻辑。

## 未覆盖与后续人工项

- 当前阶段的运动和屏幕约束仍以桌宠窗口矩形为主。视觉像素包围盒、碰撞体贴合、滚轮缩放、脚底锚点与连续拖拽左上漂移属于后续几何阶段，本记录不声称已完成。
- 跨显示器、负坐标、不同 DPI 下的拖拽手感和贴边观感仍待用户人工确认。
- 动作自然度、长时间重复感、不同角色素材清单下的鲜活程度属于主观体验，仍待用户人工确认。
- 本阶段未制作安装包，也未以安装版 EXE 验收；使用仓库构建产物直接启动 Electron。
