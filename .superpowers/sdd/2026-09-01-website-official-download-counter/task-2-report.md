# Task 2 实施报告

## 范围

- 新增无状态的官方 Windows 安装包点击旁路上报。
- 管理员工作台在现有令牌会话内读取并显示累计点击，以及统计含义限制。
- 未修改 CloudBase 后端、发行清单生成器、桌宠、依赖或环境变量。

## RED 证据

执行定向 Vitest 后预期失败：下载链接没有发送旁路请求，`AdminApiClient` 缺少指标读取方法，管理员工作台没有指标显示或不可用状态。失败均指向功能尚未实现，不包含夹具、语法或导入失败。

## GREEN 证据

- `pnpm.cmd --filter @myself/website exec vitest run --config vitest.config.ts tests/official-download-click.test.tsx tests/official-download-metric-client.test.ts tests/admin-api-client.test.ts tests/admin-app.test.tsx`：4 个文件、45 项断言通过。
- `pnpm.cmd --filter @myself/website test`：43 个文件、378 项断言通过。
- `pnpm.cmd --filter @myself/website typecheck`：通过。
- `pnpm.cmd --filter @myself/website build`：产出新的 `.next/BUILD_ID`，编译、类型检查与页面数据收集阶段均完成，未发现残留构建进程。
- `git diff --check`：通过。

## 实现与安全边界

- 只有发布态 `windows-x64` 的真实链接调用上报；保留原始 `href`，不取消默认事件也不等待请求。
- 上报使用空 JSON 对象、`keepalive: true`、`credentials: 'omit'`；同步异常、网络拒绝及 429/500 均吞没，不重试、不持久化且不生成用户标识。
- 管理员读取沿用 `x-ai-pet-admin-token`，使用独立状态和 `AbortController`；退出、403、卸载或迟到响应不会回填旧会话，读取失败只显示“暂不可用”，审核队列不受影响。

## 未覆盖项与风险

- JSDOM 对测试中的真实外链默认导航会输出“Not implemented: navigation to another Document”；测试已断言事件默认行为未被取消，浏览器实际下载仍待后续 E2E/人工验收。
- 本任务未执行远端 CloudBase 部署或真实管理员会话 smoke，仍待阶段 2C 远端验收。
