# Windows 完整离线安装包：Inno Setup 调整规格

## 授权、目标与非目标

用户于 2026-09-09 回复“确认改用”，批准将本次 Windows 安装器改为 Inno Setup。交付单个 Windows x64 `.exe`，携带现有完整 Qwen 模型、CPU／Vulkan 运行时、角色及文件任务资源；用户级安装、允许选择目录、卸载保留个人数据。

此调整只替代旧 Windows 打包方案中的 NSIS 安装器及其正式构建入口，不改变桌宠功能、模型版本、资源白名单或业务协议。不上传网站、不修改网站发布清单、不推送 Git。干净环境安装卸载与跨安装器升级未观察前不得记为通过。

## 现状证据

- `main` 已无冲突快进合并入 `AgentCoreExtension`，合并结果为 `d8bb133e`。
- 原 NSIS 压缩数据为 2853548758 字节，编译报 `File: failed creating mmap`。完整 Qwen 文件本身为 2740937888 字节；继续使用旧安装器无法满足本次单文件目标。
- `d38118db` 已修复工作区源码、开发缓存与测试资料被重复夹带的问题；实际 `win-unpacked` 审计通过，既有资源校验与生产构建通过。详细证据见同日安装包验收记录。

## 方案与数据流

保留现有 `verify:local-model-assets → build → electron-builder --dir --x64`，让 electron-builder 继续负责 Electron 发行目录、asar 与资源过滤；随后调用官方 Inno Setup 7.1.0 x64 编译器，将这个固定发行目录装入单个安装器。正式 `package:win` 不再调用 NSIS，也不自动发布。

桌面专用 `.iss` 只读取编译参数指定的 `win-unpacked`；版本从桌面 `package.json` 获取，输出名称为 `AI-Pet-${version}-windows-x64.exe`。构建脚本通过独立参数调用编译器，不拼接可执行 shell 文本；缺失编译器、资源或编译失败时退出非零。

安装器使用稳定 AppId `com.myself.desktop`、`PrivilegesRequired=lowest`，默认目录 `{localappdata}\Programs\AI Pet`，显示目录选择页，创建开始菜单入口并提供桌面快捷方式。采用 x64 安装器、关闭分卷，不在安装期间联网拉取模型。安装器不强制结束运行中的桌宠。

## 安全、隐私与兼容

- 桌宠与网站业务隔离，保留现有资源与依赖过滤；本轮不修改根锁文件及网站依赖。
- 安装输入只来自正式发行目录；用户配置、API Key、对话、授权目录、开发日志与测试资料不作为额外安装资源。
- 卸载仅移除安装器登记的应用文件和快捷方式，不编写删除个人 AppData 的逻辑。
- 原 NSIS 与新 Inno 的卸载注册不同；不宣称可自动迁移旧安装器。提供旧安装版先退出并卸载、保留个人数据后再安装的说明；本轮不实现迁移框架。
- 官方编译器固定到 7.1.0 x64，下载后核对 GitHub 发布的 SHA256 与有效 Authenticode 签名。工具安装到本次构建专用忽略目录。编译器不属于桌宠运行依赖。
- 当前没有产品签名证书，最终安装包按未签名 Alpha 交付并明确说明，不冒称正式签名版。

## 验证与交付

先更新打包契约的最小失败测试，再替换 NSIS 入口与安装器，运行定向打包测试及桌面 typecheck。执行真实正式打包命令，对发行目录复用已有资源审计与固定模型校验，确认单文件完整编译完成，记录大小和 SHA256。提供中文构建／安装说明、最终安装器与校验文件。只对实际观察过的窗口或安装步骤给出通过结论。

参考：[Inno Setup 官方下载](https://jrsoftware.org/isdl.php)、[固定版本发布](https://github.com/jrsoftware/issrc/releases/tag/is-7_1_0)、[安装器架构](https://jrsoftware.org/ishelp/topic_setup_setuparchitecture.htm)、[单文件与分卷](https://jrsoftware.org/ishelp/topic_setup_diskspanning.htm)。
