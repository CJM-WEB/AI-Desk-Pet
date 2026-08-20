# AI Pet 角色工作室验收清单

本文记录任务 13 的自动验证范围和必须由人工完成的性能观察。自动项只有在对应测试实际通过后才能勾选；人工项不得用单元测试结果替代。

## 自动验收

- [x] E2E 固定素材只从仓库内 8 张四帧透明 PNG 复制到临时 `userData`，不读取用户图片目录。
- [x] 安全角色包包含 `idle`、`carrying`、`carry` 锚点和扩展状态；恶意包包含路径穿越条目，等长替换次数严格为 2。
- [x] E2E 对话框队列仅在开发 E2E 模式启用，所有输入、输出路径均限制在临时目录，Renderer 和 preload 不暴露测试路径 API。
- [x] 正式 Renderer 控件可新建角色、导入精灵图、设置 2×2 网格、有效帧、帧率和 `ground` 锚点。
- [x] 正式 Renderer 控件可新增核心动作、搬运动作、`carry` 锚点和点击触发扩展状态。
- [x] 可显式保存草稿、编译并发布、确认不完整角色并启用。
- [x] 缺少 `thinking` 时降级到 `idle`，角色运行不阻断 Agent 请求。
- [x] 可导出角色包并在隔离数据目录导入；恶意角色包被拒绝后，ARIA 角色摘要、活动运行状态、索引原始字节和完整递归目录摘要均不变。
- [x] 启动顺序为加载索引、校验活动运行版本、失败安装并回退官方默认角色、Renderer 就绪后获取快照。
- [x] 恢复过程不删除损坏角色或草稿。
- [x] 切换角色会销毁旧纹理，启动只加载活动角色纹理。
- [x] 页面隐藏或开启减少动态效果时 ticker 停止。
- [x] 工作室关闭后不扫描素材目录：可观察 API 适配器断言关闭前后均不选择或读取素材。
- [x] 编译不阻塞 Agent IPC：独立 Renderer 等价子进程执行真实 `compileAtlas()` 并挂起图片解码时，Main 的真实 Provider、`AgentLoop` 和 `AgentService` 请求先完成；释放解码后编译正常结束。

自动验证命令：

```powershell
pnpm verify:characters
```

## 人工功能验收

- [ ] 将一个文件图标放在桌宠透明像素后方，分别在透明位置执行左键、双击和右键；确认三种输入均由底层文件接收，桌宠不抢占事件。
- [ ] 分别在当前帧可见像素与透明像素按下左键；确认仅可见像素开始拖拽，光标离开可见像素后仍持续拖拽，释放后立即结束。
- [ ] 在可见像素单击和双击左键；确认只发生拖拽，不打开聊天，也不触发扩展状态。
- [ ] 在可见像素右键；确认打开既有角色菜单，菜单中仍有“打开聊天”入口，并可正常打开聊天窗口。
- [ ] 导入精灵图并应用网格后，在不保存草稿、不编译且不发布的情况下确认真实 Pixi 预览立即出现；切换方向并调整速度，确认预览同步使用已应用快照。
- [ ] 触发自动保存成功，确认右上角只显示绿色“草稿已保存”状态且没有成功提示；模拟保存失败，确认状态变为“保存失败”并出现错误提示。
- [ ] 分别触发 success/info 与 warning/error 提示，确认前两者 3 秒、后两者 6 秒自动关闭；悬停或聚焦时倒计时暂停，移开或失焦后继续，并可手动关闭。
- [ ] 调整工作室窗口缩放比例，确认预览画布、逐帧锚点和模拟文件始终与角色图像对齐。
- [ ] 导入一张精灵图和多张独立单帧图片，检查预览、顺序和有效帧。
- [ ] 新建角色后完成待机动作并立即启用。
- [ ] 动作不完整时核对确认文案，确认后缺失核心状态降级到待机动作。
- [ ] 核对核心状态优先级、扩展状态点击触发和恢复到待机状态。
- [ ] 编辑 `ground`、逐帧 `carry` 锚点，并在真实文件搬运中检查挂载位置。
- [ ] 退出并重启应用，检查活动运行版本和未发布草稿均恢复。
- [ ] 导出后在全新本地数据目录导入，确认同名角色不覆盖；导入恶意包时确认现有角色不变。
- [ ] 开启系统“减少动态效果”，确认角色停在静态帧且桌面交互仍可用。

