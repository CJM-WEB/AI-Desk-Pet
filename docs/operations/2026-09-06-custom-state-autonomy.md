# 自定义状态与持续心情开发记录

日期：2026-09-06。依据[角色规格](../superpowers/specs/2026-09-05-ai-pet-custom-state-autonomy-design.md)与[实施计划](../superpowers/plans/2026-09-06-ai-pet-custom-state-autonomy.md)。状态：本轮角色功能、基本自动化验证及获批旧文件清理已完成，持续体验待用户人工确认。

当前进度：Task 1–6 已实现；实际单帧播放问题已修复，构建和唯一工作台闭环通过，限定复审 Approved。真实 DeepSeek／Qwen 代表场景均通过；14 个旧文件已按二次批准逐个移入回收站。最后重启观察发现运行期重复播放反馈拒绝，正在单独定位，不能先断言无影响；持续体验仍待用户反馈。下表按证据产生时点保留中间失败及其后续修复，不以中间状态覆盖当前结论。

用户已确认文件能力实际验收并授权本阶段；工作台锚点与区域保留现有入口，本轮不扩展。保留三态运动，重点接通人设系统提示词、描述决策、自定义状态及随时间变化的心情。MCP 继续禁用，官网链不进入本轮，暂不打包、不 push。

## 已有证据

