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

## 实现

- 固定 Qwen3.5-4B 原模型/量化 revision、GGUF 文件名、2,740,937,888 bytes 与 SHA-256。
- 固定 llama.cpp `b10516` 对应 commit；维护者脚本从固定 Git 来源自建 Windows x64 CPU/Vulkan，显式设置 `GGML_RPC=OFF`、`GGML_OPENMP=OFF`，仅构建 `llama-server` target 并收集其输出目录中的 DLL。
- 模型只从固定 Hugging Face resolve URL 下载到 `.partial`；下载具备一小时 Abort timeout，流式计数超过固定大小时立即销毁，流式 SHA-256 与大小均匹配后才原子改名。脚本拒绝全部命令行参数，不接收用户 URL、revision 或输出根。
- CPU、Vulkan、模型、manifest 和许可证先在独立完整 staging 根组装并通过 verifier，之后才切换正式资源根；切换失败恢复旧根，避免失败留下新旧 payload 混合状态。
- verifier 使用固定生产策略校验发行身份、revision、模型、许可证与来源说明，并对 manifest 与磁盘普通文件执行双向精确 allowlist、大小和流式 SHA-256 校验；拒绝路径逃逸、链接、额外 EXE、RPC、mmproj、第二模型和未列文件。
- verifier 与 runtime 复用 Main 私有的单一只读发行 identity；许可证和 notices 的 manifest 条目及磁盘原始字节必须同时等于 policy 的固定大小和 SHA，不进行 CRLF 规范化放行。
- 资源根第二次 rename 是事务 commit point；commit 后旧备份删除失败只发布稳定警告，下次事务在真实 `resources/local-model` 父目录内校验唯一普通目录备份后先清理，不累积多份大 payload。
- manifest 新增固定 `THIRD-PARTY-NOTICES.txt` 条目，既有运行期严格 Schema 与 allowlist 同步识别；许可证只保留 Task 8 既定文件名，不保留旧别名。
- Git 仅忽略 `apps/desktop/resources/local-model/payload/`；三个发行文本固定 `eol=lf`，manifest、许可证、notices 和脚本均进入版本库。
- `electron-builder.extraResources` 将完整 `resources/local-model` 复制到 `local-model`；`package:win` 在 build/electron-builder 前执行 verifier；普通 `build` 不执行暂存或下载。

## 验证

最终验证命令与实际结果：

```text
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/package-config.test.ts tests/local-model-assets.test.ts
通过：2 files，34 tests

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

## 未执行项

- 未下载固定 2.55 GiB GGUF，未把小 fixture 结果描述为真实模型通过。
- 未执行真实 llama.cpp CPU/Vulkan 构建、实际 DLL 依赖验收、安装包体积或干净安装卸载。
- RED 期间导入旧 stage 脚本曾触发固定 llama.cpp commit 的浅 fetch，随后因环境无 `cmake` 终止；临时目录已清理，未下载 GGUF，也未记录为 Task 10 验收证据。重构后的模块导入不再执行暂存编排。
