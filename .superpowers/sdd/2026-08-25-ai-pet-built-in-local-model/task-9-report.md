# Task 9：自动纵向、安全与 Electron 生命周期验收报告

## 状态

已完成代码、自动化验收与桌面全门禁。测试未使用真实 GGUF；真实模型、Vulkan 与安装包验收仍属于 Task 10 或人工验收范围。

## RED / GREEN

### 本地工具纵向

先新增“自然语言 → 真实环回 OpenAI `tool_calls` → 正式 `LocalModelProvider` codec → `AgentLoop` / `AgentService` → 正式 `FileToolService` → 确认 → 工具结果回填总结”的集成测试。首次运行因本地环回 fixture 不存在而 RED；加入最小 fixture 后，现有脚本化 Provider 又因不能识别本地强制非思考参数而按预期失败。补齐请求归一化后转 GREEN。

最终用例依次在真实临时授权根中创建、移动和删除 `资料.txt`。三个写操作在确认前均无副作用，确认后均检查真实文件系统；删除通过注入的真实重命名模拟可恢复回收站。六次请求全部命中 `ai-pet-local`，三次 `ToolResult` 均回填并产生最终总结，本地启用期间独立云 fixture 请求数严格为 0。

### 安全边界

先新增 Runtime / Provider AST 能力扫描与连接、正文、日志 canary 测试。首次运行因扫描 fixture 不存在而 RED；加入只读 AST 扫描后转 GREEN。

扫描证明正式 `LocalModelRuntime` 与 `LocalModelProvider` 不导入或持有 `FileToolService`、`PathPolicy`、PowerShell、Electron、授权根标识，也不存在非 `false` 的 shell 赋值。公开状态、Provider 稳定错误与普通日志序列化中均未出现 Token、端口、授权路径、Prompt、响应正文或 stderr canary。

### 真实 Electron 生命周期

先新增真实 Electron 用例与两档布局断言。首次运行时应用没有专用本地进程 fixture，窗口只能观察既有关闭状态，因此 loading 断言 RED。随后仅在严格的未打包 E2E 边界内接入真实 Electron-as-Node 子进程与环回 HTTP server；正式 `LocalModelService`、`LocalModelProvider`、会话协调器、确认和文件工具链均未被替代。

用例实际证明：

- 本地进程 ready 前桌宠、聊天与设置窗口已经出现；聊天显示 loading 且发送按钮禁用。
- 写入可观察 ready marker 后进入 CPU 兼容 ready，并可通过正式本地 Provider 聊天；云 fixture 仍为 0 次调用。
- 本地模型产生创建文件的真实确认卡，确认前文件不存在；关闭本地模型后旧确认失效且文件仍不存在。
- 关闭后下一轮聊天严格恢复持久化云路由；重新启用后应用退出会清理精确本地 fixture PID。
- Electron 原始 stdout / stderr 捕获未命中 Token、授权头、授权路径、Prompt、回复正文、响应 body canary 或私有 stderr canary。
- 720×620 默认窗口与 640×520 最小窗口均显示本地模型标题、开关和模型说明，并通过既有横向溢出与控件重叠检查。

测试只通过窗口、公开状态、真实 HTTP、文件系统、进程探针和 ready marker 等可观察条件等待，没有加入固定 `sleep`。

## 最小实现

- 新增集成测试专用本地 Provider server 包装器，复用既有脚本化环回 server，不复制 OpenAI 协议实现。
- 扩展既有 Provider 请求检查器，使其识别本地 Provider 固定的非流式、禁思考、单工具策略。
- 新增只读 TypeScript AST 安全扫描 fixture。
- 新增严格 E2E-only 的 Main 本地模型进程替身和小型 HTTP 子进程；入口仍受既有 `appIsPackaged === false`、`MYSELF_E2E=1`、固定 fake bridge 与临时目录规范路径校验共同约束。正式环境继续构造真实 `LocalModelRuntime`。
- 扩展 Electron fixture 的 ready marker、PID 读取和敏感日志 canary；未新增 Renderer IPC 或生产控制面。
- 既有 Main 生命周期源码契约同步为“普通 E2E 关闭本地模型，只有专用本地 fixture 启用；生产仍读取持久化设置”。

## 验证结果

最终实际执行：

```powershell
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/main-lifecycle.test.ts
pnpm.cmd exec playwright test --config tests/playwright.config.ts --grep "内置本地模型在真实 Electron 中经历加载"
pnpm.cmd test:security
pnpm.cmd test:integration
pnpm.cmd verify:desktop
git diff --check
```

结果：

- Main 生命周期定向测试：1 file，16 tests，通过。
- 本地模型 Electron 定向复验：1 test，通过。
- 安全套件：1 file，25 tests，通过。
- 集成套件：4 files，71 tests，通过。
- `verify:desktop`：全 workspace TypeScript 检查通过；单元套件 131 files、2965 tests 通过；安全 25 tests 通过；集成 71 tests 通过；真实 Electron 72 tests 通过，既有 B7 长时用例 1 test 按配置跳过；退出码为 0。
- `git diff --check`：无空白错误；Windows 工作区仅显示既有 LF / CRLF 提示。

