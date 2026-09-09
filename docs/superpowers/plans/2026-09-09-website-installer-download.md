# 官网 Windows 安装包下载实施计划

> 执行方式：采用子智能体驱动开发与 TDD；主智能体负责远端发布、整合和验证。遵守用户 Git 只读要求，不创建分支、提交或推送。

**目标：** 在当前官网启用已核验的 Windows Alpha 安装包下载。

**架构：** 复用现有 CloudBase 静态托管、发布清单、下载组件及点击统计。安装包存放于独立发布目录。

**技术栈：** Node.js、TypeScript、Vitest、Next.js、CloudBase CLI。

**适用规格：** [下载接入规格](../specs/2026-09-09-website-installer-download-design.md)、[官方下载计数规格](../specs/2026-09-01-website-official-download-counter-design.md)。

## 全局约束

- 只发布 `AI-Pet-0.1.0-alpha.1-windows-x64.exe` 与校验文件，不修改安装包。
- 沿用免费环境，接受少量测试额度；不开启按量、不购买、不改权限。
- 保留网站既有业务和 UI；不执行 Git 写操作或远端删除。
- 所有面向维护者的记录与结构性注释使用中文；产品英文翻译沿用 i18n 契约。

## 任务 1：让既有生成器支持最终大文件

文件：`tools/release/src/generate-manifest.ts`、`tools/release/tests/generate-manifest.test.ts`。

- [x] RED：新增大于 `2**31-1` 字节的文件回归测试，验证大小与独立预期哈希，运行工具定向测试，确认原实现报 `ERR_FS_FILE_TOO_LARGE`。
- [x] GREEN：以 `createReadStream` 顺序更新 SHA-256，保留函数签名、Schema、输出格式和失败传播，删除原整包 `readFile` 路径。
- [x] 验证 `@myself/release-tools` 的测试与 typecheck，独立审核规格符合性和代码质量。

## 任务 2：同步已有官网发布态与提示

文件：`apps/website/content/release-manifest.json`、`apps/website/components/i18n/messages.ts`，以及 `apps/website/tests/` 下 `release-manifest.test.ts`、`download-model.test.ts`、`download-chapter.test.tsx`、`page.test.tsx`、`motion-disabled-contract.test.tsx`、`website-fallback.test.tsx`。

- [x] RED：将真实清单相关断言改为发布态和真实文件身份，验证 Windows 直链及回退可用、macOS 无链接；先在原清单上确认失败。
- [x] GREEN：任务 1 完成后，以真实安装包生成清单；将中英文“邀请制 Alpha”标题改为 Alpha 测试版，保留少量测试及未签名说明。
- [x] 运行八个下载相关测试、网站 typecheck 和 `pnpm.cmd verify:website`，如出现既有失败则记录并定向定位。
- [x] 审核最小差异、未发布夹具和失败统计路径仍然保留。

## 任务 3：上传、验证并部署下载入口

生成产物与原始日志放在 `.superpowers/sdd/2026-09-09-website-installer-download/`；最终记录为 `docs/operations/2026-09-09-website-installer-download.md`。

- [x] 上传最终安装包及 `.sha256` 到 `releases/0.1.0-alpha.1/`，记录成功或失败。
- [x] 校验远端大小、HTTPS 和范围读取；默认域普通完整下载 SHA-256 一致。默认域忽略 Range，明确不承诺断点续传，不将原同源后段失败写为通过。
- [x] 使用 `NEXT_PUBLIC_CLOUDBASE_ENV_ID`、既有 Publishable Key、`NEXT_PUBLIC_API_BASE_URL=https://cjmwebsite.cn/api/v1` 与既有 `NEXT_PUBLIC_ADMIN_ORIGIN` 构建真实发布产物，E2E 产物不部署。
- [x] 对比构建与远端文件；最终 18 文件仅增量上传，原入口留本地回退材料，最后更新首页，各阶段远端核验通过。
- [x] 验证线上链接、安装包元数据、下载章节和 macOS 状态；不运行安装器。全部 18 个部署文件的 HTTPS 内容与最终构建一致。
- [x] 独立最终审核，运行 `git diff --check`，记录结果和未覆盖项并交付网址。

实际结果与完整门禁未通过项见 [本次验收记录](../../operations/2026-09-09-website-installer-download.md)。