| 范围 | 结果 | 限制 |
| --- | --- | --- |
| Task 1 V3 作者 Schema、输入转换、ID 播放视图 | 自动化通过，提交 `d26a8a23` | 纯角色运行时数据模块，未切正式 Main／Renderer |
| V3/旧 V2/V1 定向兼容 | 5 文件64项通过，角色 package typecheck 通过 | 修复前该次命令的实际结果，不代表全仓验证 |
| V1 单击／双击／右键规则迁移修复 | 新3项先失败；修复后迁移文件9项通过，typecheck通过；提交 `9bff5dd2` | 原事件合并差异转为显式迁移问题，不静默视为等价 |
| Task 1 独立审查 | 规格与质量通过 | 只审本步，后续存储／界面仍须落实问题门禁 |
| Task 2 心情衰减、单状态计划及动作调度 | 自动化通过，提交 `881e9328`；包内 365 项、最终引擎与通用调度定向 29 项、typecheck 通过 | 尚未接入桌面播放 |
| 状态保持与退出事件修复 | 两例 RED 复现；修复后引擎 11 项与 typecheck 通过；提交 `0a6ac229`，限定独立复审通过 | 未重跑包全量；桌面接线属于 Task 3 |
| Task 3 Main V3 存储、迁移门禁与表达服务 | 提交 `0568b033`；存储与接线 90 项、导入导出定向 5 项、运行时定向 91 项通过 | 整体 Task 3 未完成；Renderer 与旧 fixture 尚在适配，桌面 typecheck 未通过 |
| 明确动作自主结束 | 无限循环素材的失败用例经修复通过；Main 按真实帧周期发出 `once`，开始反馈后计时，结束后恢复有效计划或 idle | Renderer 实际执行与真实模型描述决策仍在接线 |
| Main 子步骤固定差异审查 | 发现 3 项必要修复：旧清单只读恢复的素材读取、迁移原素材持久保留、运动请求生命周期登记 | 已核对接受，待顺序修复；不能记为整步审查通过 |
| Task 3 Renderer 工作台与正式播放 | V3 单状态编辑、逐项迁移处置和按 ID 播放已接通；桌面与运行时 typecheck、桌面开发构建通过 | 定向 309 通过、1 个已确认 Main 0 档自主移动缺口失败；整 Task 3 未完成 |
| 有界播放与资源复用 | Pixi／预览／V3 接线定向 83 项、作者方向 4 项通过；原保存／并发／素材定向 96 项通过 | 预览帧同步在与构建并发时曾有一次时序失败，无代码变化独立复跑通过，不称确定修复 |
| Main 三类限定修复 | 5 项失败用例修复后通过；存储与 Director 共 205 项、桌面 typecheck 通过；提交 `cdd752a`，限定复审通过 | 原素材独立保存，坏事务保持只读；运动登记与 0 档自主锁均关闭 |
| Renderer 固定差异审查 | 发现中断未终止 Pixi 内部播放，方向／可见性变化可能恢复旧动作 | 已接管最小修复；不把画面暂停当作播放生命周期终止 |
| Renderer 中断终态修复 | 真实 React＋Pixi 接缝先复现旧动作恢复，再修复；播放器 80 项与桌面 typecheck 通过；提交 `9ff40eb0`，限定复审通过 | 明确终止当前播放并清理计时器，普通暂停恢复保留；原问题关闭 |
| Task 4 人设与分区模型决策 | 提交 `4292bc58`；运行时定向21项、桌面定向473项及最后重叠的118项通过；运行时、agent-core、桌面类型检查通过 | 人设完整投影、动态候选、请求总预算及首个有效分区保留，不把自动化当作实际模型效果 |
| 明确状态入口及动作名称回归 | 提交 `8e5112eb`、`78f58462`；明确状态按作者时长或默认3秒结束，含“状态”的动作名称保留；最终 Gate 104项通过 | 独立限定复审 Approved，没有重跑之前的完整矩阵 |
| Qwen 多 system 请求布局 | 首轮及三次定位请求均遇到模板500；`78f58462` 将系统段合并到首条，定向48项通过，真实复跑不再出现模板错误 | 本地仍保留全部人设和协议；该次真实回复缺控制／心情／计划字段，不能记为Qwen角色决策通过 |
| 真实 DeepSeek 代表场景 | 用户已配置的 `deepseek-v4-flash`，一次HTTP请求通过：喜讯产生心情与喜悦计划，同轮明确动作令牌保留，虚拟时间推进后回idle | 临时隔离Electron，无真实窗口；不是视觉观感验收，也不证明所有模型或任意语言输入 |
| Task 5 自主心情、时间与真实交互接线 | 提交 `10543a7d`；代表性协议／调度／开关5项 RED 后，原组27项通过；三包 typecheck 通过，固定差异审查 Approved | 首次未互动5分钟、后续至少15分钟、小时最多4次；只输出心情与计划；未运行真实自主模型或 Windows 休眠观察 |
| Task 5 既有三态及设置回归 | Director 99、Scheduler 21、Runtime 1、IPC 9、Provider 193项通过；旧设置 fixture 4处期望修正后相关74项通过；agent-core 契约12项通过 | 复用原运动调度，开关关闭不清心情；这些结果不能替代实际动画连续性与原生窗口体验 |
| Qwen 决策字段与当次请求约束 | 提交 `0023eb90`；26个直接定向用例、runtime／agent-core／desktop typecheck 通过 | 心情和计划必填可 null；Main 已处理的指令限制运动建议，并取消重复显式播放建议；限定审查另发现修复轮的 null 计划冻结缺口，已接管 |
| 正式代码真实 Qwen 代表场景 | `0023eb90` 重新生成诊断 bundle，真实内置模型、Vulkan 33/33；1次HTTP／Provider调用通过，心情强度0.95，选择 `cheer` 及其 `spin/wave` 动作，Main明确令牌保留；动作后仍可喜悦，虚拟2小时后回 `rest`（idle） | 使用真实 Main prepare／complete 入口，实际运动调用0、工具为空、运行时清理和Electron退出通过；临时隔离实例，无真实窗口、未观察连续分钟动画 |
| 修复轮冻结首次 null 计划 | `2e5bd423`；1项 RED 复现，直接决策文件11项、desktop typecheck 通过，限定复核 Approved | 仅改修复轮合并及直接测试；请求 Schema／提示不变，不重复真实模型场景 |
| Task 6 V3 夹具与整合 | `73738074`、`17c59ff3`；17个直接场景通过；合并安全／集成70项中65通过，另5个旧测试接缝失败修复后定向通过；固定差异复审 Approved | 安全16项全通过；修复仅涉及测试，未重跑整个矩阵；素材导入出现一次原恢复扫描诊断，未宣称完全无警告 |
| 开发构建 | `2e5bd423` 的 Main／Preload／Renderer 及产物边界检查通过 | 未打安装包；后续播放器修复会使该构建需要更新 |
| 唯一角色工作台 E2E | 两次分别34秒、32.3秒失败；第二次附带安全诊断，证实按真实ID依次收到原动作 loop、明确动作 once、恢复原动作 loop，发布单帧为1200毫秒 | Gate／Engine内存诊断正常；实际 BrowserPixiScene 对单帧 once 在微任务中立刻完成，跳过作者时长。已接管产品修复，尚不能称实际播放通过 |
| 单帧一次播放修复 | `6d9e8847`；真实 Pixi 8.19.0 先 RED 微任务提前完成，修复后1199毫秒未完成、1201毫秒唯一完成，中断无晚回调；播放器81项与desktop typecheck通过，限定复审 Approved | 仅复用原 AnimatedSprite／Ticker，删除立即完成分支，未新增计时器；单元环境有 jsdom Canvas 未实现诊断，真实画面由下行 E2E 补充 |
| 最终构建与工作台闭环 | `6d9e8847` 开发构建及产物边界检查通过；唯一 E2E **1 passed，用例49.0秒** | 实际表单创建有描述状态及两个动作，发布启用、模型请求人设／描述／零工具、明确一次播放后无新消息返回、重启、导出回导及恶意包保护均通过；不是全套 E2E 或长期人工体验 |
| 获批旧文件清理 | `2e695803`；清单 14 个普通文件、187,873 字节逐个移入 Windows 回收站；旧导出与残余引用已清理；运行时定向42项、桌面存储和播放器120项，以及运行时和4个直接消费者类型检查通过 | 保留 V1/V2 输入与迁移、角色包、素材和锚点；按用户二次批准执行，详见[精确清单与结果](2026-09-06-character-legacy-retirement.md)；未重复模型或 E2E 矩阵 |
| 开发版重启观察 | 清理后 Main／Preload 开发构建完成并启动 Electron；退出前观察到反复 `CHARACTER_PLAYBACK_UNAUTHORIZED` | 删除前实例亦出现；Renderer 没有重试循环，但正常旧令牌回报与真实播放更替的影响仍待定位，未按正常关闭噪声处理 |

