# 官网文件预览与 PayPal 图片修复实施计划

> **面向实施代理：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`，按任务逐项执行。步骤使用复选框跟踪。

**目标：** 让 PayPal 付款弹窗加载现有 PNG 资源，并恢复下载、反馈章节外围共享文件图标的悬浮预览。

**架构：** 继续使用配置驱动的付款方式和现有 `FileSwarm` 预览机制。章节容器只负责视觉层叠，下载与反馈的局部控件显式接管指针，其余区域穿透到共享文件层；反馈随机内容仍由现有生成期绑定内容源负责。

**技术栈：** Next.js 15、React 19、TypeScript、CSS Modules、Vitest、Testing Library、Playwright。

## 全局约束

- 所有文档和代码注释使用中文。
- 不复制或替换 `apps/website/public/Paypal.png`。
- 不新增文件悬浮组件，直接复用 `FileSwarm`、`FilePreview` 和现有内容源。
- 不改变文件粒子的生成频率、轨迹、数量和视觉资源。
- 不改变反馈仓储、排序、点赞和投稿逻辑。
- 本任务已获得 Git 写操作授权；每个完成审核的任务允许小步提交，但不执行合并或推送。
- 每个生产代码修改前必须先运行对应失败测试。

---

## 文件结构

- `apps/website/components/website-experience/donation/donation-content.ts`
  - 维护付款方式与付款码资源路径的唯一映射。
- `apps/website/components/website-experience/website-experience.module.css`
  - 维护根级章节与共享文件层之间的指针命中契约。
- `apps/website/components/website-experience/download/download.module.css`
  - 恢复下载章节侧边感应区和平台堆叠的局部指针命中。
- `apps/website/tests/payment-model.test.ts`
  - 验证三种付款方式的资源配置。
- `apps/website/tests/donation-chapter.test.tsx`
  - 验证 PayPal 弹窗消费配置中的 PNG 路径。
- `tests/e2e/website.spec.ts`
  - 在真实浏览器中验证下载、反馈文件图标可被悬浮并出现预览，同时验证主要控件仍可操作。

### Task 1（任务 1）：修正 PayPal 付款码路径

**文件：**

- 修改：`apps/website/tests/payment-model.test.ts`
- 修改：`apps/website/tests/donation-chapter.test.tsx`
- 修改：`tests/e2e/website.spec.ts`
- 修改：`apps/website/components/website-experience/donation/donation-content.ts`

**接口：**

- 消费：`PAYMENT_METHODS`
- 产出：PayPal 项的 `qrImagePath` 固定为 `/Paypal.png`

- [ ] **步骤 1：先把付款配置测试改为 PNG 期望值**

```ts
expect(PAYMENT_METHODS.map((item) => item.qrImagePath)).toEqual([
  '/WechatPay.jpg',
  '/Alipay.jpg',
  '/Paypal.png'
]);
```

- [ ] **步骤 2：把捐款章节弹窗测试改为 PNG 期望值**

```ts
expect(screen.getByRole('img', { name: 'PayPal付款码' }).getAttribute('src'))
  .toBe('/Paypal.png');
