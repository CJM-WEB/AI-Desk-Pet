# 聊天窗口鼠标延迟修复执行核对

依据[修复规格](../specs/2026-09-13-chat-pointer-latency-design.md)。用户已授权处理当前卡顿，保留既有视觉及流式修改。

| 步骤 | 文件与完成标准 | 结果 |
| --- | --- | --- |
| 并行诊断 | 主任务核查窗口调度；子任务分别核查原生钩子和 Renderer 稳态悬停 | 已完成，未发现 Renderer 稳态循环 |
| RED | `.superpowers/sdd/2026-09-13-chat-pointer-latency/measure-pump.ps1` 使用生产消息泵，P95 要求低于 5 毫秒 | 旧实现 17.5388 毫秒，退出 1 |
| GREEN | `apps/desktop/resources/windows/chat-pointer-observer.cs` 只替换阻断消息的休眠方式 | 同一命令退出 0 |
| 固化回归 | `apps/desktop/tests/fixtures/chat-pointer-pump-latency.ps1` 仅测当前生产代码，不保留候选替换分支 | 40 样本通过 |
| 收口 | 现有三组原生展示测试、桌面类型检查、只读复核及验收文档 | 已完成 |

实际命令、数值与未验证事项见[验收记录](../../operations/2026-09-13-chat-pointer-latency-acceptance.md)。