实际命令：

```powershell
pnpm.cmd --filter @myself/character-runtime test tests/character-v3-schema.test.ts tests/character-v3-migration.test.ts tests/character-playback-view.test.ts tests/character-v2-schema.test.ts tests/character-v1-converter.test.ts
pnpm.cmd --filter @myself/character-runtime test tests/character-v3-migration.test.ts
pnpm.cmd --filter @myself/character-runtime typecheck
git diff --check
```

最后整合采用以下命令，未运行安装包命令或重复完整验证矩阵：

```powershell
pnpm.cmd exec vitest run --config tests/vitest.config.ts tests/security tests/integration
pnpm.cmd exec vitest run --config tests/vitest.config.ts tests/integration/desktop-agent.test.ts -t '正式任务读取随机正文|无授权根可连续普通聊天|跨 Provider 仅发送当前消息|跨 Provider 单次共享|Renderer 真实图集编译'
pnpm.cmd --filter @myself/desktop test pixi-character-player.test.ts character-player.test.tsx
pnpm.cmd --filter @myself/desktop typecheck
pnpm.cmd --filter @myself/desktop build
pnpm.cmd exec playwright test --config tests/playwright.config.ts --grep "V3 人设、自定义状态动作与有限播放在发布重启回导中保持一致"
```

第一行的70项中65通过、5个旧夹具失败，第二行证明修正后的5项定向通过；不将它写成修后重跑70项全绿。最后一个命令只在修复后通过一次，前两次失败如实列在表中。本阶段相对基线 `d8a25f47`，官网、CloudBase、scanner 和锁文件差异均为空。

获批清理后的必要命令如下，均通过；仅检查共享运行时的直接消费者，没有修改 scanner 业务。

