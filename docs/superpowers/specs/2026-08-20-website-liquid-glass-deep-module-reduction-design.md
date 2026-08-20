# 网站液态玻璃深模块减法设计

> 文档状态：用户已于 2026-08-20 批准，并二次批准大量删除范围
> 日期：2026-08-20
> 适用范围：网站首页液态玻璃、章节静态呈现、输入控制器、网站 E2E

## 1. 现状证据

`LiquidGlassHome.tsx` 当前约 1154 行，表面接口只有 `active`、`isPaused`、`reducedMotion` 和 `transitionProgress`，但真实接口还外泄为四条全局 `window` 事件、事件载荷、About/Download 业务文案、Community 页码与卡片数、Support 选择状态、七张 GPU 纹理和跨五章节生命周期。调用者必须知道大量隐含协议，因此它是浅模块而不是首页渲染深模块。

当前完整网站门的真实证据：

- E2E 已从 44 项收敛为 16 项，website 323 项测试与 typecheck 通过；
- 16 项顺序运行仍在第 6 项第一步 `mouse.move` 超时；
- 关闭 trace 连续截图后，失败 trace 图片从 83 张降为 1 张，但同一调用仍超时，截图假设已证伪并撤销；
- 首页 WebGL 从 progress 0 持续到 4.08，覆盖五章；每个页面测试均建立完整 shader、七张纹理与 ticker；
- `useWebsiteController` 的全局 pointer 状态没有消费者，却在每次 `pointermove` 时触发 React 五章节树更新；
- `reducedMotion=true` 仍初始化首页 WebGL、下载 Three.js、纹理、ticker 和 RAF，只在绘制阶段减少运动。

## 2. 设计目标

1. 把 `LiquidGlassHome` 收敛为深模块：小接口背后只隐藏首页→介绍交接所需的核心流体背景和 GPU 生命周期。
2. 真实业务文案、分页、按钮选择和 DOM 交互只由各章节拥有，不再镜像进 GPU。
3. 删除四条装饰性全局事件，不把它们上移成另一组 React props 或新事件总线。
4. `prefers-reduced-motion` 使用真实无 GPU 静态路径，不把用户偏好伪装成初始化失败。
5. 删除无人消费的 controller pointer 状态和全局 React 重渲染链。
6. 不增加文件、依赖、Adapter、兼容 wrapper、测试 runner、重试或超时。

## 3. 保留的深模块接口与行为

`LiquidGlassHome` 继续只接收：

```ts
interface LiquidGlassHomeProps {
  active: boolean;
  isPaused: boolean;
  reducedMotion: boolean;
  transitionProgress?: number;
}
```

正常动画模式保留：

- 首页 AP Logo 与核心 hero；
- 首页到介绍章节的基础玻璃分裂/交接；
- 流体背景、指针响应与 canvas 自身点击波纹；
- DPR 缓冲区、resize、暂停/恢复和真实初始化失败回退。

About、Download、Community、Support 的真实内容和交互继续由现有 DOM 模块承载，不新建替代模块。

## 4. 批准后删除的生产职责

### 4.1 四条全局装饰事件

删除：

- `LIQUID_GLASS_RIPPLE_EVENT`：删除 LanguageMenu、About、Download、SharedPetCard 的跨模块装饰派发；保留各自 DOM 交互和 canvas 自身波纹。
- `LIQUID_GLASS_INTERACTION_EVENT` 与 `LiquidGlassInteractionDetail`：删除 About 到 GPU 的 hover/drag 镜像；保留 About DOM 卡片的悬停、焦点、拖拽和键盘行为。
- `LIQUID_GLASS_COMMUNITY_CARDS_EVENT`：删除 Community 页码/卡片数到 GPU 的重复投影；Repository、分页和卡片 DOM 不变。
- `LIQUID_GLASS_SUPPORT_SELECTION_EVENT`：删除 Support 当前选择到 GPU 的重复投影；反馈、投稿、付款码和按钮状态不变。

不得把上述事件替换为 Context、store、callback props 或新的事件名称。

### 4.2 五章业务纹理和 shader 分支

从 `LiquidGlassHome` 删除：

- `useI18n`、`createAboutFeatures`、`createDownloadContent` 反向依赖；
- corner/about/download/community/support 五张文字纹理及其离屏画布、绘制函数、更新状态和 sampler；
- download/community/support transition、社区卡片数、Support 选择、About hover/drag 的 uniform 和动画状态；
- 只服务上述职责的资源数组成员、事件监听和 cleanup。

从 `liquid-glass-shaders.ts` 删除对应 uniform、sampler、SDF、业务文字合成和条件分支。保留首页 logo/hero、基础玻璃、流体背景、指针、canvas 波纹和颜色合成。

### 4.3 生命周期和 controller

- `HomeExperience` 的 GPU active 范围从 `exitProgress < 4.08` 收窄为只覆盖首页→介绍交接，目标阈值 `1.08`。
- `WebsiteExperience` 不再强制首页 WebGL 在 progress 0—4 全程可见；下载及后续章节使用现有 `ChapterBackdrop`。
- 从 `useWebsiteController` 删除无人消费的 pointer 返回值、state/ref、全局 pointer listener、cleanup 和每帧 setState。
- 不重试 `WEBGL_lose_context`、`pagehide` 或独立浏览器方案；这些方向已有失败证据。

## 5. Reduced-motion 无 GPU 路径

当 `reducedMotion=true`：

