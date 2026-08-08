# Task 2：独立 HabitatStore 与目录选择策略报告

## 提交

- 提交 hash：`be3088c6fc50f63805183905f0a7af17037be962`
- 提交信息：`feat: 保存独立目录空间授权`
- 基线：`c0031926f3b345aa7cc2b3beb75169edbb7c827e`

## RED 记录

### 初始模块缺失

命令：

    pnpm.cmd --filter @myself/desktop exec vitest run --config vitest.config.ts tests/pet-habitat-store.test.ts tests/habitat-directory-policy.test.ts

结果：`2` 个测试文件失败，退出码 `1`。两个失败分别是：

- 无法找到 `../src/main/habitat/pet-habitat-store`。
- 无法找到 `../src/main/habitat/habitat-directory-policy`。

这是正确 RED：两份测试文件已经先建立，但两个生产模块尚不存在，不是测试拼写、夹具或环境错误。

### 固定磁盘分类补充 RED

命令：

    pnpm.cmd --filter @myself/desktop exec vitest run --config vitest.config.ts tests/habitat-directory-policy.test.ts

结果：`10` 项中 `3` 项失败，退出码 `1`。`network`、`removable`、`cloud-placeholder` 三种首版不支持类型均被当前实现错误授权，证明补充测试实际覆盖拒绝分支。

