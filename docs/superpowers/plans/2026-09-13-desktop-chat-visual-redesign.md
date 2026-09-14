# 桌宠聊天视觉重做实施计划

> 执行方式：使用 subagent-driven-development 分任务实现和复核；按 RED → GREEN → REFACTOR 推进。用户于 2026-09-13 批准规格及开始开发。Git 只读，不提交、不建分支。

**目标：** 将现有聊天改为顶部三球胶囊、可展开历史和头顶回复／授权气泡，保持所有业务和桌宠行为决策。

**架构：** chat 继续唯一接收业务事件、维护原会话和调用原 API；气泡窗口只消费最小展示快照，将带修订的界面点击交回原 chat。Main 新增窗口表现控制，不修改会话、授权或角色决策服务。

**技术：** 现有 Electron、React、TypeScript、Zod、Lucide、CSS；Windows 固定原生窗口资源仅用于必要的表现与鼠标观察，不增加 npm 依赖。

**规格：** [桌宠聊天视觉重做](../specs/2026-09-13-desktop-chat-visual-redesign-design.md)。

## 全局约束

- 允许窗口定位、显隐、鼠标穿透和必要 UI 通信；模型调用、聊天处理、会话保存、文件执行、授权判定和桌宠行为状态决策不变。
- pet/settings 不获得聊天正文；气泡不获得业务 IPC 权限，不订阅完整 TaskEvent、不恢复历史。
- 普通回复提交后显示 30 秒；流式增量更新，关闭同一条后不再弹出；新回复替换；授权沿用原有效期。
- 授权默认“待授权操作”，左拒绝右授权；覆盖为“明确文件编辑操作”，左拒绝右覆盖；点击正文展开原详情。
- 菜单内三横线、输入或历史区域只关菜单；底部三角与整体区域外桌面收起顶部界面；隐藏不清记录、不取消任务。
- 只修改桌面表现层和相应测试、文档；不改 Agent、文件核心、持久化、Provider、角色决策、官网和 CloudBase。
- 文档与结构性注释使用中文。已有隔离工作树直接复用；Git 只读，无自动提交。
- 每项定向 RED/GREEN 和审查结果写入本计划专属执行记录；任一诊断点连续 15 分钟没有可判定结果必须换更小复现或说明阻碍。

## 任务 1：原生窗口与外部点击验证

**文件：** 新增 `apps/desktop/tests/chat-native-presentation.test.ts`、`apps/desktop/tests/fixtures/chat-native-presentation.ts`、`apps/desktop/scripts/run-chat-native-validation.mjs`；必要实现限定为 `apps/desktop/src/main/windows/chat-native-pointer.ts` 与 `apps/desktop/resources/windows/chat-pointer-observer.ps1`、`chat-pointer-observer.cs`。测试截图只保留受控测试窗口，不读取真实用户聊天或其他应用内容。

**接口：** 原生观察器只向 Main 提供点击屏幕坐标，支持启停与有界关闭；不得监听键盘或向模型发送内容。输出接口固定为 `createChatPointerObserver({ resourceRoot, onPointerDown, onFailure })`，返回 `setEnabled(enabled)` 和异步 `dispose()`；`onPointerDown` 接收 `{ x: number; y: number }`。

- [x] RED：先写启动协议、非法输出、启停、关闭和无副作用失败测试，运行 `pnpm.cmd --filter @myself/desktop test tests/chat-native-presentation.test.ts`，记录预期失败。
- [x] GREEN：实现固定资源启动与鼠标观察；只用系统 PowerShell、隐藏窗口、固定脚本和严格消息解析；失效后不继续发布点击，不生成任意执行接口。
- [x] 原生夹具创建本程序控制的背景与玻璃窗口，验证 Electron 43.5.0 下背景材质、圆形／胶囊轮廓、动态尺寸、穿透与外部点击。夹具自动退出且有硬超时。
- [x] 以实际结果决定原生方案；真实模糊不可用不能冒充通过。当前系统可验证 Win11，Win10 单独记未验证；需要扩大能力或依赖时提交具体证据，不直接改业务。
- [x] 定向测试通过并独立复核后，记录原生事实与视觉观察界限，再接正式窗口。

接口测试示例：

```ts
const points: { x: number; y: number }[] = [];
const observer = createChatPointerObserver({ resourceRoot, onPointerDown: p => points.push(p), onFailure });
observer.setEnabled(false);
await observer.dispose();
expect(points).toEqual([]);
```

测试用注入的固定启动端口驱动协议与关闭，不依赖真实用户点击；真实鼠标链另由原生夹具验证。

## 任务 2：展示契约与 Main 展示桥

