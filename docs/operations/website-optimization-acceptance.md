# 网站架构优化阶段 2—3 本地验收记录

> 日期：2026-08-31
> 分支：`WebsiteExtension`
> 实现候选：`fbd044be417fcf6da3e5f991fbece95b4fbf9fe3`
> 总裁决：`blocked/unverified`；普通非投稿网站新功能继续冻结
> 适用范围：阶段 2A、阶段 2B、阶段 3 的本地证据及阶段 2C、生产状态；不替代 2026-08-20 的网站视觉验收记录

## 1. 阶段裁决

| 阶段 | 结论 | 实际证据与边界 |
| --- | --- | --- |
| 2A 本地结构门 | PASS | CloudBase V3 SDK、唯一 ScannerProtocol、受控 migration Adapter、scope 与 ownership 门通过。 |
| 2B 本地运行候选门 | `blocked/unverified` | PostgreSQL 17.11 顺序执行 7 个 migration 并通过 42 项行为验证；Scanner 构建、测试和候选验证器测试通过。由于本机不存在 `dockerDesktopLinuxEngine`，真实 Node 22 容器的非 root、health、EICAR 与 timeout 候选未运行，因此阶段 2B 不得记为通过。 |
| 3 HTTP 契约门 | PASS | 共享 strict HTTP 信封与 endpoint Schema、Production 与 Memory 双 Adapter 行为合同及独立规格/工程标准双审通过。 |
| 2C CloudBase 开发环境门 | 未执行 | 未连接 CloudBase 开发环境，未执行远端 migration、函数/Scanner/Hosting 部署，也未验证真实网关、对象身份、整轮锁或远端续跑。 |
| 正式生产 | 未部署 | 现在线上仍是旧测试版；本分支未上线，共享包投稿开关继续关闭。 |

## 2. 新鲜自动化证据

| 命令 | 2026-08-31 结果 |
| --- | --- |
| `pnpm.cmd verify:cloudbase` | CloudBase API 268/268、Scanner 71/71；构建与 typecheck 通过。 |
| `pnpm.cmd verify:website` | Website 348/348、两次构建、E2E 21/21。 |
| `pnpm.cmd test:website-contract` | 专属 strict TypeScript 编译与 Production/Memory 双 Adapter 行为合同 12/12。 |
| `pnpm.cmd verify:web-chain:fast` | 验证工具 70/70、shared-types 51/51、Website 348、CloudBase fast 266、Scanner 71、release-tools 4、migration 工具 36、PostgreSQL 行为 42、网站合同 12；依赖审查 0 error、9 个既有 warning。 |
| `pnpm.cmd verify:scanner-candidate` | 失败：本机缺少 Docker Linux engine named pipe；没有执行真实容器候选。 |

范围、归属、`git diff --check`、旧 HTTP 契约/旧管理员认证残余、桌宠路径零差异与工作树清洁检查均通过。这些本地证据不证明真实网关或任何远端资源已经验证。

## 3. 完整门两次运行事实

第一次 `pnpm.cmd verify:web-chain` 在 CloudBase `build-output` 的 5 秒限制处出现瞬时超时并停止；随后单独重跑该精确用例为 2/2、272ms 通过。第二次完整门中同一项为 2/2、约 4.78 秒通过，之后仅在 `verify:scanner-candidate` 因相同 Docker runtime 缺失而停止。

因此两次完整门都不能记录为全链通过：第一次保留瞬时超时事实，第二次证明该项恢复，但仍未补足真实容器候选证据。没有通过放宽 timeout、跳过候选或把单项复跑冒充完整门来改变结论。

## 4. 条件裁决与剩余门

获批规格要求阶段 2A、2B、3 全部 PASS 后才能恢复普通非投稿网站功能开发。当前阶段 2B 为 `blocked/unverified`，所以联合门未满足，普通非投稿网站新功能继续冻结；已完成的本地重构、减法和修复保留。

阶段 2C 不属于普通开发联合门，但在实际完成前持续阻塞共享包投稿开启、远端 migration、部署和上线声明。下一次裁决必须先取得可用 Docker Linux runtime 或等价真实 Node 22 容器证据；任何 CloudBase 开发环境或生产操作仍需独立授权并保存真实环境验收记录。