所有定向诊断和修复点均在十五分钟时间盒内取得可判定结果；最长完整 Electron 门禁约 5.6 分钟。

## 自审与边界

- 未修改 SDD ledger，未下载或伪造真实 GGUF 验收证据。
- 本地模型工具请求仍只能经过既有 codec、AgentLoop、Main 权限裁决、逐次确认和 `FileToolService`；Runtime / Provider 没有直接文件或 PowerShell 能力。
- fixture 子进程的 stdout / stderr 只被排空，不进入应用日志、Renderer 或公开状态；公开连接信息仍只存在 Main 私有对象。
- 云 Provider 档案在本地启用时保持可配置，但不会被当前本地会话调用；关闭后恢复既有云路由。
- 自动化覆盖了真实 Windows Electron 窗口和进程生命周期，但不能替代真实 GGUF 的 CPU / Vulkan 性能、显存回退、干净安装卸载与人工视觉验收；这些项目未写为通过。

## Round 1 审查修复

### 正式 Runtime 与生产依赖图

删除平行的 `MainE2eLocalModelRuntime`，Main 无论生产还是 E2E 都只实例化正式 `LocalModelRuntime`。E2E 通过动态测试装配模块注入正式 Runtime 已有的资源、进程、网络、端口和时间端口；真实走过 manifest 哈希校验、`validating`、Vulkan 探测失败、CPU 加载、健康检查、stderr 排空、精确停止及 Token 文件清理。fake server 与装配标识均不在生产 Main 静态依赖图中。

新增生产构建产物门禁并接入桌面 build；它会拒绝旧 Runtime 类、旧模块名或测试装配私有标识进入 `out/main`。package 配置测试同时以 TypeScript Program 从正式 Main 入口检查传递源码图。正式 Main 构建模块数由 134 降为 133，旧 Runtime 及其专用路径已删除。

### 路由与 mutation 证据

本地模型纵向集成改为由真实 `ModelRouter` 选择档案、真实 `ProviderRegistry` 创建正式 `LocalModelProvider` 与 OpenAI-compatible 云 Provider。云快照可选择 `cloud-primary` 并到达同源 `cloud-fallback`；启用本地 overlay 后选择 `builtin-local` 且 fallback 为空，完整创建、移动、删除链的云请求仍严格为 0。

两项 mutation 证明零云调用不是无效 fixture：移除本地 overlay 后，同一真实路由链会访问云 Provider；给本地路由加入跨 Provider fallback 并授权后，本地两次可重试失败会实际转到云 Provider。两项 mutation 均观察到 1 次真实云环回请求。

### 语义安全扫描与动态 canary

安全扫描器改为以 TypeScript Program / type checker 遍历正式 Runtime、Provider 及传递源码，检查解析后的导入、别名和构造依赖；禁止文件工具、PowerShell、授权根与 Electron 能力。对最终 `child_process.spawn` 调用按语义追踪别名、shorthand、变量初始化和调用前赋值，只有可证明 `shell:false` 且 `windowsHide:true` 才通过。mutation fixture 把安全值通过后续赋值改为危险值时稳定 RED。

正式 Runtime Electron fixture 产生真实随机 Token、动态端口、stderr canary 以及 fixture 脚本、模型、运行时、资源目录和 Token 文件绝对路径。上述值均通过真实 stderr、状态与关闭路径后，对 Main stdout/stderr、Renderer console/pageerror、公开 Runtime 状态以及关闭后的日志快照逐项扫描，均未泄漏。动态 canary 使用 16 MiB 有界完整原始流；达到上限时测试失败关闭，不以滚动日志尾部冒充完整证据。关闭本地模型后首次 PID 不存在且 Token 文件已删除；最终从 Renderer 调用正式退出入口，等待 Main `before-quit` 关闭事务自然退出，并在 fixture 临时根删除前证明最终 PID 不存在、第二次启动的新 Token 文件已删除且关闭日志无泄漏。

### Round 1 验证结果

最终实际执行：

```powershell
pnpm.cmd --dir apps/desktop exec vitest run tests/main-lifecycle.test.ts tests/package-config.test.ts
pnpm.cmd --filter @myself/desktop build
pnpm.cmd exec playwright test --config tests/playwright.config.ts --grep "内置本地模型在真实 Electron"
pnpm.cmd test:security
pnpm.cmd test:integration
pnpm.cmd verify:desktop
git diff --check
```

结果：

- Main 生命周期与生产依赖图定向测试：2 files，27 tests，通过。
- 正式 Runtime Electron 定向复验：1 test，通过。
- 安全套件：1 file，26 tests，通过。
- 集成套件：4 files，73 tests，通过。
- `verify:desktop`：全 workspace TypeScript 检查通过；单元套件 131 files、2966 tests 通过；安全 26 tests 通过；集成 73 tests 通过；真实 Electron 73 tests 通过，既有 B7 长时用例 1 test 按配置跳过；退出码为 0。
- `git diff --check`：无空白错误；Windows 工作区仅显示 LF / CRLF 提示。

Round 1 所有单点均在十五分钟内取得可判定结果；最长完整 Electron 门禁约 5.7 分钟。真实 GGUF、真实 Vulkan 性能、安装卸载和人工视觉验收仍不在本任务自动化通过范围。