```powershell
pnpm.cmd --filter @myself/character-runtime exec vitest run --config vitest.config.ts tests/behavior-scheduler.test.ts tests/character-expression-engine.test.ts tests/character-v3-migration.test.ts
pnpm.cmd --filter @myself/desktop test pixi-character-player.test.ts character-store.test.ts
pnpm.cmd --filter @myself/character-runtime typecheck
pnpm.cmd --filter @myself/desktop typecheck
pnpm.cmd --filter @myself/agent-core typecheck
pnpm.cmd --filter @myself/character-assets typecheck
pnpm.cmd --filter @myself/package-scanner typecheck
git diff --check
```

Task 1 保留 V1/V2 输入 Schema 的既有含义，只新增必要复用导出。V3 草稿可明确表示尚未选择 idle；正式发布必须有有效兜底及素材几何。迁移返回的独立问题报告不能因文档结构可解析而被忽略。

Task 2 先由缺失接口的 4 项失败进入实现，之后用 3 项失败定位空计划停止、冷却恢复及跨实例令牌问题。最终定向命令使用 `pnpm.cmd --filter @myself/character-runtime exec vitest run --config vitest.config.ts tests/character-expression-engine.test.ts tests/behavior-scheduler.test.ts`；原 `test -- 文件` 写法实际运行整个包，不能误记为定向运行。引擎不调用模型、系统或文件，Main 接线仍待完成。

Task 3 Main 的定向命令为 `pnpm.cmd --filter @myself/desktop test character-v3-cutover.test.ts character-store.test.ts`，以及 `pnpm.cmd --filter @myself/desktop test character-package-service.test.ts -t 'V3 导出|V1 角色包|复杂旧包|旧包资源校验|旧包图片结构'`。后者还有 69 项未运行，既有临时目录恢复扫描日志 `CHARACTER_IMPORT_RECOVERY_SCAN_FAILED` 仍出现，本轮未据该日志断言导入恢复失败或完全正常。跨进程切换期间已结束旧开发实例；上述测试均使用隔离数据。

Task 4 实际代表性模型命令为私有诊断入口 `node .superpowers/sdd/2026-09-06-ai-pet-custom-state-autonomy/run-character-live-smoke.cjs deepseek` 与同入口 `qwen`。只发送合成人设、状态及获奖场景，不读取真实会话或修改用户角色；DeepSeek原设置文件哈希保持一致。Qwen使用现有资源和Provider，Vulkan卸载33/33层，所有尝试最终均执行runtime清理。其首个问题由HTTP错误及[官方Qwen模板](https://huggingface.co/Qwen/Qwen3.5-4B/blob/main/chat_template.jinja)共同确证：模板只接受开头一条system；本地适配合并段落，未修改模型或资源模板。随后完整JSON回包证明模型会省略可选的心情或计划；单纯强化提示未解决。将两项改为必须明确评估、允许 null 表示无更新，并收紧已处理指令的当次 Schema 后，正式 `0023eb90` 代表场景通过。分阶段私有实验仅用于定位，最终通过结果来自重新编译的正式源码。

## 开始体验

1. 在工作台填写人设、状态和动作描述；希望模型自主选择的状态须勾选“允许智能体推断”，并配置可播放素材。只有 idle 承担兜底职责。
2. 编译发布并启用角色后，分享日常消息观察模型匹配。明确动作可使用“播放向你挥手动作”这类包含真实动作名的语句；默认一遍后恢复有效心情计划或 idle。
3. 保持“自主心情”开启且当前 Provider 可用，首次5分钟未互动可重新评估，此后至少间隔15分钟、每小时最多4次；只改变心情与表现，不发自主消息。关闭开关后已有心情仍随时间变化。

运动0／1／2分别保留静止、持续和间断模式，与情绪动画独立；锚点与区域仍使用原编辑入口，本轮没有扩展。

## 仍待处理

- 定位重启实例运行期重复播放反馈拒绝的来源与实际影响；保留令牌校验，不通过放宽授权掩盖问题。
- 真实 Windows 长时间动画连续性、闲置感受、三态位移及不同自定义人设的自然程度，待用户实际体验反馈。本记录不代替人工验收，也不宣称其他 Provider 或所有语言指令均已验证。