## 人工性能测量

- [ ] **待人工：空闲与播放 CPU。** 发布并启用四帧角色，关闭工作室和聊天窗口，等待 2 分钟；在任务管理器“详细信息”中先连续观察 Electron 空闲进程 5 分钟，再让角色持续播放并观察 5 分钟，分别记录平均值、峰值、系统型号和电源模式。
- [ ] **待人工：内存稳定性。** 记录启动稳定 2 分钟后的工作集；连续切换两个角色 30 次，再静置 5 分钟，记录工作集差值和是否持续增长。
- [ ] **待人工：资源释放。** 打开 Chromium DevTools 的 Performance/Memory，分别在切换动作、切换角色和关闭工作室前后采集快照；确认旧 Pixi 纹理、ticker 回调、Blob URL 和 Canvas 不再被活动对象持有。
- [ ] **待人工：编译响应性。** 编译最大允许尺寸素材时同时提交 Agent 请求，记录聊天首个状态响应时间、编译时长和界面是否出现超过 100ms 的长任务。

## 当前记录

- 2026-07-29：`pnpm verify:characters` 总验收通过；根 TypeScript 检查、Desktop 生产构建和沙箱 preload 外部依赖校验通过。
- 角色运行时 4 个文件、76 项通过；角色素材 3 个文件、82 项通过；Desktop 51 个文件、733 项通过；integration 3 个文件、14 项通过；security 1 个文件、9 项通过。
- 损坏索引恢复覆盖候选目录消失、真实 junction/symlink、不跟随链接、恢复记录写失败降级和官方默认角色启动；单实例和 Renderer 错误恢复均有定向测试。
- 编译并发集成测试已通过，覆盖真实编译路径、独立进程边界和 Main Agent 请求时序。
- 修复沙箱 preload 依赖链后，角色工作室精确 Electron E2E 通过；覆盖创建、编译、启用、状态降级、扩展触发、导出、隔离导入、恶意包不变断言和重启恢复。
- 首次发布事务显式记录上一运行版本状态；角色包在创建角色前持久化回滚事务，并在索引提交前写入角色所有权令牌，启动时可精准回滚半安装角色。
- 工作室用户关闭与应用退出共用 Main/Renderer 有界草稿刷新握手，只有 sender 和一次性 token 同时匹配才接受确认。
- Windows 进程探针把退出期间 `.Path` 短暂不可读视为可重试过渡态，路径未验证时不执行破坏性清理；完整 Desktop E2E 35 项全部通过，其中角色工作室闭环耗时 58.8 秒。
- `git diff --check` 通过，仅输出工作树行尾转换提示。
- CPU、内存和纹理释放没有进行人工测量，结果保持“待人工”。
- 2026-07-31：角色工作室真实闭环 E2E 使用新行级加减号完成空动作直接删除、4 帧动作删除取消和完整进程重启恢复；重启后无需重新导入或编译即可恢复 `idle.png`、`carrying.png`、`acting.png`、帧率 9、首帧选择和 Pixi 预览，切换到无动作状态后预览为空。单用例 1 项通过，耗时 57.5 秒。
- 本轮 Desktop 类型检查通过；角色工作室精确单测 6 个文件、154 项通过，Desktop 完整单测 59 个文件、897 项通过，security 1 个文件、9 项通过，integration 3 个文件、14 项通过。

## 2026-08-20 减法 Task 6 最终门禁（B1）

B1 已删除 `CharacterTransactionRecoveryKind`、`kind`、`deferred`、`budgetExceeded` 和可由两个分面错误码推导的辅助状态；正式恢复结果只保留角色 ID、草稿错误码和发布错误码。协调器与 Store 的重复矩阵已收敛，保留真实 marker、能力门、预算、Junction 与原子报告证据。

`pnpm.cmd verify:characters` 退出 0：character-runtime 13 个文件 221 项、character-assets 4 个文件 92 项、Desktop 85 个文件 1741 项（14 跳过）、security 20/20、integration 46/46 与 Electron E2E 60/60 全部通过，约 3.1 分钟。`pnpm.cmd verify:behavior` 也退出 0，含 Electron E2E 60/60。`pnpm.cmd verify:desktop` 的单次结果为 1，历史失败为“默认聊天与设置浮层提示”E2E 的页面/上下文关闭；其一次定向复现 1/1 通过。主裁决采用上述等价证据放行；只读诊断显示减法未触及窗口 owner、Electron fixture 或该失败场景主体，细根因尚未证实。B1 自动化完成，B2/B3 可在按本减法规格重写计划并再次审查删除门后进入。

