# 2026-09-09 Windows 安装包构建与验收记录

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
- 干净 Windows 安装、卸载、更新覆盖与真实下载链路尚未执行。该 NSIS 阶段没有形成可交付安装器；后续 Inno 最终产物见下节，首轮失败产物不属于交付内容。

## 当前处理

`electron-builder` 自动收集生产工作区包时，会把已经内联的 Core 源码目录再次带入，包括其开发缓存和日志。现通过发布过滤器移除 `@myself`／`@opencode-ai` 工作区副本及依赖内测试资料；可信运行资源继续从原 `extraResources` 分发。独立审核确认当前所有构建脚本没有这两个命名空间的外部导入。

现有 NSIS 的单文件体积限制与随包携带完整模型的要求冲突，参见 [NSIS 官方说明](https://nsis.sourceforge.io/I_get_an_error_when_compiling_large_installers)。用户已回复“确认改用”，批准使用 [Inno Setup](https://jrsoftware.org/isinfo.php) 生成完整离线 `.exe`，保留用户级安装、可选安装目录及卸载保留个人数据。对应[调整规格](../superpowers/specs/2026-09-09-inno-offline-installer-design.md)与[实施计划](../superpowers/plans/2026-09-09-inno-offline-installer.md)已落盘。

## Inno 编译器准备

- 从 [Inno Setup 官方固定发布](https://github.com/jrsoftware/issrc/releases/tag/is-7_1_0) 下载 `innosetup-7.1.0-x64.exe`，大小 14304168 字节。
- SHA256 为 `0362a383ed217d4c4239b5933866dd96d3eb2102737da92f80f6057a4b40df2f`，与 GitHub 该资产公布的 digest 一致；Authenticode 状态为 `Valid`，签名主体为 `Pyrsys B.V.`。
- 编译器按用户级安装到本次忽略目录 `tooling/inno-7.1.0`，安装退出 0，无需重启。它不属于最终桌宠运行资源。
- 网站发布清单只要求正整数 `sizeBytes`，无 2 GB 上限；现有版本与文件名契约兼容本次产物。本轮未改写网站清单或发布工具。

## 最终 Inno 产物与实际验证

| 项目 | 实际结果 |
| --- | --- |
| 新安装器配置测试 | `verify:package-config` 20/20 通过；覆盖 x64、Windows 10、用户级安装、卸载保护及隐藏无效菜单目录页 |
| 安装器构建脚本测试 | `windows-installer.test.ts` 7/7 通过；覆盖绝对文件路径、缺少资源、编译失败、缺少新输出及旧产物误报 |
| 桌面 typecheck | 退出 0；后续只调整 ISS、配置测试和说明，没有改动 TypeScript 业务或构建脚本 |
| 第一次完整正式命令 | `pnpm.cmd --filter @myself/desktop package:win` 退出 0，2026-09-09 10:01:48—10:11:50；模型校验、可信资源准备、生产构建、发行目录及 Inno 编译均完成 |
| 实际发行目录核验 | `dist/win-unpacked` 为 111 个外部文件、3396311045 字节；asar 14385 个条目，禁入资料 0、MCP SDK 0，入口、默认角色 8 张 PNG、helper、ripgrep 与许可证存在 |
| 输入发行目录模型核验 | 对上述实际目录运行 `verifyLocalModelAssets`，退出 0，固定 Qwen、CPU／Vulkan 和许可证一致 |
| 首轮安装向导观察 | 中文向导可以打开并更改安装目录；发现未被固定快捷方式使用的 `(Default)` 菜单目录页，随后取消，未执行安装 |
| 界面修正与限定复核 | `2df8cc6b` 隐藏无效菜单目录页，改用 `lzma2/normal`；定向测试和独立限定复核通过，无新增问题 |
| 最终封装 | 复用已验证的 `win-unpacked`，运行 `node apps/desktop/scripts/build-windows-installer.mjs`，退出 0；10:16:49—10:22:41，未重复构建应用或变更输入资源 |
| 最终可执行文件 | PE 标记有效，Machine 为 `0x8664`（AMD64），安装器数量为 1，Authenticode 为 `NotSigned` |
| 最终窗口观察 | 实际打开最终文件，修改目录，下一步直接进入“准备安装”，不再出现菜单占位页面；日志确认 Inno 7.1.0 64-bit、非管理员安装模式、HKCU、64 位安装模式 |
| 预览结束 | 在真正安装前取消，日志记录退出；安装器进程为 0，测试目标目录和应用 Inno 卸载注册项均不存在 |

最终文件：

- [Windows x64 安装包](../../apps/desktop/dist/AI-Pet-0.1.0-alpha.1-windows-x64.exe)
- 大小：`2855778466` 字节，约 2.86 GB（2.66 GiB）。
- SHA256：`14163215f587962301ae88b336852ef1372eee64a092052b46de96c7341867ee`。
- [校验文件](../../apps/desktop/dist/AI-Pet-0.1.0-alpha.1-windows-x64.exe.sha256)、[构建元数据](../../apps/desktop/dist/release-artifact.json)、[安装与上传说明](../../apps/desktop/dist/安装与上传说明.md)。这些是本地生成产物，未提交 Git、未上传网站。
- 应用发行目录来源：`5e7f83da6fc6335224d801317632c08d87cb2811`；最终安装脚本来源：`2df8cc6bd2bbace35a1b641dc60e8d788fee282d`。两者之间只有安装器、对应配置测试与构建说明变化。

整体代码审核及最终修复波复核均无未决问题。生成过程保留了依赖自带的 `eval`、`use client`、缺少 author、非 Windows 可选二进制和可执行资源编辑关闭等既有构建提示，未将日志描述为无警告。

本次结论为：**安装包生成与校验自动化通过，安装向导实际窗口观察通过**。输入资源审计不等于安装解包后的实机验收；**干净 Windows 安装、卸载保留数据、跨安装器升级、完整桌宠交互及真实网站下载仍待用户人工确认**。此前记录的角色素材读取异常未在本次打包中修复或宣布通过。网站业务、根锁文件和发布清单在 `d8bb133e` 之后没有改动；未 push。

本轮原始命令日志与临时审计位于 `.superpowers/packaging/2026-09-09/`，它们不属于发行内容。

## 后续官网下载接入

2026-09-09，用户另行要求把现有安装包挂到官网，并同意免费环境仅供少量测试。最终产物已接入官网 Windows 下载按钮，完整 HTTPS 下载的大小和 SHA-256 与本记录一致，线上入口实际浏览器观察通过，见 [官网下载接入验收](2026-09-09-website-installer-download.md)。上文“未上传”和“真实网站下载待确认”保留为打包阶段的历史状态；当前下载状态以该后续记录为准。干净环境安装、卸载和升级的人工验收仍未完成。
