# 网站液态玻璃深模块减法实施计划

> **前置条件：** 用户批准对应设计并二次批准第 4、5、7 节的大量删除范围后执行。使用 subagent-driven-development、TDD 和提交前独立审查。

**Goal:** 把 `LiquidGlassHome` 从跨五章节业务投影器收敛为首页→介绍交接的深 GPU 模块，为 reduced-motion 提供真实无 GPU 路径，并恢复网站阶段 0 完整门。

## 全局约束

- 只修改规格第 7 节文件；绝不触碰桌宠、Agent、文件工具或角色代码。
- 删除全局事件，不建立替代事件总线、Context、store 或 callback props。
- 不新增文件、依赖、runner、fixture、worker、retry、timeout 或测试专用产品分支。
- 不执行部署、远端修改或真实 CloudBase 操作。
- 每个行为变化执行 RED → GREEN → REFACTOR；每个问题 15 分钟止损。

### Task 1：建立 reduced-motion 无 GPU 契约

1. 在现有 fallback、motion-disabled、Download 测试中增加 RED：reduce 下 `getContext('webgl')` 和 Three.js 模型不初始化，静态 DOM 可见，失败标志不变化。
2. 最小实现静态呈现状态；复用现有 fallback 和 DOM，不复制文案。
3. 删除 `LiquidGlassHome` 内变为不可达的 reduced-motion render 分支。
4. 运行定向测试、website 全测和 typecheck；请求独立审查。

### Task 2：删除四条装饰事件和 controller pointer

1. 先锁定 About、Download、Community、Support 现有 DOM 业务行为。
2. 删除四条事件的导出、生产者、消费者、载荷、监听和 cleanup；删除 `community-ripple.test.tsx` 等只锁旧事件的测试。
3. 删除 controller 无消费者 pointer state/ref/listener/cleanup/返回值。
4. 运行相关组件/控制器测试、引用扫描、全测和 typecheck；请求独立审查。

### Task 3：删除五章 GPU 业务纹理并收窄 shader

1. 保留首页/介绍核心 WebGL E2E 作为 RED/GREEN 接口测试。
2. 从 Liquid 删除业务内容工厂、i18n、五张纹理和业务 uniform；同步从 shader 删除对应 sampler/SDF/合成分支。
3. 将 GPU active 范围收窄到 progress `< 1.08`，删除 WebsiteExperience 的 0—4 强制首页可见逻辑。
4. 每组删除后运行 shader/组件定向测试与 typecheck，避免一次性产生孤儿。
5. 统计真实净行数并请求独立审查。

### Task 4：配置真实偏好并恢复阶段 0 门

> **实际状态：2026-08-20 已完成。** 已取得完整 16 项网站 E2E、网站测试与类型检查、范围守卫及网站链 fast/full 的实际通过证据；人工视觉验收仍待用户确认。

1. Playwright 默认设为 `reducedMotion: 'reduce'`；仅规格列出的四项真实 GPU/动画测试在导航前显式 `no-preference`。
2. 先运行前 6 项锁定序列；必须 6/6 通过，否则停止。
3. 运行完整 16 项 E2E、website 323+ 测试、typecheck、fast/full 网站链与范围守卫。
4. 更新网站验收文档；人工视觉仍标记待用户确认。
5. 提交前独立复核业务不变量、删除范围、运行引用和受保护 Phase 0 差异。

### Task 5：收敛阶段 0 状态

> **实际状态：2026-08-20 已完成。** 产品减法与网站链 runner 已提交；最终验证证据和文档收敛已完成，最终文档尚待本次提交以闭合阶段 0。正式部署继续冻结。

全部自动门通过后，提交产品减法与验证证据，更新 foundation Task 4 和总优化索引。正式部署继续冻结，随后进入阶段 1 发布安全业务优化。
