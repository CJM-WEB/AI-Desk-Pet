# 官网直接下载修复验收

## 问题与范围

日期：2026-09-14，Windows、Node 24.18.0、pnpm 11.9.0。开始于干净的 `main@03b5d347`。用户指出官网下载先跳腾讯云提示页，要求点击后直接下载，并授权使用已登录的控制台；必要Git提交沿用本会话授权，不推送。

适用[修正规格](../superpowers/specs/2026-09-14-direct-installer-download-design.md)与[实施计划](../superpowers/plans/2026-09-14-direct-installer-download.md)。本轮使用同一个2982126566字节的安装包，SHA-256仍为 `17e1516a086c65d212a30c27206c6414fc2d127aefbb2d98a4030e1faa818cef`，没有重新打包。

## 根因与真实复现

上轮证明了默认域命令行整包下载完整和按钮href可用，没有实际点击验证首次浏览器导航是否被拦截；这不足以证明“点击直接下载”。本轮加入 `Sec-Fetch-Mode: navigate` 和文档导航请求头后，默认域真实返回HTTP 404、18223字节HTML，包含“页面访问提示”“测试域名”和“确定访问”，与用户截图一致。

[CloudBase官方说明](https://docs.cloudbase.net/service/alias)确认该行为来自默认域导航限制，正式解决方式是使用自定义域名。没有通过伪造确认Cookie、模拟确认、整包Blob下载或代理转发绕过提示。

独立只读核对和已登录控制台均确认 `cjmwebsite.cn` 正常绑定同环境，证书、DNS与路由正常，`/` 指向静态托管。正式域有限导航探测返回200、`application/x-msdownload`、附件文件名、精确新大小与ETag，无提示HTML。两个Range探测返回全长200而非206，由2MiB限制在接收大正文前主动终止；它们只证明响应边界，不证明完整下载或断点续传。

现有CDN仍开启分片回源；本轮对象的no-store/no-cache响应为Cache Miss，与9月9日缓存后段失败的响应模式不同。本轮没有修改CDN全局配置、网关、DNS、对象权限、认证、计费或云服务。

## 最小差异与TDD

唯一清单 `apps/website/content/release-manifest.json` 只把 `downloadUrl` 改为：

[Windows安装包](https://cjmwebsite.cn/releases/0.1.0-alpha.1/AI-Pet-0.1.0-alpha.1-windows-x64.exe)

五个测试文件共九处真实生产URL断言同步；版本、大小、SHA、文件名、发布时间与签名状态保持原值。两个下载组件继续消费同一清单，使用原生链接；旁路点击统计、macOS未发布和降级显示逻辑均未修改。

- RED：先只改URL断言，八文件中9项失败、45项通过，失败均识别旧默认域。
- GREEN：仅修改清单URL后，八文件54/54通过，官网typecheck退出0。
- 默认环境完整门禁 `pnpm.cmd verify:website`：423项单元、类型检查、默认构建与独立E2E构建通过；浏览器E2E18/20，两个原动效场景超时，整体退出1。未修改超时、重试或断言。
- 两个场景按原CLI和已有E2E导出分别独立复验，正常动效1/1通过（7.9秒），390宽度1/1通过（3.2秒），均退出0。完整门禁原18/20结果继续保留，失败上下文和trace已在复验前备份到本轮 `full-e2e-failures/` 并核对哈希。
- 独立代码与规格审核通过，未发现范围外实现或提示页绕过机制。

八文件为 `release-manifest.test.ts`、`download-model.test.ts`、`download-chapter.test.tsx`、`official-download-click.test.tsx`、`official-download-metric-client.test.ts`、`page.test.tsx`、`motion-disabled-contract.test.tsx`、`website-fallback.test.tsx`。

## 生产构建与候选

默认测试结束后单独以当前线上公开参数构建，退出0，canonical导出隔离检查通过。首页36210字节、MD5 `d819f85649dbb03b76ade7ec1fa8ea1a`，包含正式域下载URL与原SHA，不含默认域安装包地址。管理员来源保持根域，管理员脚本MD5仍为 `d26150f7deec622c287f792101f7fa01`，与本轮开始时线上字节相同。

本轮新托管基线108文件，锁定测试前67个正式导出键，11个HTML/txt回退副本均按当前清单核验。生产候选共11个：3个新资源、7个其他入口、1个首页；8个实际覆盖对象均有匹配回退副本。独立逐字节审核确认候选等于正式out与阶段目录；其余56个out文件内容等于当前基线，两个GLB与前轮已核验缓存一致。

## 完整下载与实际发布

正式域完整GET携带浏览器导航请求头，2026-09-14 18:22（北京时间）核验通过：HTTP 200、2982126566字节、用时695.85秒、SHA-256与清单一致。响应类型为 `application/x-msdownload`，`Content-Disposition` 为带准确文件名的附件，没有腾讯云提示HTML。此为完整传输证据，不是安装运行验收。

随后按资源、其他入口、首页三个阶段实际上传并逐阶段回读。最终111个对象中，100个原对象保持原值，8个入口被本轮候选覆盖，3个资源新增；安装包及校验文件未变，没有删除或清空托管内容。18:23的普通公开HTTPS请求对11个候选逐项核验大小和MD5，11/11通过；根路径首页另行核验也与候选完全一致。未添加缓存破坏参数。独立审核复算已下载文件SHA并核对发布清单、11个公开对象和保留对象，未发现不一致。

## 浏览器观察与未覆盖项

发布后实际浏览器刷新官网，Windows下载链接可见且指向 `cjmwebsite.cn` 的上述EXE路径。尝试等待下载事件并点击时，浏览器工具在40秒后超时并重置；没有取得成功下载事件。恢复读取时，页面仍为官网，下载链接获得焦点且地址正确，没有显示腾讯提示页。该观察不等同于下载管理器已启动，不能将实际点击下载验收记为通过。

切换macOS后，“即将支持”按钮禁用，Windows下载链接数为0；切回Windows后正式域下载链接恢复，页面保留在Windows下载区。用户普通浏览器的最终点击与下载管理器行为待人工确认；没有再次下载整包、安装EXE或更改浏览器设置。

本轮已完成正式域下载入口发布和完整附件传输验证；完整官网门禁保留18/20及两个场景独立复验通过的真实结果。不承诺断点续传，安装卸载仍沿用前轮“待用户人工确认”的范围。

本轮日志与回退材料在 `.superpowers/sdd/2026-09-14-direct-installer-download/`，核心证据为 `official-domain-full-download-verification.json`、`verified-03-home.json`、`public-website-verification.json`、`public-home-verification.json` 及浏览器工具记录。
