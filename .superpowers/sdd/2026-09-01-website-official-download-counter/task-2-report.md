# Task 2 实施报告

日期：2026-09-02

环境：Windows 本地环境（Microsoft Windows 11 专业版 10.0.26200，64 位）。

## 范围

- 新增无状态的官方 Windows 安装包点击旁路上报。
- 管理员工作台在现有令牌会话内读取并显示累计点击，以及统计含义限制。
- 未修改 CloudBase 后端、发行清单生成器、桌宠、依赖或环境变量。

## RED 证据

首次 RED 实际执行命令：

`pnpm.cmd --filter @myself/website exec vitest run --config vitest.config.ts tests/official-download-click.test.tsx tests/official-download-metric-client.test.ts tests/admin-api-client.test.ts tests/admin-app.test.tsx`

观察到下载链接未调用 `fetch`、`AdminApiClient` 缺少 `getOfficialWindowsDownloadClickCount`，且管理员工作台没有累计值与不可用状态。失败均指向功能尚未实现，不包含夹具或语法失败。未保留首次 RED 的原始逐行输出。

复审修复 RED 实际执行命令：

`pnpm.cmd --filter @myself/website exec vitest run --config vitest.config.ts tests/official-download-metric-client.test.ts tests/official-download-click.test.tsx`

观察到配置 `https://api.example.test/api/v1` 后，期望请求分域端点但实际仍请求硬编码 `/api/v1/official-downloads/windows/click`；新增真实链接网络拒绝、429、500 和 Windows 未发布场景当时已通过。

## GREEN 证据

- `pnpm.cmd --filter @myself/website exec vitest run --config vitest.config.ts tests/official-download-click.test.tsx tests/official-download-metric-client.test.ts tests/admin-api-client.test.ts tests/admin-app.test.tsx`：4 个文件、45 项断言通过。
- `pnpm.cmd --filter @myself/website test`：43 个文件、378 项断言通过。
- `pnpm.cmd --filter @myself/website typecheck`：通过。
- `pnpm.cmd --filter @myself/website build`：产出新的 `.next/BUILD_ID`，编译、类型检查与页面数据收集阶段均完成，未发现残留构建进程。
- `git diff --check`：通过。

## 复审修复

- 上报客户端改为复用 `NEXT_PUBLIC_API_BASE_URL ?? '/api/v1'`，支持官网静态站与 CloudBase API 分域。
- 网络拒绝、429、500 已在真实 `DownloadChapter` 链接点击中参数化验证：每项均保留原始 `href`、默认事件且只请求一次。
- Windows 未发布场景验证不渲染真实链接且零上报；管理员工作台未新增组件或状态架构。
- `pnpm.cmd --filter @myself/website exec vitest run --config vitest.config.ts tests/official-download-metric-client.test.ts tests/official-download-click.test.tsx`：2 个文件、13 项断言通过。
- `pnpm.cmd --filter @myself/website test`：43 个文件、383 项断言通过；`pnpm.cmd --filter @myself/website typecheck`：通过。

## 实现与安全边界

- 只有发布态 `windows-x64` 的真实链接调用上报；保留原始 `href`，不取消默认事件也不等待请求。
- 上报使用空 JSON 对象、`keepalive: true`、`credentials: 'omit'`；同步异常、网络拒绝及 429/500 均吞没，不重试、不持久化且不生成用户标识。
- 管理员读取沿用 `x-ai-pet-admin-token`，使用独立状态和 `AbortController`；退出、403、卸载或迟到响应不会回填旧会话，读取失败只显示“暂不可用”，审核队列不受影响。

## 未覆盖项与风险

- JSDOM 对测试中的真实外链默认导航会输出“Not implemented: navigation to another Document”；测试已断言事件默认行为未被取消，浏览器实际下载仍待后续 E2E/人工验收。
- 本任务未执行远端 CloudBase 部署或真实管理员会话 smoke，仍待阶段 2C 远端验收。