旧 owner 扫描无输出（`rg` 退出码 1，表示零命中）；受保护网站、CloudBase、scanner 和网站 E2E/配置路径在 `875048c..HEAD` 零差异，`git diff --check 875048c..HEAD` 退出 0 且无输出。相对 `875048c`，生产代码 +42/-74（净 -32），测试与 E2E 合计 +230/-669（净 -439）；相对 `c7d951d` 测试与 E2E 的净减同为 -439。既有真实 Windows、性能与资源释放人工项仍待用户确认。

## 2026-08-20 角色包导入恢复验收（B2）

环境为 Windows 11 专业版 10.0.26200。唯一新增 Electron 场景“角色包恢复一坏一好时继续启动桌宠与普通聊天”使用正式 `CharacterStore` 准备健康活动角色、带所有权令牌的半安装角色、合法 v3 marker 和可归属半截 marker；它验证合法半安装目录被回滚、坏 marker 原字节被排他保留、桌宠播放器进入 `ready`，并可继续普通聊天。Task 3 已先完成，因此该场景首次运行即为先验已绿，没有伪造 RED。

实际命令与结果如下：

- `pnpm.cmd --filter @myself/desktop build`：退出 0，约 7.5 秒。
- `pnpm.cmd exec playwright test --config tests/playwright.config.ts -g "角色包恢复一坏一好时继续启动桌宠与普通聊天"`：退出 0，1/1 通过，9.1 秒。
- `pnpm.cmd --filter @myself/desktop test -- atomic-file-coordinator.test.ts character-store.test.ts character-package-service.test.ts`：退出 0；当前 Vitest 配置实际执行 Desktop 全组，86 个文件、1775 项通过、14 项跳过，43.5 秒。
- `pnpm.cmd --filter @myself/desktop typecheck`：退出 0，约 8.4 秒。
- `pnpm.cmd test:security`：退出 0，20/20 通过，1.36 秒。
- `pnpm.cmd test:integration`：退出 0，46/46 通过，4.77 秒。
- `pnpm.cmd verify:characters`：退出 0；character-runtime 221/221、character-assets 92/92、Desktop 1775 项通过（14 项跳过）、security 20/20、integration 46/46、Electron E2E 61/61，约 4.6 分钟。
- `pnpm.cmd verify:desktop`：退出 0；全仓类型检查通过，单测 2220 项通过（14 项跳过）、security 20/20、integration 46/46、Electron E2E 61/61，约 4.5 分钟。

删除门确认 `CharacterImportJournal`、v4 正式 marker、旧 `CharacterOwnership`/摘要 helper、`preserveRollback()` 和 PackageService 的普通 `store.delete()` 均为零命中，Journal 文件不存在。`character-store.ts` 仍保留 owner 文件、活动角色保护以及移动前后身份复核。以 B2 计划提交 `6bae15f` 为基线，生产代码 +468/-271（净 +197），测试与 E2E +981/-57（净 +924）；本次 Task 4 自身只增加一个纵向 E2E，+87/-1。受保护的网站、CloudBase、scanner 与网站 E2E 路径零差异，`git diff --check` 退出 0。

终审进一步收紧了两项边界：`.complete-*` 只是不再执行的原字节证据；清理失败只有在正式 marker 排他恢复成功时才能由正式名支持下次重试，清理与恢复正式名双故障只允许固定诊断，不生成角色 issue。候选稳定排序后只取活动项加最多其余 255 项；第 257 项及以后保持不变且不逐项 issue/log，只记录一次聚合诊断；deferred 仅用于已入 256 项但因 2000ms 预算尚未开始的 marker。上述既有命令不作为这两项收紧边界的通过证据，须由后续定向测试与门禁重新验证。

真实断电、强制终止、非恶意外部程序在恢复期间替换 marker，以及 B3 窗口提示可读性没有本次人工证据，状态均为“待用户人工确认”。同一 Windows 用户下主动绕过检查的恶意进程不在本阶段威胁模型内，不列为待验收承诺。

### Task 3 边界收紧后的复验

