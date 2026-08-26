# AI 桌宠四项回归收口验收记录

日期：2026-08-27

环境：Windows 11、Electron 43、Node.js/pnpm workspace、Vulkan 本地模型资源

## 1. 验收范围

本记录只覆盖本轮四项回归：固定尺寸拖拽、云 Provider 流式正文、受控文件工具和三态运动。MCP 正式运行链继续禁用，本轮不制作安装包。

## 2. 实现事实

### 2.1 拖拽

- Renderer 只发 begin/update/end 零坐标节拍；Main 读取系统光标并用冻结宽高的 `setBounds()` 原子移动。
- `controller` 与 `native` owner 独立；程序化位置预期不再拒绝 controller 接管，只在总 owner 集合边沿改变上层 blocker。
- `pointercancel`、`pointerup`、`mouseup`、Renderer 失效和窗口销毁均有收口；`getBounds`、`setBounds` 或回调抛错时使用 fail-safe 清理。

### 2.2 流式正文

- OpenAI-compatible、Anthropic 和 Gemini 普通无工具聊天均逐帧公开正文。
- 工具规划、工具参数和失败总结仍缓冲完成，不向 Renderer 流出半截结构。
- 协议终态后主动取消 reader，不等待长连接 EOF；Abort、超限、缺终态和终态后尾数据失败关闭。

### 2.3 文件工具

- 本地与云 Provider 共用 AgentLoop、canonical 工具名和 Main FileToolService，没有第二套文件执行器。
- 创建、读取、Glob、Grep、编辑、移动和回收站删除均以宿主结果为唯一成功事实。
- 普通文件以同卷排他硬链接占用目标后删除源，目录使用 Windows 不覆盖 `rename`；目标竞争、源删除失败和清理前目标替换均失败关闭。
- 授权根保存前和每次路径解析都拒绝系统、程序、全部 Windows 用户的凭据、密钥、浏览器配置与 AI Pet 私有目录；拒绝 NTFS ADS，普通 `.git` 和普通隐藏目录不被误封。

### 2.4 三态运动

- 运行时唯一持久 owner 为 `movementMode: 0 | 1 | 2`：持续静止、持续运动、间歇自主。
- 模式 2 每轮从 10–30 秒均匀抽取；模式 1 到达目标附近后继续换目标；拖拽、聊天和文件确认只暂停，不改写持久模式。
- 停止跨重启保留；停止后的明确单次方向/区域指令仍可执行。

## 3. 自动化证据

| 命令或验收 | 结果 |
| --- | --- |
| 桌面拖拽/IPC 定向测试 | 101/101 通过 |
| Provider 与会话流式定向测试 | 215/215 通过 |
| FileToolService 与 PathPolicy | 143/143 通过，typecheck 通过 |
| 单 worker 根级单测 | 132 个文件、3180/3180 通过 |
| `pnpm.cmd test:security` | 28/28 通过 |
| `pnpm.cmd test:integration` | 78/78 通过 |
| Electron E2E | 全量旧时序批次 76 通过、1 按设计跳过、拖拽验收脚本 1 项失败；修正 Win32 注入时序后该拖拽用例单独 1/1 通过，当前测试集证据合计 77 通过、1 跳过 |
| 真实 Win32 拖拽 | 3 轮 × 20 步，含 5.5 秒长按；owner 与尺寸恒定 |
| Vulkan 本地模型验收 | 首次受控失败组合检查未满足；拆分稳定诊断后复跑通过，离散显卡、全层 offload、禁止思考、七类文件操作、取消/失败恢复均为 true |

## 4. 已观察的门禁抖动

- `verify:behavior` 与 `verify:desktop` 的默认高并发单测会使既有文件系统测试超过 5/20 秒；本轮 `verify:behavior` 停在桌面单测 2515/2519，未进入后续门。相同代码树以单 worker 运行六个项目后 3180/3180 通过，证明是门禁资源争用，但原脚本本轮不记为通过。
- 5000 条目 Glob 预算测试隔离耗时约 14–16 秒，高并发实测约 22 秒，因此仅将该测试上限调整为 30 秒，不改生产预算。
- 角色恢复 E2E 在全量负载下超过默认 10 秒，改为等待真实 `data-status=ready` 最多 20 秒后通过，未改生产逻辑。
- Win32 按键注入有时在首次系统光标移动时才向 Renderer 投递按下事件；拖拽验收改为在首次真实位移后检查 probe 与 Main owner，仍保留三轮、长按和逐步尺寸断言。

## 5. 人工验收边界

自动化已验证系统光标、窗口边界、运动状态和真实文件副作用。真实人眼感受的拖拽跟手性、动画语义和不同 Windows DPI/多显示器体验仍待用户人工验收；本次不将这些未观察项写为已通过。
