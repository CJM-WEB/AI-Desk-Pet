# AI 桌宠拖拽、运动恢复、文件移动与 Zen 退役实施计划

规格：`docs/superpowers/specs/2026-08-25-ai-pet-drag-resume-file-move-zen-removal-design.md`

## Task 1：RED 固定四条缺陷

- 在 Provider、SettingsStore 与设置 UI 测试中断言 Zen 能力不存在且旧档案被定向迁移。
- 在拖拽控制器与 PetView 测试中断言 pointerdown 立即开始、首轮同步、拖拽静态视觉和提示删除。
- 在 Gate 与 Director 测试中断言显式运动先解锁再执行，落盘失败不运动。
- 在 Router、AgentLoop、FileToolService、集成与 E2E 中断言真实移动和只读结果不能伪造写成功。

完成标准：新增测试在当前实现上因对应缺陷稳定失败，而不是因夹具或类型错误失败。

## Task 2：删除 Zen 正式链

- 删除目录、Schema、Registry、Provider、设置服务、会话、UI 与错误映射分支。
- 增加旧 Zen 档案的退役迁移，保留其他设置。
- 删除旧 Zen 专属测试与现行验收结论。

完成标准：Zen 功能扫描只允许退役迁移和历史规格中的替代说明；现有 Provider 定向测试通过。

## Task 3：修复拖拽

- Renderer pointerdown 立即启动 Main 拖拽；删除阈值状态。
- Main 建立 session 后立即同步一次，再保留 interval。
- 拖拽期间使用 static 播放，删除提示 DOM/CSS。

完成标准：拖拽定向测试通过，窗口尺寸和 scale tick 不变。

## Task 4：修复运动恢复

- Gate 增加短词。
- Director 在显式运动前原子解除停止锁，失败关闭。

完成标准：行为 RED 转绿，既有停止、持续运动和自主调度测试不回归。

## Task 5：实现真实文件移动与写结果绑定

- 扩展公共规划、工具 Schema、注册表、确认卡和 FileToolService。
- Main 预览/确认链展示源与目标并执行真实 `rename`。
- AgentLoop 将写任务完成绑定到期望操作的本地结果。

完成标准：单元、真实 FS 集成和 Electron E2E 均证明确认前无副作用、确认后源消失目标出现，伪成功被拒绝。

## Task 6：门禁与减法收口

- 运行定向测试、类型检查、安全、集成、Desktop 与 Behavior 门禁。
- 删除只服务旧 Zen、拖拽阈值、提示文字与伪测试工具的代码。
- 运行 `git diff --check` 和只读差异审查，更新独立验收记录。

完成标准：自动证据逐项对应需求；主观拖拽观感明确标记待用户人工确认。