以 `124bb49` 为新实现基线复验，不覆盖上面的首次验收记录。该修复相对规格收紧提交 `ecdc3f5`，生产代码 +47/-49（净 -2），测试 +64/-65（净 -1）；删除了 detached 证据的执行入口，并把恢复 inventory 在排序后截断为 256 项。

- `pnpm.cmd --filter @myself/desktop build`：退出 0，约 7.5 秒。
- `pnpm.cmd exec playwright test --config tests/playwright.config.ts -g "角色包恢复一坏一好时继续启动桌宠与普通聊天"`：退出 0，1/1 通过，8.2 秒。
- `pnpm.cmd verify:characters`：退出 0；character-runtime 221/221、character-assets 92/92、Desktop 1775 项通过（14 项跳过）、security 20/20、integration 46/46、Electron E2E 61/61，约 4.5 分钟。
- `pnpm.cmd verify:desktop`：退出 1；全仓类型检查通过，单测阶段 2218 项通过、14 项跳过，两个未修改的旧场景分别在 5 秒超时，因此后续 security、integration 与 Electron 阶段未由该命令执行。失败场景为 `saveCompiled 首次写拒绝既有 ID，覆盖要求 expectedPreviousSha256 匹配` 和 `事务恢复协调：活动与非活动角色的坏分面彼此隔离且原 marker 字节保持不变`。
- 按“一次定向复现”约束执行 `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/character-asset-service.test.ts tests/character-store.test.ts -t "saveCompiled 首次写拒绝既有 ID|事务恢复协调：活动与非活动角色"`：退出 0，2/2 通过，3.31 秒；没有重跑完整门。`verify:desktop` 的失败仍按事实保留，不写成通过；同一新 HEAD 的 security 20/20、integration 46/46 与 Electron 61/61 证据来自此前已完整通过的 `verify:characters`。

复验删除门再次确认旧 Journal、v4 正式 marker、旧所有权摘要 helper、`preserveRollback()`、PackageService 普通 `store.delete()` 与 detached marker 执行匹配均为零命中，Journal 文件不存在；`.complete-*` 只保留在当前 marker 移动清理的内部临时文件名。生产代码明确先稳定排序，再用 `slice(0, MAX_IMPORT_RECOVERY_ENTRIES)` 截断 256 项。以最新 B2 计划提交 `ecdc3f5` 为保护基线，网站、CloudBase、scanner 与网站 E2E 路径零差异，`git diff --check` 退出 0。

### 最终代码基线复验

最终 B2 代码基线为 `c2455b2`。它相对上一验收提交 `aa2fb57` 的生产代码 +26/-27（净 -1）、测试 +25/-27（净 -2），把 2000ms 预算起点移到 inventory 排序与 256 项截断之后，并使已开始处理的坏候选同样受单项完成边界保护。其相邻 151 项测试与 Desktop typecheck 的通过属于修复提交前置证据；依据终审裁决，本轮不重复完整门禁。

本轮实际执行 `pnpm.cmd --filter @myself/desktop build`，退出 0，约 7.8 秒；随后执行唯一纵向场景 `pnpm.cmd exec playwright test --config tests/playwright.config.ts -g "角色包恢复一坏一好时继续启动桌宠与普通聊天"`，退出 0，1/1 通过，7.9 秒。旧 Journal、v4 正式 marker、旧所有权摘要 helper、`preserveRollback()`、PackageService 普通 `store.delete()` 与 detached marker 执行匹配继续零命中，Journal 文件不存在；代码仍先截断 256 项，再记录 `startedAt`。以 `ecdc3f5` 为保护基线，网站、CloudBase、scanner 与网站 E2E 路径零差异，`git diff --check` 退出 0。此前完整门及 `verify:desktop` 的历史结果保持原文，不由本轮小范围复验改写。

## 2026-08-21 角色恢复降级纵向验收（B3）

环境为 Windows 11 专业版 10.0.26200。原“角色包启动恢复”场景已原位替换为两个真实 Electron 重启场景，没有新增 fixture fault seam，也没有修改生产代码：

- 非活动角色场景通过正式工作室导入健康角色；退出后同时准备坏草稿 marker、坏包 marker 和可安全回滚的包 marker。重启后桌宠播放器保持 `ready`、不显示 fallback，工作室只在选中目标角色时显示草稿与导入恢复提示，普通聊天可继续提交；公开快照不含用户目录、marker sentinel、hash、token、owner 或事务标识。
- 活动角色场景通过正式工作室导入并启用角色；退出后写入坏发布 marker。重启后活动角色切换为 `builtin-default`，桌宠显示降级提示和工作室入口，原 marker 字节保留，默认角色与问题角色仍在工作室列出，普通聊天可继续提交。

