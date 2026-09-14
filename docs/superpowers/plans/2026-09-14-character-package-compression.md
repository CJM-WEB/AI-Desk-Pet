# 完整角色包压缩实施计划

依据：[已授权规格](../specs/2026-09-14-character-package-compression-design.md)。使用现有隔离 worktree；基准 `9faef2a1`。规格驱动、子智能体协作和测试驱动执行。本轮新改动不自动提交。

## 共同约束

仅优化普通导出副本；无新依赖，不改像素/配置/行为/界面，不改官网、扫描器、共享包预算和导入协议。保留恢复导出的原始证据字节。每张优化解压预算 128 MiB，压缩异步且逐张进行。

## 任务 1：PNG 无损优化器

文件：新增 `apps/desktop/src/main/characters/character-export-png.ts`、`apps/desktop/tests/character-export-png.test.ts`。

接口：`optimizePngForExport(input: Buffer): Promise<Buffer>`；只输出更小且语义不变的 PNG，否则返回原 Buffer。

- [x] RED：构造包含全透明非零 RGB、16 位/调色板信息、多个 IDAT、附加文本/颜色块的 PNG；原样返回时缩小断言失败。
- [x] GREEN：只改变 IDAT zlib 编码，保留全部其他块；校验 CRC/结构，异步重压 memLevel 8/9 择小，超预算/异常/不适用回退。
- [x] 验证：新旧 IDAT 解压字节完全相等，原 Buffer 未改；损坏、未知、动画、无收益及超预算不破坏输入。独立复核发现大量空块的解析放大，另经 RED/GREEN 加入 8192 块预算。

## 任务 2：完整包流式导出

文件：`apps/desktop/src/main/characters/character-package-service.ts`、`apps/desktop/tests/character-package-service.test.ts`、`tests/integration/character-workshop-assets-fixture.test.ts`。集成夹具原先比较 PNG 编码字节，按已批准契约改为独立比较完整过滤流及非 IDAT 块，而不是只验证可以打开。

依赖任务 1 接口。保留 `exportCharacter(characterId, destination): Promise<void>`。

- [x] RED：真实导出同时缩小源图和图集；全部文件、草稿和发布配置保持；导入成功且原目录内容未变化。
- [x] GREEN：在现有安全归档事务内依次校验/优化/消费资源；只在导出 JSON 副本更新 byteLength/sha256 与几何修订。
- [x] 验证：复用原有源文件竞态、目标竞态、错误清理测试；覆盖写入失败时不继续读取后续资源；最终 JSON/包预算仍检查。原先两项旧播放投影顶层 name 断言失败独立记录。

## 任务 3：默认包、回归与交付

文件：新增 `docs/operations/2026-09-14-character-package-compression-acceptance.md`；只在必要时增加实际 Electron 验证。

- [x] 用实际默认包执行导出与新目录回导，记录真实 ZIP 字节，不拿图片总和当最终包体；确认 18 图原始过滤流逐字节一致。
- [x] 验证完整草稿、九动作发布和九份源图读取；真实 Electron 双皮肤夹具验证重新编译、导出和回导。未对默认九动作包重新编译，不能将夹具结果写成该默认包的重新编译结果；人工观感仍待用户确认。
- [x] 定向测试、typecheck、构建及角色/桌面门禁；安全16、集成76与真实Electron闭环通过。两个全量门禁各39失败，已知37断言及额外独立重跑通过项见[验收](../../operations/2026-09-14-character-package-compression-acceptance.md)，没有写为全绿。
- [x] 独立规格/质量复核及预算修复复审完成；范围、编码、链接与 `git diff --check` 在交付前核查，实际证据见验收。
