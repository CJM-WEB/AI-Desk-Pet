# 官网安装包下载接入验收

> 后续更新：2026-09-14已从最新main重建并同名覆盖官网安装包，见[最新替换验收](2026-09-14-latest-installer-replacement.md)。本文的旧大小、SHA与免费套餐仅描述9月9日历史状态，下方同名下载链接现在返回新版。

## 范围与授权

- 日期：2026-09-09；执行环境：Windows、Node.js、pnpm 11.9.0。
- 基线：`main`，`be8187392267054fd35d2d54acebd28303a1974f`，开始时工作区干净。
- 用户要求将现有安装包挂到官网，并明确选择继续使用当前免费 CloudBase 环境，接受少量测试的额度限制。
- 复用上海环境 `ai-pet-scanner-dev-d0cpbc8094826` 的静态托管与独立 `releases/0.1.0-alpha.1/` 目录。未开通付费、修改按量开关、对象权限、投稿、数据库、API、域名或桌宠业务；未执行 Git 写操作。
- 规格与计划：[下载接入规格](../superpowers/specs/2026-09-09-website-installer-download-design.md)、[实施计划](../superpowers/plans/2026-09-09-website-installer-download.md)。安装器自身的历史验收见 [安装包生成记录](2026-09-09-windows-package-acceptance.md)。

## 产物身份