实际命令与结果：

- `rg -n -i "recovery|恢复|marker|restart\\(" tests/e2e/desktop.spec.ts`：完成既有恢复、marker 与重启场景盘点；B3 最终只保留下述两个“角色恢复”重启场景。
- `pnpm.cmd --filter @myself/desktop build`：退出 0，生产构建和沙箱 preload 外部依赖校验通过，约 14 秒。
- `pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/character-startup.test.ts tests/character-ipc.test.ts tests/preload-api.test.ts tests/official-default-character.test.ts tests/character-recovery.test.ts tests/pet-view.test.tsx tests/character-workshop-components.test.tsx tests/character-workshop-close-renderer.test.tsx`：退出 0，8 个文件、141 项通过。
- `pnpm.cmd --filter @myself/desktop typecheck`：退出 0。
- `pnpm.cmd exec playwright test --config tests/playwright.config.ts --grep "角色恢复"`：最终退出 0，2/2 通过，约 37 秒。
- `pnpm.cmd --filter @myself/desktop test -- character-startup.test.ts character-ipc.test.ts preload-api.test.ts official-default-character.test.ts character-recovery.test.ts pet-view.test.tsx character-workshop-components.test.tsx character-workshop-close-renderer.test.tsx`：该 package script 实际执行 Desktop 全组，退出 1；1801 项通过、14 项跳过，恢复矩阵用例达到固定 5 秒超时；随后一次定向复现退出 0，1/1 约 1.37 秒。
- `pnpm.cmd test:security`：退出 0，20/20 通过。
- `pnpm.cmd test:integration`：退出 0，46/46 通过。
- `pnpm.cmd verify:characters`：退出 1；Desktop 阶段 1800 项通过、14 项跳过，两个既有 5 秒用例在并行负载下超时，因此后续 security、integration 与 Electron 阶段未由该命令执行。两个超时用例分别单独定向复现时均退出 0，其中恢复矩阵 1/1 约 1.37 秒、包导入串行场景 1/1 约 1.34 秒。
- `pnpm.cmd verify:desktop`：退出 1；工作区类型检查通过，单元阶段 2238 项通过、14 项跳过，9 个既有文件系统重测试在并行负载下达到固定 5 秒超时，因此后续阶段未由该命令执行。本记录不把该门禁写成通过，也不为本次 E2E 范围修改生产代码或放宽安全断言。

旧 `startupRecoveryErrorCode`、动态 recovery callback、`loadCharacterStartupRecovery`、Actions recovery getter、`fallbackActive` 及跨 IPC 派生字段扫描均为零命中。以 B3 计划基线 `d58f2e8` 检查，网站、CloudBase、scanner 和网站 E2E 路径零差异，`git diff --check` 退出 0，仅有工作树 CRLF 转换提示。

Task 3 的 E2E 变更为 +139/-54（净 +85），已从初稿净 +110 继续删减重复导航与快照矩阵；最终恢复重启场景严格为两个。相对减法基线 `c7d951d`，Desktop 测试与 E2E 当前合计 +1837/-860（净 +977），尚未达到“测试与 E2E 净减”总门，不能宣称减法阶段完成；该缺口主要位于此前 B2/B3 单元测试提交，超出本 Task 3 仅允许 E2E 与验收记录的修改范围，须在提交前由主任务继续审计合并。

真实 Windows 窗口层级、焦点、布局、文案可读性及重启视觉没有本次人工观察，均保持“待用户人工确认”。

## 2026-08-21 Task 6 新鲜全门禁与减法账本（`035fd96`）

此前 `c715f13` 的全绿门禁仅作历史记录。本节从 Task 5 fix round 2 后的 `035fd96` 重新执行全部七条顶层命令，且每条仅一次、均未达到 15 分钟：定向聚合 8 文件/182 通过（39.11 秒）、Desktop typecheck 退出 0（10.39 秒）、Desktop test 86 文件/1808 通过/14 跳过（54.18 秒）、security 20/20（2.70 秒）、integration 46/46（6.13 秒）、`verify:characters` 退出 0（runtime 221、assets 92、Desktop 1808/14、security 20/20、integration 46/46、Electron E2E 62/62，335.74 秒）。