**文件：** 新增 `apps/desktop/src/shared/chat-presentation.ts`、`apps/desktop/src/main/windows/chat-presentation-bridge.ts`、`apps/desktop/src/preload/chat-presentation.ts`、`apps/desktop/tests/chat-presentation-bridge.test.ts`；小幅修改 `apps/desktop/src/shared/myself-api.ts`、`apps/desktop/src/preload/index.ts` 增加可选的 `chatPresentation` 接口。不改原业务 IPC 的 sender 校验。

**接口：** 用独立 `chat-presentation:*` 通道定义 `ChatPresentationApi`，提供 `publish(snapshot)`、`onSnapshot(listener)`、`dispatch(intent)`、`onIntent(listener)`、`setLayout(layout)`、`onCommand(listener)`、`ready()`。接口为可选，以保持现有测试注入 API 有效；正式 preload 必须接入。

快照限定一条普通回复与一个当前确认的展示数据，包含 `epoch`、`revision`、`conversationRevision`、正文、按钮说明、原详情文本、忙碌／错误。意图必须携带相同代次、修订、会话修订及消息／确认 `targetId`，只允许 `dismiss-reply`、`confirm`、`reject`、`toggle-details`。布局只包含顶部展示模式与交互矩形、期望尺寸；不能携带目标路径、任意窗口句柄或执行方法。`ready()` 返回 Main 的代次与修订水位；单独气泡失效通过 `reset.preserveConfirmation` 保留原 chat 当前确认，普通会话清理不保留。精确类型以共享文件为唯一依据。

- [x] RED：模拟 chat、bubble、pet 三个 sender，验证只有 chat 能发布、只有当前 bubble 能提交与当前快照一致的意图；未知字段、旧修订、错误身份全部拒绝。
- [x] GREEN：实现严格 Schema、展示窗口 ready 后的当前快照交付、失效与清理。Main 不执行意图对应的业务，只转交 chat。
- [x] 验证失败、窗口重建、重复 ready 不重放点击；快照不写磁盘，失败不输出正文。
- [x] 跑定向测试和桌面 typecheck，独立复核。

关键拒绝测试：

```ts
await bridge.publish(chatSender, snapshot);
expect(() => bridge.dispatch(petSender, intent)).toThrow();
expect(() => bridge.dispatch(bubbleSender, { ...intent, revision: snapshot.revision - 1 })).toThrow();
expect(forwardedIntents).toEqual([]);
```

## 任务 3：Renderer 视觉与回复生命周期

**文件：** 新增 `apps/desktop/src/renderer/src/chat/chat-presentation-controller.ts`、`ChatIsland.tsx`、`ChatBubbleView.tsx`、`chat-presentation.css` 及对应 `apps/desktop/tests/chat-presentation-controller.test.ts`、`chat-island.test.tsx`、`chat-bubble-view.test.tsx`。修改 `ChatPanel.tsx` 的呈现接线、三个既有确认组件的视觉和 `App.tsx` 的纯展示分支；删去 `styles.css` 被替代的聊天专用规则。保持原处理函数的业务内容。

最小职责拆分另增同目录 `confirmation-presentation.ts`、`use-chat-presentation.ts` 和 `use-presentation-layout.ts`，分别负责原文案映射、原 owner 展示通信和实际 DOM 区域测量；对应测试为 `confirmation-presentation.test.tsx`、`use-chat-presentation.test.tsx`、`use-chat-presentation-reset.test.tsx`、`presentation-layout.test.tsx`、`chat-bubble-isolation.test.tsx`。旧 `ChatCloseButton` 未再被正式入口使用，随其专用测试删除，收起行为由新组件和窗口测试验证。

**接口：** 消费任务 2 的契约。`ChatIsland` 通过 props 接收原输入、消息、状态与回调，不决定业务是否允许发送或取消；`ChatBubbleView` 仅用展示 API。计时控制器只处理普通气泡的消息身份、流式提交与关闭标记，使用可注入的时钟与调度器，不能调用业务 API。

- [x] RED：假时钟验证提交前不自动关闭、提交后恰为 30 秒、新 ID 替换、手动关闭同 ID 不复活、恢复正文不弹出；权限快照不被计时清除。
- [x] RED：组件测试验证三球展示阶段、菜单与历史联动、点击关闭层级、Enter／输入法沿用原处理、正在执行的停止按钮和详情精确映射。
- [x] GREEN：按规格尺寸与虹彩玻璃视觉实现组件；CSS 形变使用展示状态，无新增动效依赖。关闭按钮悬浮／键盘聚焦可见。
- [x] ChatPanel 继续使用原 owner、会话修订和 API；只将气泡点击映射回这些原回调，保留故障时原窗口内可操作回退。
- [x] 定向测试、原 chat-panel／renderer-components 测试和 typecheck 通过后独立复核。

