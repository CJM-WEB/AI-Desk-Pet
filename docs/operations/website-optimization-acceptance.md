# 网站架构优化阶段 2—3 本地验收记录

> 日期：2026-08-31
> 分支：`WebsiteExtension`
> 实现候选：`e0a38f33645fc3e0d6fd5f7f80f13d5fb46a3751`
> 总裁决：PASS；恢复普通非投稿网站功能开发资格
> 适用范围：阶段 2A、阶段 2B、阶段 3 的本地证据及阶段 2C、生产状态；不替代 2026-08-20 的网站视觉验收记录

## 1. 阶段裁决

| 阶段 | 结论 | 实际证据与边界 |
| --- | --- | --- |
| 2A 本地结构门 | PASS | CloudBase V3 SDK、唯一 ScannerProtocol、受控 migration Adapter、scope 与 ownership 门通过。 |
| 2B 本地运行候选门 | PASS | PostgreSQL 17.11 顺序执行 7 个 migration 并通过 42 项行为验证；真实 Node 22 容器候选以非 root UID 999 运行，Docker health、EICAR 阻断和 timeout 失败关闭均通过。 |
| 3 HTTP 契约门 | PASS | 共享 strict HTTP 信封与 endpoint Schema、Production 与 Memory 双 Adapter 行为合同及独立规格/工程标准双审通过。 |
| 2C CloudBase 开发环境门 | 未执行 | 未连接 CloudBase 开发环境，未执行远端 migration、函数/Scanner/Hosting 部署，也未验证真实网关、对象身份、整轮锁或远端续跑。 |
| 正式生产 | 未部署 | 现在线上仍是旧测试版；本分支未上线，共享包投稿开关继续关闭。 |

## 2. 新鲜自动化证据

| 命令 | 2026-08-31 结果 |
| --- | --- |
| `pnpm.cmd verify:cloudbase` | CloudBase API 268/268、Scanner 71/71；构建与 typecheck 通过。 |
| `pnpm.cmd verify:website` | Website 348/348、两次构建、E2E 21/21。 |
| `pnpm.cmd test:website-contract` | 专属 strict TypeScript 编译与 Production/Memory 双 Adapter 行为合同 12/12。 |
| `pnpm.cmd verify:scanner-candidate` | PASS；不可变镜像 `sha256:1f50baa75ac83201d71252b367945d44683455d810ebbadbd2f72fa36100bf1`，Node v22.23.2、ClamAV 1.4.3/28109、UID 999、health PASS、EICAR blocked、timeout HTTP 503。 |
| `pnpm.cmd verify:web-chain`（显式提供本地 PG17 runtime） | PASS；验证工具 71/71、shared-types 51/51、Website 348、CloudBase fast 266、Scanner 71、release-tools 4、migration 工具 36、PostgreSQL 行为 42、网站合同 12、CloudBase 构建产物 2、构建工具 3、真实 Scanner 候选和浏览器 E2E 21；依赖审查 0 error、9 个既有 warning。 |

范围、归属、`git diff --check`、旧 HTTP 契约/旧管理员认证残余、桌宠路径零差异与工作树清洁检查均通过。这些本地证据不证明真实网关或任何远端资源已经验证。

## 3. 故障修复与最终完整门事实

早期完整门曾分别在 CloudBase `build-output` 瞬时超时和 Docker Linux engine 缺失处停止，这些失败不计为通过。后续诊断发现 Docker Desktop 遗留两个不可访问的零字节运行时 socket；停止后端并将对应临时目录可恢复地隔离后，Linux engine 恢复为 29.7.2/linux/x86_64。

真实候选首次执行继续以 503 失败，根因是候选探针的下载替身复制 ZIP 后没有返回生产 `Download` 契约要求的 `ArchiveIdentity`，尚未进入 ClamAV。提交 `e0a38f3` 仅补齐真实字节数与 SHA-256；同一真实候选随后通过，独立规格与工程质量复审均为 PASS、0 个 finding。

修复后的第一次完整门因调用进程没有提供 `AI_PET_POSTGRES_RUNTIME` 而在 PostgreSQL 行为门前停止；显式提供已验证的本地 PostgreSQL 17.11 runtime 后，从 scope 到浏览器 E2E 的同一次完整门全部通过。期间没有放宽 timeout、跳过候选、连接远端环境或把单项复跑冒充完整门。

## 4. 条件裁决与剩余门

获批规格要求阶段 2A、2B、3 全部 PASS 后才能恢复普通非投稿网站功能开发。三门现已全部通过，联合门满足，因此恢复普通非投稿网站功能开发资格；该裁决不代表已经开始阶段 4，也不授权任何远端操作。

阶段 2C 不属于普通开发联合门，但在实际完成前持续阻塞共享包投稿开启、远端 migration、部署和上线声明。任何 CloudBase 开发环境或生产操作仍需独立授权并保存真实环境验收记录。
