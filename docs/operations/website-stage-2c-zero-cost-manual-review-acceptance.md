# 网站阶段 2C 零费用人工审核验收记录

## 结论

- 日期：2026-09-02。
- 范围：阶段 2C 零费用人工审核的本地实现、自动化验证、真实 Docker 候选、运维文档收敛，以及上海免费开发环境的实际最小部署与已完成远端 smoke 子项。
- 提交范围：`5c914ef`（不含）至本次阶段 2C 整分支终审修复提交（含，本记录所在提交）。
- 远端状态：`remote: pass`；最小部署、备案根域名接入、最终五章节视觉覆盖、真实 OTP 管理员登录、公开反馈／建议正文及其点赞、共享包强制发布/风险提示/下载/互动/隔离清理和官方下载计数均已通过；cleanup 每日 timer 配置已创建并启用，函数直调与真实清理通过，自然定时投递尚未观察。
- 本记录证明阶段 2C 的上海免费开发／测试环境验收通过，但不表示正式生产上线。用户已确认规格中的“评论”只指公开反馈／建议正文，不包含共享资源留言或回复；监控、告警、日志脱敏和正式生产发布属于后续独立工作。

## 已执行的远端环境门

| 项目 | 实际结果 |
| --- | --- |
| 旧环境删除 | 已只读核对旧上海环境 `ai-pet-scanner-dev-d8cq…e` 的地域、体验套餐和资源；展示销毁范围并取得行动时第二次明确确认后，先销毁再永久释放。环境列表复核确认该环境已不存在；新加坡旧环境未触碰。 |
| 新环境创建 | 创建页明确显示上海、PostgreSQL、免费体验版、6 个月、配置与实付均为 0.00 元，且未勾选任何搭配购买；兑换码验证通过后创建。 |
| 费用保护 | 新环境 `ai-pet-scanner-dev-d0cp…826` 的套餐页显示免费体验版、有效期至 2027-03-01、体验版不支持自动续费、资源点 `0/3000`；按量付费开关未开启。 |
| PostgreSQL migration | CLI 对比确认远端与本地全部 16 条 migration 一致；远端最新版本为 `20260901020000`，没有 pending 或 conflict。 |
| 私有对象存储 | 私有 Bucket `ai-pet-private` 已存在，`public=false`。 |
| 函数 | 仅部署 `ai-pet-api` 与 `ai-pet-cleanup`；两者均为 Event 云函数、Node.js 20.19。真实共享包 finalize 暴露 V3 双实例身份覆盖后，两个函数均以代码更新部署统一服务端身份；`ai-pet-api` 为 `$LATEST`、Active/Available。免费体验版实际固定超时 3 秒、内存 256 MB。 |
| 网关 | 默认网关保留公开 `/api` 与管理员 `/api/v1/admin` 两条 `SCF` 路由；备案根域名增加 `/` 静态托管及同语义两条 API 路由。公开 API 按 IP、管理员 API 按用户限流，均为总 QPS 100、单客户端 10。公开 `GET /api/v1/community` 返回 200；未认证管理员请求返回 401 `MISSING_CREDENTIALS`。 |
| 身份 | 邮箱 OTP 已启用，唯一管理员账号为 ACTIVE；真实 OTP 登录、双头管理员认证、详情读取和管理员指标读取均已通过。 |
| 静态托管 | 网站以目标环境、既有 Publishable Key 与 `https://cjmwebsite.cn/api/v1` 构建。首次部署曾清理旧哈希并保留 67 个候选文件与 6 个平台文件；最终视觉恢复改用 13 文件最小增量覆盖且不删除旧对象，当前共 78 个对象，其中 67 个当前候选文件、6 个平台文件及 5 个未再引用的旧构建哈希文件。未记录任何 Key 值。 |
| 投稿与费用 | `SHARED_PACKAGE_SUBMISSIONS_ENABLED=false`。域名验收后套餐页显示当前计费周期总资源点 3000、已使用 81.39，按量付费开关关闭；HTTP 加速请求数为 0、流量为 0 Byte。没有购买、升级或开启按量。 |
| 日志与反馈链 | 已临时开通上海开发环境函数日志且未购买独立日志资源包。日志定位并闭环空 GET 正文与 void RPC 204 两个兼容问题；反馈真实执行批准发布、公开读取、点赞 `0→1`、撤赞 `1→0`、删除隔离和公开消失，审计记录保留批准与删除两次动作。CloudBase 系统日志会保存函数响应摘要，因此当前只允许测试数据且共享包投稿继续关闭；接入真实投稿或正式上线前必须关闭该日志或先完成独立脱敏方案。 |
| 共享包真实链 | 使用一个受控 `uploading` 测试夹具上传 68 字节 PNG 与 1376 字节 ZIP，远端对象身份、大小、MIME 与 SHA-256 一致。管理员 5 分钟 ZIP 地址返回 200 和同一 SHA-256；普通批准因缺少系统证据保持禁用，两步 `force_publish` 后公开依据为 `admin_override`，卡片、详情和下载入口均显示人工覆盖风险提示。公开下载计数 `0→2`，同一幂等键重放只计一次；点赞 `0→1→0`。 |
| 删除与 cleanup | 测试共享包删除后进入三天隔离，公开列表、详情和下载均不可达，`force_publish` 与 `delete` 审计保留。仅把该精确测试 ID 的 `purge_after` 调整到过去后调用真实 cleanup：记录进入 `purged`、正文和发布字段清空、资产行归零、两个私有对象消失、审计仍保留。远端已创建唯一启用的 `ai-pet-cleanup-daily`，七段 Cron 为 `0 0 4 * * * *`；时区以控制台标注为准。timer 创建后另行直调在 717 ms 内返回 `claimed=0/purged=0/failed=0/expiredOperationsPurged=0`；尚未观察一次平台自然定时投递。 |
| 凭据处置 | 排障输出曾使旧服务端 API Key 与 `ABUSE_HMAC_SECRET` 进入本机工具记录；随即同时轮换，旧 Key 已删除失效，函数改用新值，仓库外陈旧本地配置已删除。仓库、本文和前端均未记录新值。 |

