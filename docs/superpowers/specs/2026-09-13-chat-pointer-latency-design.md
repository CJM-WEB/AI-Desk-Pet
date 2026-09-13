# 聊天窗口鼠标延迟修复

用户报告顶部聊天框展开后鼠标经过时严重延迟，授权处理本次性能问题。范围仅限窗口表现层鼠标观察器，沿用[聊天视觉规格](2026-09-13-desktop-chat-visual-redesign-design.md)，不改变任何业务功能或视觉样式。

## 证据与原因

`apps/desktop/resources/windows/chat-pointer-observer.cs` 在安装鼠标钩子的线程中，每次处理消息后执行 `Thread.Sleep(10)`。依据 [Microsoft 的 LowLevelMouseProc 文档](https://learn.microsoft.com/en-us/windows/win32/winmsg/lowlevelmouseproc)，低级鼠标回调通过同步消息进入安装线程；该线程的普通休眠会阻碍及时响应。

使用生产 `Run` 消息泵、仅增加夹具自有隐藏消息窗口进行测量。旧等待方式的同步消息中位延迟为 9.7504 毫秒，P95 为 17.5388 毫秒；只替换等待调用的隔离候选 P95 为 0.2918 毫秒。Renderer 稳态悬停检查没有发现布局或 IPC 循环。

## 最小修复

- 使用 `MsgWaitForMultipleObjectsEx` 等待输入；`QS_ALLINPUT` 覆盖同步消息，`MWMO_INPUTAVAILABLE` 防止遗漏已进入队列的输入。API 语义参见 [Microsoft 文档](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-msgwaitformultipleobjectsex)。
- 保留原有 10 毫秒的无输入等待上限，保证 stdin 命令、心跳和退出的既有调度范围；有消息到达时立即唤醒，继续复用 `PeekMessage` 派发。
- 等待失败进入原有异常清理和固定错误码路径。
- 删除原消息泵上的 `Thread.Sleep(10)`，不叠加新线程、输入监听或依赖。

鼠标按下协议、坐标含义、generation、启停、输出队列、首击穿透和点击外部收起规则保持不变。模型、流式输出、授权、会话、文件和桌宠行为逻辑均不属于本次改动。

## 验收边界

先运行消息泵延迟失败测试，再替换等待调用并运行同一测试；补充现有点击观察器、窗口控制和展示桥测试、桌面类型检查。

回归夹具只向自有隐藏窗口发送 `WM_NULL`，不注入鼠标、不采集屏幕或其他应用内容，并对就绪、单次发送和退出设置超时。它证明原消息泵的等待延迟，不等价于整机鼠标手感或完整 Electron 原生交互验收。实际鼠标体验仍需重启桌宠后人工确认。
