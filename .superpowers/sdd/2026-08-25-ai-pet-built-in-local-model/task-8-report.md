# Task 8：固定资源、可复现暂存与打包门禁报告

## 状态

已完成代码与自动化验证；真实 2.55 GiB GGUF 下载、CPU/Vulkan 构建、安装包生成和真实模型验收不在本任务执行范围，留待 Task 10。

## RED / GREEN

先新增本地模型资源 verifier、打包配置和运行期 notices 测试。首次运行 Task 8 定向命令共 13 项按预期失败：verifier 模块、脚本命令和第四个 `extraResources` 尚不存在。

实现后新增两个审查驱动的 RED：

- `git check-attr` 证明三个发行文本最初为 `eol: unspecified`，无法保证 Windows checkout 后的固定字节哈希；新增精确 `.gitattributes` 后转绿。
- 暂存事务 fixture 证明旧脚本导入会直接进入真实编排，且没有整体切换/回滚端口；重构为可导入的整体资源根切换函数后，成功替换与失败回滚均转绿。

额外执行 allowlist mutation 检查：临时放宽 manifest 已列额外 EXE 后，`llama-cli.exe` 与 `benchmark.exe` 两项测试稳定失败；恢复严格限制后转绿。

最终复审 fix round 1 继续按 TDD 补齐四组边界：

- CRLF 文本与同步改写的 manifest 在旧 canonical-text 逻辑下会通过；改为 policy 同时固定原始 `path`、`size`、`sha256` 后转为拒绝。
- verifier 与 runtime 原先各有一份发行常量；提取单一只读 ESM identity，并以对象同一性和生产文件原始字节测试锁定。
- 内存 Web Stream 分别模拟永久 stall 与首块超限且不结束；加入一小时下载 timeout、Abort、流式字节上限与同步 SHA 后转绿。
- 注入 commit 后备份删除失败，旧实现错误报失败；明确第二次 rename 为 commit point 后改为告警，并验证下一次事务先安全清理固定备份再切换。

fix round 2 新增两个并发交错 RED：第一事务分别暂停在 commit rename 前和 commit 后备份清理中；旧实现中第二事务会返回 `ENOENT` 或直接抢先完成切换。加入跨进程排他锁后，第二事务均稳定返回 `STAGE_TRANSACTION_BUSY`，且第一事务的 backup、rollback 和提交后清理不受破坏。

## 实现

- 固定 Qwen3.5-4B 原模型/量化 revision、GGUF 文件名、2,740,937,888 bytes 与 SHA-256。
- 固定 llama.cpp `b10516` 对应 commit；维护者脚本从固定 Git 来源自建 Windows x64 CPU/Vulkan，显式设置 `GGML_RPC=OFF`、`GGML_OPENMP=OFF`，仅构建 `llama-server` target 并收集其输出目录中的 DLL。
- 模型只从固定 Hugging Face resolve URL 下载到 `.partial`；下载具备一小时 Abort timeout，流式计数超过固定大小时立即销毁，流式 SHA-256 与大小均匹配后才原子改名。脚本拒绝全部命令行参数，不接收用户 URL、revision 或输出根。
- CPU、Vulkan、模型、manifest 和许可证先在独立完整 staging 根组装并通过 verifier，之后才切换正式资源根；切换失败恢复旧根，避免失败留下新旧 payload 混合状态。
- verifier 使用固定生产策略校验发行身份、revision、模型、许可证与来源说明，并对 manifest 与磁盘普通文件执行双向精确 allowlist、大小和流式 SHA-256 校验；拒绝路径逃逸、链接、额外 EXE、RPC、mmproj、第二模型和未列文件。
- verifier 与 runtime 复用 Main 私有的单一只读发行 identity；许可证和 notices 的 manifest 条目及磁盘原始字节必须同时等于 policy 的固定大小和 SHA，不进行 CRLF 规范化放行。
- 资源根第二次 rename 是事务 commit point；commit 后旧备份删除失败只发布稳定警告，下次事务在真实 `resources/local-model` 父目录内校验唯一普通目录备份后先清理，不累积多份大 payload。
- 资源切换先验证固定 `resources/local-model` 父目录是非链接且真实路径一致的普通目录，再预制带随机 owner 文件的非空锁目录并以 rename 原子发布；持锁后再次验证父目录。锁覆盖 backup 检查、commit、rollback 和提交后清理；发布阶段的 `EEXIST`、`ENOTEMPTY` 归一化为稳定 `STAGE_TRANSACTION_BUSY`，Windows `EPERM` 仅在 `lstat` 证明 fixed lock 普通目录确实存在时归一化。释放前严格复核锁根不是 Junction、真实路径一致、仅含本事务 owner 且元数据匹配；之后只删除本事务 owner，再复核空普通目录并执行非递归 `rmdir`。锁根被替换或出现其他 owner 时只告警，不会递归清理或跟随重解析点删除根外文件。由于仅凭 PID/时间无法在 Windows 上可靠证明持有者已失活，脚本不自动删除 stale 锁，需维护者核验 owner 元数据后人工清理。
- manifest 新增固定 `THIRD-PARTY-NOTICES.txt` 条目，既有运行期严格 Schema 与 allowlist 同步识别；许可证只保留 Task 8 既定文件名，不保留旧别名。
- Git 仅忽略 `apps/desktop/resources/local-model/payload/`；三个发行文本固定 `eol=lf`，manifest、许可证、notices 和脚本均进入版本库。
- `electron-builder.extraResources` 将完整 `resources/local-model` 复制到 `local-model`；`package:win` 在 build/electron-builder 前执行 verifier；普通 `build` 不执行暂存或下载。

