# 最新 main 安装包重建与官网下载替换计划

> 采用现有规格与子智能体检查推进；本次为既有发布流程的再次执行，不新增业务功能。用户已要求制作最新安装包并覆盖官网旧版，并在执行期间补充授权必要的 Git 提交，无需暂停确认；最终验证后提交本次改动，不推送。

**目标：** 从 `main` 的 `3f794389` 重建完整 Windows x64 离线包，将官网下载页替换为本次实际产物。

**架构：** 复用 [Inno 安装器规格](../specs/2026-09-09-inno-offline-installer-design.md)、[下载接入规格](../specs/2026-09-09-website-installer-download-design.md) 和 [构建说明](../../operations/windows-installer-build.md)。使用现有生成器更新唯一发布清单，沿用同环境默认下载域与独立发布目录。

**技术栈：** pnpm、Electron Builder、Inno Setup 7.1.0、Next.js、CloudBase。

## 全局约束

- 使用当前源码及 `package.json` 中的 `0.1.0-alpha.1`，保留同名安装包；以本轮大小、SHA-256 和时间区分旧内容。
- 使用正式生产构建，不复用旧 `win-unpacked`；固定 Qwen 模型与运行时必须通过现有完整校验。
- 用户要求覆盖已挂载版本，允许替换明确的安装包对象、校验文件、网站清单及对应页面。沿用现有环境；本轮只读核实该环境已是个人版，按量和自动续费关闭，不沿用旧免费额度数值，不购买、不改套餐、按量、权限、数据库或 API。
- 本地旧产物与线上原入口先保存回退材料；不做批量或永久清理，不删除其他文件。
- 凭据仅由现有 CLI 或内存读取；不进入日志、文档、构建新增字段或网站。保留既有公开客户端配置。
- 当前分支全量桌面门禁已有未通过记录；本次不修改无关桌宠业务或测试以掩盖它们，不把打包通过写成全业务验收通过。

## 任务 1：重建并核验最新安装包

文件：`apps/desktop/dist/` 为生成输出；本次运行证据在 `.superpowers/sdd/2026-09-14-latest-installer-replacement/`。

- [x] 确认 `main`、干净差异、模型资源和已验证 `ISCC.exe`；备份旧 `dist`，确认所有绝对路径位于当前仓库或已登记工具目录。
- [x] 运行已有打包定向回归：`pnpm.cmd --filter @myself/desktop test tests/package-config.test.ts tests/explorer-main-wiring.test.ts tests/windows-installer.test.ts` 与桌面 `typecheck`。
- [x] 设置 `AI_PET_ISCC` 后执行 `pnpm.cmd --filter @myself/desktop package:win`，记录各阶段与最终退出码；长命令后台跟踪，单点十五分钟仍无判定结果时停止并记录。
- [x] 对生成发行目录校验固定模型、可信资源与默认角色，检查 asar 中未携带工作区副本、开发缓存、个人资料及禁用 MCP SDK。
- [x] 检查唯一安装器、PE/x64、版本、未签名状态、大小与 SHA-256，生成对应 `.sha256` 与本地构建来源记录。独立审计产物身份。

## 任务 2：同步最新下载清单

文件：`apps/website/content/release-manifest.json`；仅当原固定旧产物断言受影响时修改 `apps/website/tests/release-manifest.test.ts`、`download-model.test.ts`、`download-chapter.test.tsx` 等实际命中文件。

- [x] 用现有 `@myself/release-tools generate:manifest` 从新安装器生成候选，字段必须来自实际产物。
- [x] 对固定旧大小／SHA 的断言先更新并运行 RED，确认仅因旧清单而失败；同步生成器候选后运行同组 GREEN。现有版本、链接与 macOS 未发布断言保留。
- [x] 运行官网 `pnpm.cmd verify:website`；记录真实失败，不提高超时或放宽无关断言。实际为423单元通过、E2E18/20；两个超时场景独立复验均通过，完整门禁仍记录退出1。
- [x] 独立复核清单、测试差异、正式构建配置与候选部署范围。发现旧助手的管理员来源与现网不符，部署前恢复根域、重建候选并通过限定复核。

## 任务 3：替换线上文件并交付

- [x] 查询当前托管和套餐状态，只读核对旧线上安装包与本地保留副本身份；获取当前网站清单和原入口回退材料。
- [x] 同名覆盖新 `.exe` 和 `.sha256`；核对远端大小与对象身份。使用已验证的默认域，若返回旧缓存则仅处理该文件缓存或等其失效，不扩大远端配置范围。
- [x] 真实完整下载一次新安装包并比对 SHA-256；响应必须对应新内容，不因文件名相同而沿用旧证据。
- [x] 复用线上公开生产配置构建 canonical `apps/website/out`，验证无 E2E 认证内容；按新资源、其他入口、首页顺序增量部署，首页最后。
- [x] 核对线上页面、资源及最新下载元数据；浏览器观察 Windows 链接启用、macOS 无链接；不重复整包下载，不默认安装到用户环境。
- [x] 更新本次独立验收、旧状态入口和进度记录；执行 `git diff --check` 并完成最终独立审核，交付官网与本地安装包。

既有构建流程本身不增加实现；其证据是现有测试和真实产物核验。若遇到需要更改功能、协议或安全边界的新问题，先记录并确认范围，再执行对应 SDD/TDD。

## 打包前提修正：固定受保护资源的换行

首轮包的实际启动出现 `EXPLORER_BRIDGE_FAILED`。调查证实当前检出把两个 Explorer 资源转为 CRLF，原始字节 SHA 与完整性清单不符；仅恢复 LF 后哈希精确等于既有清单，e43f 对照资源也完全一致。运行期安全检查正确拒绝了错误字节。

此修正只恢复既有、已批准的资源字节，不改变脚本逻辑、完整性清单、校验方式或失败策略：

- [x] 在 `apps/desktop/tests/package-config.test.ts` 增加读取两个真实资源并对照既有完整性清单 SHA 的失败回归，先观察 RED。
- [x] `.gitattributes` 对 `apps/desktop/resources/windows/explorer-space-bridge.ps1` 与 `explorer-space-shell-tab-helper.cs` 声明 `text eol=lf`，并将本地两文件恢复为 LF；禁止更改已批准摘要或忽略校验。
- [x] GREEN 后运行打包相关测试、桌面 typecheck 和真实资源复核，独立检查只发生换行恢复。
- [x] 首轮包保留为诊断材料，取消其上传，检查远端旧包是否保持；重新执行完整 `package:win`、发行审计与隔离启动，以新结果重新生成官网候选及测试固定值。