## 已执行的本地事实

| 项目 | 实际结果 |
| --- | --- |
| PostgreSQL 行为门 | 本地 PostgreSQL 17.11，顺序执行 16 个 migration，85 项行为验证通过。 |
| 自动化测试 | 共 986 项通过：门禁测试 108、共享契约 43、网站单测 383、CloudBase API 核心 277、CloudBase 构建产物 3、包扫描器 67、发行工具 4、migration 工具 42、网站合同 34、CloudBase 构建工具 6、Playwright E2E 19。 |
| 网站 | 383 项单测通过；生产构建通过；Playwright E2E 19/19 通过。 |
| CloudBase API | 280 项通过（含构建产物 3 项）；构建与 typecheck 通过，产物只含 `api`、`cleanup`。 |
| 包扫描器 | 67 项测试通过；typecheck 通过。 |
| 依赖审查 | 263 个模块、687 条依赖；0 个错误，8 个已批准历史 warning。 |
| 真实 Docker 候选 | imageId `sha256:a02f6a8a6cd2fbd3663a61d811c9eae4f7bc6a3b0fdb41f1b495fbaa60a45a9c`；Node `v22.23.2`、ClamAV `1.4.3`、UID `999`；ClamAV DB `28110`，更新时间 `2026-09-01T11:10:23.000Z`，裁决时年龄 0 天；无网络、全部 capability 移除、只读根文件系统、只读输入与 `mode=1777` tmpfs 条件下，干净包进入人工审核、EICAR 阻断、非法包拒绝。 |

## 2026-09-02 官方安装包点击计数补充

- 本地范围新增第 16 条前向 migration `20260901020000_official_windows_download_click_metric.sql`；历史 migration 未修改。
- Memory 与生产合同替身共用公开空响应和管理员累计值合同；公开社区、反馈与静态页面不返回 `officialDownloadCount` 或 `clickCount`。
- 本地浏览器场景以 Memory API 连续登记两次点击，公开页不显示指标，认证管理员工作台才显示累计值；本次完整网站链与范围/所有权门均通过。
- 上海远端公开计数接口已使用空对象请求并返回 200/空数据；认证管理员工作台读取到累计值 3。三次均为本轮可解释的验收点击，不代表三个用户、三次传输完成或三次安装。

## 2026-09-02 上海远端日志诊断与真实反馈验收

