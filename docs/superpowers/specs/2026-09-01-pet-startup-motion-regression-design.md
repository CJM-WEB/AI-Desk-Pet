# 桌宠启动与移动体验回归修复设计

日期：2026-09-01

状态：用户已指定启动问题采用推荐方案 2，并授权严格复审后持续实施

## 1. 目标

本轮只修复三个已复现问题：

1. 首次没有活动角色时初始化官方默认角色，但不显示“当前角色运行版本不可用”；真实运行版本损坏时仍降级并准确提示，后续健康角色加载成功后清除旧提示。
2. 无论拖拽多少轮，桌宠窗口、角色和恢复横幅始终保持固定 `180 × 220 DIP`，不继承 Windows 高 DPI 返回的漂移尺寸。
3. 移动动画按逐帧脚底锚点稳定落点，Renderer 位移对齐物理像素；当前紫色角色的 `move` 表现改用已经导入但尚未使用的 Run 素材。

## 2. 非目标与边界

- 不恢复滚轮缩放，不新增角色尺寸设置。
- 不启用 MCP，不改变文件、PowerShell 或角色包安全边界。
- 不自动改写其他用户角色的动作语义，也不根据 Alpha 轮廓猜测作者未声明的锚点。
- 不修改窗口透明、置顶、鼠标穿透或运动三态的既有产品语义。

## 3. 现状证据与根因

### 3.1 首次初始化被误判为损坏

`CharacterActions.getCharacterRuntimeSnapshot()` 对“索引中没有活动角色”和“活动角色运行版本不可用”都返回 `null`。`prepareCharacterStartup()` 随后把任意 `null` 投影为 `CHARACTER_RUNTIME_UNAVAILABLE`，导致正常首次初始化也显示降级横幅。Renderer 又将启动快照保存为优先错误，健康角色切换成功后没有清除它。

### 3.2 拖拽继承漂移尺寸

桌宠窗口创建参数已经固定宽高，但 `PetWindowInteractionController.beginDrag()` 每轮重新保存 `BrowserWindow.getBounds()` 的宽高。Windows 高 DPI 边界换算一旦返回漂移尺寸，下一轮拖拽就会把该尺寸作为新权威写回。`CharacterPlayer` 在 Main 几何刷新时还会临时移除舞台宽高锁，使漂移客户区有机会成为新的 Canvas 尺寸，因此角色和横幅会一起变大。

### 3.3 移动闪烁由三项问题叠加

- 角色格式和工作台支持 `frame.anchors.ground`，正式播放器却始终只使用动作级 `action.anchors.ground`。
- Renderer 每帧使用未对齐物理像素的 CSS 小数位移，透明像素画在高 DPI 下发生采样抖动。
- 当前活动角色的 `move` 动作绑定 `Pink_Monster_Attack2_6.png`，而 `Pink_Monster_Run_6.png` 仅存在于源素材目录且没有进入表现；攻击帧的大幅姿态变化被当作移动动画播放。

## 4. 设计

### 4.1 三态启动裁决

Main 私有启动依赖返回以下封闭结果，不扩展 IPC：

```ts
type ActiveRuntimeValidation =
  | { kind: 'ready'; activeCharacterId: string }
  | { kind: 'missing' }
  | { kind: 'unavailable' };
```

- `ready`：继续使用现有活动角色，不准备默认角色。
- `missing`：准备官方默认角色，`fallbackErrorCode` 保持 `null`。
- `unavailable`：按现有恢复路径准备官方默认角色，并发布 `CHARACTER_RUNTIME_UNAVAILABLE`。
- 索引恢复、资源损坏和其他白名单错误仍保持原有更具体的错误码。
- `CharacterPlayer` 在活动角色变更后完成强制重载并报告 `null` 时，`PetView` 同时清除播放器错误和旧启动降级错误。

### 4.2 单一固定窗口尺寸

- `window-manager` 导出唯一的 `PET_WINDOW_SIZE`，窗口创建、拖拽控制器和 Main 几何协调器共同使用。
- 拖拽会话只保存起始光标与起始 `x/y`；每次 `setBounds()` 都写入 `PET_WINDOW_SIZE`，不采用后续 `getBounds()` 的宽高。
- Main 几何刷新只重新提交已经锁定的舞台尺寸，不再先移除 `width/height`。
- 拖拽异常、窗口销毁和 owner 释放逻辑保持不变。

### 4.3 稳定逐帧播放

- 正式 Pixi 场景显示每一帧时，使用 `frame.anchors.ground ?? action.anchors.ground` 设置精灵锚点；布局位置仍由动作级脚底权威计算，从而让不同帧的声明脚底落在同一屏幕点。
- Main 以正式动作级 Alpha 联合范围为保守基线，再联合每个逐帧脚点产生的实际偏移；左右镜像都不得让真实帧越过贴边与运动裁决边界。
- Pixi 精灵启用像素坐标取整；Renderer 的剩余运动位移按 `1 / devicePixelRatio` 步长量化，避免 CSS 合成落在半个物理像素上。
- 不改变作者已声明的逐帧锚点，不引入运行时 Alpha 猜测。
- 当前角色先完整备份到 `D:\Backup`，再在角色工作室正式草稿/发布链中把移动表现的源帧换为 Run 素材；不得直接手改已编译运行目录。

## 5. 失败处理与数据安全

- 无活动角色时默认角色准备失败，不伪造“已切换成功”。
- 真实损坏的活动角色仍保留恢复横幅和工作室入口；只有健康强制重载成功才清除旧提示。
- 窗口边界读取失败沿用现有安全穿透与 owner 清理，不采用未知尺寸。
- 当前角色数据修改前复制精确角色目录和索引到带时间戳的 `D:\Backup` 子目录；发布失败时保留备份与旧运行版本，不删除源素材。

## 6. TDD 与验收

1. 启动：覆盖 `missing` 无警告初始化、`unavailable` 真降级、健康强制重载清除旧横幅。
2. 尺寸：模拟第一轮 `180 × 220`、第二轮 `270 × 330` 的 `getBounds()` 漂移，断言每次提交仍为 `180 × 220`；几何刷新后舞台锁不解除。
3. 闪烁：覆盖逐帧 ground 锚点随帧切换、动作级布局点恒定、`1.5 DPR` 下剩余位移对齐物理像素。
4. 数据：备份后通过正式发布链将当前 `move` 动作改为 Run；重新读取运行清单，确认移动帧引用新的编译资源。
5. 自动化：定向测试、桌面 typecheck、桌面测试、`verify:characters`、`verify:behavior`、`git diff --check`。真实窗口拖拽、提示尺寸和移动观感由用户最终人工验收。