计时测试示例：

```ts
controller.accept({ type: 'assistant_message_start', turnId: 'one' });
controller.accept({ type: 'assistant_message_delta', turnId: 'one', delta: '你好' });
clock.advance(30_000);
expect(controller.snapshot()?.text).toBe('你好');
controller.accept({ type: 'assistant_message_commit', turnId: 'one', text: '你好' });
clock.advance(29_999);
expect(controller.snapshot()).not.toBeNull();
clock.advance(1);
expect(controller.snapshot()).toBeNull();
```

## 任务 4：正式窗口装配

**文件：** 新增 `apps/desktop/src/main/windows/chat-presentation-windows.ts`、`apps/desktop/tests/chat-presentation-windows.test.ts`；修改 `window-manager.ts`、`window-commands.ts`、`main/index.ts` 的窗口装配、`electron-builder.yml` 的必要原生资源以及原窗口测试。不得修改角色几何权威或 ConversationEventProjection。

**接口：** 组合任务 1–3；顶部观察使用 Electron screen，气泡位置消费现有宠物视觉包围框和原生 move 事件。当前 chat getter 仍只返回原 chat。窗口控制器提供显示、收起请求、布局同步、几何更新、销毁清理和测试快照。

贴边布局通过既有命令通道向 bubble 单独投递 `bubble-anchor`，只含 `bodyLeft`、`tailX` 和 `side`。Main 计算局部位置，Renderer 的宽度自适应约束保证旧锚点在正文变长时不会引起裁宽反馈；没有新增宠物状态、屏幕读取或业务能力。

- [x] RED：窗口端口测试覆盖中央顶边提示、不抢焦点、点击才展开、外部点击收起、透明空白穿透、跨屏/DPI、气泡跟随与边界限位；证明没有调用宠物移动或状态 API。
- [x] GREEN：接入原聊天窗口与纯展示气泡，借原生材质／形状支持玻璃；旧相邻定位退出正式入口。
- [x] 原 hideChat／窗口 close 请求先执行收起动画，再隐藏原生窗口；顶部收起不撤销气泡等待、不取消任务。
- [x] 新窗口只收到专属展示 API 事件，业务 sender 白名单保持原状；展示失败使原 chat 的确认入口可达。
- [x] 更新资源打包断言，运行窗口、IPC、事件投影和生命周期定向测试、typecheck、build；独立复核。

不可越界断言：

```ts
controller.updatePetGeometry(geometry);
expect(pet.setBounds).not.toHaveBeenCalled();
expect(cancelTask).not.toHaveBeenCalled();
expect(pet.webContents.send).not.toHaveBeenCalledWith(expect.stringContaining('presentation'), expect.anything());
```

## 任务 5：视觉验收与减法收口

用户最后明确只负责聊天界面视觉层，停止额外角色、拖拽和模型业务回归及其问题修补。本任务按最新范围收口；早先额外运行仅保留过程记录，不充当最终整套业务通过证明。

**文件：** 新增 `tests/e2e/chat-visual-presentation.spec.ts` 并在 `tests/playwright.config.ts` 注册；新增 `docs/operations/2026-09-13-desktop-chat-visual-redesign-acceptance.md`。既有 `desktop.spec.ts`、`character-event-bindings.spec.ts`、`character-motion-continuity.spec.ts` 与 `tests/fixtures/electron-app.ts` 只保留受新 UI 影响的菜单、历史、气泡、详情、收起动画及分窗可见性定位，不改变原模型准备或业务断言。

`apps/desktop/tests/explorer-layer-production-boundary.test.ts` 与 `desktop-e2e-entry.test.ts` 的精确资源／测试归属名单同步新增正式视觉文件，保留原边界断言。撤除为额外回归加入的模型身份预植、绑定响应脚本修补和无关坐标诊断。

- [x] RED → GREEN：正式 Electron 与真实浏览器定位视觉差异，修复菜单命中、输入遮挡、气泡贴边和显示回退；不放宽原业务断言。
- [x] 定向组件、计时、展示协议和窗口测试验证发送入口、头顶正文、30 秒生命周期、原按钮映射、过期点击及故障回退。
- [x] 正式视觉 E2E 验证顶边提示、三球展开、菜单／历史、输入左侧、原生区域、受控外部首击和独立气泡保留。
- [x] 类型检查、构建及相关安全／集成检查记录实际结果；完整门禁既有失败单独标明，不继续额外业务修复。
- [x] 独立复核展示职责与业务零改动边界；删除已替代的旧视觉代码。
- [x] 验收记录区分 Windows 11 实测、视觉自动化和其他环境待人工确认。
- [x] 最后核对范围清理、`git diff --check` 与文档链接；Git 始终只读。