- CloudBase 网关把无正文 GET 表示为 `body: ''`；旧详情解析误把它当作非法 JSON 并返回 400。最小修复只把 `undefined` 和精确空字符串视为无正文，非空正文及额外 query 继续失败关闭。
- PostgREST 对 `RETURNS void` 的计数 RPC 返回 204 空正文；旧客户端强制解析 JSON，导致数据库已计数却对外误报 500。最小修复只接受 HTTP 204 为成功空数据，其余响应继续走原有有界解析和错误归一化。
- 两次修复均按 RED → GREEN 完成独立回归测试和复审；部署后 10:18 起日志共观察到 3 个函数请求，平台与应用层均为 200，0 个失败，最长 709 ms。
- 临时反馈已从隔离区保留至 `purgeAfter` 到期；公开列表已确认不再出现，未直接篡改或删除审计数据。
- 官方 `IgnoreSysLog` 配置已做真实试验，但环境日志仍出现系统响应摘要，不能作为脱敏措施；试验配置已撤回，没有把无效加法留在正式配置中。

## 2026-09-02 上海共享包与 cleanup 验收

- 最初 finalize 返回 `UPLOAD_INCOMPLETE`；数据库声明与对象实际内容均正确。根因是服务端先用 API Key 初始化 RDB、再用 HTTP 网关调用 `context` 初始化 Storage，后一个实例无法读取私有对象且覆盖同环境请求身份。
- 修复按 RED → GREEN 把 RDB 与私有 Storage 收敛为同一个服务端 API Key 实例，并删除第二次 SDK 初始化。该 Key 原本已是 RDB 必需的函数环境变量；管理员网关、Bearer Token、邮箱白名单和角色校验未改变。
- 同一测试夹具在代码更新后无需重传即成功进入 `manual_review_pending`，随后完成待审短期下载、两步强制发布、公开风险提示、公开下载、幂等计数、点赞/撤赞、隔离删除及物理清理全链。
- Event 函数省略 `context` 与 API Key 的默认初始化路径未在远端另行试验；当前方案复用函数原本就必须持有的一份服务端 Key，且已通过完整真实链。为一个尚未证明能降低实际权限的替代路径重新部署和重建对象夹具会扩大变更面，因此只把它保留为正式生产前的可选最小权限硬化项，不阻塞开发环境阶段 2C。
- `cloudbaserc.json` 只为 cleanup 声明每日一次触发器；远端白名单核对为 `name=ai-pet-cleanup-daily`、`type=timer`、`enabled=1`、Cron 匹配。每日约 28–31 次调用，预期由现有套餐覆盖；共享包子项结束时资源点为 1.75/3000、套餐外与按量扣费均为 0，后续域名验收的更新读数见下一节。当前只证明配置存在和函数可执行，不把尚未发生的自然定时投递写成通过。

## 2026-09-02 备案根域名开发验收补充

- 用户明确批准把已备案根域名 `cjmwebsite.cn` 接入上海开发环境；既有 `www.cjmwebsite.cn` CNAME 保持不变，没有触碰旧新加坡环境。本接入只用于阶段 2C 开发验收，不构成正式生产切流。
- 根域 CNAME 已从旧 A 记录切换为 `cjmwebsite.cn.cdn.dnsv1.com`；CloudBase 自定义域名、DNS 与平台 CNAME 状态均为成功。已有双域 SSL 证书被复用，没有购买证书或套餐。
- 根域路由为 `/` 静态托管、公开 `/api` 云函数和管理员 `/api/v1/admin` 云函数；公开接口按 IP、管理员接口按用户限流。HTTPS 首页与 `GET /api/v1/community` 均返回 200。
- 免费体验版拒绝新增 Web 安全域名，官方错误为 `OperationDenied.FreePackageDenied`。为保持零额外费用，没有升级套餐；公开构建改用备案根域 API 形成同源请求，原默认静态域名继续作为管理员 OTP 入口。真实已登录管理员工作台仍能读取投稿队列与官方下载计数。
- 首次静态构建 67/67 上传成功；当时只删除经本地引用对比确认失效的旧哈希文件并保留 67 个当前构建文件和 6 个平台认证文件。最终视觉恢复后的最新对象状态与不删除策略见下一节。真实浏览器复测中首页、共享仓库和支持模块正常，共享仓库不再出现加载失败。
- 域名验收后套餐页为免费体验版，资源点 81.39/3000，按量付费关闭，HTTP 加速请求数 0、流量 0 Byte。本轮没有购买、升级或开启按量能力。

## 2026-09-02 最终视觉恢复上海覆盖验收

