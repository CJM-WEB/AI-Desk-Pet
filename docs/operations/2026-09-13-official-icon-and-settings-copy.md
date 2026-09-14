# 官方图标与设置文案替换验收

日期：2026-09-13。环境：Windows，当前桌面端工作区。

## 修改范围

- 内置模型标题保持“内置本地模型”，说明改为“开启期间聊天和 Agent 不调用云模型，无需API KEY”。删除重复说明，保留开关、运行状态、故障与重试反馈。
- 官方源图为用户指定的 `D:/Python/Important/myself/apps/website/public/AP.png`，与仓库 `apps/website/public/AP.png` 字节一致，SHA-256 为 `63670f316498b5dadbe08d4aff9dea5d10304e4b3ea996c22381e15db9b60d7d`。
- 使用现有 Pillow 转换：裁去透明留白，保持标志颜色与比例；1024 像素画布上添加浅色圆角底板，标志最大边 832 像素，居中并以 Lanczos 缩放。替换原 `apps/desktop/resources/icon.ico`，包含 16、20、24、32、40、48、64、128、256 像素九档资源。
- 所有正式窗口（含重新创建的窗口）、托盘和 Renderer 页面图标共用该 ICO。发行资源额外携带 ICO；打包仅禁用签名，保留 EXE 图标资源写入。
- 原 Inno `SetupIconFile` 已引用同一 ICO，覆盖安装器和卸载器；桌面／开始菜单快捷方式及应用卸载列表使用应用 EXE 图标。依据 [Electron 图标格式文档](https://www.electronjs.org/docs/latest/api/native-image)、现有 electron-builder 26.15.3 的 `winPackager.js` 和 [Inno SetupIconFile 文档](https://jrsoftware.org/ishelp/topic_setup_setupiconfile.htm)。未修改网站、角色素材、模型或业务逻辑。

## 实际验证

- `pnpm.cmd --filter @myself/desktop test tests/package-config.test.ts tests/window-security.test.ts tests/window-commands.test.ts`：44 项通过。更新既有打包断言后先复现旧配置禁用图标写入的失败，修改配置后通过。
- `pnpm.cmd --filter @myself/desktop test tests/windows-installer.test.ts`：7 项通过。
- 在 `apps/desktop` 中执行 `pnpm.cmd exec vitest run --config vitest.config.ts tests/multi-provider-settings.test.tsx`：13 项通过。首次组件测试命令误选全套测试，发现后中止；该中止不记为通过，也未据此修改无关代码。
- `pnpm.cmd --filter @myself/desktop typecheck` 与 `pnpm.cmd --filter @myself/desktop build`：退出 0；favicon 随 Renderer 构建输出，生产边界检查通过。第三方构建提示保持原样。
- 实际 Electron 执行正式入口中的图标初始化片段：隐藏窗口调用原生 `setIcon` 成功，ICO 解码为 256 × 256，托盘创建并清理成功。
- 复用现有构建器的 `editWindowsResources` 向 Electron EXE 验证副本写入图标，读回 PE 资源确认唯一图标组内九档图像均与源 ICO 字节一致；验证副本已删除。
- 已查看转换后的图标预览；`git diff --check` 通过。

## 未覆盖项

本次没有重打完整离线安装包、安装或覆盖用户现有安装。开发版需重新启动；安装版图标需使用后续重新打包的版本。真实任务栏／托盘不同 DPI 外观与 Windows 图标缓存刷新仍待用户人工确认。
