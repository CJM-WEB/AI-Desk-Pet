# 网站链验证入口与边界

> 适用范围：阶段 0 的本地网站链自动化验证。本文只定义入口和覆盖边界；实际运行结果以 [网站业务链验证与人工验收记录](website-chain-verification-acceptance.md) 为准。

## 唯一入口

- `pnpm.cmd verify:web-chain:fast` 是日常快速包级门，适用于本地改动后的快速反馈。
- `pnpm.cmd verify:web-chain` 是当前唯一完整网站链门；需要完整网站链证据时必须使用该入口，不以 `verify:website`、`verify:cloudbase` 或单独构建命令替代。
- `pnpm.cmd deps:audit:web` 只审查网站链依赖，不表示全仓、桌宠或 Electron 已通过。
- `pnpm.cmd verify:web-chain:scope` 用于单独检查阶段 0 变更范围；完整门与快速门都会先执行同一范围检查。

## 快速门与完整门

| 门 | 覆盖内容 | 不覆盖内容 |
| --- | --- | --- |
| `verify:web-chain:fast` | 范围与测试归属、验证工具单元测试、shared-types/website/cloudbase-api/package-scanner/release-tools 的类型检查和测试、根 CloudBase 迁移工具测试、网站依赖审查 | CloudBase 函数构建与构建产物测试、Scanner 构建、网站 E2E |
| `verify:web-chain` | 快速门全部内容，以及 CloudBase 三函数构建、构建后产物测试、根 CloudBase 构建工具 `node:test`、Scanner Vite 构建和网站静态构建后的 Playwright E2E | 桌宠、Electron、根 integration/security、角色包测试及任何真实云资源操作 |

完整门中的 release-tools 覆盖来自快速门；两个根 CloudBase `node:test` 分别为迁移工具测试和函数构建工具测试。

## 范围基线与 warning

- 阶段 0 变更基线固定为 `0dab17de8863a7c726a5bb5fceff35a1713daad1`。扩大允许范围或更改根 manifest 的受限键，必须由新的获批计划更新范围策略。
- 依赖审查中的既有历史 warning 只允许减少。它们是技术债快照，不构成业务功能、云环境或生产发布通过的证明。
- 本入口只证明本地自动化命令的退出码和输出，不替代人工视觉验收。

## 明确不在本次范围

CloudBase 真实数据库、Bucket、函数部署、Scanner 镜像、域名、CORS/CSP、OTP、监控告警、备份和任何正式发布均不在本次范围。真实 CloudBase 验证与正式部署继续冻结，必须在后续独立计划中取得逐项授权和实际环境证据。