`verify:desktop` 在 unit 阶段退出 1（73.15 秒）：workspace typecheck 通过，108 文件通过、1 文件失败，2252 通过、1 失败、14 跳过；后续 security、integration 与 Electron 阶段未执行。失败为 `draft-character-preview.test.tsx` 中“场景播放帧回写父级，纯索引同步不重建且后续控制从实际帧继续”，`showAction` 期望 2 次、实际 3 次。按失败后只定向一次的约束，该用例单独复现退出 0、1/1 通过（3.50 秒）。本记录不将完整 `verify:desktop` 写为通过，也不以定向通过掩盖原失败。

相对 `c7d951d` 的精确 numstat 为 Desktop tests `+1661/-822`（净 `+839`）、E2E `+297/-313`（净 `-16`），合计 `+1958/-1135`（净 `+823`）。**行数门未满足，不得宣称全局减法完成。**本次没有新鲜 owner 审计可证明“安全减法已耗尽”，因此不作该项结论；后续收敛不得删除唯一安全证据。

旧生产符号扫描为零命中；`fallbackActive` 只在 `character-ipc.test.ts:48` 的严格 Schema 负例出现一次。Workshop StrictMode 只读一次恢复快照且不写入、恢复快照 RPC 失败的通用文案/路径与 token 脱敏、Pet RPC 失败不伪造完成 fallback 均由本次定向聚合覆盖。网站、CloudBase、scanner、网站 E2E 与配置保护路径在提交、工作树及暂存区均为零差异；`git diff --check c7d951d..HEAD`、`git diff --check` 与 `git diff --cached --check` 均退出 0。Task 5 fix round 2 的独立复审已通过，先前关于重复 Renderer 页面发现 helper 的 Important 已清零。

### Tasks 1–5 正式证据简表

| Task | 提交区间与精确净值 | mutation RED | 最终 GREEN | 独立复审 |
| --- | --- | --- | --- | --- |
| 1 | `67ee510..4c78325`：`+55/-95`，净 `-40` | 将 `publicFallbackCode()` 的 `CHARACTER_RESOURCE_INTEGRITY_FAILED` 退化为 `CHARACTER_OPERATION_FAILED`；启动测试 18 项中 2 项按预期失败 | `character-startup` + `character-recovery`：2 文件/33 通过；Desktop typecheck 通过 | C0/I0 |
| 2 | `4c78325..8283932`：`+83/-86`，净 `-3` | Preload 直接返回 IPC payload，使两类非法结果被错误接受；Pet 在空运行错误时清空启动 fallback，使“启动 fallback 先到”断言失败 | `character-ipc` + `preload-api` + `pet-view`：3 文件/69 通过；Desktop typecheck 通过 | C0/I0 |
| 3 | `8283932..5d2b34d`：`+19/-38`，净 `-19` | 在 exclusive link 失败后 `catch` 并 `rename` 临时文件；final 被覆盖或意外出现，失败阶段断言按预期失败 | `atomic-file-coordinator`：1 文件/5 通过；Desktop typecheck 通过 | 主任务双审查 C0/I0/M0 |
| 4 | `5d2b34d..2db5ed1`：`+160/-177`，净 `-17` | 将恢复循环的 owner token 改为错误 UUID；真实重启用例失败且半安装 `demo` 目录保留 | `character-package-service`：1 文件/71 通过；Desktop typecheck 通过 | C0/I0/M1（行计数差异；Git numstat `-17` 为准） |
| 5 | `2db5ed1..035fd96`：`+103/-181`，净 `-78` | 无 mutation RED：仅收敛 E2E 页面发现 helper，报告未修改生产行为，不能伪造破坏点；先验绿为现有完整 E2E 62/62 | build 通过；定向 2/2 通过；完整 Desktop E2E 62/62 | fix round 2 后复审 C0/I0/M0 |

表中任务证据来自各 Task 忽略报告、ledger 与对应提交；Task 4 使用 Git numstat，而不是文件行计数。该表补充证据归属，不改变上方 `+823` 总账或完整 `verify:desktop` 失败事实。

真实 Windows 窗口层级、焦点、布局、文案可读性、重启视觉与拖拽体验仍待用户人工确认。
