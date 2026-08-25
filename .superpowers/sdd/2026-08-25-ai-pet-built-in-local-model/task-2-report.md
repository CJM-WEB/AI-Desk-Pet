# Task 2：内置档案与无损路由覆盖报告

## 状态

已完成。

## RED

先新增 `apps/desktop/tests/local-model-route.test.ts`，运行：

```text
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/local-model-route.test.ts
```

结果：失败，原因是 `../src/main/local-model/local-model-route` 模块不存在，符合预期 RED。

## 实现

- 新增 Main 内存路由模块，固定产生 `BUILTIN_LOCAL_PROFILE_ID = 'builtin-local'`。
- 使用既有 `preset` 档案形状，固定声明 `chat`、`tools`，并设置 `hasStoredSecret: false`。
- 目录项仅由本地模块提供，未加入共享公开 `providerCatalog`；函数不接收 URL 或模型 ID 参数。
- `createLocalModelRoutingSnapshot` 始终深拷贝云快照；开启时追加本地档案并覆盖四类路由、清空 fallback、关闭跨 Provider 回退；关闭时逐字段返回云快照副本。
- 补充 Agent Core 路由测试，覆盖本地聊天、Agent、视觉能力拒绝与空 fallback。

## 测试命令与结果

```text
pnpm.cmd --dir apps/desktop exec vitest run --config vitest.config.ts tests/local-model-route.test.ts
通过：3 tests

pnpm.cmd --dir packages/agent-core exec vitest run --config vitest.config.ts tests/model-router.test.ts
通过：14 tests

pnpm.cmd --filter @myself/agent-core test -- model-router.test.ts
通过：3 files，74 tests

pnpm.cmd --dir apps/desktop typecheck
通过

pnpm.cmd --filter @myself/agent-core typecheck
通过

git diff --check
通过（仅有 Git 的换行格式提示）
```

## 提交

提交信息：`feat(desktop): 注入本地模型路由覆盖`；最终 commit hash 以提交后的 `git log` 为准。

## 自审

- 修改范围仅为 Task 2 路由模块、两处测试和本报告。
- 未修改 SettingsStore，未改变云档案或云路由持久化数据。
- 未修改或恢复已退役 Zen 路径。
- 本地档案、目录项和覆盖只在调用结果的 Main 内存快照中出现；输入云快照保持不变。
- 视觉路由由现有 `ModelRouter` 能力检查稳定抛出 `MODEL_CAPABILITY_REQUIRED`，聊天与 Agent 无 fallback。

## concerns

无阻塞 concerns。后续 Task 需要把本模块目录项与本地 Provider 的 Main 私有运行时连接起来，并继续保持目录项不进入公开 Provider 设置目录。
