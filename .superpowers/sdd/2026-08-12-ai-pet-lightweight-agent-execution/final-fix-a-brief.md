# 最终修复 A：文件工具边界

基线：`c816c08`。仅修改 `packages/file-tools`、必要的确认卡与对应测试。

1. `read_file` 增加严格返回字符上限，单行 1 MiB 不得完整进入结果；保持 UTF-8、行范围和 truncated 语义。
2. `create_file` 对敏感正文（API key、Bearer、PEM、password/secret/token 赋值等）不公开预览；过长正文也不公开正文，只公开字符数和 suppressed 原因。同步类型/确认卡。
3. `create_file` 写失败清理本次新建目标；`apply_patch` 写、关闭、rename 失败均尽力删除本次临时文件，不删除竞争方文件。
4. 每项先写故障注入/边界 RED，再 GREEN；不得扩大 TOCTOU 威胁模型，不改网站。
5. 定向 file-tools、shared、Renderer 测试与 typecheck、diff/website。报告 `final-fix-a-report.md`，不要提交，由主控统一提交。
