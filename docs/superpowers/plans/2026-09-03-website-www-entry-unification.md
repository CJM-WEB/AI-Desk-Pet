# 网站 www 入口统一运维计划

> 执行方式：主智能体操作已登录控制台，子智能体独立核对官方资料。遵守既有系统排障与完成前验证流程；本次不是网站功能开发，不修改业务源码。

## 目标与边界

用户于 2026-09-03 授权统一新旧网站入口，并允许采用 CloudBase 现有绑定之外的免费 HTTPS 跳转方案。目标是 `www.cjmwebsite.cn` 的 HTTP 与 HTTPS 请求转到 `https://cjmwebsite.cn`，保留路径与查询参数。上海 CloudBase 网站、API、认证、数据库、投稿开关和桌宠业务均不变；不得购买、升级或开启按量付费；不得绕过 CloudBase 体验版新增域名限制。

## 现状与方案

- 切换前：根域首页是 2026-09-02 新版，SHA256 为 `65726be22ccaada18ad880a44fdc4fc318137fd561b55f32a54f2157d8c227ba`；`www` 返回 2026-08-08 旧版。
- CloudBase 旧环境控制台显示临时隔离；新环境新增域名被套餐限制阻止。解绑旧站不等于新环境获得接入权限。
- 使用已获授权的独立 Makers 跳转项目，仅上传 `edgeone.json` 和不含业务内容的 `index.html`，不添加函数、数据库、密钥或依赖。首个 `/*` → `https://cjmwebsite.cn/:splat` 候选已因实际跳转失败被替换；最终采用 `$wwwhost` → `$host` 的原生 301 规则，并在平台开启强制 HTTPS 301。
- 原生域名规则只对自定义域名生效，因此先添加 `www`、复用已有有效 SSL 证书，通过定向连接验证，再更新 DNS。若域名占用要求不可逆解绑或出现新协议确认，按行动时确认规则停止，不先拆旧入口。
- 部署资产临时存放于系统临时目录，不加入网站构建或工作区包配置；本计划保留准确规则作为复现说明。

## 步骤与验收

- [x] RED：2026-09-03 对 `http://www.cjmwebsite.cn/`、`https://www.cjmwebsite.cn/` 和带查询参数的投稿状态页执行不跟随重定向的 HTTP 检查，三项均得到 200、没有 Location，与预期跳转不符。
- [x] 官方资料和账号条件调查：Makers 免费服务可开通，当前账号已进入空项目列表；没有购买或接受额外收费安排。
- [x] 验证候选配置。首个两文件部署虽成功，但默认预览根路径实际跳到字面值 `/:splat` 并丢失查询参数，已判失败且未切换 DNS。第二候选使用原生反向域名规则，通过两个目标节点、四组路径的 8/8 HTTPS 定向测试，保留深层路径、查询参数、中文百分号编码与末尾斜杠。强制 HTTPS 生效后，HTTP 深层链接经过两次 301 最终到 HTTPS 根域，返回 200，无循环且证书校验通过。
- [x] 关联 `www` 并配置有效 HTTPS。独立项目为 `makers-qt1q5odhgrbd`，生效部署为 `dpmwptdfbx9l`。归属验证使用 `edgeonereclaim.www` TXT；已有证书 `ZfX6LSdA` 同时覆盖根域与 www，到期时间为 2026-10-30 21:59:59，控制台确认已部署。未删除旧 CloudBase 绑定。
- [x] 记录原 www CNAME `www.cjmwebsite.cn.tcbaccess.tencentcloudbase.com` 和 TTL 600；2026-09-03 11:15:50 仅将 www 改为 `www.cjmwebsite.cn.pages.dnsoe6.com`，根域、MX、NS 和既有证书验证记录不变。Google 公共 DNS 随即返回新 CNAME。
- [x] GREEN（命令行与公共 DNS）：普通网络复验四个 HTTP/HTTPS 根域与 www 入口均返回新版首页，SHA256 完全一致；www 最终地址为 `https://cjmwebsite.cn/`。公开 API 为 200，匿名管理员 API 为 401。
- [ ] 当前浏览器缓存窗口后复验：11:26 原 TTL 窗口后，刷新与新标签的部分 www 请求仍出现旧 chunk，未通过；命令行和公共 DNS 持续通过，腾讯云域名已生效、证书已部署。现有浏览器工具不提供 DNS/连接缓存清除能力，未关闭整个用户应用或删除其缓存。配置切换已完成，当前客户端需重新启动浏览器或等待进一步传播后复查，不把它扩大为所有浏览器已同步；已保留直接访问新版根域的标签。
- [x] 更新现行运维手册和既有阶段 2C 验收记录中的 2026-09-03 补充节；检查 `git diff --check`，确认无业务源码变更。不合并分支。

## 失败与恢复

DNS 切换前失败时保留现有入口。切换后若 HTTPS 或跳转失败，可恢复记录中的原 www CNAME；该恢复会重新暴露旧版，应仅作为短期恢复并明确告知用户，不能算完成。根域全程保持正常。免费政策按当前官方文档和控制台记录，不承诺永久不变。

## 证书授权与最终配置

2026-09-03 11:07，配置现有 SSL 托管证书时，腾讯云要求创建服务相关角色 `TEO_QCSLinkedRoleInCertlist`，关联预设策略 `QcloudAccessForTEOLinkedRoleInCertlist`。官方策略对全部证书资源允许查询、下载、修改别名和上传，并非仅允许读取当前 www 证书；其列出的动作不包含数据库访问或证书购买。已向用户说明权限范围并暂停；用户随后明确批准，11:11 后按正常控制台流程完成授权。未绕过权限，也未下载或输出证书私钥。

最终 `edgeone.json` 为以下单条配置，平台另开启 www 强制 HTTPS 301；没有自编跳转函数：

```json
{
  "redirects": [
    {
      "source": "$wwwhost",
      "destination": "$host",
      "statusCode": 301
    }
  ]
}
```

历史候选部署仍保留在平台部署历史中，但不再承接流量；未为清理历史执行删除。切换前失败、传播过程和最终成功证据见 [既有验收记录](../../operations/website-stage-2c-zero-cost-manual-review-acceptance.md) 的 2026-09-03 补充节，不以计划代替实际结果。本次不改网站业务源码、不执行 Git 写操作、不购买或升级服务。

## 官方依据

- [CloudBase 跨环境迁移](https://docs.cloudbase.net/quick-start/env-transfer)：目标环境重新配置域名与证书。
- [Makers 自定义域名](https://cloud.tencent.com/document/product/1552/127404)：域名归属、CNAME 与 HTTPS 设置。
- [Makers 免费配额](https://cloud.tencent.com/document/product/1552/132789)：当前免费域名和 SSL 配额。
- [平台跳转配置](https://pages.edgeone.ai/document/edgeone-json)：301、绝对目标地址及路径匹配。
- [EdgeOne 服务角色权限](https://cloud.tencent.com/document/product/598/85219/)：`QcloudAccessForTEOLinkedRoleInCertlist` 的证书权限范围。