- `LiquidGlassHome` 不调用 `getContext('webgl')`，不编译 shader、不创建纹理、不注册 GSAP ticker；
- 显示现有品牌静态 fallback，但 `data-initialization-failed` 保持 `false`；
- About、Download、Community、Support 复用现有 DOM，并通过统一的静态呈现状态保证文本、按钮和导航可见；
- Download 不挂载 `DownloadModelViewer`，不创建第二个 WebGL context、GLTF 或 RAF；
- 系统偏好运行中切换为 reduce 时释放正常动画 effect；切回 no-preference 时可重新初始化。

静态模式不得创建第二套页面或复制业务文案。必要 CSS 只解除现有 DOM 的透明/隐藏装饰。

## 6. E2E 职责

> **2026-08-21 当前职责接替：** 下列四项是 2026-08-20 阶段 0 的历史配置。当前 normal-motion 真实浏览器专项只保留 `390 离开再返回首页后液态画布缓冲区保持可用` 与 `390 宽度液态玻璃首页无横向溢出`；1440×900、DPR 2 的缓冲/viewport 以及 pointer uniform、点击 ripple 数据流由 `apps/website/tests/magnetic-intro.test.tsx` 的组件契约承担。滚轮状态机由模型/控制器测试承担，真实全局 wheel 接线合并到既有 reduced-motion E2E。接替规格为 `2026-08-21-website-gpu-e2e-responsibility-subtraction-design.md`。

网站 Playwright 默认使用真实 `reducedMotion: 'reduce'`，使法律、审核、反馈、付款码和普通移动布局链走无 GPU 产品路径。仅以下四项在导航前显式使用 `no-preference`：

1. `普通滚轮连续追赶、吸附、隔离惯性并重计新手势`
2. `390 离开再返回首页后液态画布缓冲区保持可用`
3. `390 宽度液态玻璃首页无横向溢出`
4. `液态玻璃 WebGL 画布按性能比例建立缓冲区并响应指针`

`减少动态效果直接进入稳定首页` 保持 reduce，用于证明静态产品路径。不得根据 `NODE_ENV`、查询参数或测试变量改变产品行为。

## 7. 精确修改与删除范围

生产文件：

- `apps/website/components/home-experience/LiquidGlassHome.tsx`
- `apps/website/components/home-experience/liquid-glass-shaders.ts`
- `apps/website/components/home-experience/HomeExperience.tsx`
- `apps/website/components/website-experience/WebsiteExperience.tsx`
- `apps/website/components/website-experience/use-website-controller.ts`
- `apps/website/components/i18n/LanguageMenu.tsx`
- `apps/website/components/website-experience/about/AboutChapter.tsx`
- `apps/website/components/website-experience/download/DownloadChapter.tsx`
- `apps/website/components/website-experience/community/SharedPetChapter.tsx`
- `apps/website/components/website-experience/community/SharedPetCard.tsx`
- `apps/website/components/website-experience/support/SupportChapter.tsx`
- About、Community、Support 现有 CSS module 中必要的静态可见规则

测试与配置：

- 对应现有 website 测试，不新增测试文件；删除只锁定全局装饰事件或旧 GPU 业务投影的测试。
- `tests/playwright.website.config.ts`
- `tests/e2e/website.spec.ts`
- `docs/operations/website-chain-verification-acceptance.md`

预计生产代码净减少约 900—1100 行：`LiquidGlassHome` 减少约 574—674 行，shader 减少约 249—319 行，controller 和事件生产者减少约 70—110 行。最终以 Git diff 事实为准。

## 8. 安全与业务不变量

以下行为不得变化：

- 匿名投稿、系统审核、管理员审核和公开可见性；
- 状态令牌 Fragment 清理；
- Download 发布状态与真实安装信息；
- Community Repository、分页与卡片操作；
- Support 反馈草稿、投稿、付款码和输入隔离；
- i18n 文案与语言切换；
- 桌宠、Agent、文件工具和角色代码完全不修改。

## 9. 验收与停止条件

> **2026-08-21 当前验收：** 2026-08-20 的四项 normal-motion 与完整 16/16 仍是当日阶段 0 历史结果；当前门使用上述两条 390 E2E、组件 DPR/指针契约和 14 项完整清单，已在阶段 1 Task 11 中自动化通过。

先写 RED：

- reduce 下首页和 Download 不创建 WebGL；静态品牌与章节业务 DOM 可见；失败标志保持 false；
- normal motion 下首页仍创建 WebGL；切换 reduce/no-preference 可释放并重建；
- controller pointer 已从接口删除且章节滚轮/触屏行为保持；
- 四条全局事件从运行代码零命中，相关 DOM 行为测试仍绿。

GREEN 后依次运行：website 组件测试、typecheck、前 6 项锁定 E2E、完整 16 项 E2E、`verify:web-chain:fast`、`verify:web-chain`、范围守卫和 `git diff --check`。任一命令或问题达到 15 分钟立即停止。

如果前 6 项仍在同一 `mouse.move` 阻塞，停止本方案，不增加测试外围或继续删除独有 E2E。

## 10. 大量删除批准与恢复

本规格涉及跨 10 个生产 TS/TSX 文件、1 个 shader 文件、相关测试和 3 个现有 CSS module 的集中职责删除，预计净减 900—1100 行，属于大量删除。实施前必须取得用户对第 4、5、7 节的二次明确批准。

删除通过独立 Git 提交保存，可从父提交恢复；不删除用户文件、远端数据或部署资源。
