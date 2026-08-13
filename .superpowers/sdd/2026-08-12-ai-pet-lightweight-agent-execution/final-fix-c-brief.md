# 最终修复 C：PowerShell 清理与文件错误贯通

基线：`c816c08`。修改 PowerShellTool、AgentService/CapabilityAdapter/Coordinator 与对应测试。

1. PowerShell 每次运行保存共享 completion；Abort/timeout 已进入挂起清理后调用 close 必须等待同一 completion，清理完成后才清 active。用假时钟/deferred killTree RED。
2. 集中补齐安全文件错误映射：ENTRY_CHANGED、RECYCLE_BIN_FAILED、ENTRY_TYPE_UNSUPPORTED、LINK_NOT_ALLOWED 等贯穿 Service→Adapter→Coordinator，消息/nextAction稳定且不泄密；已发布错误不可被 Coordinator 再降级成 AGENT_INTERNAL_ERROR 或重复发布。
3. 通过 Coordinator 的冲突、非空目录/链接、回收站失败测试先 RED 后 GREEN。
4. 定向 PowerShell/AgentService/Adapter/Coordinator 测试、desktop typecheck、diff/website。报告 `final-fix-c-report.md`，不要提交，由主控统一提交。
