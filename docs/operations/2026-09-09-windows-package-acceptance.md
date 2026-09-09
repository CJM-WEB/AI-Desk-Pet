# 2026-09-09 Windows 安装包准备记录

## 范围与版本

- 用户要求先把本地 `main` 合并到 `AgentCoreExtension`，再生成供后续网站下载的桌宠安装包。
- 已快进合并 `1e174401` → `d8bb133e`，没有冲突。桌面端、Agent、文件工具、角色运行时和有限 OpenCode Core 的业务目录在这次合并中没有变化。
- 打包版本保持 `0.1.0-alpha.1`，Windows x64，随包携带固定 Qwen3.5-4B 与 CPU／Vulkan 运行时。
- 本轮不上传、不部署、不修改网站业务或网站发布清单。网站更新仅来自用户指定的分支合并。

## 已执行检查

| 项目 | 实际结果 |
| --- | --- |
| `pnpm.cmd install --frozen-lockfile` | 退出 0；按合并后的锁文件同步依赖，无锁文件改写 |
| `pnpm.cmd --filter @myself/desktop verify:package-config` | 修复后 20/20 通过 |
| `pnpm.cmd --filter @myself/desktop typecheck` | 退出 0 |
| `package:win` 中的资源校验与桌面生产构建 | 通过固定模型资源校验、Vite 构建、preload、MCP 和本地模型生产边界检查 |
| 首次 NSIS 编译 | 失败；压缩数据为 `2853548758` 字节，`makensis` 返回 `File: failed creating mmap` |
| 开发资源夹带回归 | 实际构建器过滤器先复现 `.electron-smoke/meta.json` 被接纳，修复后拒绝工作区开发文件并接纳 `zod`、`yauzl`、`yazl` |
| 修复后的 `electron-builder --win --dir --x64` | 两次均退出 0；最终目录为 `apps/desktop/dist/release-20260909-final/win-unpacked`，比首次干净目录额外排除了三份上游独立测试脚本 |
| 最终实际发行目录检查 | asar 14385 个条目、外部 111 个文件；检查的开发缓存、日志、测试夹具、个人配置路径均为 0，MCP SDK 条目为 0；默认角色 8 张 PNG、helper、ripgrep 与许可证存在 |
| 对实际发行目录复用 `verifyLocalModelAssets` | 退出 0；Qwen、运行时、清单及许可证的固定身份、大小与哈希一致 |

以上结果只证明本次范围，不覆盖此前整套业务门禁中的失败或未执行项目。

## 启动观察与未覆盖项

- 通过已单独验证的 Electron `--user-data-dir` 参数，在仓库忽略目录内使用全新的资料目录启动 `release-20260909-clean` 打包应用；未复制个人 Provider、API Key、对话或自定义角色。后续 `release-20260909-final` 仅多移除三份上游测试脚本，不把首次观察记作重新观察。
- 实际窗口观察到默认桌宠；内置 `llama-server.exe` 从该发行目录的 Vulkan 资源路径启动。这不等于模型对话或文件任务验收通过。
- 日志出现一条 `character:source-read` 的 `CHARACTER_INPUT_INVALID`。只读调查发现官方默认草稿使用 `idle-atlas` 等素材标识，而工作室源素材读取契约要求 UUID；这是待核对的契约差异，尚未追踪该次请求参数来确认因果。该链路未在本轮修改，也未记为通过。
- Windows 自动输入两次报告点击位置被 Codex 所属窗口覆盖；按工具规则停止重试。聊天、工作室交互和完整动画表现仍待用户人工确认。
- 对已记录 PID 与可执行路径一致的测试进程执行整树终止，随后核对测试 Main 与模型进程均不存在；用户原有开发版实例保持运行。这只证明测试清理，不证明正常退出生命周期。
- 干净 Windows 安装、卸载、更新覆盖与真实下载链路尚未执行。当前没有可交付的最终安装器，不得上传首轮失败产物。

## 当前处理

`electron-builder` 自动收集生产工作区包时，会把已经内联的 Core 源码目录再次带入，包括其开发缓存和日志。现通过发布过滤器移除 `@myself`／`@opencode-ai` 工作区副本及依赖内测试资料；可信运行资源继续从原 `extraResources` 分发。独立审核确认当前所有构建脚本没有这两个命名空间的外部导入。

现有 NSIS 的单文件体积限制与随包携带完整模型的要求冲突，参见 [NSIS 官方说明](https://nsis.sourceforge.io/I_get_an_error_when_compiling_large_installers)。已向用户提出改用 [Inno Setup](https://jrsoftware.org/isinfo.php) 生成完整离线 `.exe` 的方案，保留用户级安装、可选安装目录及卸载保留个人数据；尚待用户答复。

本轮原始命令日志与临时审计位于 `.superpowers/packaging/2026-09-09/`，它们不属于发行内容。
