# Task 3 实施报告

## 范围与结论

- 日期：2026-09-02。
- 环境：Windows；本地 PostgreSQL 17.11 runtime 仅在验证进程临时指定，未写入 `.env`、脚本或项目配置。
- 已完成：Memory API、生产 `createApi` 合同、网站 E2E、网站范围门和阶段 2C 部署/验收文档均已收敛至官方下载点击计数。
- 未执行：上海远端第 16 条 migration、函数部署、网关、托管和真实管理员 smoke；这些项目仍为未验证，未写为通过。

## RED → GREEN 证据

1. RED：`pnpm.cmd test:website-contract` 中新增的 Memory 合同以 `404` 失败，证明 Memory API 缺少官方点击端点；生产 Adapter 同时通过，定位为测试替身缺口。
2. RED：`pnpm.cmd verify:web-chain:scope` 拒绝第 16 条 migration、官方下载规格与计划，证明范围白名单尚未收敛。
3. GREEN：Memory 仅保存生命周期内的单个非负累计值；公开 POST 严格返回 `{}`，管理员 token 才可读取 `clickCount`。合同测试 34/34 通过，且两个 driver 均拒绝明确的非管理员 token（403）。
4. GREEN：`pnpm.cmd test:e2e:website` 19/19 通过；Memory API 连续两次公开点击后，公开页不显示指标，管理员工作台显示 `2`。
5. 发行清单在本次验证为 `unpublished`，因此 E2E 不伪造真实 Windows 链接；真实链接的旁路上报行为继续由 Task 2 的网站单测覆盖。

## 最终验证

以下命令均观察到退出码 0：

```powershell
pnpm.cmd test:website-contract
pnpm.cmd test:e2e:website
pnpm.cmd verify:web-chain:scope
pnpm.cmd verify:web-chain:ownership
pnpm.cmd verify:web-chain # 在临时 PostgreSQL runtime 环境中执行
```

完整网站链中的本地 PostgreSQL 行为门输出：`PostgreSQL 17.11：16 个迁移，85 项行为验证通过`。完整链包含范围、所有权、合同、构建、依赖审查、扫描候选与 E2E；依赖审查为 263 个模块、687 条依赖、0 errors、8 个既有批准 warning。真实 Docker 候选 imageId 为 `sha256:a02f6a8a6cd2fbd3663a61d811c9eae4f7bc6a3b0fdb41f1b495fbaa60a45a9c`。

## 未覆盖项与风险

- 本地 Memory/合同/E2E 不能替代上海远端的函数、数据库、网关或身份认证 smoke。
- 计数只代表服务器接受的点击，不代表下载、安装或独立用户。
