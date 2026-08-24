# 角色发布播放参数验收记录

## 验收范围

- 日期：2026-08-24
- 环境：Windows，`AgentCoreExtension` 分支，本地 pnpm workspace
- 规格：`docs/superpowers/specs/2026-08-24-character-published-playback-design.md`
- 计划：`docs/superpowers/plans/2026-08-24-character-published-playback.md`
- 范围：工作台动作倍速与素材水平反转的草稿保存、编译发布、旧运行时投影和实际 Pixi 播放消费。

## TDD 证据

### 正式契约与投影

- RED：V2 严格 Schema 报告 `playbackRate`、`mirrorX` 为未知字段；投影结果缺少两个字段。
- GREEN：V2 与旧 `ActionClip` Schema 接受合法值、拒绝越界或非法类型，投影保留显式值。
- 变异复核：移除旧 `ActionClip` 对应约束时，4 个非法值拒绝断言会失败；恢复后通过。

### 工作台持久化

- RED：当前皮肤表现未写入两个字段，编译发布输入缺少字段；动作或皮肤切换后预览未恢复正式表现参数。
- GREEN：当前皮肤、当前动作保存 `playbackRate` 与 `mirrorX`；回退表现首次编辑克隆精确覆盖；编译发布保留字段；只有速度和方向控件写入正式表现。

### 实际播放器

- RED：首次播放与方向切换始终收到固定 `speed: 1`，`mirrorX: true` 时仍收到原运动方向。
- GREEN：首次播放与方向切换共用发布参数裁决，覆盖四种异或方向组合和缺省倍速。
- 审查修复 RED：素材反转后 `getAnchor()` 仍按原运动方向计算，锚点与实际画面相反。
- 审查修复 GREEN：场景布局、像素命中与附着物锚点共用有效方向；两组参数化测试分别覆盖四种方向组合。

## 自动化结果

以下结果均来自本记录日期内、合并所有实现后的实际命令输出。

| 命令或门禁阶段 | 结果 |
| --- | --- |
| `pnpm.cmd --filter @myself/character-runtime test` | 15 个文件，288 项通过，0 失败 |
| `pnpm.cmd --filter @myself/character-assets test` | 6 个文件，99 项通过，0 失败 |
| `pnpm.cmd --filter @myself/desktop typecheck` | 通过 |
| `pnpm.cmd --filter @myself/desktop test` | 97 个文件，2230 项通过，0 失败 |
| `pnpm.cmd test:security` | 24 项通过，0 失败 |
| `pnpm.cmd test:integration` | 67 项通过，0 失败 |
| 桌面生产构建与 preload/MCP 边界校验 | 通过 |
| `pnpm.cmd test:e2e:desktop` | 72 项通过，1 项按配置跳过，0 失败 |
| `pnpm.cmd verify:characters` | 退出码 `0` |
| `git diff --check` | 通过；仅报告用户原有文档的行尾提示，无空白错误 |

## 独立审查

- 正式契约审查提出 1 项 P2 测试缺口，补充旧 `ActionClip` 非法值直接测试后复审清零。
- 工作台持久化审查：P0、P1、P2 均为 0。
- 播放器审查提出 1 项 P1 锚点方向问题，完成 TDD 修复后复审清零。

## 待用户人工确认

自动化不能替代真实 Windows 窗口内的主观视觉判断。用户总体验验收至少包含：

1. 在工作台为某个动作设置明显的非 `1` 倍速并“编译并发布”，实际桌宠播放节奏随之变化。
2. 切换素材方向并发布，实际桌宠静止、向左移动和向右移动时画面、锚点和命中区域保持一致。
3. 切换动作、皮肤和角色后返回，参数仍按对应“皮肤 × 动作”恢复。
4. 重启开发进程后，实际桌宠仍读取已发布参数。

状态：自动化通过；真实 Windows 视觉与最终总体验待用户人工确认。