- 部署源为 `fa2298172fab74724a9925c14fab1a6a6b6cf250`，候选 Next.js build ID 为 `Bqg-hzylBmDLBJApiTJ_L`。构建只在进程内使用既有浏览器 Publishable Key，未输出或写入仓库；API 基地址固定为 `https://cjmwebsite.cn/api/v1`。
- 部署前本地候选共 67 个文件，远端共 73 个对象。普通对象以本地 MD5 对比远端 ETag：52 个一致；两个大型 GLB 的本地与远端字节数分别精确一致为 24,870,164 和 49,360,612，远端为 multipart ETag，未把它误当普通 MD5。实际差异闭合为 5 个新增哈希资源和 8 个入口文件。
- 8 个旧入口文件在覆盖前逐个下载到系统临时回退目录，文件大小和 MD5 均与部署前远端 ETag 一致。随后按“哈希资源、文本入口、章节 HTML、根 `index.html`”顺序逐文件上传 13 项，全部成功；没有调用 Hosting delete、目录同步或 prune，也没有修改数据库、函数、Bucket、身份、网关和远端内容。
- 上传后远端共 78 个对象。67/67 个候选路径全部存在；65 个普通对象的大小与 MD5/ETag 全部一致，两个 multipart GLB 字节数一致；5 个新哈希资源、6 个 `__auth`／`cloud-admin` 平台文件和 5 个旧构建哈希文件全部保留。旧哈希不再被新 HTML 引用，本次按“不删除”约束保留。
- `https://cjmwebsite.cn` 与上海默认托管域名的首页、管理员页、投稿状态页及三份法律页面均返回 200；两域首页响应内容一致，且 13/13 个 Next.js 静态引用与部署候选一致。默认托管域名的 `/api/*` 会落入静态回退，不能当作 API；真实业务 API 权威入口仍是 `https://cjmwebsite.cn/api/v1`。
- 自定义域公开社区、反馈和建议 GET 均返回 200 JSON，当前真实公开数据均为 0 条；未认证管理员队列和官方下载指标接口均返回 401 `MISSING_CREDENTIALS`。线上 smoke 没有投稿、点赞、下载或其他远端写请求。
- Chromium 149、1440×900、正常动效下依次进入 `home/about/download/community/feedback`，活动章节进度为 0/1/2/3/4；每章 Canvas CSS 尺寸为 1440×900、缓冲区为 1296×810、WebGL context 未丢失。About 为三块玻璃，Download 模型就绪，Feedback 两组各三项操作均可见；控制台错误和 page error 均为 0。
- Community 运行时 uniform columns 为 `0.13775 / 0.37925 / 0.62075 / 0.86225`，rows 为 `0.792 / 0.208`。真实 computed CSS 得到的列中心与生产 helper 最大偏差 0.014 CSS px，行中心最大偏差 0.018 CSS px；helper 与实际上传 uniform 一致。线上真实内容为 0 条，因此没有伪造投稿来制造卡片，真实卡片 DOM 中心距离记为不适用；`900px` 正常动效边界下卡片 shader count 为 0 且 context 健康。
- CLI 复核上海环境仍为 `NORMAL` 的免费体验版，静态托管为 `online`，函数仍只有既有的 `ai-pet-api` 与 `ai-pet-cleanup`。本次没有购买、升级、创建套餐、开启按量服务、日志资源包、函数、数据库、Bucket 或密钥；部署后的套餐用量页面因浏览器登录态失效未重复读取，不能把旧读数冒充新读数。
- 新鲜门禁：`verify:cloudbase` 为 CloudBase API 280/280、包扫描器 67/67；网站 typecheck、生产构建和单元测试 413/413 通过；范围门、测试所有权门及 `git diff --check` 通过。`verify:website` 的单浏览器串行 E2E 实际为 15/20，5 项均在进入交互阶段因同一 GPU 浏览器停滞至 60 秒或页面关闭而失败；没有提高 timeout、增加 retry 或放宽断言。相同 20 项此前已在独立新 Chromium 进程逐项通过，本次上海线上五章独立 headed smoke 也通过，因此保留该运行器限制事实，不把一键门禁写成全绿。
- 当前发行清单继续是 `unpublished`，所以线上只验证下载章节的未发布状态及“计数失败不阻断”的自动化合同，没有伪造正式安装包链接或真实下载成功。

## 2026-09-02 本轮新鲜本地验证

以下均为本地验证，不替代远端 smoke：

```powershell
pnpm.cmd verify:cloudbase
pnpm.cmd verify:website
pnpm.cmd verify:web-chain:scope
pnpm.cmd verify:web-chain:ownership
git diff --check
git status --short
```