```

- [ ] **步骤 3：把端到端付款码断言改为 PNG 期望值**

```ts
await expect(paypalImage).toHaveAttribute('src', '/Paypal.png');
```

- [ ] **步骤 4：运行单元测试并确认因生产配置仍为 JPG 而失败**

运行：

```powershell
pnpm --filter @myself/website test -- payment-model.test.ts donation-chapter.test.tsx
```

预期：至少两个 PayPal 路径断言失败，实际值为 `/Paypal.jpg`，期望值为 `/Paypal.png`。

- [ ] **步骤 5：最小修改 PayPal 配置**

```ts
{
  id: 'paypal',
  name: 'PayPal',
  qrImagePath: '/Paypal.png',
  imageAlt: 'PayPal付款码'
}
```

- [ ] **步骤 6：重新运行目标测试**

运行：

```powershell
pnpm --filter @myself/website test -- payment-model.test.ts donation-chapter.test.tsx
```

预期：目标测试全部通过。

### Task 2（任务 2）：恢复下载与反馈文件图标悬浮预览

**文件：**

- 修改：`tests/e2e/website.spec.ts`
- 修改：`apps/website/components/website-experience/website-experience.module.css`
- 修改：`apps/website/components/website-experience/download/download.module.css`

**接口：**

- 消费：`[data-testid="file-icon"]`、`[data-testid="file-preview"]`、章节 `data-chapter-id`
- 产出：下载和反馈章节的外围区域允许指针命中共享文件图标，局部控件保持 `pointer-events: auto`

- [ ] **步骤 1：增加真实浏览器悬浮回归测试**

在 `tests/e2e/website.spec.ts` 中增加：

```ts
test('下载与反馈章节的外围文件图标可悬浮预览且主要控件保持可操作', async ({
  page
}) => {
  const runtimeErrors = collectRuntimeErrors(page);
  await page.setViewportSize({ width: 1440, height: 900 });
  await enterInteractive(page);

  await enterChapter(page, 'download');
  const downloadIcon = page.locator(ICON).first();
  await expect(downloadIcon).toBeVisible();
  await downloadIcon.hover();
  await expect(page.locator(PREVIEW)).toBeVisible();
  await expect(page.getByRole('group', { name: '选择下载平台' })).toBeVisible();

  await page.keyboard.press('PageDown');
  await expect(page.locator(WEBSITE)).toHaveAttribute(
    'data-active-chapter',
    'feedback'
  );
  const feedbackIcon = page.locator(ICON).first();
  await expect(feedbackIcon).toBeVisible();
  await feedbackIcon.hover();
  const feedbackPreview = page.locator(PREVIEW);
  await expect(feedbackPreview).toBeVisible();
  await expect(feedbackPreview).toContainText(/类型 (反馈|建议)/u);
  await expect(page.getByRole('group', { name: '选择反馈操作' })).toBeVisible();

  expect(runtimeErrors).toEqual([]);
});
```

- [ ] **步骤 2：构建并运行新增测试，确认图标悬浮被章节层拦截**

运行：

```powershell
pnpm.cmd --filter @myself/website build
.\node_modules\.bin\playwright.cmd test --config tests/playwright.website.config.ts --grep "下载与反馈章节的外围文件图标" --workers=1
```

预期：测试在 `downloadIcon.hover()` 或 `feedbackIcon.hover()` 处失败，Playwright 报告其他元素截获指针，或预览保持不可见。

- [ ] **步骤 3：让三类共享文件章节的全屏容器统一穿透指针**

将 `website-experience.module.css` 中现有捐款规则扩展为：

```css
/* 共享文件章节只让局部控件接管指针，外围区域继续命中文件图标。 */
.chapter[data-chapter-id='download'],
.chapter[data-chapter-id='feedback'],
.chapter[data-chapter-id='donation'] {
  pointer-events: none;
}
```

- [ ] **步骤 4：显式恢复下载章节核心控件命中**

在 `download.module.css` 中补充：

```css
.sideSensor,
.platformStack {
  pointer-events: auto;
}
```

反馈章节的 `.feedbackRoller` 和捐款章节的 `.paymentRoller` 已经显式设置 `pointer-events: auto`，不重复修改。

- [ ] **步骤 5：重新构建并运行新增测试**

运行：

```powershell
pnpm.cmd --filter @myself/website build
.\node_modules\.bin\playwright.cmd test --config tests/playwright.website.config.ts --grep "下载与反馈章节的外围文件图标" --workers=1
```

预期：下载和反馈文件图标均能悬浮显示预览，两个章节的主要控件可见且无运行时错误。

- [ ] **步骤 6：运行反馈随机绑定现有测试**

运行：

```powershell
pnpm --filter @myself/website test -- feedback-preview-source.test.ts
```

预期：同一粒子绑定稳定、释放后重新随机、空仓储与读取失败兜底测试全部通过。

### Task 3（任务 3）：完整回归验证

**文件：**

- 验证：`apps/website`
- 验证：`tests/e2e/website.spec.ts`

**接口：**

- 消费：任务 1 和任务 2 的全部变更
- 产出：可构建、类型正确且交互回归通过的网站

- [ ] **步骤 1：运行网站单元测试**

```powershell
pnpm --filter @myself/website test
```

预期：全部通过，无新增警告。

- [ ] **步骤 2：运行类型检查**

```powershell
pnpm --filter @myself/website typecheck
```

预期：退出码为 0。

- [ ] **步骤 3：运行生产构建**

```powershell
pnpm --filter @myself/website build
```

预期：静态导出成功，`out/Paypal.png` 存在。

- [ ] **步骤 4：运行网站端到端测试**

```powershell
pnpm test:e2e:website
```

预期：全部通过，PayPal 图片成功解码，下载与反馈文件图标悬浮预览正常。

- [ ] **步骤 5：检查最终改动范围**

```powershell
git status --short
git diff --check
git diff -- apps/website/components/website-experience apps/website/tests tests/e2e/website.spec.ts
```

预期：只有本计划列出的代码、测试与文档发生变化，`git diff --check` 无输出。
