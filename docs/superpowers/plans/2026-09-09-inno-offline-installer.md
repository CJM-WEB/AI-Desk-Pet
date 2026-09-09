# Inno 完整离线安装包实施计划

> **执行要求：** 使用 subagent-driven-development 执行有边界的实现任务；用户已批准方案及本地 Git 提交，无需重复询问。

**目标：** 产出随包携带完整 Qwen 的 Windows x64 单文件离线安装器。

**架构：** 现有 electron-builder 生成发行目录，Inno Setup 7.1.0 x64 封装安装器。现有生产资源过滤与校验保持有效，业务代码不变。

**技术栈：** Node.js、Electron、electron-builder、Inno Setup、Vitest、PowerShell。

## Global Constraints

- 规格：`docs/superpowers/specs/2026-09-09-inno-offline-installer-design.md`；用户已明确批准。
- 版本保持 `0.1.0-alpha.1`，输出 `AI-Pet-0.1.0-alpha.1-windows-x64.exe`，完整模型离线随包。
- 用户级安装、可选安装目录、卸载保留个人数据，禁止强制结束正在运行的桌宠。
- 不修改桌面业务代码、网站业务、根锁文件，不上传、不部署、不 push。
- 中文文档和结构性注释；保留现有资源白名单；正式入口仅使用 Inno 安装器。

### Task 1: 替换安装器并验证正式打包链路

**文件：**
- 修改 `apps/desktop/package.json`、`apps/desktop/electron-builder.yml`、`apps/desktop/tests/package-config.test.ts`。
- 新建 `apps/desktop/scripts/build-windows-installer.mjs`、`apps/desktop/resources/windows/installer.iss`。
- 需要行为测试时新建 `apps/desktop/tests/windows-installer.test.ts`。
- 新建中文 `docs/operations/windows-installer-build.md`，说明构建器来源、命令、输出和安装注意事项。
- 验收记录 `docs/operations/2026-09-09-windows-package-acceptance.md` 由主智能体在实际构建后更新，实现者不改该文件。

**接口：**
- `package:win` 依次执行现有模型校验、生产构建、`electron-builder --win --dir --x64 --publish never --config electron-builder.yml`、`node scripts/build-windows-installer.mjs`。
- 新脚本从桌面 `package.json` 读取版本，以桌面根目录为基准读取 `dist/win-unpacked`、输出到 `dist`；使用环境变量 `AI_PET_ISCC` 指定可信 `ISCC.exe`，缺失时给出明确构建说明。无需下载器或新增依赖。
- `.iss` 由脚本通过独立 `/D` 参数获得 `AppVersion`、`AppVersionNumeric`、`SourceDir`、`OutputDir`。AppVersionNumeric 使用版本前三段加 `.0`。独立 argv 调用，不拼接 shell 命令。
- `.iss` 使用 AppId `com.myself.desktop`、AppName `AI Pet`、SetupArchitecture `x64`、PrivilegesRequired `lowest`、DiskSpanning `no`、DefaultDirName `{localappdata}\Programs\AI Pet`；目录选择页可用，卸载不删除 AppData，不强制终止桌宠。完整发行目录递归作为 Files 输入。
- 构建器由主智能体准备：官方 7.1.0 x64，安装程序 SHA256 `0362a383ed217d4c4239b5933866dd96d3eb2102737da92f80f6057a4b40df2f`；不把编译器加入运行依赖。

- [ ] **步骤 1：RED。** 更新当前 NSIS 契约测试，要求新版正式链路及 Inno 配置，明确卸载保护、单文件离线与资源白名单。例如：

```ts
expect(packageJson.scripts['package:win']).toContain('electron-builder --win --dir --x64 --publish never');
expect(packageJson.scripts['package:win']).toContain('node scripts/build-windows-installer.mjs');
expect(configText).not.toMatch(/^nsis:/mu);
expect(installerText).toContain('PrivilegesRequired=lowest');
expect(installerText).toContain('DiskSpanning=no');
expect(installerText).not.toContain('[UninstallDelete]');
```

运行 `pnpm.cmd --filter @myself/desktop verify:package-config`，确认失败来自旧链路或缺失安装器。脚本参数、资源缺失和编译失败的测试应调用实际导出行为并替代编译进程，不真实安装软件。

- [ ] **步骤 2：GREEN。** 最小实现正式入口与脚本，保留所有 `files` 和 `extraResources` 过滤。使用现有 Node API（`readFile`、`stat`、`execFile`）调用编译器；编译成功需确认输出存在。ISS 只封装既有 `win-unpacked`，提供图标、开始菜单／桌面入口，静默安装不自动启动桌宠。
- [ ] **步骤 3：定向验证。** 运行打包配置及新增脚本测试、桌面 typecheck、`git diff --check`；记录真实 RED/GREEN 输出。只提交本任务的实现、测试和构建说明文件。
- [ ] **步骤 4：任务审核。** 独立审核范围、安装卸载契约与失败路径；主智能体同时准备经哈希及签名验证的官方编译器。
- [ ] **步骤 5：真实构建。** 主智能体设置 `AI_PET_ISCC`，执行 `pnpm.cmd --filter @myself/desktop package:win`，将日志保存在忽略目录。后台构建定期读进度；单个尝试 15 分钟无可判定结果即停下调查，不反复碰运气。
- [ ] **步骤 6：产物和记录。** 审计实际发行目录、固定模型与许可证，确认仅一个安装 `.exe`，计算 SHA256，写中文交付说明。观察可安全完成的安装器界面，不覆盖用户现有安装或资料。尚未完成的干净环境安装卸载明确写待人工确认。提交记录后做最终范围审核，不推送。
