# 对话纵向接线验收记录

> **现行差异（2026-08-25）：** 本文的回收站提交帧闭环是历史验收。当前文件确认后由 Electron Main 直接执行，不再等待 Renderer 动画里程碑；普通聊天、披露、重置和 Main 文件安全边界保持不变。

## 1. 验收结论与边界

- 日期：2026-08-10（Asia/Shanghai）
- 平台：Windows
- 分支：`AgentCoreExtension`
- 基线：`2267b66`
- 最终提交前 HEAD：`2267b6605cbab741abe7cbe4d1b8dd9f562183ee`
- 范围：仅智能桌宠 Desktop 的默认 Chat、Main 明确文件意图门、File、Disclosure、Reset 与安全回收站闭环。
- 结论：六道非网站自动门均通过；Windows 人工验收尚未执行，不能据此宣称人工验收完成。

自动 E2E 全程使用隔离 `userData`、脚本 Provider、临时授权根和隔离回收站适配器。测试未读取真实用户密钥、聊天记录或文件内容，也没有操作真实 Windows 回收站。

## 2. 自动门结果

六道门按下表顺序串行执行，没有并行启动 Electron。根脚本 `typecheck` 会递归进入 `apps/website`，因此正式第一道门采用只覆盖非网站工作区的等价类型门。

| 门 | 命令 | 结果与精确计数 | 跳过 | 耗时 | 证据来源 |
| --- | --- | --- | --- | --- | --- |
| 1 | `pnpm.cmd -r --filter @myself/shared-types --filter @myself/file-tools --filter @myself/agent-core --filter @myself/character-runtime --filter @myself/character-assets --filter @myself/desktop --filter @myself/release-tools --if-present typecheck` | 7/7 个非网站工作区通过，退出码 0 | 0 个工作区 | 12.78 秒 | pnpm 递归任务输出 |
| 2 | `pnpm.cmd test:unit` | 98 个测试文件通过；1849 项通过 | 14 项（总计 1863 项） | Vitest 40.38 秒 | 根脚本明确列出的非网站单元测试输出 |
| 3 | `pnpm.cmd test:security` | 1 个测试文件、20/20 项通过，退出码 0 | 0 | 1.18 秒 | Vitest 安全门输出 |
| 4 | `pnpm.cmd test:integration` | 4 个测试文件、30/30 项通过，退出码 0；其中 Provider fixture 6/6 | 0 | 2.27 秒 | Vitest 集成门输出 |
| 5 | `pnpm.cmd test:e2e:desktop` | 49/49 项通过，退出码 0 | 0 | 2.4 分钟 | Playwright Electron E2E 输出 |
| 6 | `pnpm.cmd verify:behavior` | character-runtime 13 文件/221 项；agent-core 2 文件/31 项；desktop typecheck 通过；desktop 77 文件/1453 项通过；security 1 文件/20 项；integration 4 文件/30 项；E2E 49/49 项，退出码 0 | desktop 14 项 | 约 3 分 33 秒；其中各测试段分别为 1.13 秒、0.808 秒、37.64 秒、1.22 秒、2.62 秒、2.3 分钟 | `verify:behavior` 顺序输出 |

门 5 与门 6 结束后均只读扫描本工作树相关的 `electron.exe`、`node.exe` 进程，结果为空，未发现测试残留进程。

## 3. 纵向场景证据

| 场景 | 自动证据 |
| --- | --- |
| Chat | 无授权范围时连续完成三轮普通聊天；三次自然文本请求的工具数组均严格为空，第三轮请求包含前两轮 Renderer 可见回合。 |
| 默认分流 | 精确提交“帮我整理一下”，可信 Main 明确文件意图门将其保留为普通聊天并展示 Provider 的自然回复；隔离文件系统快照前后一致，未创建文件 Agent 或工具调用。 |
| File | 明确文件请求在无授权时稳定显示设置引导；隔离文件系统不变，文件 Agent 未创建。 |
| Disclosure | Chat 与 Agent 固定为不同 Provider；“仅发送当前消息”不会携带旧可见历史；`share_once` 会携带当前可见历史一次，下一次文件请求重新出现披露卡，证明授权未复用。新披露决策前不会发出下一次规划，源 Provider 精确 4 次、目标 Provider 精确 2 次，双方脚本都完整且无额外消费。 |
| Reset：挂起响应 | 旧 Provider 响应挂起时新建对话；释放后等待脚本 Provider 完成第一个 `response.end` 步骤，再次确认会话仍为 idle/0；随后才提交新消息并等待第二步完成，最终仅 2 条可见消息且阶段为 success/idle，没有旧阶段或旧错误回流。 |
| Reset：待确认动作 | 重置前捕获旧确认按钮定位器；重置后该定位器消失、确认卡探针为假、目标文件保持不变，且新会话可以继续提交。 |
| 回收站 | 既有安全回收站搬运闭环继续通过：只有匹配提交帧后才写入隔离适配器；成功后目标进入隔离回收站，恰有 `.attempt-1` 审计标记且重复上报不增加尝试，并保留中断、失败与幂等证据。 |
| 角色闭环 | 自然文本回复附带的受支持 `happy` 情绪产生 `character_emotion` 事件；对话阶段成功、无错误，角色切换后闭环继续工作。 |

