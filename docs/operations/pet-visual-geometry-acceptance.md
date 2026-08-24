# 桌宠视觉几何与缩放验收记录

## 验收环境

- 测试日期：2026-08-24（Asia/Shanghai）。
- 操作系统：Windows 11 Pro，版本 `10.0.26200`，OsBuildNumber `26200`。
- 运行时：Node.js `v24.18.0`、pnpm `11.9.0`、Electron `43.1.1`。
- 分支与验收基线：`AgentCoreExtension`，开始验收时 HEAD 为 `649203c`。
- 测试范围：Desktop 的视觉几何、滚轮缩放、角色缩放持久化、动作脚底稳定和四边运动；不包含安装包或 EXE 启动方式。

## 自动化结果

| 场景 | 实际结果 | 证据边界 |
| --- | --- | --- |
| alpha 命中滚轮 | 真实 Electron 页面在透明像素和可见像素各使用 `page.mouse.wheel`；透明像素不改变档位，可见像素从 100% 变为 110% | 命中判断复用正式 alpha hit，不从测试 Canvas 猜测 |
| 缩放范围 | 可见 wheel 入口通过后，正式 preload→Main 调用把 `scaleTick` 从 `11` 推进到 `20`、再到 `5`；到达 200% 与 50% 后继续请求不再增加几何 revision | 边界调用等待真实事务结果，不使用 Renderer fire-and-forget 隐藏错误 |
| 脚底稳定 | 缩放与官方动作切换期间，持久脚底和 Renderer 匿名实际脚底采样均保持一致，且未出现越界 | Renderer 内组合真实窗口、Canvas 与动作锚点，仅返回布尔；逐帧主观观感仍不由离散采样替代 |
| 角色持久化 | 官方角色保存 50%，导入角色保存 130%；连续两次使用同一隔离 userData 重启后均恢复各自档位 | 同时覆盖新角色默认 100% 及切换事务期间并发滚轮请求 |
| 四边运动 | 导入的安全角色分别响应左、右、上、下自然语言指令，产生真实窗口运动并在对应工作区边界停止 | 四个方向均从工作区中心开始，按可见矩形而非透明窗口外框判断贴边 |
| 稳定性复跑 | 四边移动场景单次通过后，以单 worker 连续重复 3 次，结果 `3 passed (1.8m)` | 每个方向保留具名步骤，失败时不输出屏幕绝对坐标 |

## 严格 E2E 探针

视觉几何探针只在固定 E2E 开关下存在，并严格返回以下四个字段：

- `revision`：几何提交 revision；
- `scaleTick`：5 至 20 的整数档位，对应 50% 至 200%；
- `visualBoundsInWindowRatio`：可见矩形相对窗口的归一化 `x`、`y`、`width`、`height`；
- `outOfBounds`：可见矩形是否越出当前工作区的布尔值。

解析器拒绝旧九字段结构以及任何额外字段；探针在布局事务进行中、相对几何未稳定、revision 或角色发生变化、窗口实际尺寸与快照不一致时返回空值。它不返回脚底坐标、窗口坐标、工作区坐标、显示器 ID、文件路径或窗口句柄。生产 preload 边界不新增接口。

## 已执行命令

```powershell
pnpm.cmd --filter @myself/desktop typecheck
pnpm.cmd --filter @myself/desktop exec vitest run tests/pet-geometry-coordinator.test.ts tests/e2e-boundary.test.ts
pnpm.cmd exec vitest run --config tests/vitest.config.ts tests/integration/desktop-agent.test.ts -t "E2E 几何探针最小披露边界"
pnpm.cmd --filter @myself/desktop build
pnpm.cmd exec playwright test --config tests/playwright.config.ts tests/e2e/desktop.spec.ts --grep "alpha 命中真实 wheel 后在 50%–200% 封顶并保持脚底" --repeat-each=3 --workers=1 --reporter=line
pnpm.cmd exec playwright test --config tests/playwright.config.ts tests/e2e/desktop.spec.ts --grep "官方动作切换保持持久脚底且四边 region 终点贴边" --repeat-each=3 --workers=1 --reporter=line
pnpm.cmd verify:desktop
```

结果：Desktop 类型检查和构建通过；几何协调器与 E2E 边界测试 `80/80` 通过；严格探针集成测试 `5/5` 通过；alpha-wheel 与四边真实 Electron 场景各自连续 `3/3` 通过。曾有一次未指定仓库 Playwright 配置的诊断命令使用默认 5 秒断言超时，alpha-wheel 首档等待失败；另一次正式全门禁暴露了旧候选扫描会把迟到穿透状态归给下一像素，以及逐格重放 UI 事件会跨 Canvas 重建落空。最终夹具让候选状态有界收敛，只用真实 wheel 证明透明/可见入口，其余档位直接等待正式 preload→Main 事务。上述失败尝试不计入通过证据。

最终 `pnpm.cmd verify:desktop` 通过：全仓类型检查通过；单元测试 `2745/2745`、安全测试 `24/24`、集成测试 `67/67`；Desktop 构建、preload 外部依赖边界和生产 MCP 禁用边界通过；真实 Electron E2E `72 passed, 1 skipped, 0 failed`，总耗时约 7.3 分钟。跳过项为既有 B7 五分钟长时场景，不属于本次视觉几何验收。

## 人工验收与安全范围

- **待用户人工确认**：官方动作切换时的逐帧视觉观感是否完全无抖动。自动化已经证明持久脚底不变和离散采样不越界，但这些证据不能替代肉眼对帧间跳变的判断。
- 本轮真实 Electron E2E 会反复启动隔离桌宠进程；测试结束后由 fixture 清理，不使用安装包或 EXE 发布入口。
- 本轮没有启用桌宠 MCP；MCP runtime、Agent 和 Renderer 继续保持禁用。
- 本轮没有新增文件系统、PowerShell、密钥或任意系统权限，也没有向 Renderer 暴露屏幕绝对坐标。
