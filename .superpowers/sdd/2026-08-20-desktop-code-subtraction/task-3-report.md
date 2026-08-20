# Task 3：Electron 安全 E2E 合并验收记录

日期：2026-08-20
基线提交：`7e7b92a`

## 修改范围

- 修改：`tests/e2e/desktop.spec.ts`
- 删除：重复场景 `只有当前聊天窗口能使用已知 actionId 确认文件动作`，以及仅供该场景使用的 Provider 步骤、页面定位、票据暂存和确认逻辑。
- 保留的最终场景：`会话任务事件只向 chat 完整投递、向 pet 只投递 phase 且非 chat 不能执行票据`。

## 场景与行数

| 项目 | 修改前 | 修改后 |
| --- | --- | --- |
| 测试文件行数 | 4,993 | 4,893 |
| 投影场景 | `会话任务事件只向 chat 完整投递并向 pet 投递 phase`（第 4493 行） | `会话任务事件只向 chat 完整投递、向 pet 只投递 phase 且非 chat 不能执行票据`（第 4493 行） |
| 已知票据确认场景 | `只有当前聊天窗口能使用已知 actionId 确认文件动作` | 已删除，检索结果为 0 |

代码差异为 37 行新增、147 行删除，净减少 110 行；文件实测行数净减少 100 行。

## 合并后的安全断言

合并场景从 chat 的 `pending_action` 捕获文件 `actionId` 后，依次让 pet、settings 和 characters 调用 `confirmAction(actionId)`，均断言拒绝并匹配 `AGENT_IPC_SENDER_INVALID`。随后断言确认卡仍可见、`projection-privacy.txt` 尚不存在；chat 正式确认后再断言目标文件存在。

原投影最小化防线仍保留：pet 收到的每项事件严格只有 `phase` 与 `type` 两个键且 `type` 为 `phase`；settings 与 characters 事件数组为空；三个非 chat 投影的序列化结果均不含 `actionId`、`command`、正文哨兵、授权路径或 `requestId` 等敏感值。

## 自动化证据

迁移断言、删除旧场景前：

```powershell
pnpm.cmd --filter @myself/desktop build
pnpm.cmd exec playwright test --config tests/playwright.config.ts tests/e2e/desktop.spec.ts --grep "会话任务事件只向 chat"
```

结果：构建通过；Playwright `1 passed (7.9s)`。

删除旧场景并更正最终测试名后复验同一命令：构建通过；Playwright `1 passed (8.5s)`。

补充检查：

```powershell
rg -n "只有当前聊天窗口能使用已知 actionId" tests/e2e/desktop.spec.ts
git diff --check
```

结果：旧测试名零命中；`git diff --check` 无格式错误。

## 关注项

构建仍会输出既有的 `lucide-react` `"use client"` bundle 提示，Playwright 会输出 `NO_COLOR` 与 `FORCE_COLOR` 的环境变量警告；两次命令均以退出码 0 完成，未观察到本任务引入的失败或泄漏断言退化。
