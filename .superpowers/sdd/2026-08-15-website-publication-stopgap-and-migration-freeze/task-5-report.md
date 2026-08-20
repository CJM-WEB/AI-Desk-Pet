# Task 5：管理员 UI 失败原因投影报告

日期：2026-08-20
范围：管理员投稿详情的共享包技术扫描门禁与 UI 回归测试。

## 变更

- 所有未发布的 `shared_package` 在缺少当前有效技术扫描证据时，禁用“批准发布”并显示现有 `admin.detail.technicalBlocked` 文案。
- 当前证据继续校验扫描类型、提供方、结论、包对象键、实际大小和扫描码，并新增投稿 ID 与状态版本绑定校验。
- 普通反馈与建议、自动驳回转人工、隔离恢复和管理员详情只读路径未改动。

## RED → GREEN 记录

1. 将旧的“人工审核共享包无需系统扫描即可批准”测试反转为缺证据必须禁用。
2. 新增状态版本过期的扫描证据不得解除门禁测试。
3. RED：旧 UI 将两种待人工审核共享包的批准按钮保持可用，两个断言失败。
4. GREEN：收紧 UI 条件并补齐证据身份与状态版本校验后，测试通过。

## 验证

```powershell
pnpm.cmd --filter @myself/website test -- admin-app.test.tsx admin-api-client.test.ts
# 40 个测试文件、324 项测试通过

pnpm.cmd --filter @myself/website typecheck
# tsc --noEmit 通过

git diff --check
# 通过
```

未执行真实浏览器人工验收；本次未修改服务、SQL、其他 UI 或桌宠模块。
