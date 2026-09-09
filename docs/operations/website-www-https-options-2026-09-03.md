# 官网 www HTTPS 零新增费用方案调研

> 日期：2026-09-03；性质：官方资料调研，不是实施规格或生产验收。
> 范围：将 `www.cjmwebsite.cn` 统一到 `https://cjmwebsite.cn`，不迁移整站、不修改网站业务代码、不更换整域 NS。
> 本次仅检索官方公开文档并写入此文件；未开通服务、绑定域名、申请证书、修改 DNS 或执行 Git 写操作。
> 后续配置切换已执行；本文保留调研当时的候选判断，实际状态以 [既有验收记录](website-stage-2c-zero-cost-manual-review-acceptance.md) 的 2026-09-03 www 入口统一补充节为准，不再以本文“尚未实施”判断当前上线状态。

## 1. 结论

1. **CloudBase 免费跨环境转移绑定：证据不足，不应尝试绕过升级限制。** 官方跨环境迁移要求在目标环境重新添加自定义域名、重新配置证书及 DNS，没有说明旧环境域名资格可以绕过目标环境套餐限制。现有根域不能为试探资格而解绑。[CloudBase 跨环境迁移](https://docs.cloudbase.net/quick-start/env-transfer)
2. **EdgeOne Pages（现名 Makers）独立重定向项目：当前官方能力和免费配额支持，是候选方案，但尚未实施。** 独立项目仅承接 `www` 的 HTTPS 和重定向，根域继续使用现有 CloudBase。官方支持外部 301、域名正反向重定向、免费自定义域名及 SSL；这是一项基于文档组合的可行性推断，不等于当前账号已具备全部开通条件。[重定向配置](https://cloud.tencent.com/document/product/1552/127389)、[免费配额](https://cloud.tencent.com/document/product/1552/132789)
3. **DNSPod 普通显性 URL 转发不满足目标。** 官方明确源地址只支持 HTTP，目标地址支持 HTTPS 不能解决 `https://www.cjmwebsite.cn` 的 TLS 接入。[隐/显性 URL 记录](https://cloud.tencent.com/document/product/302/12649)

## 2. CloudBase 绑定迁移边界

- 官方没有一键跨环境迁移；静态托管迁移的域名步骤仍是进入目标环境、添加域名、更新解析。[官方流程](https://docs.cloudbase.net/quick-start/env-transfer)
- SDK 的 `CreateHostingDomain` 与 `deleteHostingDomain` 分别表示绑定、解绑，文档没有赋予跨环境迁移优惠或资格豁免。[静态托管 SDK](https://docs.cloudbase.net/api-reference/manager/node/hosting)
- 因主任务已观察到上海体验环境“新增域名”提示套餐升级，本调研不能把 SDK/API 可调用性解释为获准绕过套餐。若继续走 CloudBase，需官方支持明确确认现有资格的迁移规则；在此之前不删除根域或旧 `www` 绑定。

## 3. EdgeOne 候选方案及约束

### 3.1 最小部署形态

采用与业务项目分离的直接上传项目，仅包含入口 `index.html` 和 `edgeone.json` 重定向配置；不导入业务仓库，不部署函数、KV、模型或整站。官方要求直接上传内容根目录存在 `index.html`，允许 ZIP/文件夹上传，并支持 `redirects`；直接上传不执行平台构建。[直接上传](https://cloud.tencent.com/document/product/1552/127371)

重定向目标固定为 `https://cjmwebsite.cn`。官方支持 `source` 路径通配符与 `:splat` 捕获，以及外部绝对地址，因此可规划保留路径的跳转；查询参数、中文编码、末尾斜杠及 HTTP/HTTPS 的实际行为必须部署后测试，本文不把它们标为已验证。[edgeone.json](https://cloud.tencent.com/document/product/1552/127389)

### 3.2 域名、DNS 与证书

| 核对项 | 官方证据与当前限制 |
| --- | --- |
| 仅接入 `www` | 可添加子域名，在现有 DNS 服务商配置归属权验证记录和 CNAME；无需迁移根域或整域 NS。大陆或含大陆加速需域名已备案。[自定义域名](https://cloud.tencent.com/document/product/1552/127404) |
| HTTPS | 2026-08-19 更新的域名文档明确“添加后不会自动生成证书”，需要手动配置。不能依赖旧 FAQ 的自动生成描述。[自定义域名](https://cloud.tencent.com/document/product/1552/127404) |
| 免费证书 | 支持申请、部署和续签；有效期 90 天，到期前 15 天自动申请续期。不支持下载，不承诺证书 SLA。[申请免费证书](https://cloud.tencent.com/document/product/1552/127407) |
| 切换期间可用性 | 自动验证须先切 CNAME，在证书签发前 HTTPS 暂不可用。优先使用 DNS 委派验证，先添加 CA 验证子域名的 CNAME、完成签发和部署，再切业务 `www` CNAME；这不是整域 NS 委派。[申请免费证书](https://cloud.tencent.com/document/product/1552/127407) |
| 旧平台占用 | 腾讯云 CDN 或 EdgeOne 已存在同名域名时，可能要求先删除旧绑定。旧 CloudBase `www` 是否触发该限制尚未验证；触发时先明确精确旧绑定、影响和恢复路径，不猜测删除。[排障指南](https://cloud.tencent.com/document/product/1552/127457) |

### 3.3 费用、额度和承诺

当前免费版：200 个自定义域名、40 个项目、5 GB 总存储、500 次构建/月、100 条 `redirects`；支持免费 SSL。函数另有执行额度，但本候选方案无需函数。[限制与配额](https://cloud.tencent.com/document/product/1552/132789)

网站安全加速流量和请求不限量；新版中国站文档同时说明当前实际额度处于较宽松的免费阶段，商业化后可能调整。现行价格文档尚未公布商业版定价；超额可申请提额，不能由此保证永久免费、永不限速或永不停服，也不能套用普通 EdgeOne 付费 CDN 的超额价格。[常见问题](https://cloud.tencent.com/document/product/1552/127458)、[价格与套餐](https://cloud.tencent.com/document/product/1552/132790)

因此，本方案只能表述为“按当前官方免费版配置，预计无需新增服务费用”；开通时仍需确认控制台实际套餐为免费、未选增值服务、未引入后付费。根域既有 CloudBase 流量和费用不因重定向自动消失。

### 3.4 账号、协议与人工步骤

- 官方准备工作要求登录腾讯云并开通 Makers 服务；可使用现有中国站腾讯云账号，不需要为此另建国际站账号或关联 GitHub。[CLI 准备工作](https://cloud.tencent.com/document/product/1552/127423)、[直接上传](https://cloud.tencent.com/document/product/1552/127371)
- 本次未检查开通界面，**无法确认现有账号是否已开通、是否需要额外协议确认、短信验证或实名认证**。不得把“官方所有用户可开通”写成这些步骤可以免除。
- 若确实需要新注册腾讯云账号，官方注册流程涉及手机号/验证码及服务、隐私、账号协议；本项目已有账号时不主动新建。身份核验、验证码和超出当前授权的协议由用户本人确认。[注册腾讯云](https://cloud.tencent.com/document/product/378/17985)

## 4. 实施前检查与验收建议（未执行）

1. 只读确认旧 `www` 的真实绑定归属、当前有效证书、解析记录和 TTL；保留根域现状。若旧域名占用会阻挡新绑定，先形成可恢复的切换步骤。
2. 在现有腾讯云中国站账号确认 Makers 免费开通条件；出现付费、权限或新授权门槛即暂停，不调用 API 绕过。
3. 经主任务确认后部署独立重定向资产；先验证预览上的外部跳转，再处理自定义域名、证书与 CNAME。
4. 验收 `http://www.../`、`https://www.../`、存在的深层路径、查询参数及中文编码：证书匹配、响应为预期 301/302、`Location` 指向根域、无循环，根域仍返回新版内容。正式 301 应在验证完成后启用。
5. 只有上述生产结果实际观察通过后才另写验收记录。本文不替代规格批准、账号开通确认或生产验收。

## 5. 调研验证记录

- 读取仓库根 `AGENTS.md`，未发现更深层 `AGENTS.md`；写入前目标文件不存在，工作区 `git status --short` 无输出。
- 来源仅采用 CloudBase 与腾讯云/EdgeOne 官方产品文档；未使用开发者社区文章作为结论证据。
- 旧 Pages 页面存在过时数量和证书描述，本结论采用 2026 年更新的腾讯云 Makers 文档；Pages 更名未改变既有账号、项目和域名行为。[官方更名说明](https://cloud.tencent.com/document/product/1552/127458)
- 本次为纯文档调查，不运行网站或 CloudBase 无关测试。链接已通过官方页面读取或官方检索结果核对；生产链路、账号开通状态及方案实施均不在本调研验收范围。