## 验证

最终验证命令与实际结果：

```text
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/package-config.test.ts tests/local-model-assets.test.ts
通过：2 files，41 tests

pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/local-model-manifest.test.ts tests/local-model-runtime.test.ts
通过：2 files，42 tests

pnpm.cmd --filter @myself/desktop typecheck
通过

pnpm.cmd --filter @myself/desktop build
通过；普通 build 未触发 stage 或模型下载

node --check apps/desktop/scripts/stage-local-model.mjs
node --check apps/desktop/scripts/verify-local-model-assets.mjs
通过

git diff --check
通过（仅有 Git 的工作区换行提示；无 whitespace error）
```

## 审查

独立审查未发现 Critical。两项 Important（Windows EOL 哈希稳定、stage 失败留下混合 payload）和一项可直接修复的 Minor（顺序断言 `indexOf(-1)` 假通过）均已补测试并修复。

fix round 1 消除了原报告中“打包 verifier 与运行期身份重复”的 Minor concern；两边现在引用同一只读模块。

fix round 1 独立复审未发现 Critical 或 Important。复审提出的两个 Minor 测试缺口也已补齐：调用方 Abort、成功多块下载/原子改名，以及 identity 顶层和嵌套对象深冻结均有直接断言。

fix round 2 针对并发 stage 的 Important 增加两个真实文件系统交错测试，直接证明非持锁事务不能检查或清理第一事务的固定 backup，也不能破坏 rollback。

fix round 2 复审进一步覆盖“事务失败且锁所有权异常”的组合失败：脚本先发布 `STAGE_TRANSACTION_LOCK_CLEANUP_PENDING` 再保留原事务错误，并保留无法确认所有权的锁目录供人工核验；mutation 回退告警顺序时新增测试稳定失败。

Windows 路径安全另以两个 Junction 用例验证：父目录为 Junction 时在任何锁写入前拒绝；事务中 fixed lock 被替换为 Junction 时只告警，根外 owner 文件保持不变。移除写锁前父目录校验的 mutation 会在 Junction 目标残留锁目录，测试稳定失败。

fix round 3 将候选目录准备与原子发布拆成两个错误边界：candidate `mkdir`、owner `open/write/sync/close` 的错误原样传播并清理本事务候选；只有 `rename(candidateRoot, lockRoot)` 发布阶段的冲突才可能映射 BUSY。三个注入测试分别覆盖 owner 写 `EPERM`、无锁发布 `EPERM` 和有锁发布 `EPERM`；将发布 `EPERM` 无条件映射 BUSY 的 mutation 会使无锁用例稳定失败。

## 未执行项

- 未下载固定 2.55 GiB GGUF，未把小 fixture 结果描述为真实模型通过。
- 未执行真实 llama.cpp CPU/Vulkan 构建、实际 DLL 依赖验收、安装包体积或干净安装卸载。
- 锁协议防止正常 stage 进程互删，并拒绝测试覆盖的 Junction 替换；具备父目录写权限的外部进程若在最终校验与 owner `unlink` 之间主动替换路径，纯 Node `fs` 没有 `unlinkat` 或 Windows 目录句柄原子删除接口可证明绝对免疫。该场景不属于正常 stage 协议，若需抵御需另行引入原生 Windows 锁/文件句柄能力。
- RED 期间导入旧 stage 脚本曾触发固定 llama.cpp commit 的浅 fetch，随后因环境无 `cmake` 终止；临时目录已清理，未下载 GGUF，也未记录为 Task 10 验收证据。重构后的模块导入不再执行暂存编排。
