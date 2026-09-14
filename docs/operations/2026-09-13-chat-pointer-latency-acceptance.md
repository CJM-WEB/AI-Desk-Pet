# 聊天窗口鼠标延迟修复验收

日期：2026-09-13。环境：Windows，本地隔离工作区。

## 实际修改

唯一生产代码修改为 `apps/desktop/resources/windows/chat-pointer-observer.cs`：把鼠标钩子线程中阻塞输入的 `Thread.Sleep(10)` 换成可被系统消息立即唤醒的 `MsgWaitForMultipleObjectsEx`；保留原 10 毫秒无输入等待上限，失败仍进入原固定错误与清理路径。

新增独立原生消息泵回归夹具。没有改变 Renderer 样式、鼠标点击协议、窗口行为、流式输出、模型、授权、文件或角色逻辑；没有新增依赖或进行 Git 写操作。

## RED / GREEN 与证据

临时消息泵夹具读取生产 C#，只添加自有隐藏消息窗口与就绪信号，在该窗口上发同步 `WM_NULL`。不启动桌宠，不注入系统鼠标，不读取其他窗口。

| 生产消息泵 | 样本数 | 中位延迟 | P95 | 最大值 | 退出码 |
| --- | --- | --- | --- | --- | --- |
| 修复前 `Thread.Sleep(10)` | 40 | 9.7504 ms | 17.5388 ms | 22.8080 ms | 1 |
| 隔离候选，仅替换等待调用 | 40 | 0.0641 ms | 0.2918 ms | 0.4929 ms | 0 |
| 修复后原生产代码，同一夹具 | 40 | 0.0627 ms | 0.1779 ms | 0.2459 ms | 0 |
| 固化回归夹具最终运行 | 40 | 0.0838 ms | 0.2035 ms | 0.3064 ms | 0 |

回归阈值为 P95 低于 5 毫秒，用于捕获消息泵重新加入固定休眠；不是全机鼠标输入延迟的承诺。

以下最终命令均退出 0：

```powershell
powershell.exe -NoProfile -NonInteractive -File apps/desktop/tests/fixtures/chat-pointer-pump-latency.ps1
pnpm.cmd --filter @myself/desktop test tests/chat-native-presentation.test.ts tests/chat-presentation-windows.test.ts tests/chat-presentation-bridge.test.ts
pnpm.cmd --filter @myself/desktop typecheck
```

三组定向测试共 50 项通过。C# 已由原生夹具实际编译并执行。修改仅为运行时加载的 C# 资源，没有重新运行无关桌面构建或角色、模型切换回归。

独立只读检查还使用当前生产 Renderer 与无头 Edge，在展开稳定后发送 500 次 CDP 鼠标移动：新增布局上报、尺寸读取、样式读取、ResizeObserver 回调均为 0；长任务、页面错误、非法布局也为 0。展开动画的短时测量正常结束，未把它当成持续性能问题修改。

交叉复核没有发现阻断项，确认原点击协议、generation、启停、失败与清理语义不变。

## 测量限制与使用

尝试过只识别夹具自身标记的原生鼠标注入探针，但本环境未能收到低级鼠标回调；修正就绪屏障和线程布局后仍无有效回调，已停止该路径。没有把这些尝试当成真实鼠标时延或 original/wake 的有效对比。微移测试没有点击、按键或滚动，保留原位置恢复守卫；探针仅保留在 `.superpowers/sdd/2026-09-13-chat-pointer-latency/` 调试目录。

原生消息泵延迟已自动化验证；用户桌面的实际鼠标手感与完整 Electron 交互仍为“待用户人工确认”。需要完全退出并重新启动桌宠，使现有鼠标观察器进程加载新资源。

原生消息等待语义参见 [LowLevelMouseProc](https://learn.microsoft.com/en-us/windows/win32/winmsg/lowlevelmouseproc) 与 [MsgWaitForMultipleObjectsEx](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-msgwaitformultipleobjectsex)。完整范围见[规格](../superpowers/specs/2026-09-13-chat-pointer-latency-design.md)和[执行核对](../superpowers/plans/2026-09-13-chat-pointer-latency-fix.md)。
