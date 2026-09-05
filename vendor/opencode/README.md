# 有限 OpenCode Core 嵌入

来源：`https://github.com/anomalyco/opencode`，固定提交 `2a6be0a03b93a6734070e10a6c3b56863475f214`。许可证见 [LICENSE](LICENSE)。本目录只服务 AI Pet 的文件任务核心，不是完整 OpenCode 产品。

## 来源与重建

`sources.json` 记录每个上游源文件路径、原 SHA-256、本地 SHA-256、原包清单指纹和固定直接依赖。`local-patches.json` 保存有限修改的精确替换片段及原因；提取脚本校验上游指纹，并拒绝覆盖未记录的本地改动。当前提取 276 个源文件，修改 15 个上游文件。

从仓库根目录运行：

```powershell
node packages/coding-task-core/extract-upstream.cjs
pnpm.cmd install --frozen-lockfile --ignore-scripts
node packages/coding-task-core/build-windows-helper.cjs
pnpm.cmd --filter @myself/coding-task-core typecheck
pnpm.cmd --filter @myself/coding-task-core test
node packages/coding-task-core/run-electron-tests.cjs
```

提取脚本只读本地 `D:/AgentLearning` 固定提交，根据真实适配入口的静态导入、数据库字面量动态迁移导入和五个类型门面生成闭包。修改入口或上游副本后先更新有据可查的补丁，再重算闭包。脚本不自动删除旧文件。

## 保留与适配

- 保留原会话 runner、协调器、事件/存储/投影及 Node SQLite；权限、文件工具和进程的窄适配见下文及补丁清单。
- Global 移除导入时的目录创建和全局锁设置，新增宿主显式任务目录初始化；Windows 默认 XDG 路径为空时只计算临时目录候选，不进行隐式写入。
- LocationServiceMap 的类型范围缩到当前目录和禁用快照，不导入产品全图。
- Image 明确禁用 Bun 专用 Photon 转换器，保持原 `ResizerUnavailableError` 回退契约。本次只验收文本读取，不声明图片转换能力。
- 装配原 read、glob、grep、write、edit、apply_patch、bash、todowrite。插件、MCP、技能发现、外部指令发现、LSP、PTY、后台命令与全产品服务图不装配。源码中由静态类型/Schema依赖带入的产品配置定义不代表运行能力已开启。
- 每实例独立内存数据库、任务 Agent 和 Session。只暴露 `once/reject`，不启用项目持久化 `always` 授权；输出落盘位于独立任务数据子目录，close 清理该子目录。

## 类型与打包

`build-types.cjs` 先使用上游的 strict、`noUncheckedIndexedAccess: false`、`exactOptionalPropertyTypes: false` 检查全部提取源码，再按本仓库全部 strict 选项检查宿主源码和测试的所有诊断。只生成 AI Pet 公共入口的声明，声明不引用 vendor 类型。未跳过上游语义检查，也未放宽宿主诊断。

上游自引用命名空间和匿名 Effect Schema 类不支持直接全量声明导出，因此不生成/分发完整 vendor 声明包。`.d.ts` 与本地打包验收目录为可再生产物，不纳入来源源码。

Electron 验收使用桌面已安装的 Electron 二进制，先将真实入口及依赖打为单个 Node ESM，再运行同一套真实文件/SSE集成测试。esbuild 必须优先 `module` 再 `main`：jsonc-parser 的 UMD 入口带动态相对 require，直接捆绑 UMD 会产生缺失的 `./impl/format`。所有数据库迁移已编入产物，不依赖原上游目录。

## 直接依赖用途

| 固定依赖 | 必要职责 |
| --- | --- |
| effect 4.0.0-beta.83 | 原核心服务、Schema、事件流、取消与任务生命周期 |
| @effect/platform-node 4.0.0-beta.83 | 原 Node 文件系统、路径、HTTP/进程适配所需静态模块 |
| drizzle-orm 1.0.0-rc.2 | 原数据库表、查询和 Node SQLite 驱动 |
| @opencode-ai/effect-drizzle-sqlite（本地固定提交） | 原 Effect/Drizzle桥接 |
| @opencode-ai/llm、@opencode-ai/schema（本地固定提交） | 模型协议和原始共享Schema |
| immer 11.1.4 | 原模型参数派生 |
| jsonc-parser 3.3.1、gray-matter 4.0.3 | 静态配置/Markdown解析依赖；配置发现未启用 |
| mime-types 3.0.2 | 原 read 文件 MIME识别 |
| glob 13.0.5、minimatch 10.2.5、fuzzysort 3.1.0 | 原文件/配置模块依赖；搜索执行保留原 rg 服务 |
| cross-spawn 7.0.6、which 6.0.1 | 原 POSIX 进程适配与固定 shell 解析；Windows 执行由 Job 服务替换 |
| xdg-basedir 5.1.0 | 原 Global默认路径计算，宿主用显式任务路径替换 |
| @types/bun 1.3.13 | 未装配技能发现代码的原 Bun类型引用，仅开发期 |
| @types/cross-spawn 6.0.6、@types/mime-types 3.0.1、@types/which 3.0.4 | 上述原模块的开发期类型检查 |

