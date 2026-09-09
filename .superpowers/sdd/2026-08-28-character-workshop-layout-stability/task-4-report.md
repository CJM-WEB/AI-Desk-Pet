# Task 4 实施报告：移除皮肤编辑界面并保留多皮肤兼容

## 实施范围

- 删除 `SkinList.tsx` 与 `SkinInspector.tsx`，并从工作台 View 移除对应装配、皮肤删除确认分支、专属派生值和 handler。
- 左栏标题改为“角色”，保留角色列表与“编辑角色人设”入口；清理只服务皮肤列表、皮肤检查器的 CSS 和组件测试。
- 同步清理 `character-workshop-state-list.dom.test.tsx` 中遗漏的皮肤检查器直接测试。
- 保留 `selectedSkinId`、动作预览的皮肤维度、Store 多皮肤 API、V2 `skins/defaultSkinId`、逐皮肤编译、角色包导入导出和 V1 运行时投影。
- 把正式安全角色包 fixture 扩为双皮肤，并以 `winter` 默认皮肤的 `playbackRate=1.5`、`mirrorX=true` 作为跨链兼容探针。

## RED 与先验保护证据

1. UI 退役 RED：执行 `character-workshop-components.test.tsx` 时新增用例失败，现有界面仍显示“角色与皮肤”，结果为 1 失败、37 通过。
2. Store 兼容保护先验为绿：增强既有发布测试为 `defaultSkinId=winter` 的双皮肤草稿，定向执行结果为 1 通过、92 跳过；证明生产 Store 在本任务开始前已逐皮肤编译。
3. 双皮肤 fixture RED：执行 `character-workshop-assets-fixture.test.ts` 时期望 `winter`、实际为 `default`，结果为 1 失败。

## GREEN 与真实 Electron 证据

- 组件、DOM 与 Store 定向测试：`character-workshop-components.test.tsx`、`character-workshop-state-list.dom.test.tsx`、`character-workshop-store.test.ts` 共 141/141 通过。
- 双皮肤 fixture integration：1/1 通过，导入后的 draft 与 manifest 均为 `default,winter`，默认皮肤为 `winter`，播放属性未丢失。
- 布局 DOM：15/15 通过；Task 3 四条 splitter 未被移除。
- Task 3 真实 splitter E2E：1/1 通过，四条分隔器拖动、重开恢复与窄屏回退保持有效。
- 更新后的原工作室闭环：1/1 通过，单皮肤人设、状态动作、精确表现、重启与导出回导保持有效。
- 新增真实双皮肤闭环：1/1 通过，覆盖真实导入、默认 `winter` 预览、编译发布、启用后的 V1 runtime 属性、导出、删除、回导、再次启用与运行时复核。
- E2E 对连续两次包选择只改写本用例临时目录中的 safe 与第二队列槽字节，并断言两者等于刚导出的包；默认 safe→malicious 队列和生产边界未修改。

## 全量门禁

`pnpm.cmd verify:characters` 退出 0：

- character-runtime：341/341 通过。
- character-assets：99/99 通过。
- desktop typecheck：通过。
- desktop：2857/2857 通过。
- security：28/28 通过。
- integration：92/92 通过。
- production build：Main、Preload、Renderer 与 Preload/MCP/本地模型边界脚本通过。
- Electron E2E：79 通过、1 条既有 B7 长时用例按套件设计跳过，总耗时 9.3 分钟。

`git diff --check` 退出 0，仅输出工作树既有的 LF/CRLF 转换提示。

## 失败路径与收口

- 首次双生命周期 E2E 因 150 秒总预算不足而终止；随后按单一 seam 拆分，确认真实导入、编译和运行时均正常。
- 编译后点击“启用角色”曾被成功 toast 拦截；测试改为先关闭 toast，再执行下一步。
- 活动角色不能直接删除；闭环先启用官方默认角色，再删除待回导角色，遵守正式 Store 约束。
- E2E dialog 默认第二次返回恶意包；闭环只在该用例的隔离临时目录把第二队列槽替换为刚导出的安全字节，未改变全局夹具或产品行为。

## 已知非阻塞事项

- JSDOM 不实现 Canvas 2D Context，相关 DOM 测试仍输出既有 `HTMLCanvasElement.getContext()` 警告，但测试通过；真实 Electron 已覆盖正式 Renderer。
- 本任务只退役皮肤编辑 UI，不迁移或删除用户角色包中的多皮肤数据；工作台仍按当前默认皮肤预览和编辑动作表现。
