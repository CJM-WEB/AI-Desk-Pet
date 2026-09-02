# 内容审核与应急处置手册

本手册供唯一管理员审核 AI Pet 共享资源包、反馈和建议。普通投稿匿名；管理员身份、私有对象地址、状态令牌和审核证据不得公开。

> 当前状态（2026-09-02）：本地人工审核路径和上海免费开发环境均已验证，`remote: pass`。基础设施、真实管理员 OTP、公开反馈／建议正文及其点赞、共享包强制发布/风险披露/互动/隔离清理均已通过；cleanup 每日 timer 配置已创建并启用，函数直调和真实清理通过，自然定时投递尚未观察。用户已确认不实现共享资源留言或回复。本文表示阶段 2C 开发／测试验收通过，不表示正式上线；现行证据见 `website-stage-2c-zero-cost-manual-review-acceptance.md`。

## 1. 审核原则

- 只公开与 AI Pet 直接相关且不含政治、色情、暴力、违法、广告、隐私泄露、恶意文件或侵权风险的内容。
- 新共享包上传完成后直接进入 `manual_review_pending`；新反馈和建议创建后同样直接进入 `manual_review_pending`。
- 新共享包没有当前有效系统扫描通过证据。普通批准必须失败关闭并返回 `TECHNICAL_SCAN_REQUIRED`；本地 Docker 报告不是系统通过证据。
- 反馈和建议不依赖角色包技术证据，管理员人工审核通过后可执行普通 `approve`，发布依据为 `standard`。
- 共享包如需公开，唯一管理员必须在人工审核与独立风险确认后执行 `force_publish`；发布依据必须为 `admin_override`，同时保留原扫描事实、风险确认、审计和公开风险提示。
- 普通批准与强制发布都不能绕过非空标题/正文、固定对象键、恰好一个 cover 和 package、MIME、实际正大小及其他发布结构不变量。

历史 `system_reviewing` 与 `auto_rejected` 仅用于兼容已有记录。管理员可将其转入人工队列，但不得把历史状态误写成仍有自动审核运行时。

## 2. 共享包本地 Docker 检查

按以下顺序执行，不得跳过或增加第二个扫描/预览工具：

1. 在管理员详情使用“下载待审 ZIP（5分钟）”链接下载 ZIP，保存到独立的待审目录；短期地址不进入公开 DTO、日志或下载计数。
2. 对该同一文件记录 SHA-256，再运行下列现有 Docker CLI。构建阶段的 `freshclam` 需要网络取得病毒库；运行阶段必须保持 `--network none`。UTC 日期构建参数使病毒库每日刷新，候选验证拒绝超过 7 天的数据库；超过时限应重新构建并验证。

```powershell
$clamavRefreshDate = (Get-Date).ToUniversalTime().ToString('yyyy-MM-dd')
docker build --file apps/package-scanner/Dockerfile `
  --build-arg "CLAMAV_DB_REFRESH_DATE=$clamavRefreshDate" `
  --tag ai-pet-package-scanner:local .

$archivePath = (Resolve-Path '.\package.zip').Path
Get-FileHash -LiteralPath $archivePath -Algorithm SHA256
docker run --rm --network none --read-only --cap-drop ALL `
  --tmpfs /tmp/scan:rw,noexec,nosuid,nodev,mode=1777 `
  --mount "type=bind,source=$archivePath,target=/input/package.zip,readonly" `
  ai-pet-package-scanner:local /input/package.zip
