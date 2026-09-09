# 网站验证码与资源投稿恢复验收

日期：2026-09-09（北京时间）。范围：上海 `ai-pet-scanner-dev-d0cpbc8094826`、现有网站及管理员入口；不涉及桌宠、套餐购买、合并或新的生产环境。

## 复现与原因

- 根域 `https://cjmwebsite.cn/admin/` 向既有管理员邮箱发送验证码，显示“验证码暂时无法发送，请稍后重试”。CloudBase 邮箱验证码登录为启用、云开发代发；Web 安全域名包含默认托管域名，不包含根域。体验版不增加收费认证域名权限。
- 原默认托管域已有管理员会话可读队列。退出后重新发送，页面由邮箱表单切换到“邮箱验证码”输入框，证明平台已接受本次发送；随后实际浏览器再次显示“内容审核控制台”和审核队列，管理员会话已恢复。未读取收件箱或验证码，不能据此声称亲眼确认邮件投递内容。
- 匿名 `POST /api/v1/submissions/prepare` 在开关修复前返回 `503 / SHARED_PACKAGE_SUBMISSIONS_PAUSED`，没有创建投稿；远端 API 函数开关确为 false，函数与环境正常。不是缺失上传代码或数据库。

## 云端配置事实

- 官方 `SCF.UpdateFunctionConfiguration` 解除 API 函数日志绑定（保留角色）：请求 `1707cff3-4b7a-4990-81e8-a8ccc80d54bd`。
- 随后在内存中保留七项完整环境变量，仅将 `SHARED_PACKAGE_SUBMISSIONS_ENABLED` 改为 true，显式保持两个 CLS 标识为空：请求 `cccd0cd3-794f-49b3-92f8-795aec34578e`。
- 读取回：API 函数 `Active`，投稿开关 true，`ClsLogsetId` 与 `ClsTopicId` 都为空。没有改变身份校验、私有 Bucket 或人工审核规则。不得用默认注入 CLS 绑定的 SDK 更新方式意外重新启用响应日志。
- 套餐页：免费体验版，有效期至 2027-03-01；当前周期消耗 269.4 / 3000 点，按量付费关闭。本次没有购买、升级、新建收费资源。这是观察时点的用量，不是无限免费承诺。

## 本地修复与质量检查

- 管理员初始化增加可选 `NEXT_PUBLIC_ADMIN_ORIGIN`，在认证 SDK 前统一入口；部署值为 `https://ai-pet-scanner-dev-d0cpbc8094826-1391054083.tcloudbaseapp.com`。无配置保持原行为。
- E2E 构建在既有隔离模块中将该变量置空，不能将真实管理员来源带入 Memory API 测试。
- 原始配置只接受精确 HTTPS origin 或其结尾斜杠形式；规范化路径、空 query/fragment 等变体先 RED 后 GREEN。首次独立复审指出的归一化漏洞已修复，复审通过。
- 管理员定向测试 41/41，网站单元测试 424/424，网站 typecheck 通过；构建隔离测试 25/25。
- 最终独立复审没有代码阻断项，指出原测试只观察令牌读取、未直接观察认证工厂的一处 Minor。已在两个既有测试位置改为不注入 auth、直接监听真实 `createAdminAuth` 导出；没有增加生产代码或测试数量。复审确认问题消除，再运行 44 个文件共 424 项测试及 typecheck 均通过；这次仅测试修正，无需再次部署。
- 首次错误地在质量门禁整体进程中注入生产配置，造成两项既有单元测试的默认环境假设不成立；未改业务或测试迎合，改为无生产配置运行质量门禁，部署构建单独注入正式公开配置。
- 无生产变量的 `pnpm.cmd verify:website` 完成 typecheck、424 项单元测试、常规构建和隔离 E2E 构建；串行浏览器结果为 15/20，通过数不能写成全绿。五项超时均在首页渲染或画布响应位置，尚未到其目标交互；此前 2026-09-02 已记录同类共享浏览器渲染停滞。
- 对五项失败分别启动独立 Playwright 进程，原断言、原超时不变，全部通过：共享包人工队列/强制发布风险披露、568×320 投稿编辑器、付款码输入隔离、390 付款码安全边距、390 首页画布离开返回。命令模式为 `node node_modules/@playwright/test/cli.js test --config tests/playwright.website.config.ts --grep '<原用例名称>' --output '<独立结果目录>'`。结果目录位于 `tests/.playwright-output/website-isolated-*-20260909`（共享包目录为 `website-isolated-20260909`）。这证明全部 20 个用例至少一次通过，不等于同一次完整命令通过；浏览器复用稳定性未在本次修复。

