# 任务 9B2 审查修复设计

## 目标

修复 CDP E2E 安全边界、进程回收、错误保真、跨 chunk 脱敏和窗口命令可测试性五项 Important，同时保持正式 IPC/preload API 不变，且不在默认沙箱启动真实 Electron。

## 设计

1. Main E2E 边界先要求临时根与两个候选均为已存在目录，再用 `realpathSync.native` 取得 Windows 规范路径，最后仅对规范路径做 `relative` containment。文件、不存在路径、前缀碰撞，以及解析到临时根外的 Junction/symlink 全部返回 `null`。
2. 默认 Electron 终止器保留精确 PID 与 executable 校验。Windows `taskkill` 非零或超时后执行原 child 的 `SIGKILL`；无论使用哪条路径，都必须观察原 child 的 exit/非空 `exitCode` 才算成功。fixture 只在各资源清理成功后清引用，`dispose` 只在进程、浏览器和临时目录全部清理成功后置为 released。
3. create/restart 的启动或 CDP 错误始终为主错误。后续 cleanup/dispose 失败时抛出脱敏 `AggregateError`，主错误置于 `cause` 和 errors 首位，清理错误作为附加错误保留。
4. stdout/stderr chunk 只缓存于 fixture 内部；对外 `logs` 与诊断错误均先拼接完整文本、统一脱敏，再执行长度/数量限制，避免 key、Authorization Header 或授权根被跨 chunk 拆分绕过。
5. 新建最小窗口命令控制器：`hideChat` 仅隐藏未销毁窗口；`showChat` 统一执行 ensure、position、show、focus。`index.ts`、托盘和正式 `registerWindowIpc` 复用同一控制器。Renderer 仅抽取无状态按钮组件以便行为测试，不增加 IPC/preload 测试 API。

## 测试边界

每项先写聚焦 RED，再做最小 GREEN。进程测试全部使用可注入假进程，不执行 `taskkill.exe` 或真实 Electron；Windows Junction 测试创建真实临时 Junction并在用例结束后只删除本轮目录。最后运行用户指定的 desktop、integration/security、纯 Playwright 夹具、typecheck 和 build。

## 自审

设计没有新增 Renderer 能力、任意路径入口或 Main Inspector；没有大拆分 `desktop.spec.ts`。该文件动态导入和重复逻辑只记录为后续 Minor 重构项。
