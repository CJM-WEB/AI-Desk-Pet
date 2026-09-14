# 当前会话持久化与模型切换确认验收

日期：2026-09-13。环境：Windows、当前独立工作树、Electron 43.5.0。依据：[规格](../superpowers/specs/2026-09-13-current-conversation-persistence-design.md)、[实施计划](../superpowers/plans/2026-09-13-current-conversation-persistence.md)。本文只记录本次实际证据，不替代其他桌宠功能的验收。

## 实现范围

- 普通当前对话以 `current-conversation.bin` 在应用数据目录加密保存，退出等待已接纳写入完成。恢复完整可见正文以及原有 20 回合／16,000 Unicode 字符内的模型上下文，不恢复任务、许可或运行代次。
- 无痕开启后冻结此前普通快照；关闭开关不补存本段内容。明确新对话或清除当前对话仍会清除旧快照，下一段普通会话恢复写入。
- Main 统一比较实际聊天和任务模型，覆盖 Qwen、云模型路由、活动档案及旧设置入口。确认取消不提交设置；同模型重载、改名称或非活动配置保留聊天。目录、隐私等普通配置只失效旧运行。
- 聊天快照只发给当前 chat 窗口；Main 与 Renderer 共用正文归并。删除旧百条裁剪与重复流式归并，回复 ID 在应用重启后仍唯一。
- 保存错误单独呈现，不清许可卡或中断任务；真实写入恢复后消除提示。退出撤回未确认切换，等待已确认提交和当前新对话清空结算。

## TDD 与复核

失败测试先覆盖了存储实例重建、无痕不补存、损坏文件保护、配置修改清空正文／历史、恢复确认晚到、重启后回复 ID 冲突、模型取消及退出竞态。修复后分别运行直属测试；最终汇总命令与结果见下节。

回复 ID 的组合回归使用真实 Coordinator、Store、临时磁盘及 ChatAdapter；仅在 Adapter 边界注入流式回调，再委托真实回复流程。本次未扩展 Provider 的流式能力。模型切换测试使用隔离 Runtime／配置适配器，没有调用用户实际 Qwen 或云模型。

## 自动化结果

- 全仓类型检查：自动化通过，包含网站、CloudBase、共享契约和桌面消费者。
- 最终 `pnpm.cmd --filter @myself/desktop typecheck`：自动化通过，覆盖最后的保存故障恢复通知改动；日志 `conversation-persistence-final-typecheck.log`。
- 桌面构建：自动化通过，包含沙箱 Preload 及生产边界检查。
- 最终定向验证：20 个测试文件、409 项全部通过，覆盖会话、存储、切换、IPC、Preload、聊天／设置 UI、生产接线、密钥及既有验收脚本的隔离单元测试；日志 `conversation-persistence-targeted.log`。
- `pnpm.cmd test:security`：16／16 自动化通过；日志 `conversation-persistence-security.log`。
- `pnpm.cmd test:integration` 首轮为 75 通过、角色包夹具 1 项 5 秒超时；随后完整单 worker 复核 `node.exe node_modules/vitest/vitest.mjs run --config tests/vitest.config.ts tests/integration --maxWorkers 1`，76／76 自动化通过、21.41 秒，没有修改测试期限；日志 `conversation-persistence-integration.log`、`conversation-persistence-integration-recheck.log`。
- 首轮 `pnpm.cmd verify:desktop`：失败。Core 108 通过、1 跳过；工作区单元测试 3168 通过、57 个唯一失败。42 个失败与此前 `wake-background-verify-desktop.log`／`wake-background-verify-behavior.log` 同名；新增 15 项中，2 项为本次接线变化对应的旧源码单行断言，13 项为超时。没有把该次完整门禁记录为通过。
- 首轮两项隔离 Electron 测试：失败于 `connect_over_cdp` 的 5 秒夹具期限，尚未执行聊天断言。连接诊断证实约 6 秒后 CDP 实际连接成功，随后四个 Renderer 加载；只对本次夹具调整阶段期限为 15 秒，产品实现不变。
- 更新等待期限后，重新构建并在独立空档运行 `node.exe node_modules/@playwright/test/cli.js test --config tests/playwright.config.ts tests/e2e/desktop.spec.ts --grep 当前对话持久化与无痕隔离`：2／2 自动化通过，47.3 秒。使用默认角色及正式 Main／Preload／Renderer，正常退出后再启动；验证正文与下一轮上下文恢复、新对话重启后为空且新请求无旧历史、无痕及退出无痕后的本段内容不改变密文文件。日志 `current-conversation-e2e-serial-build.log`、`current-conversation-e2e-serial.log`；测试进程已清理。

完整门禁的两项旧接线断言已按新保存顺序和关闭边界更新，纳入上述 409 项通过结果。新增 13 项超时按完整测试名过滤、`--maxWorkers 1` 串行复核，13／13 自动化通过（7 文件、28.13 秒），没有修改期限；包括素材服务、角色包、角色存储、V3 迁移、默认角色、生产包边界和 Pixi 播放器。日志 `conversation-persistence-timeout-recheck.log`。此前同名的 42 项失败未在本次范围内修复，因此完整门禁仍记录为失败。

验证日志保存在本工作树 `.superpowers/`，不作为产品数据或 Git 提交内容。`git diff --check`、本次文档中文编码与链接检查通过；网站、CloudBase、包扫描器及依赖锁文件没有差异。

## 人工范围

真实 Windows 原生切换确认框的观感与日常用户操作体验：待用户人工确认。确认接纳、取消、退出 AbortSignal 以及取消后设置界面复原有自动化证据；现有 Electron 夹具只提供 Renderer CDP，本次没有新增 Main 调试入口或产品确认绕过机制。

本次不新增会话列表、跨设备同步或长期记忆；不修改官网链路，不读取真实聊天、凭据或用户素材，不自动执行 Git 提交。
