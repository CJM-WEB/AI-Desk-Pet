# main 与 WebsiteExtension 集成验收记录

## 范围与当前结论

- 日期：2026-09-09；环境：Windows 本地工作区，不涉及云端、线上部署或 Git 推送。
- 依据：用户要求先 `main → WebsiteExtension`，再 `WebsiteExtension → main`；计划见 [双向集成计划](../superpowers/plans/2026-09-09-main-website-integration.md)。
- 网站原始头 `a89920b46ad502a3a3b28adc8028475909232646`；main 原始头 `1e1744015fe3ada982cc170670fa772ed715dd7a`；网站文档现场保存提交 `c8ee7418460b5b5f255b60a1932d7381cad1383d`。
- 三方合并没有文本冲突。第一步候选保留在 WebsiteExtension；当前完整门禁存在失败，尚未执行第二步，不把此记录解释为可以发布的全绿验收。
- main 保持原提交；没有推送、删除分支、删除工作区或修改腾讯云。线上上传仍受体验环境安全域名限制，不因 Git 合并而恢复。

## 恢复点与业务完整性

- 本地恢复引用：`codex/backup-main-before-website-20260909` 与 `codex/backup-website-before-main-20260909`。原先四份未提交的网站运维文档已保存，不丢弃或覆盖。
- 网站应用 `apps/website`、`apps/cloudbase-api`、`apps/package-scanner` 以及 `cloudbase`、`cloudbaserc.json`，对网站文档快照 `c8ee741` 的差异为空。
- 桌宠应用、`agent-core`、`file-tools`、`coding-task-core`、`character-runtime`、`character-assets` 和 `vendor`，对 main 原始头的差异为空。
- 共享文件采用三方合并：main 的桌面契约、编码任务、E2E 入口保留；网站审核契约、子路径导出及对应门禁保留。桌面 E2E 只收集两个桌面文件的 81 项，未混入网站测试；仅列举，不等于运行通过。
- 只读双侧审查确认：7 个桌面相关依赖 importer 与 main 一致；网站侧 284 个传递依赖快照与网站原始头一致。`pnpm-lock.yaml` 相对自动合成树无手工修改。
- main 引入的旧文件中存在空白警告；本轮没有为了格式改变其业务原文。相对 main 的合并新增差异及本轮未暂存差异检查无空白错误。

## 最小集成适配

1. 网站范围门固定基线改为获批 main 原始头，精确补充本次及先前获批的网站文档；保持桌宠禁止目录、manifest 既有脚本保护和退役检查。RED 为 43/45、GREEN 为 45/45；规格与质量独立审查通过。
2. 冻结锁文件安装首次因 `msgpackr-extract` 的可选构建未裁决失败，pnpm 自动加入占位项；将其明确为 false 后重装通过，使用已有预编译可选包，不运行额外本机构建。未改变依赖版本。
3. 网站浏览器配置兼容修复：main 新增的测试入口检查使 `use.reducedMotion` 的 TS2769 暴露。按 [Playwright 官方 contextOptions 文档](https://playwright.dev/docs/api/class-testoptions#test-options-context-options) 与本地锁定版本的类型/运行实现核对，只将选项移至 `use.contextOptions`。现有用例不再自行调用 `emulateMedia` 补救，而是验证真实页面默认媒体条件；RED 实际 false、GREEN 为 true 且交互断言通过。未修改网站或桌宠业务。

## 新鲜验证

| 命令／范围 | 实际结果 |
| --- | --- |
| `pnpm.cmd install --frozen-lockfile` | 明确可选构建配置后退出 0 |
| `pnpm.cmd verify:cloudbase` | 退出 0；API 280/280、Scanner 67/67；构建与类型检查通过 |
| `pnpm.cmd verify:website` | 网站类型、单元 424/424、生产构建和 E2E 构建通过；修复前 E2E 15/20，整体退出 1 |
| `pnpm.cmd test:website-contract` | 34/34，退出 0 |
| `pnpm.cmd test:cloudbase-tools` | 39/39，退出 0 |
| `pnpm.cmd --filter @myself/release-tools test` | 4/4，退出 0；全仓检查过程的 release 类型检查亦通过 |
| `pnpm.cmd --filter @myself/shared-types test` | 67/67，退出 0 |
| `pnpm.cmd test:security` | 16/16，退出 0 |
| `pnpm.cmd --filter @myself/desktop build` | 退出 0，包含 preload 与正式产物边界检查；保留第三方依赖构建警告 |
| `pnpm.cmd verify:desktop` | 首次在网站 Playwright 配置 TS2769 处退出 2，未执行后续链；后续最小适配后单独全仓 `pnpm.cmd typecheck` 退出 0 |
| 网站默认减少动效单项 | RED 真实媒体条件 false；配置修复后 1/1，通过原交互断言 |
| `pnpm.cmd test:unit`（另行执行） | 2784 通过、88 失败，137 文件中 17 失败，另有 3 个未处理错误；不是全绿 |
| `pnpm.cmd --filter @myself/coding-task-core test`（另行执行） | 106 通过、2 失败、1 跳过；失败文件随后独立复测 20/20，通过但不抹去首轮失败 |
| `pnpm.cmd test:integration`（另行执行） | 52/54；Provider 数据不一致及一个素材 fixture 超时 |
| `node --test tools/verification/*.test.mjs` | 111/112；失败为历史依赖审查规则冲突 |
| `pnpm.cmd verify:web-chain:ownership` | 退出 0 |

本轮部分测试同时运行，出现多个超时；未全部独立复验，不推断所有失败均由负载引起。未提高 timeout、添加 retry、放宽断言或修补无关业务来制造通过。网站单元保留 jsdom Canvas/navigation 及预期错误路径警告；它们不是浏览器人工验收。

## 已确认的历史阻断与待处理项

### main 原始分支已复现

- `apps/desktop/tests/pet-visual-geometry.test.ts`：33 项中 30 项失败，返回 `PET_GEOMETRY_MANIFEST_INVALID`。生产在 `0568b033` 切换 V3，测试工厂仍构造 V2。测试及其直接实现与合并树相同。
- `tests/integration/provider-server.test.ts`：13 项中 1 项失败。`75ea43cb` 将 structured 响应拆为独立类型，测试仍将 `structured_output` 放在 text 响应；实际普通文本“向左移动”不能按 JSON 解析。
- 上述复现在 main 现有依赖上直接执行 Vitest CLI 完成，未更改源码或安装。main 的 pnpm 入口另有工作区依赖元数据不同步，不能据此声称 main 原先全绿。

### 网站原始分支已存在

- `deps:audit:web` 返回 6 个 LiquidGlass 导入错误和 8 个 orphan 警告。原始网站头的六处组件导入、两份规则与审查入口完全相同。最终视觉恢复规格批准跨章节有限视觉事件，而旧规则仍禁止该直接依赖；本次不移除获批视觉或放宽规则。
- 完整浏览器测试的五项失败发生在首页进入 interactive、付款码页面初始化或液态画布读取阶段，与此前网站验收记录中的五项一致。相同症状不是本次所有失败原因均已证明的替代；修复配置后的结果另记。

### 尚未满足的第二步条件

- 完整桌面门禁和网站依赖门尚未通过，其他超时与未处理错误也未全部归因。不能把“Git 无冲突”和“业务目录来源正确”写成“整体质量门已通过”。
- 当前不执行 `WebsiteExtension → main`，不回退 main 的 V3／独立结构化响应，也不为合并改写定稿视觉。历史测试与门禁治理需另行明确范围并完成验证后，再执行获批的第二次合并。
