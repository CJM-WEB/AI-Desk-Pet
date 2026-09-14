# 当前对话持久化与切换确认实施计划

依据：[本次规格](../specs/2026-09-13-current-conversation-persistence-design.md)。采用子智能体驱动开发与 TDD；已有独立工作树内实施，不新增依赖、不改官网、不自动提交。目标是普通当前对话退出后可恢复，模型切换先确认，并保留用户确认的无痕例外。

## 任务一：Main 会话存储与消息归并

文件：新增 `apps/desktop/src/shared/conversation-transcript.ts`、`apps/desktop/src/main/conversation/conversation-session-store.ts` 及对应桌面测试；按需要扩展 `conversation-history.ts` 的恢复／变更通知。复用 `atomic-file-coordinator.ts` 与 `SecretEncryptionAdapter`。

- [x] RED：真实临时文件重建恢复、流式仅正式提交保存、完整记录不随模型上下文裁剪、无痕关闭后不补存、清空与排队写入、损坏与解密失败不覆盖。
- [x] GREEN：最小单文件快照、加密与串行原子写入；独立保存有界模型历史，仅恢复数据。
- [x] 定向测试与接口复核，向主线程交付初始化、事件接纳、上下文更新、新对话、无痕与 flush 接口。

## 任务二：模型切换事务

文件：`settings/desktop-settings-service.ts`、`local-model/local-model-service.ts`、`ipc/register-ipc.ts` 的设置注册部分、新增必要的 Main 模型切换协调模块及对应测试。`main/index.ts` 由主线程接线。

- [x] RED：取消零设置写入且零清理、同值和非活动配置不新建对话、Qwen 覆盖云设置、本地 stop/save 失败保留文字、已提交本地但 start 失败按新模型处理。
- [x] GREEN：统一身份比较与串行确认，复用已有设置回滚；运行失效先于提交，清文字只在身份实际变化后执行，清除旧无条件 reset 路径。
- [x] 定向测试并记录供主线程注入的确认、运行失效、新对话接口。

## 任务三：会话生命周期与界面恢复

文件：`conversation-coordinator.ts`、`main-conversation-composition.ts`、`main/index.ts`、`shared/ipc-channels.ts`、`shared/myself-api.ts`、`preload/index.ts`、Agent IPC、Renderer `App.tsx`／`task-store.ts`／必要聊天与设置文案及相关测试。

- [x] RED：配置失效保留历史但撤销任务、实例重建恢复上下文、chat 专属恢复、快照与新消息／新对话顺序、不会恢复旧许可。
- [x] GREEN：接通 Main 存储和统一切换确认；恢复只给 chat，消息归并共用；新对话与清数据共用清理，退出等待写入。
- [x] 相关测试与桌面类型检查；最小隔离 Electron 场景验证重启与无痕；确认接受／取消使用 Main 和 UI 定向测试，实际原生对话框待用户人工确认，不启动用户真实配置。

## 任务四：收口

- [x] 复核规格与安全边界；运行 `verify:desktop`、必要安全／集成和定向 E2E，记录失败与人工范围。
- [x] 更新 CONTEXT、旧规格替代指针与独立验收记录；检查中文编码、链接、差异和未清理旧路径。

结果与未覆盖范围见[独立验收记录](../../operations/2026-09-13-current-conversation-persistence-acceptance.md)；完成实施和检查不表示既有完整门禁失败已修复。
