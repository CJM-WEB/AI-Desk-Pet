# AI 桌宠拖拽、运动恢复、文件移动与 Zen 退役自动验收记录

## 1. 范围与结论

- 日期：2026-08-25（Asia/Shanghai）。
- 规格：`docs/superpowers/specs/2026-08-25-ai-pet-drag-resume-file-move-zen-removal-design.md`。
- 范围：Zen 退役、低延迟固定视觉拖拽、停止后显式运动恢复、真实普通文件移动。
- 当前状态：实现、两轮独立复审与自动门禁完成；真实 Windows 主观拖拽手感待用户人工确认。
- MCP runtime、Agent 与 Renderer 继续禁用；本轮没有制作安装包。

## 2. 实现结果

- Zen：生产链只保留 SettingsStore 的定向退役迁移；旧 Zen 档案及其路由引用被移除，DeepSeek 和其他设置保留。
- 拖拽：像素命中后 pointerdown 同轮启动 Main 拖拽，Main 同轮首笔同步；正式播放器和 CSS 备用角色在拖拽期间冻结当前播放，释放后恢复且不重启动作；“拖动我”已删除。
- 行为：显式“动、运动、跑”及持续运动在停止锁存在时先持久化 `movementStopped=false`，成功后才运动；保存失败保持停止。回收站语义优先于普通移动语义。
- 文件：新增 `builtin.files.move_file`。确认前无文件副作用；确认后 Main 使用真实 `rename`，并复核源消失与目标实体身份。覆盖、身份变化、跨卷、权限失败和结果不确定均不发布成功。
- 协议：能力任务只能调用本轮公告工具；写任务只有同名 Main `ok:true` 结果才能进入模型总结，只读结果不能伪造移动成功。

## 3. TDD 与复审证据

- 拖拽定向：最终 4 个文件 123 项通过；正式 `behavior-action` 与 `behavior-authority` 两条播放器路径均覆盖 static/animated 切换且 `play` 不重启。
- 行为定向：Gate、Director 与 Scheduler 151 项通过；真实 Electron 用例证明停止跨重启，随后“向左一点”解除停止并产生向左位移。
- 文件定向：file-tools 67 项、AgentLoop 73 项、Desktop 移动相关 261 项通过；真实临时文件系统和 Electron E2E 均验证确认前无副作用、确认后源消失且目标内容一致。
- Zen 定向：8 个文件 289 项通过；迁移守卫同时从仓库根和 Desktop workspace 运行通过。
- 独立复审先后发现正式播放器基础动作未冻结、移动后缺少实体复核；修复后复核结论为 Critical 0、Important 0、Ready。

## 4. 最终门禁

- `pnpm.cmd verify:desktop` 退出 0：全仓类型检查通过；单元 2823/2823、安全 23/23、集成 70/70；正式构建、preload 与 MCP 生产边界校验通过；Electron E2E 71 通过、1 条既有长时场景按配置跳过、0 失败。
- `pnpm.cmd verify:behavior` 退出 0：character-runtime 303/303、agent-core 73/73、Desktop typecheck 与 Desktop 测试、安全 23/23、集成 70/70；正式构建通过；Electron E2E 71 通过、1 跳过、0 失败。
- `git diff --check` 在最终代码上退出 0（仅 Git 的 LF/CRLF 提示）；Zen 扫描只剩定向迁移常量与旧格式迁移夹具，拖拽阈值、“拖动我”和无消费者凭据字段均无生产残留。

## 5. 人工验收边界

- 自动化证明 pointerdown 启动、正式播放器冻结、窗口宽高不变、真实文件副作用和行为状态变化。
- 鼠标拖拽的主观跟手程度、不同用户素材的肉眼轮廓稳定性仍需用户在真实桌面窗口人工确认。
- 文件移动只支持同一授权根内普通文件到已存在目录；不支持目录移动、覆盖、跨根或跨卷 fallback。
