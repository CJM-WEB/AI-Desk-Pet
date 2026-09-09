# main 与 WebsiteExtension 双向集成计划

## 授权与边界

- 依据：2026-09-09 用户明确要求先将 `main` 合并到 `WebsiteExtension`，验证后再将 `WebsiteExtension` 合并到 `main`。
- 网站业务以网站分支为准，桌宠业务以 main 为准；共享文件采用三方合并，保留双方互不冲突的职责。不新增功能，不重新部署，不修改云资源，不推送远端，不删除分支或工作区。
- 网站原始提交：`a89920b46ad502a3a3b28adc8028475909232646`；main 原始提交：`1e1744015fe3ada982cc170670fa772ed715dd7a`；共同祖先：`0dab17de8863a7c726a5bb5fceff35a1713daad1`。
- 网站分支四份既有未提交文档先核对并保存为独立提交；main 工作区必须保持干净。两端创建恢复引用，禁止通过硬重置丢弃已有工作。

## 最新执行裁决

- 2026-09-09 用户在获知门禁失败及暂缓状态后明确要求执行第二步，替代先前暂不合并的决定。本轮执行已审查快照的本地快进集成，不新增业务修复，不推送或部署，不将已知测试失败改写为通过。
- 第一阶段合并提交为 `520264eb`；第二阶段首次快进将 main 从 `1e174401` 推进到 `fed2dca0`。后续仅同步收尾记录，最终以两分支提交和树完全一致、工作区干净为 Git 集成完成证据。
- 下方步骤 4 的暂缓要求保留为先前流程记录，本次版本合并按用户最新指令执行；完整质量门与生产发布仍待独立验收。

## 可检查步骤

1. 保存边界与现场：核对双方工作区、分支、适用规则、原始提交和既有文档差异。保存恢复引用与网站文档提交。
2. 在网站分支执行 `git merge --no-ff --no-commit main`。网站三个应用目录须与网站快照完全一致，桌宠应用及专属包须与 main 原始提交完全一致。共享契约、依赖、测试与规则由两名只读子智能体分别审查，主智能体复核。
3. 运行合并后的依赖安装校验、全工作区类型检查、网站、CloudBase、桌面验证。现有测试作为本次集成回归证据；若发现合并引入的缺陷，先保留稳定失败用例，再作最小修复。纯版本集成不另造功能测试。
4. 在网站分支保存明确标注验收状态的合并候选检查点，以便运行依赖提交祖先关系的范围门；候选提交不代表完整门禁通过。记录实际结果及既存限制，若关键问题尚未解决，不推进 main。
5. 再次核对 main 未被其他任务改变且工作区干净，在 main 工作区执行 `git merge --ff-only WebsiteExtension`；第一步已包含 main 历史，允许用快进完成第二步，不制造多余合并提交。
6. 复核两分支提交及树一致、双亲来源可追溯、无冲突标记、工作区干净。交付提交号、测试证据和未验证范围。

## 时间与验收约束

- 单个卡点 15 分钟内换更小的检查或替代方案，单轮任务按用户要求控制在 40 分钟内；长命令使用后台会话读取进度。
- 不降低安全或业务断言，不将旧验收冒充新结果；浏览器运行器的既存限制须独立复验并如实记录。
- 这次 Git 集成不代表线上资源上传问题已修复，也不代表生产部署完成；其状态继续以网站登录与上传修复验收记录为准。

## Task 1：合并后范围门基线适配

- 原因：旧固定基线把本次用户明确批准并入的 main 桌宠历史误判为网站越界。仅迁移到上文 main 原始提交，不使用动态 HEAD，不删除范围门。
- 修改文件：`tools/verification/website-scope-policy.mjs`、`tools/verification/verify-website-scope.test.mjs`。
- 固定基线改为 `1e1744015fe3ada982cc170670fa772ed715dd7a`。禁止目录、manifest 既有脚本约束和退役检查均保持原样。
- 精确增加文档白名单：`docs/operations/website-www-https-options-2026-09-03.md`、`docs/superpowers/plans/2026-09-03-website-www-entry-unification.md`、`docs/operations/website-login-upload-repair-2026-09-09.md`、`docs/superpowers/specs/2026-09-09-website-login-upload-repair-design.md`、`docs/superpowers/plans/2026-09-09-website-login-upload-repair.md`、本计划及 `docs/operations/main-website-integration-2026-09-09.md`。
- 安装已复现 main 原有缺项：`msgpackr-extract` 的可选本机构建未裁决，pnpm 写入占位配置后拒绝后续命令。主智能体将 `pnpm-workspace.yaml` 中该项明确为 false，保留锁文件内的预编译包，不启用额外构建脚本。范围策略须允许这个精确配置路径；不改其他依赖版本。
- RED：先以真实 Git 固定基线读取 package.json，验证其与合并后的 manifest 比较不误报 main 已批准脚本，同时仍拒绝任意桌宠脚本改写；新增精确文档白名单行为测试，拒绝相似未获批文件。避免只断言一个常量等于自身预期的形式测试。
- GREEN：仅更新基线与精确路径列表，运行 `node --test tools/verification/verify-website-scope.test.mjs`。实际整仓范围命令要在网站分支合并提交后执行，因为未提交合并的索引仍包含 main 导入差异；此时 main 分支仍不更新。
- 子智能体不得 Git 写入或修改其他文件；主智能体保留合并索引的唯一控制权。报告记录 RED/GREEN 输出与限制。

## Task 2：网站浏览器测试选项兼容

- 现有失败：合入 main 新增的 E2E 归属测试后，桌面类型检查两次在 `tests/playwright.website.config.ts` 的 `use.reducedMotion` 处报告 TS2769。当前锁定 Playwright 的 TestOptions 未暴露该字段，浏览器上下文则支持；官方 contextOptions 文档也提供该设置方式。
- 修改范围：仅 `tests/playwright.website.config.ts` 与 `tests/e2e/website.spec.ts`，不改业务代码、依赖版本、超时、重试或已有交互断言。
- RED：在现有“减少动态效果直接进入稳定首页”用例中，取消测试自己调用 `emulateMedia` 的补救，先直接断言新页面的 `matchMedia('(prefers-reduced-motion: reduce)').matches` 为 true；用实际网站 Playwright 配置运行该单项，记录默认配置未生效的失败。
- GREEN：仅把网站配置的 `use.reducedMotion` 移到 `use.contextOptions.reducedMotion`，保留值 `reduce`，加中文结构性注释说明当前锁定版本的上下文选项边界。重跑同一单项及桌面 typecheck；不修改桌面文件。
- 产物复用已构建的 `.e2e-out`；若主智能体仍在运行完整网站 E2E，先等待其结束，避免并行 GPU 测试相互影响。报告存入本计划隔离工作目录的 `task-2-report.md`，禁止 Git 写操作。
