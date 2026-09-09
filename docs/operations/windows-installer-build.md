# Windows 离线安装包构建说明

## 构建器来源

正式安装器使用 Inno Setup 7.1.0 x64 的官方命令行编译器 `ISCC.exe`。编译器应从 Inno Setup 官方发行渠道取得，并在使用前验证安装程序 SHA256 为 `0362a383ed217d4c4239b5933866dd96d3eb2102737da92f80f6057a4b40df2f`，同时验证 Authenticode 签名有效且签名者为 `Pyrsys B.V.`。编译器属于本机构建工具，不加入项目依赖，也不随应用分发。

## 构建命令

先将 `AI_PET_ISCC` 设置为已验证的 `ISCC.exe` 绝对路径，再从仓库根目录执行：

```powershell
$env:AI_PET_ISCC = 'C:\path\to\Inno Setup 7\ISCC.exe'
pnpm.cmd --filter @myself/desktop package:win
```

正式入口依次校验完整本地模型、执行生产构建、由 `electron-builder` 生成 `dist/win-unpacked` 完整发行目录，再调用 Inno Setup 将整个目录递归封装。构建过程不联网下载编译器。

输出文件为 `apps/desktop/dist/AI-Pet-0.1.0-alpha.1-windows-x64.exe`。这是包含应用、完整本地模型与许可文件的单个离线安装程序，不生成分卷；交付前应核对目录内容、安装器数量、文件大小和 SHA256。

## 安装与卸载注意事项

- 安装器面向 Windows 10/11 x64，默认安装到当前用户的 `%LOCALAPPDATA%\Programs\AI Pet`，无需管理员权限，并允许用户选择其他目录。
- 安装器创建开始菜单和桌面快捷方式。静默安装完成后不会自动启动桌宠。
- 安装和升级不会强制结束正在运行的桌宠；若目标文件被占用，应由用户自行退出桌宠后重试。
- 卸载只移除安装目录与快捷方式，不删除 `%APPDATA%` 或 `%LOCALAPPDATA%` 中的个人角色、设置、会话及其他用户数据。
- 干净环境安装、升级、运行中重装和卸载后的数据保留仍需在真实 Windows 环境人工确认，未观察前不得记录为通过。