新增固定 diff 8.0.2 仅供原 edit/apply_patch 生成差异；宿主直接声明 @effect/platform-node 4.0.0-beta.83 复用原流转换。没有安装 effect-sqlite-node、Photon、PTY、OpenCode插件或AI SDK Provider产品集合。Effect上游补丁只涉及未使用的 HttpApi OpenAPI/SSE Schema，不属于当前调用闭包，因此未应用。

## 任务范围与文件边界

宿主 `CodingSessionOptions` 提供任务真实目录、`approvedCommands`、固定 `commandShell`、可选 `trashFile`、`windowsJobHelper`、`ripgrepExecutable`。两个可执行程序参数均为 `{ executablePath, sha256 }`，只接收宿主可信输入；模型工具 Schema 不包含这些字段。

原 PermissionV2 为唯一裁决服务。每任务内存 Agent 允许普通读取、搜索、创建和精确编辑；覆盖、删除、外部目录、未批准命令等待一次许可。命令资源是固定 shell、真实 cwd、完整原命令 JSON 元组的 SHA-256；命令中的星号、问号、拼接和换行不能扩张许可。只暴露 once/reject，拒绝只结算对应调用，并作为失败工具结果返回原 runner。

原 write 在覆盖许可前读取旧字节，批准后用原 writeIfUnchanged 检查冲突；新文件用原 create 的排他创建。apply_patch 在所有目标批准后才应用，删除仅支持一个普通文件并只调用宿主回收站；缺回调或多文件删除拒绝。补丁仍顺序应用，不声明跨文件原子回滚。

LocationMutation 与 FileMutation 提交边界统一复用 file-tools 的纯系统/私有路径保护；不调用 FileToolService 或旧 AgentLoop。拒绝 UNC、设备、ADS、相对越界、链接和 Junction，许可等待后的路径会重新检查。原 rg 不跟随链接；递归搜索把同一私有保护集合转成优先排除参数，避免先读取私有正文再过滤。保留原精确匹配和冲突语义。

## Windows 命令与可信程序

保留原 AppProcess 和 bash。PowerShell 参数接缝来自同一固定提交 `packages/opencode/src/tool/shell.ts` 的 `cmd()` 分支（MIT）；设置标准流为 UTF-8 以匹配原 AppProcess 解码。cmd 保留 `/d /s /c` 受控启动。普通目标命令可以访问宿主用户有权访问的资源；任务许可与 Job 都不是 OS 沙箱。

Windows 底层替换为本包 `windows-job-spawner.ts` 和构建期编译的 `native/windows-job-helper.cs`。helper 使用 Windows 10 的创建属性 JOB_LIST，在目标开始运行前绑定匿名 Job；HANDLE_LIST 仅继承目标标准流，Job 句柄不继承。KILL_ON_JOB_CLOSE 兜底，取消、超时与根进程先退出均用同一个 Job 句柄终止后代，查询 ActiveProcesses 归零后结算。控制管道具当前用户 ACL、随机名称、大小/时间/顺序上限，独立于 stdout/stderr；目标 stdin 为 NUL。隐藏窗口生效的代码参数已验证，窗口实际视觉仍待人工验收。

原 Effect timeout/race 会遮蔽 Scope 释放缺陷；process.ts 的最小补丁保留并恢复该 Cause。adapter 不使用原吞错 finalizer，不从退出父 PID 重建归属。helper 异常、控制损坏、Job API 失败和未观察到归零都会明确失败，宿主会话不能继续启动命令。close 等待原执行链停止，清理失败缓存到重复 close；初始化/释放失败仍尝试删除本实例目录。

helper 只在构建机编译，生成 `dist/windows-job-helper.exe` 与 JSON SHA-256 清单；目标机无需编译。运行前每次验证宿主给定文件和哈希，缺失或不符拒绝执行，不回退无 Job 进程。rg 同样由宿主提供固定文件与哈希；替换原 RipgrepBinary.node，不装配其 PATH 探测或联网下载服务，保留原 Ripgrep.Service 与 AppProcess。测试默认读取 `packages/coding-task-core/dist/rg.exe`（可用 `CODING_TEST_RIPGREP` 显式覆盖），准备官方固定二进制与打包由桌面接入任务负责。

Job API 设计依据为微软 [Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)、[创建属性](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute) 与 [活动进程计数](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_accounting_information)。参考微软 hcsshim `aad63033893a51e34f6879e51bedc4a754f286d9` 的 Job 生命周期结构，没有复制其 Go 代码。WMI、服务、提权代理等代为创建的进程不能据此宣称受 Job 约束。

## 验证边界

2026-09-05 在本机真实磁盘和 Windows 进程上使用 HTTP/SSE 模型夹具验证工具全链、改测修复、权限拒绝/失效/冲突、进程树取消/超时/父先退出、Job API 故障、helper 崩溃、双 Job 隔离及输出上限。会话终态只表示原 runner 停止；命令退出事实单独投影，修复成功不会继承历史失败。公开工具事件只保留有限事实，权限 metadata 供 Main 私有消费，不直接转发整份原事件。

真实 DeepSeek/Qwen、Electron Main 分发路径、资源管理器回收站、Windows 窗口可见性、干净安装机运行时和桌面退出验收由后续桌面接入提供证据；本包的自动化测试不代替这些人工和集成验收。所有 Git 操作只读；网站、CloudBase、扫描器既有锁文件依赖图保持 HEAD 原内容。
