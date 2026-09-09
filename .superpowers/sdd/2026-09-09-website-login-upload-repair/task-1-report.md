# Task 1 管理员入口最小修复报告

## 实施范围

- 修改 `apps/website/components/admin/AdminApp.tsx`：在管理员初始化 effect 中读取可选的 `NEXT_PUBLIC_ADMIN_ORIGIN`，并在认证初始化前完成来源校验与跳转裁决。
- 修改 `apps/website/tests/admin-app.test.tsx`：真实渲染 `AdminApp`，通过浏览器 `location.replace` 边界 spy 和认证客户端 spy 覆盖跨来源、同来源、未配置及非法配置。
- 仓库中未发现网站环境变量示例文件，因此未创建第二套配置体系；公开配置值由主智能体在既有部署文档中维护。
- 未修改首页视觉、桌宠、认证 SDK、OTP 授权、后端或云端配置。

## TDD 证据

### 基线

命令：

```powershell
pnpm.cmd --filter @myself/website test -- tests/admin-app.test.tsx
```

结果：退出码 0。该 workspace 脚本未将尾随参数限制为单文件，实际运行网站全部单测：44 个测试文件、413 项测试通过。

### RED

命令：

```powershell
pnpm.cmd --dir apps/website exec vitest run --config vitest.config.ts tests/admin-app.test.tsx
```

结果：退出码 1；38 项中 6 项失败、32 项通过。跨来源用例因 `location.replace` 调用次数为 0 失败；五个非法配置用例因未出现既有配置错误 UI 失败。同来源和未配置用例通过，证明兼容路径未被测试误判。

### GREEN

同一定向命令结果：退出码 0；1 个测试文件、38 项测试全部通过。

最小实现行为：

- 未配置时保留原有 runtime 初始化行为。
- 仅接受根路径、无账号密码、无查询、无 fragment 的 HTTPS URL；允许结尾斜杠。
- 目标来源不同于当前来源时，仅调用 `location.replace(`${target.origin}/admin/`)`，不创建认证 runtime，因此不会启动认证 SDK，也不会携带输入页面的 query 或 fragment。
- 目标来源相同时创建原 runtime，不跳转、不循环。
- 解析失败或配置不合法时显示既有 `admin.error.config` UI，不初始化认证。

## 最终验证

```powershell
pnpm.cmd --filter @myself/website test
pnpm.cmd --filter @myself/website typecheck
```

- 网站全部单测：退出码 0；44 个测试文件、421 项测试通过。
- 网站 typecheck：退出码 0，`tsc --noEmit` 无错误。
- 按任务边界未运行 build、网站 E2E、浏览器检查或云端操作；这些由主智能体统一执行。
- 测试输出包含仓库既有的 jsdom canvas/navigation 提示以及受控 401/403 日志，本次没有新增警告类别。

## 自审与疑点

- 修改限定为管理员组件、对应测试和本报告；未触碰现有脏文档。
- 未引入依赖、未增加新配置文件、未更改页面样式或业务 API。
- `NEXT_PUBLIC_ADMIN_ORIGIN` 是构建期公开变量，正式配置值及带配置构建验证仍由主智能体完成。
- 单元测试通过替换全局 `location` 边界验证跳转顺序；真实浏览器的导航行为仍属于主智能体 E2E/人工验收范围。

## E2E 构建环境隔离补充

主智能体规格复审后补充要求：`tests/build-website-export.mjs` 原样继承 `process.env`，可能把正式 `NEXT_PUBLIC_ADMIN_ORIGIN` 带入 Memory E2E 构建。本次将既有 E2E 构建环境组装收口到 `createWebsiteE2eBuildEnvironment`，保留其他继承值，但强制覆盖 `NEXT_PUBLIC_ADMIN_ORIGIN: ''`；未绕过或改动 `AdminApp` 的来源安全逻辑。

RED 命令：

```powershell
node --test tools/verification/website-export-isolation.test.mjs
```

结果：退出码 1，25 项中 1 项失败，因构建环境组装函数尚不存在；其余 24 项通过。

GREEN 使用同一命令：退出码 0，25/25 通过。按范围未运行 build 或 E2E，由主智能体统一验证。
