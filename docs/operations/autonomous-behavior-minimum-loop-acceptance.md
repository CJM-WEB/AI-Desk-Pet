# 自主行为最小闭环验收记录

## 验收环境

- 测试日期：2026-08-06（Asia/Shanghai）。
- 操作系统：Windows 10 Pro，WindowsVersion `2009`，OsBuildNumber `26200`。
- 应用版本：`0.1.0-alpha.1`。
- 使用角色：官方 `builtin-default`；隔离测试角色 `e2e-safe-character`（V2，六类标准语义与一个自定义状态）。
- 测试范围：仅智能桌宠 Desktop，不包含网站与 WebsiteExtension。

## 自动化闭环结果

| 场景 | 实际动作与结果 | 证据边界 |
| --- | --- | --- |
| 待机 | `idle-action`（集成）与 `idle-main` / `safe-idle-action`（Electron） | Main 产生动作，Renderer 探针观察到已排程或播放终态 |
| 倾听 | `listen-action` / `safe-listen-action` | 服务组合测试和 Electron 页面事件序列均观察 `listening` 先于 `thinking`；未虚构人工目视 |
| 思考 | `think-action` / `safe-think-action` | Agent 提交后由可信阶段事件触发 |
| 移动 | `move-action` / `safe-move-action` | Electron 同时观察到动作与窗口坐标变化，位移仍由运动服务完成 |
| 成功 | `celebrate-action` / `safe-celebrate-action` | 模型有意图、非法意图及无意图的成功流程均回到本地成功语义 |
| 失败 | `fail-action` / `safe-fail-action` | 脚本 Provider 耗尽后公开稳定错误并进入失败动作 |

## 中断、反馈和降级

- 用户交互中断：正常待机播放收到桌宠拖拽交互后产生更高 revision 的待机动作，旧调度不再是当前动作。
- 抗中断：运行时和 Main 单元门禁继续验证抗中断动作；本次集成没有降低中断优先级或令牌鉴权断言。
- Renderer 反馈：Electron 关键断言要求动作离开 `scheduled`，到达 `started` 或合法终态；用户交互后必须是更高 revision 的新动作完成 Renderer 反馈。preload 单元测试另验证同动作旧令牌乱序返回不会污染新调度。
- 合法 Agent 意图：可推断自定义状态在集成中选择 `focus-action`；Electron 中合法移动意图选择 `safe-move-action`。
- 非法 Agent 意图：不存在的 `missing-state` 未进入探针，任务开始决策明确回退到本地思考状态，再进入成功流程。
- 无 Agent 意图：Electron 仍完整观察思考与成功；服务组合测试验证六类本地状态不依赖模型行为意图。
- 角色切换：从 `e2e-safe-character` 切回 `builtin-default` 后，当前动作变为 `idle-main`，旧 `safe-fail-action` 不再生效。
- 应用重启：由 Desktop 既有 Electron 重启用例验证同一隔离 userData 的恢复与清理；本次新增闭环用例验证角色切换令牌隔离。没有声称进行主观重启动画观察。
- 模型不可用：脚本 Provider 无剩余响应时公开“模型服务发生错误，请稍后重试。”，桌宠进入 `safe-fail-action`，基础窗口保持可用。

## 连续五分钟观察

自动观察实际持续 `303725 ms`，共采样 11 次：

- 行为 revision：`0, 5, 11, 17, 23, 29, 35, 41, 47, 53, 59`；动作集合为初始空值与 `idle-main`，未观察到无界动作 ID 增长。
- Main Electron CPU 累计时间：从 `1.40625 s` 增至 `3.359375 s`，五分钟增量 `1.953125 s`。
- Main Electron 工作集：峰值 `132313088 bytes`，末值 `115421184 bytes`。
- 脱敏日志：`38575 bytes`；自动断言确认不含测试密钥、授权目录或 `Authorization` 字段。
- 自动化无法证明动画主观流畅度、肉眼重复感和所有日志文本的人工语义判断；这些项目标记为**待人工**，未写成已完成观察。

## 安全范围确认

本次行为闭环没有新增文件实体、长期记忆、语音、MCP、桌面自动化或高权限 IPC。行为探针只在固定 E2E 参数下暴露五个字段：revision、主状态 ID、来自 Main 决策快照的修饰状态 ID 列表、动作 ID、播放状态；不返回 Agent 解释、聊天内容、素材 ID、文件路径、窗口句柄或播放令牌。生产 preload 边界测试确认无 E2E 参数时不暴露探针。
