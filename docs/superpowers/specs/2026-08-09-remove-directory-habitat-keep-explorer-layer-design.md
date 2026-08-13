# 删除目录藏身并保留 Explorer 动态图层设计

> **2026-08-10 阶段 3 尾声修订：** 本文正文记录目录藏身退役时的设计与验收基线，其中 `alwaysOnTop: false` 指当时的默认模式。后续新增默认关闭、由用户显式控制的独立窗口置顶偏好：开启时全局置顶并暂停 `moveAbove`，关闭时立即恢复 `alwaysOnTop: false`，后续新鲜准确快照可重新建立相邻层级。该例外不改写下方历史任务与验收结论，也不追认未完成的人工矩阵。

## 1. 背景与决策

阶段 3B 已实现 Explorer 活动标签识别、Electron 窗口相邻层级和目录藏身业务。真实人工验收表明，目录藏身并非当前产品核心目标；继续修复该业务会消耗与核心图层目标不相称的时间。

本次产品决策为：

- 彻底删除目录藏身业务及其专用基础设施；
- 保留并独立化 Explorer 动态图层；
- 桌宠始终保持普通可见窗口，不因 Explorer 失焦、桥异常或快照不可用而自行隐藏；
- `alwaysOnTop` 始终为 `false`；
- Explorer 在前台且快照准确时，桌宠通过 Electron `moveAbove` 位于该 Explorer 窗口上方；
- 切换到其他应用后不执行额外置顶或隐藏，由 Windows 自然把当前应用放在桌宠上方。

本设计取代尚未提交的“手动进入目录空间前台探针修复”，并终止目录空间 Task 12 人工验收。

## 2. 目标

1. 生产应用不再提供目录授权、藏身、呼唤、召回或自动藏身能力。
2. 生产应用不再读取、采集、传输或展示 Explorer 当前目录路径。
3. Explorer 活动窗口识别继续使用固定 helper、认证 JSONL 管道、严格协议与精确实例/序列校验。
4. 图层协调器只调整 Z 序，不控制桌宠显示、隐藏、焦点、坐标、动作或持久化。
5. 删除被替代的旧模块、旧协议字段、旧 UI、旧测试和死代码，不保留兼容壳、环境开关或双路线。
6. 保留普通桌宠显示/隐藏命令、桌面坐标持久化、角色系统和其他设置。

## 3. 非目标

- 不重新设计桌宠视觉、角色动作或聊天功能。
- 不实现跨平台 Explorer 等价能力。
- 不主动删除用户磁盘上已有的 `habitat.json`；新版本只是不再读取它。
- 不恢复 User32 `SetWindowPos` 层级路线。
- 不引入通用窗口枚举、标题读取、截图、键鼠模拟或目录扫描能力。
- 不在本次工作中解决多显示器、负坐标或混合 DPI 的新增产品行为；保留现有 Electron 图层测试覆盖。

## 4. 保留的图层核心

保留并迁移到独立的 Explorer 模块边界：

- `explorer-space-bridge.ps1`；
- `explorer-space-shell-tab-helper.cs`；
- Explorer 严格协议与客户端；
- 活动 Explorer 标签到外层 HWND 的唯一映射；
- 双采样、实例身份、单调序列、前台与最小化校验；
- `ExplorerWindowLayerController` 的 Electron `moveAbove` 路线；
- bridge/helper 逐文件打包与完整性校验；
- 非 topmost 窗口安全门。

原 `src/main/habitat` 中仍需保留的 Explorer 文件迁移到 `src/main/explorer`。迁移完成后不保留仅起转发作用的旧路径文件。

## 5. 新图层协调器

新增单一职责的 `ExplorerPetLayerCoordinator`：

- 输入为 Explorer 客户端发布的严格快照；
- 只接受当前 bridge 代次内单调递增的事件；
- 只在 `ready`、前台、非最小化、非歧义且 HWND 为规范十进制字符串时调用 `moveAbove`；
- `none`、`ambiguous`、`unavailable`、失焦、最小化、陈旧序列和桥错误均只更新内部水位或记录稳定错误，不调用 `show`、`hide`、`focus` 或坐标接口；
- 重复或并发快照不得让旧异步完成覆盖较新层级事实；
- `close` 后拒绝新动作并等待当前层级调用收敛。

协调器不拥有目录、路径、Habitat 状态、运动区域或角色表现概念。

## 6. 路径事实删除

图层只需要 Explorer HWND、实例、矩形、前台、最小化和序列，不需要目录路径。因此：

- `explorer-snapshot` 的 `ready` 结构删除 `path`；
- bridge 不再序列化路径；
- helper 删除路径读取、路径规范化、路径竞态和路径指纹逻辑；
- helper 仍保留唯一标签映射和映射前后双采样；
- 搜索结果可作为普通 Explorer 窗口参与图层，不再因其虚拟路径被判为 `none`；
- 日志、Renderer、preload、Agent 和 E2E 控制面均不得出现 Explorer 路径。

## 7. 彻底删除范围

### 7.1 Main 业务

删除：

