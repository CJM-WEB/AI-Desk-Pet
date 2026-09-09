# 工作台样式夹具路径修复报告

## RED 证据

从仓库根目录执行：

`pnpm.cmd exec vitest run --config apps/desktop/vitest.config.ts apps/desktop/tests/character-workshop-components.test.tsx`

首次结果为 30 项中 24 项通过、6 项失败。两处 CSS helper 以 `process.cwd()` 拼接 `src/renderer/...`，因此错误读取 `仓库根/src/...` 并统一产生 `ENOENT`；从 `apps/desktop` 目录启动时偶然可用，暴露出测试对命令工作目录的隐式依赖。

## 最小修复

- 只修改 `character-workshop-components.test.tsx`，不改生产代码。
- `workshopCss()` 与 `rendererStyles()` 都以 `dirname(fileURLToPath(import.meta.url))` 获得测试模块目录，再解析 `../src/...`。
- 未继续使用静态 `new URL(资源路径, import.meta.url)`：JSDOM 下该形式会被 Vite 当作浏览器资源转换，传给 `fileURLToPath()` 后稳定报“URL must be of scheme file”。先转换模块自身 URL 可避开该转换，同时保留模块路径为唯一事实来源。

## GREEN 与验证

- 仓库根目录定向组件测试：30/30 通过。
- `apps/desktop` 包目录定向组件测试：30/30 通过。
- 根目录 `pnpm.cmd typecheck`：10 个适用 workspace 全部通过。
- 未运行完整门禁，符合本轮仅修复测试 cwd 回归的范围限制。
- `git diff --check`：退出 0，仅有既有行尾转换提示。