实现探针后的首次运行暴露两个真实适配问题：Windows PowerShell 5 会把 `-Command` 后续路径拼入命令文本；263 字符路径又触发旧 .NET 路径限制。修复分别改为子进程专用环境变量传路径，以及仅在属性读取时使用 `\\?\` 扩展路径。未修改测试预期绕过问题。

## GREEN 验证

### 精确专项

命令：

    pnpm.cmd --filter @myself/desktop exec vitest run --config vitest.config.ts tests/habitat-directory-policy.test.ts tests/pet-habitat-store.test.ts

结果：`2` 个测试文件、`18/18` 项通过。

覆盖内容：

- Store 缺失安全默认值、损坏隔离、原子失败保留旧版本、跨实例并发顺序。
- 重启恢复 folder、进入前桌面坐标、localOffset 与目录身份。
- Renderer 投影移除 absolutePath、dev、ino 与进入前桌面坐标。
- 清配置不触碰目标目录；Store 私有父目录身份变化失败关闭。
- 目录必须是稳定普通目录；拒绝根、保护目录、UNC、链接/Junction、网络盘、可移动盘和云占位。
- 目录替换、删除、权限拒绝、身份冲突与双采样 TOCTOU 失败关闭。
- 同一真实目录拒绝重复，名称前缀相似的不同目录不误判。

### brief 原命令与 Desktop 全量

命令：

    pnpm.cmd --filter @myself/desktop test -- pet-habitat-store.test.ts habitat-directory-policy.test.ts

该仓库的 package script 会把额外 `--` 原样传给 Vitest，因此此命令实际执行 Desktop 全量套件。最终结果：

- `68/68` 个测试文件通过。
- `1297` 项通过，`14` 项跳过，共 `1311` 项。
- 退出码 `0`。

命令：

    pnpm.cmd --filter @myself/desktop typecheck

结果：`tsc --noEmit` 通过，退出码 `0`。

同时执行 `git diff --cached --check`，无空白错误。

## 修改文件

- `apps/desktop/src/main/habitat/pet-habitat-store.ts`
- `apps/desktop/src/main/habitat/habitat-directory-policy.ts`
- `apps/desktop/tests/pet-habitat-store.test.ts`
- `apps/desktop/tests/habitat-directory-policy.test.ts`

未修改 Renderer、Preload、Agent、Website、Task 0 Explorer、window manager、electron-builder 或 package 配置。工作树原有的 `apps/desktop/electron-builder.yml` 与 `apps/desktop/tests/package-config.test.ts` 修改未暂存、未进入提交。

## 隐私与稳定持久化证明

- 私有文件固定为严格 `version: 1` 结构，只允许 preferences、directories 与 desktop/folder 二选一 location。
- Schema 为 strict，不接受 Explorer HWND、矩形、前台应用、播放令牌、桥接序号或过渡态。
- Renderer 投影只返回自动藏身设置、公开目录提示、启用状态、availability 和不透明目录 ID；不返回绝对路径、dev、ino、进入前桌面坐标或其他配置目录。
- `pathHint` 只取真实目录末级名称并限制为 80 个 Unicode 字符，不构造可逆完整路径。
- Windows 卷类型与属性探针通过 `execFile` 无 shell 执行；绝对路径只进入 Main 子进程专用环境变量，不写 stdout、日志或 Renderer DTO。探针超时、输出异常或不可用时按 unsupported 失败关闭。

## TOCTOU 与目录身份证明

- 授权与可用性复核均执行两轮 `realpath/lstat/stat`，比较真实路径与 dev/ino。
- lstat/stat 必须同时为目录、不得是符号链接，且两者 dev/ino 必须一致。
- 两轮之间任何真实路径或身份变化返回 `HABITAT_DIRECTORY_CHANGED`；删除、权限拒绝和读取失败返回不可用。
- Store 写入前后复核私有父目录的 realpath、lstat/stat 类型与 dev/ino；父目录替换返回 `HABITAT_STORAGE_CHANGED`。
- Store 使用现有 `enqueueFileOperation` 与 `atomicWriteText`，跨实例同文件写入按调用顺序串行；临时写失败不会替换上一版本。

## 不读取或修改目标目录证明

- 目录策略生产文件没有导入或调用 `readdir`、`readFile`、`writeFile`、`rm`、`unlink`、`rename` 或 `mkdir`。
- 目标目录操作仅为双次 `realpath/lstat/stat`、身份比较，以及 Windows 卷类型和文件属性元数据查询。
- 链接目标与清除配置测试均放置 marker，验证 marker 内容和目录条目保持不变。
- 损坏 Store 只重命名私有 `habitat.json` 为唯一 `.corrupt-*` 文件；不会扫描、搜索、删除或修复任何配置目标。
- `clear()` 只以安全默认快照原子重写 HabitatStore，不删除、重命名或写入目标目录。

## 自审结论与 concerns

- 已按最小范围实现两个生产模块和两份测试，没有接入 dialog、IPC 或 Main 组合，也没有触碰 Task 3+。
- 固定磁盘判定依赖 Windows 内置 PowerShell/.NET 的 `DriveInfo` 与 `FileAttributes`。这是只读、超时、失败关闭边界；如果未来运行环境移除 Windows PowerShell，目录授权会明确拒绝而不是降级猜测。
- 无其他已知 correctness、隐私或数据破坏 concern。

## 修复轮 1：公开名称不变量与父目录竞争

### RED 证据

命令：

    pnpm.cmd --filter @myself/desktop exec vitest run --config vitest.config.ts tests/pet-habitat-store.test.ts tests/habitat-directory-policy.test.ts

结果：`25` 项中 `7` 项正确失败，`18` 项通过，退出码 `1`。失败分布为：

- `5` 个恶意磁盘 `pathHint`（含正反斜杠、冒号、`.` 和 `..`）未被隔离。
- `41` 个 emoji 被 Zod 按 UTF-16 代码单元误判为超过 `80`。
- 私有父目录替换后，保存错误覆盖了替代父目录中无关的 `habitat.json`。

将竞争检查点进一步精确为“暂存完成、提交前”的 `before-commit` 后，旧实现的单项测试仍正确 RED：保存错误成功，未触发父目录替换与拒绝分支。

独立审查后又补充两组 RED：

- Policy 对 `bad:name` 与经 NFKC 变成冒号的 `bad：name` 均错误授权，`2/2` 项错误 resolve，证明 Policy 与 Store 的严格 `pathHint` 口径尚未共享。
- 提交前父路径分别产生 `ENOENT`、`ENOTDIR` 时，旧实现均误报 `HABITAT_STORAGE_FAILED`；两项测试要求稳定的 `HABITAT_STORAGE_CHANGED` 并核对旧父目录上一版本字节。

### 最小修复

- Store 的 `displayName` 与 `pathHint` 统一按 `Array.from(value)` 计算 Unicode 码点，范围固定为 `1..80`；Policy 与 Store 共享同一公开名和 `pathHint` 谓词并继续按码点截断。
- `pathHint` 统一拒绝 `.`、`..`、正反斜杠与冒号，只接受单一末级显示名；NFKC 后产生禁用字符的 Policy 结果同样拒绝。磁盘非法记录继续走既有损坏隔离与安全默认分支，公开投影不返回恶意内容。
- Store 保存改为“捕获父身份 → 写 UUID 唯一暂存文件 → 记录暂存 dev/ino → `before-commit` → 最后复核父身份与暂存身份 → 仅重命名本方暂存文件”。
- 删除提交后的失败检查点，避免最终文件已经提交后再返回 `HABITAT_STORAGE_CHANGED`。失败清理仅在父目录身份和暂存文件 dev/ino 均仍匹配时删除；无法复核时保守保留，不删除替代项。
- 保存期间明确出现的 `ENOENT`、`ENOTDIR` 命名空间变化稳定映射为 `HABITAT_STORAGE_CHANGED`，其他 I/O 错误仍映射为 `HABITAT_STORAGE_FAILED`。

### GREEN 与回归验证

精确专项：

    pnpm.cmd --filter @myself/desktop exec vitest run --config vitest.config.ts tests/pet-habitat-store.test.ts tests/habitat-directory-policy.test.ts

结果：`2/2` 个测试文件、`29/29` 项通过，退出码 `0`。

Desktop 默认并行全量的唯一失败始终是同一个无关导出测试受资源争用影响，分别在 `5019ms`、`5032ms` 命中 `5000ms` 超时；该用例单独复跑均 `1/1` 通过，最终一次耗时约 `579ms`，未修改或放宽测试。随后以 `--maxWorkers=4` 降低并行争用并完整执行全部 Desktop 测试：

- `68/68` 个测试文件通过。
- `1308` 项通过，`14` 项跳过，共 `1322` 项。
- 退出码 `0`。

命令：

    pnpm.cmd --filter @myself/desktop typecheck

结果：`tsc --noEmit` 通过，退出码 `0`。相关文件 `git diff --check` 同样退出 `0`。

### 范围与 concerns

- 修复只涉及 Habitat Store、目录策略、两份专项测试和本报告；未修改 PowerShell 卷探针、Task 3+、Website、Renderer、Preload、Agent、Main 组合、electron-builder 或 package 配置。
- 工作树原有的 `apps/desktop/electron-builder.yml` 与 `apps/desktop/tests/package-config.test.ts` 状态不属于本修复，不进入修复提交。
- Node 提供的是路径式 `rename`，不存在可供此处使用的目录句柄式 `renameat`。当前实现关闭了全部可控检查点，并保证常规父目录替换时源暂存路径缺失、不会覆盖替代父目录既有文件；仍依赖不可预测 UUID 防止外部进程在最后一次身份复核与 `rename` 之间主动伪造同名暂存文件。