### 3.1 旧 `actionId` 拒绝的证据边界

E2E 探针按规格不得暴露 `actionId`，因此 Electron E2E 没有绕过 Renderer 直接重放旧 ID。安全的纵向证据是：重置前保存的旧确认控件在重置后不可再操作、确认卡消失、文件不变、新会话继续工作。Main 层的直接拒绝由 `apps/desktop/tests/conversation-coordinator.test.ts` 中“等待文件确认时 reset 委托文件清理并使旧 actionId 失效”用例提供。两层证据共同覆盖“用户入口失效”和“Main 拒绝旧 ID”，但不把私有 ID 暴露给 E2E 探针。

## 4. 可观测性与脱敏

- `tests/fixtures/electron-app.ts` 的会话探针只通过测试侧 CDP 读取可见 DOM，并仅返回 `phase`、可见消息数、披露卡是否存在、文件确认卡是否存在四个去标识化字段。
- 探针不返回聊天正文、历史正文、Provider 信息、密钥、文件正文、绝对路径、`actionId`、`requestId` 或任何 token。
- fixture 支持对附加 Provider 密钥统一脱敏；对应测试先证明第二 Provider 密钥会泄漏的 RED，再证明 GREEN 后日志中不存在该密钥。
- 新增场景以唯一哨兵检查聊天正文、文件正文、两个 Provider 密钥和绝对授权路径均未进入捕获日志。
- 单元门包含 `apps/desktop/tests/preload-production-boundary.test.ts`，继续证明未启用固定 E2E 开关时生产 preload 不暴露测试探针。此次会话探针只存在于 E2E fixture，没有新增生产 preload 接口。

## 5. 网站边界与执行偏差

`git diff --name-only -- apps/website` 为空，网站文件零改动；没有运行 `verify:website`，也没有构建、启动或测试网站。

执行期间曾按简报原命令启动一次根 `pnpm.cmd typecheck`，脚本展开后意外执行了 `apps/website` 的 `tsc --noEmit` 并通过。发现后立即停止把根脚本作为验收门，后续改用表中等价非网站类型门。该次网站 TypeScript 检查不计入任何验收证据，也没有产生网站文件修改或构建产物。首次启动的 `pnpm.cmd test:unit` 也在脚本边界复核时安全中止，不计入结果；表中门 2 是随后从头执行的新鲜结果。

## 6. 已知非阻断输出

- Vite 构建报告第三方模块中的 `"use client"` 指令被忽略，不影响桌宠构建与 E2E。
- 测试输出包含 `NO_COLOR` 环境提示。
- JSDOM 报告未实现 Canvas，以及角色错误降级用例输出预期错误日志；相关用例仍按断言通过。
- `git diff --check` 只报告 Windows 下未来可能进行 LF/CRLF 转换的提示，没有空白错误。

## 7. 待用户执行的 Windows 人工验收

以下项目全部为**待用户执行**，本记录不把它们标记为通过：

- [ ] 在真实桌宠中连续进行三轮普通聊天，确认第三轮能自然承接前两轮可见上下文。
- [ ] 输入模糊请求，确认获得自然聊天回复，且不触发文件副作用或授权设置引导。
- [ ] 在未授权目录时发起明确文件请求，确认出现稳定的授权设置引导。
- [ ] 分别执行“仅发送当前消息”和“仅本次共享历史”，确认文案、继续执行与单次消费符合预期。
- [ ] 在模型响应挂起时新建对话，确认旧内容不回流且新会话可继续。
- [ ] 在文件动作待确认时新建对话，确认旧确认入口失效且文件不变。
- [ ] 在专用、无隐私内容的真实授权目录完成一次安全文件任务，并核对真实 Windows 回收站结果与可恢复性。
- [ ] 抽查桌宠日志，确认不含聊天正文、文件正文、API Key、Authorization、完整绝对路径或私有标识。