| 字段 | 实际值 |
| --- | --- |
| 版本 | `0.1.0-alpha.1` |
| 平台 | Windows x64 |
| 文件名 | `AI-Pet-0.1.0-alpha.1-windows-x64.exe` |
| 大小 | `2855778466` 字节，约 2.86 GB（2.66 GiB） |
| SHA-256 | `14163215f587962301ae88b336852ef1372eee64a092052b46de96c7341867ee` |
| 签名 | 未签名 Alpha |
| 下载地址 | [Windows 安装包](https://ai-pet-scanner-dev-d0cpbc8094826-1391054083.tcloudbaseapp.com/releases/0.1.0-alpha.1/AI-Pet-0.1.0-alpha.1-windows-x64.exe) |
| 校验文件 | [SHA-256 文件](https://ai-pet-scanner-dev-d0cpbc8094826-1391054083.tcloudbaseapp.com/releases/0.1.0-alpha.1/AI-Pet-0.1.0-alpha.1-windows-x64.exe.sha256) |

最终安装包来源为 `C:/Users/Administrator/.codex/worktrees/e43f/myself/apps/desktop/dist/`。本轮重新计算本地大小和 SHA-256，与最终打包记录一致；没有使用主目录中的旧安装包，没有重新封装或执行安装器。

## 代码与自动化证据

| 检查 | 实际结果 |
| --- | --- |
| 发布生成器 RED | 原 `readFile` 对超过 2 GiB 的真实文件报 `ERR_FS_FILE_TOO_LARGE`；5 项测试中 1 项按预期失败 |
| 发布生成器 GREEN | `pnpm.cmd --filter @myself/release-tools test`：5/5；同包 `typecheck` 通过；流式哈希替换整包读取，接口和清单契约保持一致 |
| 实际包生成清单 | 真实 2.86 GB 安装包生成成功；候选与官网清单逐字段比较一致 |
| 官网 RED | 八个下载相关测试文件共 54 项，原未发布清单下 9 项按预期失败 |
| 官网 GREEN | 相同八文件 54/54，官网 `typecheck` 通过 |
| 任务审核 | 生成器审核无问题；官网审核指出两处降级场景缺少固定链接断言，补齐后两个文件 25/25，限定复审确认关闭 |
| 官网完整门禁 | `pnpm.cmd verify:website`：44 文件、424 项单元测试及两次静态构建通过；E2E 18/20，两项正常动效场景在 60 秒超时，整体退出 1 |
| E2E 定向复验 | 原超时场景分别在独立进程运行，正常动效五章 1/1（12.3 秒）、390 宽度场景 1/1（6.9 秒）；没有提高超时、加 retry 或改变断言 |
| 默认域 URL 收口 | 六个相关测试中的固定 URL 先 RED：9 失败、45 通过；清单改为真实包生成的默认域候选后 GREEN：八文件 54/54、官网 `typecheck` 通过 |
| 最终正式构建 | 默认域清单以现有公开客户端配置独立构建 canonical `apps/website/out`，退出 0；`assertCanonicalExportClean` 通过；E2E 使用独立导出目录 |
| 最终限定审核 | 清单、固定 URL、规格和最终暂存逐项复核，无新增问题；18 个候选文件大小与 MD5 均匹配，未发现旧同源安装包 URL |
| 最终差异检查 | `git diff --check` 通过；修改仅涉及发布生成器、官网清单与提示、对应测试和发布记录，未变更锁文件、桌宠业务或云 API |

八个定向文件为 `release-manifest.test.ts`、`download-model.test.ts`、`download-chapter.test.tsx`、`official-download-click.test.tsx`、`official-download-metric-client.test.ts`、`page.test.tsx`、`motion-disabled-contract.test.tsx`、`website-fallback.test.tsx`。未发布夹具、macOS 无链接及旁路统计失败不阻断下载的测试均保留。

初次完整验证把生产构建参数传给全部测试，导致两项要求缺省环境的既有用例失败；从实际参数与测试断言确认原因后，改为默认环境运行门禁，再单独构建正式产物。没有修改测试预期规避失败。测试日志保留了 jsdom 导航、Canvas 与颜色环境等既有提示，未宣称无警告。

上述两项 E2E 超时与 [main 集成验收](main-website-integration-2026-09-09.md) 已记录的场景相同；本次独立复验通过不覆盖完整套件 18/20 的事实，也不推断超时的全部根因。

## 远端与下载链证据

- CloudBase CLI 上传两个发布文件，随后通过远端对象清单独立确认大小为 `2855778466` 和 `104` 字节。CLI 返回的 `successCount: 0` 未作为上传结论；结论依据远端对象与实际 HTTPS 请求。
- 安装包对象 ETag：`e239e2de3bf4a2b464459e731adf6bfc-2724`；该分片 ETag 不等同于整包 SHA-256。
- 官网 `.sha256` 实际读取内容与本地一致。
- 首次冷缓存 HEAD 在 25 秒超时，首次 Range 返回完整 200，取消时已接收 `392749056` 字节。缓存建立后 HEAD 返回 200、正确 MIME `application/x-msdownload` 与完整大小；`bytes=0-63` 返回 206，`Content-Range: bytes 0-63/2855778466`，正文 64 字节。
- 官网同源链路未通过：保留首个正式下载连接收到的 `461164544` 字节前缀，以四段范围请求续传剩余内容；每段要求 206 与精确范围。后段多次连接中断，最后 1 MiB 请求虽返回 206 但在 30 秒内没有正文，未把该链路写成通过。
- 源站诊断：已有 CLI 临时凭据只在内存用于静态桶只读请求，COS 尾部 64 字节返回 206、精确内容范围，并与本地尾部完全一致；未公开签名地址或更改对象权限。默认静态域会忽略 Range 并返回全长 200，自定义域尾段问题仍待定位。
- CDN 诊断：原 `RangeOriginPull.Switch=on`，回源到 `prod.tcbaccess-in.tencentcloudbase.com`。精确安装包路径关闭分片的请求被 `UnknownParameter` 拒绝，回读字段与其余配置指纹均未改变；没有修改全局开关或新增服务。
- **最终默认域整包下载自动化通过**：普通 GET 返回 HTTP 200，完整收到 `2855778466` 字节，用时 `348.910209` 秒；重新计算 SHA-256 为 `14163215f587962301ae88b336852ef1372eee64a092052b46de96c7341867ee`，与本地一致。响应 MIME 为 `application/x-msdownload`，`Content-Disposition: attachment`。该地址仍属于当前免费环境，替代原同源 CDN 安装包 URL。
- **网站部署自动化通过**：部署前再次确认原有 81 个网站对象与调查基线一致，另有本轮上传的两个安装包发布文件。最终增量为 18 个文件、383993 字节：10 个哈希资源（309581 字节）、7 个其他入口（38154 字节）、1 个首页（36258 字节）。按资源、其他入口、首页顺序上传，各次 CLI 退出 0，分别报告 10/10、7/7、1/1 成功；每阶段独立回读远端大小与 MD5。最终远端共 93 个对象，未被覆盖的 75 个原有对象（含安装包与校验文件）身份均保持一致，没有删除远端文件。
- 8 个原入口已备份并核验。部署内容来自 `default-domain/` 暂存，原同源 URL 的 19 文件候选未部署。
- 两个原有 GLB 使用 COS 分片 ETag，该值不是完整文件 MD5；通过实际 HTTPS 全文、响应 ETag 与大小取得内容哈希，确认它们与本地完全一致，因此不重新上传模型。
- **线上文件自动化通过**：普通 HTTPS GET 核对全部 18 个部署文件，均返回 200，大小与 MD5 全部匹配。首页为 36258 字节，MD5 `7596580a456e33b47022a1c0a0f95124`，包含最终默认域下载链接；默认域 `.sha256` 返回 200，内容与最终产物一致。

## 线上浏览器观察

2026-09-09 13:10—13:12（UTC+8），在 Codex 内置浏览器重新加载 [官网](https://cjmwebsite.cn/)，实际观察如下：

- 首页与介绍章节正常呈现，可通过 Page Down 进入下载章节。
- Windows 下载按钮显示“下载 Windows”，可见且启用；读取其 `href` 与本记录的最终默认域 URL 完全一致。
- 页面显示 `AI-Pet-0.1.0-alpha.1-windows-x64.exe`、`2723.5 MB`（沿用既有显示格式）、完整 SHA-256、“未签名测试版”和“Alpha 测试版”说明。
- 切到 macOS 后显示“版本尚未发布”，按钮“即将支持”禁用，未提供安装包链接；随后切回 Windows。
- 下载正文已经通过一次真实普通 GET 全量验证。本次浏览器观察没有再次点击下载以重复消耗约 2.86 GB 流量；浏览器下载保存过程、安装和卸载不属于本次观察结论。

本次结论：**官网下载入口部署、远端文件核验及整包下载 SHA-256 自动化通过，线上下载章节实际浏览器观察通过**。完整网站 E2E 门禁仍保留 18/20 的实际结果，不能写成整套全绿。

## 限制与未覆盖项

- 本环境仅供少量测试。开始时免费资源点使用量为 `283.87/3000`，按量付费关闭；国内静态流量单价为 `210 点/GB`，存储为 `3.94 点/GB/天`。完整校验下载和已取消探测也消耗流量，不能把开始时余额当作交付时余额。[腾讯云价格说明](https://cloud.tencent.com/document/product/876/127357)
- 最终默认域实测忽略 Range，不承诺断点续传；采用普通完整下载。原官网同源 CDN 地址的后段失败尚未修复，因此不作为官方下载链接。
- 干净 Windows 安装、卸载、跨版本升级及完整桌宠交互仍待用户人工确认，本轮未执行安装器。
- 原始日志、下载文件、分段与部署回退材料保存在 `.superpowers/sdd/2026-09-09-website-installer-download/`，不属于发布内容；遵守用户要求保留，不执行递归清理。