## 线上部署与入口验收

- 正式公开配置单独注入构建进程，不写入新的环境文件。现有公开 Key 解码核对为目标环境的 `anon` 角色；构建成功，Build ID 为 `y_jTA7Y7iPYTpfay53zdE`。部署的是 `apps/website/out`，不是 `.e2e-out`，产物不含测试管理员会话字面量。
- 只上传六个文件，先哈希资产后入口：`_next/static/chunks/app/admin/page-8dbaeb98bfd9f05a.js`、`_next/static/chunks/webpack-8b59808a95735acd.js`、该 Build ID 下的 `_buildManifest.js` 与 `_ssgManifest.js`、`admin/index.txt`、`admin/index.html`。CLI 分别确认 4/4、2/2 成功；远端管理员脚本与本地内容一致。不删除旧哈希文件，不覆盖首页或桌宠产物。
- 使用官方 `PurgeHTTPServiceCache` 提交仅管理员三条 URL 的缓存刷新，请求 `24a3886e-a5be-4f0f-b5f7-5a5e1cca5b5c`，任务 `636499838459986721`。任务查询返回平台 `FailedOperation.ThirdServiceError`，未将查询错误当作刷新成功证明；后续普通 HTTP 实测管理员入口 200 且已引用新脚本。
- 实际浏览器新标签从 `https://cjmwebsite.cn/admin/?repair=20260909` 自动跳至默认托管域的 `/admin/`，查询参数未携带，显示“内容审核控制台”、官方下载点击指标和原待审队列。旧标签曾遇到连接关闭的浏览器错误页，使用同浏览器新标签验证成功；未更改网络或绕过证书提示。
- 部署前后 `https://cjmwebsite.cn/` 的首页均为 31526 字节，SHA256 均为 `65726be22ccaada18ad880a44fdc4fc318137fd561b55f32a54f2157d8c227ba`。首页及视觉资产未变化。

## 真实上传验收状态

已选择不含个人资料的受控夹具：PNG 68 字节，SHA256 `431ced6916a2a21a156e38701afe55bbd7f88969fbbfc56d7fe099d47f265460`；ZIP 1376 字节，SHA256 `ed48b5f9ed0df4bf1f0d36de95f904abae6ecb0c618d33dd71d3dce3590264ea`。浏览器表单处于提交前，因页面注明提交即同意协议，已请求本次测试确认。尚未将此写成完整真实上传通过。不会公开测试包，也不会动既有用户反馈。

## 官方依据

- [CloudBase 身份认证 API](https://docs.cloudbase.net/api-reference/webv3/authentication)
- [腾讯云更新函数配置](https://cloud.tencent.cn/document/product/583/18580)
- [腾讯云函数日志响应摘要说明](https://cloud.tencent.com/document/product/583/52637)
- [静态托管 CDN 缓存](https://cloud.tencent.com/document/product/876/46900)
- [刷新云开发 HTTP 服务缓存](https://cloud.tencent.com/document/api/876/137741)

回滚边界：只恢复管理员入口产物及将投稿开关设为 false，不重新启用响应日志，不恢复旧网站首页，不修改用户投稿。
