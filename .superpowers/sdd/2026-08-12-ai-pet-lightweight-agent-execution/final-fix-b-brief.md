# 最终修复 B：路由与 Adapter 收敛

基线：`c816c08`。仅修改 capability intent router、capability task adapter 及对应测试/必要调用点。

1. 明确 PowerShell 执行请求支持真实脚本载荷，如 `$x=1; Get-ChildItem`、`& { Get-ChildItem }`，但讨论/评价/引号正文仍为聊天；不得改成任意句子触发。
2. `prepareTarget` 只接受 `{generation, taskKind}`；`submit` 必须显式 `taskKind`，删除字符串旧签名与默认 file 降级，迁移全部调用/测试，不留别名。
3. 每项先 RED 后 GREEN；定向 router/coordinator/adapter/composition/typecheck、旧签名静态反查、diff/website。
4. 报告 `final-fix-b-report.md`，不要提交，由主控统一提交。