```

3. 保存该 ZIP 的 SHA-256 和 CLI JSON；同时保存当前候选镜像验证中的 `clean`、`eicar` 与 `invalid` 结果。CLI 成功后，才可用归档管理器以只读方式打开**同一 ZIP**，在一次性预览目录检查全部图片。
4. 检查完成后删除本地 ZIP 副本与一次性预览目录；不创建预览导出器、不上传本地报告。

镜像默认以非 root `scanner` 用户运行；根文件系统和输入 ZIP 均为只读。唯一可写位置是 `/tmp/scan` tmpfs，`mode=1777` 是非 root ClamAV 创建临时文件的必要条件。不得向容器传入云凭据、管理员令牌、私有对象地址或任何 Scanner Secret。

报告为本地 JSON：成功表示 ZIP 预算、路径、图片解码、角色结构和 ClamAV 检查完成，并且固定包含 `manualReviewRequired: true`。管理员必须人工查看封面和所有需审核图片；这些都是人工观察，不产生系统通过证据，发布仍只能使用 `force_publish` / `admin_override`。EICAR、非法结构、扫描超时、病毒库缺失或其他依赖失败均应保持内容隐藏并记录稳定错误码。

## 3. 每日人工队列

1. 登录 `/admin`，确认使用唯一管理员的邮箱 OTP。
   - 当前免费开发环境不能新增 `cjmwebsite.cn` Web 安全域名，因此管理员从既有默认静态托管域名的 `/admin` 登录；备案根域名主要供公开网站使用。不得为此升级套餐或关闭管理员双头认证。
2. 刷新待审核详情，核对标题、正文、封面、图片、版权、广告、联系方式、隐私和与 AI Pet 的相关性。
3. 共享包先阅读本地 Docker 报告并人工查看图片；报告只辅助风险判断，不是自动发布条件。
4. 每次管理员动作带状态版本和幂等键。遇到 409 时重新加载详情，不得重放旧操作。

## 4. 发布裁决

### 4.1 反馈与建议：普通批准

确认内容满足审核原则后，填写最小必要理由并执行普通 `approve`。成功后内容公开，`publication_basis=standard`。不需要角色包扫描报告。

### 4.2 共享包：强制发布

共享包在 `manual_review_pending` 且没有当前有效系统通过证据时：

1. 填写具体审核理由；
2. 第一次点击只展开风险确认；
3. 完整阅读风险说明后，提交 `ADMIN_OVERRIDE_ACCEPTED`；
4. 执行 `force_publish`，确认结果为 `published` 且 `publication_basis=admin_override`；
5. 检查公开卡片、详情与下载入口显示“管理员人工放行，未通过系统安全验证”。

该动作不得制造或改写通过证据，不得删除历史扫描事实、风险摘要、状态版本或审计快照。任何数据库、存储、管理员授权或结构断言失败时都失败关闭。

## 5. 驳回、删除与恢复

人工审核不通过时，填写与规则对应的简短理由并驳回，正文和文件保持私有。已公开内容遇到投诉、漏审或紧急风险时立即删除并确认公开列表消失、下载不再签发地址、审计记录保留。

恢复前重新核对内容和原因。反馈与建议按删除前状态恢复；共享包恢复后只回到人工审核，不能自动公开或把本地报告当成系统扫描通过。到期清理由 `ai-pet-cleanup` 承担，远端唯一的每日 timer 已创建并启用，但自然定时投递尚未观察；未来触发成功仍须以对象、资产行、投稿字段和审计事实的实际结果判断，不能仅凭触发器存在宣称已清理。

## 6. 审计、失败关闭与应急

每个管理员写操作必须保存管理员授权、目标投稿、前后状态、理由、幂等键、版本和时间。强制发布额外保留精确风险确认、可见扫描摘要和动作快照。审计不得保存完整违规正文、私有文件、状态令牌、签名地址、密钥或主机绝对路径。

数据库、存储、授权、结构检查、本地扫描或人工判断任一环节不足时，保持内容隐藏。发现恶意文件、批量违规、权限绕过或令牌泄露时，关闭匿名写路径、下架受影响内容、使下载失效并按授权轮换受影响密钥；恢复前重新验证匿名与管理员边界。

## 7. 已退役能力

腾讯 TMS、腾讯 IMS、CloudBase Run Scanner、远程 Scanner HTTP/HMAC、`ai-pet-moderation-worker` 和自动审核结果回写均已退役，禁止作为人工审核的执行步骤、审批依据或故障降级路径。旧记录中的扫描事实仍可读，但不代表这些服务正在运行。
