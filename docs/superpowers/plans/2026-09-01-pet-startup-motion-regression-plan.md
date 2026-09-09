# 桌宠启动与移动体验回归修复计划

适用规格：`docs/superpowers/specs/2026-09-01-pet-startup-motion-regression-design.md`

状态：启动与固定尺寸任务已实施；闪烁代码调整按用户后续决定撤回。

## 任务 1：启动空状态与损坏状态分流

- 文件：`apps/desktop/src/main/characters/character-startup.ts`、`apps/desktop/src/main/index.ts`、`apps/desktop/src/renderer/src/pet/PetView.tsx`
- RED：首次空索引初始化默认角色不产生降级码；健康强制重载清除旧横幅。
- GREEN：增加 Main 私有三态裁决并复用现有列表、默认角色与播放器成功回调。
- 完成标准：真实损坏仍提示，正常首次初始化和修复后的健康角色不提示。

## 任务 2：冻结拖拽与舞台尺寸

- 文件：`apps/desktop/src/main/windows/window-manager.ts`、`apps/desktop/src/main/windows/pet-window-interaction-controller.ts`、`apps/desktop/src/main/windows/pet-geometry-coordinator.ts`、`apps/desktop/src/main/index.ts`、`apps/desktop/src/renderer/src/characters/player/CharacterPlayer.tsx`
- RED：第二轮拖拽返回漂移宽高时测试失败；Main 几何刷新解除舞台宽高时测试失败。
- GREEN：共享固定窗口尺寸，拖拽永远提交固定宽高，删除舞台解锁旧路径。
- 完成标准：多轮拖拽与几何刷新均不能改变窗口和舞台尺寸。

## 任务 3：撤回闪烁代码调整

- 文件：`apps/desktop/src/renderer/src/characters/player/pixi-character-player.ts`、`apps/desktop/src/renderer/src/characters/player/CharacterPlayer.tsx`、`apps/desktop/src/main/characters/pet-visual-geometry.ts`
- RED：新增回归期望动作级 ground、未取整 Pixi 和原始小数 CSS 位移，使当前闪烁修正实现失败。
- GREEN：删除逐帧 ground、逐帧 Main 边界联合、`roundPixels` 和 DPR 位移量化，恢复上一版本正式播放路径。
- 完成标准：只撤回闪烁相关代码；舞台尺寸锁、固定窗口尺寸、启动恢复和 Run 角色数据保持不变。

## 任务 4：修正当前紫色角色移动表现

- 数据：活动角色 `a497bc43-7915-49e9-bfd8-b87903d8a491`。
- 前置：将精确角色目录和 `index.json` 复制到 `D:\Backup` 的带时间戳目录。
- 执行：通过角色工作室草稿/发布链把 `move` 表现从 Attack2 素材切换到已导入的 Run 素材。
- 完成标准：运行清单的移动表现来自 Run 新编译资源；旧源素材保留，发布失败可由备份恢复。

## 任务 5：复审与验证

- 运行定向测试与桌面 typecheck，再运行角色、行为及桌面适用门禁。
- 使用独立规格复审和代码质量复审检查需求、边界、旧路径删除及测试覆盖。
- 构建可启动版本并保留人工验收步骤；MCP 运行时继续禁用。
