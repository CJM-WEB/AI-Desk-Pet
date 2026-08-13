# 最终修复 B 执行报告

## 完成范围

- 能力意图路由器新增两类明确 PowerShell 脚本载荷证据：变量赋值后续脚本（如 `$x=1; Get-ChildItem`）与调用运算符脚本块（如 `& { Get-ChildItem }`）。
- 命令讨论、评价、引号正文、代码块和文件正文仍保持普通聊天；路由仍要求消息开头存在明确执行措辞，不接受任意句子触发。
- `CapabilityTaskAdapter.prepareTarget` 只接受 `{ generation, taskKind }`；删除字符串旧签名及其默认文件任务降级。
- `CapabilityTaskAdapter.submit` 必须显式传入 `taskKind`；删除可选任务类型与默认文件任务降级，并迁移对应测试调用。
- 未修改网站、IPC、preload、共享通道或其他能力模块；未执行 Git 写入。

## RED / GREEN

### Router

- RED：新增 `$x=1; Get-ChildItem` 与 `& { Get-ChildItem }` 两个明确执行用例，旧实现均返回 `chat`；同轮负例覆盖脚本评价与引号正文。
- GREEN：增加最小脚本结构识别后，Router 定向测试 141/141 通过。
- 最终规格 RED：显式 `执行 PowerShell` 前缀下，17 个参数与绝对 `.ps1` 路径仍被通用命令 shape 拒绝；控制结构由旧规则偶然放行。超出 16 KiB 的载荷在独立边界测试中错误进入能力任务。
- 最终规格 GREEN：明确中英文 PowerShell 执行前缀改走专属判定，只要求载荷非空、UTF-8 不超过 16 KiB，并复用引用屏蔽与自然语言讨论防线；通用命令前缀仍保留原 shape/参数限制。
- 回归修复：完整 Router 首轮发现单 token 的“安全吗/好不好/值得吗”被新前缀误判，补齐整段讨论判定后，真实脚本、讨论、评价与引号正文共 149/149 通过。
- 性能 RED：聚合 unit 门中 16 KiB+1 边界用例超时；受控依赖测试进一步证明 Router 没有“显式 PowerShell 早拒绝且不进入文件 Gate”的接缝。
- 性能 GREEN：将原文件候选、公共后缀和结构扫描提取为默认文件 Gate；显式 PowerShell 前缀在 Gate 前完成接受或超限拒绝。受控调用计数证明超限请求对文件 Gate 为 0 次调用，不依赖绝对耗时阈值。
- 语义回归：早期路由首次完整运行捕获“运行 PowerShell 是什么？”回归；补齐专属讨论表达后 Router 150/150 通过。

### Adapter

- RED：用编译期参数契约检查旧字符串 `prepareTarget` 与缺省 `taskKind`；旧实现导致两个 `@ts-expect-error` 未使用，`desktop typecheck` 退出 2。
- GREEN：删除 overload、字符串分支和 `taskKind ?? 'file'` 后，参数契约改为精确类型断言，`desktop typecheck` 退出 0。

## 验证

- Router、Coordinator、Adapter、Composition 定向 Vitest：4 个测试文件、228 个测试通过。
- `@myself/desktop` typecheck 新鲜重跑退出 0。
- 旧签名、旧类名与 `POWERSHELL_TASK_NOT_READY` 静态反查无生产或调用命中。
- `git diff --check` 通过；`apps/website` 无差异。

## 注意事项

- 工作区共享的 `progress.md` 及其他任务差异由主控维护，本修复未改动这些文件。
- Vitest 通过仓库根本地二进制执行；计划中的 `pnpm --dir apps/desktop exec vitest` 在当前 pnpm 链接状态下找不到可执行文件。
- 依据简报与仓库约束，本修复未暂存、提交或执行其他 Git 写操作。
