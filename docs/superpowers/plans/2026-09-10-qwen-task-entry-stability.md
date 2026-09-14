# 内置 Qwen 子目录任务稳定性计划

日期：2026-09-10，更新：2026-09-11。状态：诊断与已批准的 Qwen 专用适配已完成；定向测试及子目录有限实测通过，完整稳定性与仓库门禁未全部通过。DeepSeek、用户文件与设置未修改，详细证据见验收记录。

## 规格与诊断结论

原有[单一发送规格](../specs/2026-09-08-single-send-expression-isolation-design.md)规定主请求采用原生正文或空参数任务申请、`toolChoice:auto`，不携带 `response_format`。本轮恢复该行为的提示及温度候选经过 RED/GREEN 后，仍未通过真实多轮验收，未留在生产源码。

[诊断记录](../../operations/2026-09-10-qwen-subdirectory-diagnosis.md)证实 Core 能进入子目录，主要问题在 Qwen 主请求漏选任务。用户于 9 月 11 日批准[Qwen 会话决策规格](../specs/2026-09-10-qwen-conversation-decision-design.md)，仅对内置 Qwen 使用单次精简 JSON，再映射既有申请，局部覆盖原规格。

## 已完成诊断

- [x] 读取研究文档、现行规格、领域词汇、真实代码与用户目录。
- [x] 隔离复现截图五轮对话，区分根目录、子目录和空文件的实际工具证据。
- [x] 原生候选先 RED、最小实现 GREEN，执行真实复测及相应门禁并记录失败。
- [x] 固定原始失败请求，排除合法工具调用在解析时丢失；仅改变工具说明仍失败。
- [x] 隔离精简 JSON 原型；严格 anyOf 的 8 条有限入口实验通过，记录聊天事实约束和端到端尚未验证。
- [x] 撤回 8 个生产及测试文件中的本轮实验改动，保留用户既有研究文档修改与诊断材料；未使用 Git 写操作。

## 已批准的实施顺序

### 任务一：Qwen 本地适配

文件：`apps/desktop/src/main/providers/local-model-provider.ts`、`apps/desktop/src/main/conversation/conversation-chat-adapter.ts`、`apps/desktop/tests/local-model-provider.test.ts`。

依赖：新规格已批准。RED：从正式 ChatAdapter 构造请求，断言仅 Qwen 的精确宿主入口改用无工具严格响应 Schema，历史、人设、用户原文保持；合法 chat 解包为正文，task 映射空参数申请，坏联合结构拒绝。再补空白、长度、额外字段、未知 kind、取消及 generation 失效。

GREEN：复用原响应契约、输入预算、Provider 错误和连接失效检查完成最小适配；不增加模型调用、重试、关键词路由、执行器或新依赖。完成标准：定向测试与桌面类型检查通过；DeepSeek 请求与独立表现不变。

完成证据：新增断言先有 27 项按预期失败，最小实现后本地 Provider 65 项通过；连同主会话、协调器及云 Provider 共 201 项通过。最后提示补充明确事实查询语义后，201 项重新通过。

### 任务二：授权边界回归

文件：`apps/desktop/tests/conversation-chat-adapter.test.ts`、`apps/desktop/tests/main-conversation-composition.test.ts`，按现有接缝需要选择，避免重复测试。

依赖：任务一。RED：合法 task 只触发 Main 范围卡，确认前 Core 调用为零；取消、拒绝、过期或带伪造许可的输出不能执行。GREEN：优先复用现有正式组合，只有实际缺陷才修改生产代码。

完成标准：拒绝、取消、迟到事件和范围确认边界通过；不得因模型输出 task 就绕过用户授权。

完成证据：只新增 Main 组合测试，未修改授权实现。6 条新增用例覆盖确认前零执行、拒绝、取消／reset 后迟到响应与伪造许可；完整组合测试 27 项通过。畸形输出先确认失败断言能暴露缺陷，再验证稳定错误及原文不泄漏。

### 任务三：真实验收与收口

文件：`tools/diagnostics/qwen-followup-probe.mjs`、`docs/operations/2026-09-10-qwen-subdirectory-diagnosis.md`、`tests/fixtures/fake-local-model-process.mjs`、`tests/integration/local-model-process-fixture.test.ts`、`tests/e2e/desktop.spec.ts` 的本地模型生命周期用例。后面三项用于校准新私有协议的 HTTP 夹具及现有活动匹配请求顺序，不改其他 E2E 场景或云 Provider 实现。

依赖：任务一、二。运行实际人设及合成人设的根目录→子目录→文件跟进；每次明确查阅均检查对应轮次工具事实。加入非空子文件与根目录同名文件，验证完整目标和正文；纯讨论、拒绝、引用零任务。保留失败，不以偶然通过代替稳定性结论。

运行定向测试、类型检查、安全、集成、桌面门禁与相关 Electron 检查；区分本轮引入、已确认既有、原因未明和待人工确认。只留下正式路径，删除被替代的本地实验逻辑，不改 DeepSeek、Core 或权限边界。完成后更新实际记录并运行 `git diff --check`，不提交、推送、打包或安装。

验收边界：当前源码的实际人设三轮、同名文件三轮与两个拒绝／讨论负例已取得真实工具证据；固定强人设五轮中的两次重复确认因提出未预批准命令而失败，完整场景不标记通过。Electron 夹具已改为当前私有协议，并通过真实 LocalModelProvider 到假进程 HTTP 的 RED/GREEN 与 11 项检查；各门禁最终结果统一写入诊断记录。

收口证据：全 workspace 类型检查、Core 108 项（另 1 项跳过）、安全 16 项、桌面构建及窄 Electron 生命周期检查通过。完整单元门禁 2884 项通过／40 项失败，集成 64 项通过／1 项失败，未标记全量通过。Electron 仅补全本用例原本漏掉的活动匹配响应及精确请求顺序，未改生产逻辑。实现与本轮验证执行完毕，剩余稳定性和人工项见诊断记录。
