# 网站登录与投稿恢复计划

> 执行方式：subagent-driven-development。用户已授权自行复审后连续实施，不重复请求批准。

**目标：** 恢复管理员正确登录入口和真实匿名资源上传。

**架构：** 复用既有认证、投稿、存储与审核，仅增加管理员 origin 构建配置并修正远端开关。

**技术栈：** Next.js、React、Vitest、CloudBase CLI 与已登录控制台。

## 全局约束

- 适用规格：`docs/superpowers/specs/2026-09-09-website-login-upload-repair-design.md`。
- 仅网站，禁止桌宠改动、禁止合并，不增加收费服务，不打印任何凭据。
- 保留全部已有工作区改动；只提交本人明确拥有的文件。

### Task 1: 管理员入口最小修复

文件：修改 `apps/website/components/admin/AdminApp.tsx`、`apps/website/tests/admin-app.test.tsx`；按既有位置给网站构建环境示例增加唯一公开配置 `NEXT_PUBLIC_ADMIN_ORIGIN`（若无网站示例则只记录于报告，由主智能体更新部署手册，不创建第二份配置体系）。

构建隔离补充：`tests/build-website-export.mjs` 及其已有 `tools/verification/website-export-isolation.mjs` 和测试必须确保 Memory E2E 构建将该 origin 置空，防止从部署进程继承真实管理员来源而跳离测试环境。复用已有隔离模块，不在认证代码中为 E2E 绕过来源裁决。

接口：管理员组件初始化时读取可选 `NEXT_PUBLIC_ADMIN_ORIGIN`。值未设置则保持原行为；有效且不同来源则跳转 `${target.origin}/admin/`，不得初始化认证或携带输入 URL 的 query/fragment；相同来源正常初始化，无循环。仅接受纯 HTTPS origin（允许结尾斜杠），拒绝账号密码、路径、查询、fragment。错误用现有配置错误 UI。

- [x] 先运行现有管理员定向测试作为基线。
- [x] RED：增加行为测试，真实渲染 AdminApp；用浏览器 location 边界 spy 观察跳转，认证初始化 spy 仅用于验证跳转之前不得启动 SDK。分别覆盖跨来源、同来源、未配置、非法配置。
- [x] GREEN：在现有初始化 effect 中实现最小 origin 检查和跳转；无需新依赖、无需改认证 SDK。
- [x] 运行管理员定向测试、网站全部单元测试和 typecheck；主智能体统一运行带正式公开配置的构建和网站 E2E，避免并发构建互相覆盖。E2E 串行 15/20，五项独立进程复验通过，不能标记整条命令全绿。
- [x] 自查差异并提交仅本任务代码与测试，报告 RED/GREEN 结果；实施子智能体不部署、不操作云端。

### Task 2: 云端配置与验收

由主智能体操作已登录控制台和官方 CLI。先保存配置摘要，保留完整变量仅在内存，关闭 API 响应日志后开启投稿。读取回确认。完整匿名上传受控夹具并确认人工审核状态与公开列表不可见；管理员驳回该测试记录。部署 Task 1 构建产物，实测根域自动到正确管理员入口、发送验证码平台反馈。更新 `docs/operations/cloudbase-deployment.md` 和独立本次验收记录，复审后交付，不合并。

- [x] API CLS 解除绑定，投稿开关 true；读取回 Active，按量付费仍关闭。
- [x] 管理员六项静态产物部署与入口跳转实测；默认域接受验证码发送，后续观察工作台恢复；首页字节哈希不变。
- [ ] 真实受控投稿提交、私有人工队列与驳回验收：表单已准备，待用户确认本次提交所接受的协议，不以本地 E2E 代替真实上传。

执行证据见 `docs/operations/website-login-upload-repair-2026-09-09.md`；当前不将整个修复任务或真实上传标记为完成。