- Habitat Store、目录策略、身份解析、位置 CAS；
- Habitat 状态机、错误码、自动策略、设置服务；
- Habitat 窗口控制器、目录运动区域、前台全屏 blocker；
- Habitat 启动恢复、召回、呼唤、自动进入和观察匹配；
- Habitat 专用托盘命令和 Main E2E fake。

混合生命周期文件中的通用启动清理、退出协调、角色切换协调和异步错误边界迁移到中性命名模块；迁移后删除旧 Habitat 文件，避免保留误导性边界。

### 7.2 Renderer、preload 与 IPC

删除：

- 设置页“空间”标签和 `HabitatSettings`；
- Habitat DTO、Zod schema 和 8 个 IPC channel；
- preload 中 8 个 Habitat API；
- Main 的 Habitat IPC 注册与 sender 门；
- 相关公开 API 类型和测试。

### 7.3 托盘与设置

删除“藏到目录”“呼唤桌宠”“召回桌面”和目录列表。保留普通桌宠显示/隐藏、聊天、角色工作室、设置和退出命令。

### 7.4 角色与运动

删除仅由目录空间引入的：

- `hide`、`emerge` 行为状态和调度事实；
- Habitat 表现请求、令牌与固定回退；
- 官方角色中的目录空间动作；
- folder 运动区域、local offset 和 folder 位置持久化。

保留普通桌面移动、idle/moving 行为、用户交互暂停以及退出前安全排空。

### 7.5 测试与文档

删除只验证已移除业务的测试、fixture、人工验收文档和未提交的前台探针修复文档。保留并更新 Explorer helper、协议、客户端、图层控制器、窗口安全、打包完整性和 Electron 图层验证。

历史架构与实施计划不作为生产入口；在活跃总设计和阶段计划中明确标记目录藏身已退役、Explorer 动态图层继续保留，防止后续重新引入已删除业务。

## 8. 启动、失败与退出

### 8.1 启动

1. 创建 `alwaysOnTop: false` 的桌宠窗口；
2. 完成普通 Renderer 与角色初始化；
3. 启动 Explorer bridge 并注册图层协调器；
4. bridge 启动失败不阻止桌宠显示，应用退化为普通窗口层级。

### 8.2 运行失败

- bridge、协议、完整性或 `moveAbove` 失败不得隐藏桌宠；
- 不得把桌宠改为 topmost；
- 只记录不包含路径、HWND、实例或私有错误文本的稳定错误码；
- 后续新鲜准确快照允许重新建立图层。

### 8.3 退出

退出顺序只保留：停止观察与定时任务、关闭图层协调器、关闭 bridge、排空普通桌面位置写入，再执行既有角色与 Agent 清理。不存在 Habitat 保存、召回或目录清理。

## 9. 数据处理

新版本不读取或迁移 `habitat.json`，也不自动删除该文件。原因是功能代码删除不应隐式扩大为用户数据删除。用户以后执行应用级“清除本地数据”时，可由统一数据清理流程处理遗留文件；本次不新增专用删除逻辑。

## 10. 测试设计

### 10.1 TDD 顺序

1. 新增图层协调器失败测试，证明当前代码缺少“只调层级、不改可见性”的边界；
2. 新增生产边界失败测试，锁定 Habitat IPC、Store、UI、行为状态、路径快照和旧控制器均不存在；
3. 最小实现图层协调器并接入 Main；
4. 删除目录业务及其测试，再更新保留的 Explorer 测试；
5. 删除路径字段与 helper 路径读取，更新真实 helper/bridge 测试；
6. 运行 runtime、Desktop 全量、typecheck、build 和 Electron 图层验证。

### 10.2 自动行为门

- 准确前台 Explorer 快照只调用一次 `moveAbove`；
- 陈旧序列、错误实例、失焦、最小化、歧义、不可用和 bridge 错误不调用层级且不隐藏；
- 切换 Explorer 窗口时较旧异步完成不能覆盖新窗口；
- 图层失败后窗口仍可见且 `alwaysOnTop` 为 `false`；
- 生产协议与输出无 `path`；
- 生产源码无 Habitat IPC、目录 Store、hide/emerge、自动藏身和旧 User32 层级路线；
- 打包资源仍只包含固定 bridge/helper，不包含测试 fixture。

### 10.3 人工验收

1. Explorer 前台时确认桌宠位于该 Explorer 上方；
2. 切到普通应用时确认普通应用覆盖桌宠，桌宠自身没有隐藏；
3. 再切回 Explorer，确认动态图层重新建立；
4. 关闭或最小化 Explorer，确认桌宠保持普通可见窗口；
5. 确认设置页和托盘中不存在任何目录空间入口。

## 11. 完成标准

- 上述目录业务生产代码、入口、协议、测试和未提交文档全部删除；
- Explorer 动态图层自动门和人工验收通过；
- `alwaysOnTop: false` 保持；
- 全量测试、typecheck、build 与打包资源审计通过；
- 工作树中不存在兼容壳、双路线、无引用导出或仅为旧 Habitat 保留的依赖；
- 活跃架构文档准确反映“目录藏身退役、Explorer 图层保留”。
