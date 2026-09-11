# 网站共享资源最小开放验收计划

> 执行方式：主智能体按检查项顺序执行；可按 subagent-driven-development 分派独立文档核对。只有实际证据满足时才勾选；本轮结果见[验收记录](../../operations/2026-09-11-shared-resources-opening-acceptance.md)。

**目标：** 在现有个人版 CloudBase 环境接通官网匿名上传、管理员直接人工审核和匿名完整下载。

**方案：** 遵循[已确认规格](../specs/2026-09-11-shared-resources-opening-design.md)，只调整必要的安全来源与投稿开关，复用已有私有上传、人工队列、强制发布和下载链。跳过 Scanner，不新建环境，不修改业务代码。

**技术栈：** CloudBase PostgreSQL、私有 Storage、现有 API／cleanup 云函数、Next.js 官网。

## 全局约束与文件

- 唯一目标环境：上海 `ai-pet-scanner-dev-d0cpbc8094826`；官网 `https://cjmwebsite.cn`。
- 用户表示个人版已购；先核对生效，不代购、不重复购买、不开启按量付费、不新建生产环境。
- 不运行或修复 Scanner；人工审核继续使用两步 `force_publish`、`ADMIN_OVERRIDE_ACCEPTED` 和公开 `admin_override` 提示。
- 私有 Bucket、短期签名、限流、管理员授权、版本、幂等与审计保持原边界；API CLS 不得记录签名或状态令牌。
- 文档范围为本计划、对应规格与 `docs/research/2026-09-11-shared-resources-opening-analysis.md` 顶部替代说明。云端实际验收结束后另写 `docs/operations/2026-09-11-shared-resources-opening-acceptance.md`，并同步部署／审核运维入口的当前摘要；不修改旧验收事实。
- 不执行 Git 写操作，不修改桌面、官网、API 或 Scanner 业务代码，不批量删除文件或云端内容。

## 任务 1：核对当前能力并配置精确来源

**依赖：** 已确认规格；用户现有控制台会话。输出是当前配置证据，不是上传成功。

- [x] 只读核对目标环境 ID、上海地域、个人版生效、API／cleanup 正常与投稿开关当前值；记录观察时间。
- [x] 检查 Web 安全域名／HTTP 网关跨域来源，仅补充官网 `https://cjmwebsite.cn` 对应的精确配置，保留其他来源；读取确认添加结果。
- [x] 检查 API 的 `ClsLogsetId`、`ClsTopicId` 为空；若日志门不满足，保持投稿关闭并在原授权范围内处理，不能带签名响应开启实测。

**完成标准：** 套餐和来源均已实际读取确认，私有与日志边界满足；未购买、新建或修改无关资源。

## 任务 2：受控真实上传与私有待审

**依赖：** 任务 1 通过。参考现有 `apps/website/components/website-experience/community/cloud-shared-pet-repository.ts` 与 `apps/cloudbase-api/src/services/submission-service.ts`，不修改两者。

- [x] 复用现有不含个人资料、符合现有尺寸/MIME要求的最小 V1 夹具封面与 ZIP；记录文件大小和 SHA-256。保留 ZIP 原字节供下载比对，不修改版本号或据此扩大兼容性结论。
- [x] 保留所有其他函数环境变量和空 CLS 绑定，仅将 `SHARED_PACKAGE_SUBMISSIONS_ENABLED` 设为 true 并读取确认。
- [x] 从 `https://cjmwebsite.cn` 的实际浏览器提交成功，结合既有 prepare／两次 PUT／finalize 顺序实现、成功回执和真实文件观察，确认投稿进入人工待审；没有导出逐条网络响应。
- [x] 核对实际对象的大小/MIME和待审队列；匿名公开列表为空，未审核投稿的详情与下载均 404。
- [ ] 投稿者专属状态查询页：浏览器工具 URL 安全策略拦截，未验证且未绕过；不据此推断网站接口失败。
- 本轮上传主链路未失败，不触发回滚。后续必需链路失败则恢复 false，读取确认并记录阶段。

**完成标准：** 同一受控投稿完成真实直传并保持私有待审，不以本地 Mock 或历史响应代替。

## 任务 3：直接人工审核与完整公开下载

**依赖：** 任务 2 通过。复用现有管理员和公开下载界面，不调用 Scanner、不构造技术通过证据。

- [x] 管理员直接检查受控投稿，填写理由，经过既有两步风险确认执行 `force_publish`。
- [x] 核对 `published + admin_override`、审核审计和公开卡片／详情／下载入口的人工放行风险提示。
- [x] 独立公开页面的下载按钮触发真实 download 事件；另用无 Cookie／Authorization 的匿名 HTTP 链路完整下载同一 ZIP，1376 字节和 SHA-256 均匹配原包。浏览器工具不提供落盘读取接口，两项证据分别记录，不把下载事件或计数当作完整文件哈希。
- [x] 仅软下架本次测试样本并核对隔离状态、审计和新下载请求 404；不永久删除用户数据。本轮未发生必需链路失败，未触发投稿回滚。

**完成标准：** 上传、人工裁决、公开风险提示与匿名完整下载哈希均有本轮证据，之后才宣布本轮上传与下载开放验证通过。不声称 V2/V3 或全部新旧包兼容，不声称桌面已启用。

**非阻断补充：** 桌面回导可在今后确有需要时另行验证，本次不执行，不作为开放门禁，也不延伸为 Scanner 或桌面改造。

## 任务 4：验收记录与差异核对

- [x] 主智能体在独立验收记录中写明日期、环境、真实配置和操作结果、是否保持投稿开启、失败／未验证项及回滚结果；不包含密钥、OTP、状态令牌、签名 URL 或私有对象地址。
- [x] 核对本轮七份文档的中文 UTF-8、链接和替代关系；对当前文档差异运行 `git diff --check`，不执行 Git 写操作。独立复核指出的旧费用建议已补充明确替代说明。
- [x] 本轮只有云端配置和文档修改，未运行无关业务测试。如果后续另行形成必要代码修复，则先 RED/GREEN，再执行对应 package 的测试与 typecheck，并按影响范围追加 `pnpm.cmd verify:website` 或 `pnpm.cmd verify:cloudbase`。

**完成标准：** 规格、计划与验收职责分离；未执行步骤不勾选，未观察到的结果不写通过。