- `verify:cloudbase`：CloudBase API 280/280（含构建产物 3 项）、包扫描器 67/67 通过。
- `verify:website`：网站 383/383、生产构建与 Playwright E2E 19/19 通过。
- 域名接入完成后重新执行 `verify:cloudbase` 与 `verify:website`：CloudBase API 280/280、包扫描器 67/67、网站 383/383、生产构建和 Playwright E2E 19/19 均返回 0。
- 范围门、测试所有权门与差异检查通过；提交后 `git status --short` 为空。
- 本轮再次执行完整 `verify:web-chain`：从 scope 到新增的 CloudBase build tool test 均通过，随后在 `scanner-candidate` 因 Docker Desktop daemon 不存在而以 1 退出，按门禁设计未继续执行。网站 E2E 已由上面的独立 `verify:website` 新鲜通过；Scanner 的同日真实候选证据仍见“真实 Docker 候选”，不得把本次失败写成完整链通过。

Task 7 最终复验实际执行：

```powershell
$env:AI_PET_POSTGRES_RUNTIME='C:\Users\Administrator\AppData\Local\Temp\ai-pet-pg17-stage2\runtime'
pnpm.cmd verify:web-chain
pnpm.cmd verify:web-chain:scope
pnpm.cmd verify:web-chain:ownership
git diff --check 5c914ef..HEAD
git status --short
```

完整网站链、范围门、测试所有权门和提交差异检查均返回 0；`git status --short` 在记录提交前只列出本轮已解释的管理员 ZIP E2E、Memory API 地址、退役策略与测试、现行规格/计划、两本运维手册、优化索引、旧验收历史恢复和本验收记录。

本地行为已收敛为：新共享包和反馈/建议直入 `manual_review_pending`；反馈可普通 `approve` 并记录 `standard`；新共享包没有有效系统证据时普通批准失败关闭，只能经风险确认执行 `force_publish`，并记录 `admin_override` 与公开风险提示。restore 的旧幂等 key 在恢复后的后续发布、驳回、隔离或清理生命周期中仍回放首次快照；同 key 改管理员原始输入继续冲突，新 key 不能绕过当前状态与版本门。

管理员详情提供 5 分钟待审 ZIP 地址；该地址不进入公开 DTO，真实 E2E 下载返回 `application/zip`，且不会增加公开下载计数。本地 Docker CLI 不是云端服务：构建阶段 `freshclam` 使用网络更新病毒库，运行阶段固定 `--network none`；候选病毒库超过 7 天必须重建并复验。报告要求人工查看图片，且不能作为系统扫描通过证据。

## 已退役的云端自动审核入口

现行 CloudBase 最小部署面仅为 PostgreSQL、私有 Bucket、`ai-pet-api`、`ai-pet-cleanup`、身份、网关和静态托管。CloudBase Run Scanner、腾讯 TMS、腾讯 IMS、`ai-pet-moderation-worker`、Scanner HTTP/HMAC 和 Scanner Secret 已退役，禁止部署。对应的 17 个旧自动审核与远程 Scanner 源码/测试路径由范围门同时拒绝工作树与 Git 索引恢复。

## 非阻断后续项

共享包强制发布、风险提示、待审包短期下载、公开下载/互动和完整远端数据清理均已验证；cleanup timer 配置已创建并启用，函数直调与真实清理通过，自然定时投递尚未观察。用户已确认“评论”只指现有公开反馈／建议正文，该正文发布、公开读取和点赞链已经通过，不实现共享资源详情页留言或回复。监控、告警、日志脱敏和正式生产发布仍未验证，属于阶段 2C 关闭后的独立工作，不冒充本次开发环境 smoke。

本机 Docker Desktop 在远端共享包复验后发生启动故障，当前无法再次运行同一容器；本阶段早先记录的同日镜像摘要、ClamAV 数据库、干净包、EICAR 和非法包结果仍是实际证据，且本轮未修改 Scanner 代码。该桌面环境故障作为后续运维问题保留，不把未执行的重复扫描写成通过。

共享包投稿开关继续保持 `SHARED_PACKAGE_SUBMISSIONS_ENABLED=false`。`cjmwebsite.cn` 当前只指向上海开发环境；后续远端写操作继续执行行动时预览与失败关闭，任何远端验证成功也不自动等于正式生产上线。
