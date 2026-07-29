# AI Pet 共享仓库与中英文支持 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 AI Pet 官网中增加本地可用的共享仓库章节，并让全部网站内建可见文案支持简体中文和英文切换。

**Architecture:** 先建立集中式国际化上下文和类型安全语言资源，再让现有章节及新章节统一消费翻译函数。共享仓库通过 `SharedPetRepository` 接口隔离页面和 IndexedDB，元数据与 ZIP Blob 分库存储，页面使用独立领域模型管理校验、分页和切页动画。

**Tech Stack:** Next.js 15、React 19、TypeScript 5、CSS Modules、Vitest、Testing Library、Zod、GSAP、Lucide React、IndexedDB、fake-indexeddb

## Global Constraints

- 章节顺序固定为：首页、关于、下载、AI Pet 共享仓库、反馈与建议、捐款。
- 新页面严格复用现有字体、颜色、边框、阴影、背景、按钮、弹窗、指针倾斜和章节切换语言。
- 每页固定最多 8 条分享包，默认按创建时间从新到旧排序。
- ZIP 仅允许 `.zip` 且最大 100 MB；封面仅允许 `.png`、`.jpg`、`.jpeg`、`.webp` 且最大 5 MB。
- 名称必填且最多 30 个字符；描述必填且最多 500 个字符。
- 同一浏览器对同一分享包只能保持一个点赞状态，再次点击取消。
- 首期只使用 IndexedDB，本机数据不得描述为跨用户共享。
- 首期语言为 `zh-CN` 和 `en`；首次按浏览器语言选择，手动选择后优先读取本地偏好。
- 用户输入的分享包名称、描述和反馈内容保持原文，不自动翻译。
- 所有新增文档、结构性注释和提交说明使用中文。
- 不修改或删除 `apps/website/.next-corrupt-20260730/`。
- 只运行自动化测试、类型检查和生产构建，不执行浏览器逐页查看或人工视觉验收。

---

### Task 1: 建立国际化核心与语言菜单

**Files:**
- Create: `apps/website/components/i18n/i18n-types.ts`
- Create: `apps/website/components/i18n/messages.ts`
- Create: `apps/website/components/i18n/I18nProvider.tsx`
- Create: `apps/website/components/i18n/LanguageMenu.tsx`
- Create: `apps/website/components/i18n/language-menu.module.css`
- Modify: `apps/website/app/layout.tsx`
- Modify: `apps/website/components/website-experience/WebsiteExperience.tsx`
- Test: `apps/website/tests/i18n.test.tsx`
- Test: `apps/website/tests/page.test.tsx`

**Interfaces:**
- Produces: `Locale = 'zh-CN' | 'en'`
- Produces: `MessageKey = keyof typeof zhCN`
- Produces: `Translate = (key: MessageKey, values?: Record<string, string | number>) => string`
- Produces: `useI18n(): { locale: Locale; setLocale(locale: Locale): void; t: Translate }`
- Produces: `I18nProviderProps` 支持测试和服务端稳定初值使用的 `initialLocale?: Locale`
- Produces: `LANGUAGE_STORAGE_KEY = 'ai-pet-locale'`

- [ ] **Step 1: 为语言选择、资源完整性和插值写失败测试**

```tsx
// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { I18nProvider, useI18n } from '../components/i18n/I18nProvider';
import { LanguageMenu } from '../components/i18n/LanguageMenu';
import { en, zhCN } from '../components/i18n/messages';

function Probe() {
  const { locale, t } = useI18n();
  return <output>{locale}:{t('navigation.nextChapter')}</output>;
}

describe('官网国际化核心', () => {
  it('中英文资源拥有完全相同的键', () => {
    expect(Object.keys(en).sort()).toEqual(Object.keys(zhCN).sort());
  });

  it('首次访问按浏览器语言选择英文并同步根元素 lang', async () => {
    Object.defineProperty(window.navigator, 'language', {
      configurable: true,
      value: 'en-US'
    });
    render(<I18nProvider><Probe /></I18nProvider>);
    await waitFor(() => expect(screen.getByText(/^en:/)).toBeTruthy());
    expect(document.documentElement.lang).toBe('en');
  });

  it('手动选择中文后保存偏好', async () => {
    render(<I18nProvider><LanguageMenu /><Probe /></I18nProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'language' }));
    fireEvent.click(screen.getByRole('menuitemradio', { name: '简体中文' }));
    expect(localStorage.getItem('ai-pet-locale')).toBe('zh-CN');
  });
});
```

- [ ] **Step 2: 运行测试并确认国际化模块尚不存在**

Run: `pnpm --filter @myself/website test -- tests/i18n.test.tsx`

Expected: FAIL，提示无法解析 `components/i18n/I18nProvider`。

- [ ] **Step 3: 实现语言类型、资源键和插值函数**

```ts
export const locales = ['zh-CN', 'en'] as const;
export type Locale = (typeof locales)[number];

export const zhCN = {
  'language.button': 'language',
  'language.chinese': '简体中文',
  'language.english': 'English',
  'navigation.label': '章节导航',
  'navigation.previousChapter': '上一章节',
  'navigation.nextChapter': '下一章节'
} as const;

export type MessageKey = keyof typeof zhCN;
export const en: Record<MessageKey, string> = {
  'language.button': 'language',
  'language.chinese': '简体中文',
  'language.english': 'English',
  'navigation.label': 'Chapter navigation',
  'navigation.previousChapter': 'Previous chapter',
  'navigation.nextChapter': 'Next chapter'
};
```

插值实现只替换 `{name}` 形式的已提供变量；缺失变量保留原标记，方便测试发现资源错误。

- [ ] **Step 4: 实现 Provider 的首次解析、持久化和根元素同步**

```tsx
export const LANGUAGE_STORAGE_KEY = 'ai-pet-locale';

export function resolveInitialLocale(
  stored: string | null,
  browserLanguage: string
): Locale {
  if (stored === 'zh-CN' || stored === 'en') return stored;
  return browserLanguage.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}
```

Provider 服务端与 hydration 初值使用 `zh-CN`，挂载后读取偏好和浏览器语言；切换时写入 `localStorage` 并更新 `document.documentElement.lang`。本地存储不可用时仍更新当前会话状态。

- [ ] **Step 5: 实现首页右上角语言菜单并接入页面**

`LanguageMenu` 使用 `Languages` 和 `Check` 图标，触发器文本固定为 `language`，菜单项使用 `role="menuitemradio"` 和 `aria-checked`。组件仅在 `WebsiteExperience` 的首页进度稳定为 0 时挂在右上角固定控制层；一旦离开首页即卸载，返回首页后按已有语言选择恢复。菜单的 Escape 关闭、外部点击关闭和焦点恢复行为保持不变。

- [ ] **Step 6: 运行国际化和页面测试**

Run: `pnpm --filter @myself/website test -- tests/i18n.test.tsx tests/page.test.tsx`

Expected: PASS。

- [ ] **Step 7: 提交国际化基础**

```bash
git add apps/website/app/layout.tsx apps/website/components/i18n apps/website/components/website-experience/WebsiteExperience.tsx apps/website/tests/i18n.test.tsx apps/website/tests/page.test.tsx
git commit -m "feat(website): 建立中英文切换基础"
```

---

### Task 2: 国际化首页、介绍章节与共享文件预览

**Files:**
- Modify: `apps/website/components/i18n/messages.ts`
- Modify: `apps/website/components/home-experience/content-pool.ts`
- Modify: `apps/website/components/home-experience/FilePreview.tsx`
- Modify: `apps/website/components/website-experience/SharedVisualLayers.tsx`
- Modify: `apps/website/components/website-experience/about/about-content.ts`
- Modify: `apps/website/components/website-experience/about/AboutChapter.tsx`
- Modify: `apps/website/components/website-experience/about/AboutFeaturePanel.tsx`
- Modify: `apps/website/components/website-experience/about/AboutFeaturePreview.tsx`
- Test: `apps/website/tests/content-pool.test.ts`
- Test: `apps/website/tests/about-chapter.test.tsx`
- Test: `apps/website/tests/shared-layer-contract.test.tsx`

**Interfaces:**
- Consumes: `Translate`、`useI18n()`
- Produces: `createContentPool(t: Translate): Record<FileKind, readonly PreviewContent[]>`
- Produces: `createAboutFeatures(t: Translate): readonly AboutFeature[]`

- [ ] **Step 1: 写英文渲染和结构化内容失败测试**

```tsx
it('英文环境渲染英文介绍内容', () => {
  render(
    <I18nProvider initialLocale="en">
      <AboutChapter interactive />
    </I18nProvider>
  );
  expect(screen.getByRole('button', { name: 'System Safety' })).toBeTruthy();
  expect(screen.queryByText('保障系统安全')).toBeNull();
});

it('英文文件预览池不包含中文内建文案', () => {
  const pool = createContentPool((key) => en[key]);
  expect(JSON.stringify(pool)).not.toMatch(/\p{Script=Han}/u);
});
```

- [ ] **Step 2: 运行相关测试并确认仍输出中文**

Run: `pnpm --filter @myself/website test -- tests/content-pool.test.ts tests/about-chapter.test.tsx tests/shared-layer-contract.test.tsx`

Expected: FAIL，英文上下文仍渲染中文内容或工厂函数不存在。

- [ ] **Step 3: 将首页预览池改为按语言生成**

保留文件类型、数量和随机抽取算法，仅把标题、元信息和预览行替换为语言键。`pickPreview` 接收已经生成的内容池，避免模块加载时锁定语言：

```ts
export function pickPreview(
  kind: FileKind,
  random: () => number,
  pool: Record<FileKind, readonly PreviewContent[]>
): PreviewContent {
  const entries = pool[kind];
  const index = Math.min(entries.length - 1, Math.floor(random() * entries.length));
  return entries[index]!;
}
```

- [ ] **Step 4: 将介绍内容改为翻译工厂**

图标、层级、进入顺序和插画类型保持静态；标题、眉题、摘要和三条详情通过 `createAboutFeatures(t)` 生成。英文标题使用 `System Safety`、`File Management`、`Text Editor`、`Companion Chat`、`Desktop Organizer`。

- [ ] **Step 5: 本地化共享文件层的可访问文案**

把“文件预览队列”、文件预览标签和错误状态接入 `useI18n()`。切换语言后只更新文本，不重新启动首页磁吸开场或章节转场。

- [ ] **Step 6: 运行首页、介绍和共享视觉测试**

Run: `pnpm --filter @myself/website test -- tests/content-pool.test.ts tests/about-chapter.test.tsx tests/shared-layer-contract.test.tsx`

Expected: PASS。

- [ ] **Step 7: 提交首页与介绍国际化**

```bash
git add apps/website/components/i18n/messages.ts apps/website/components/home-experience apps/website/components/website-experience/about apps/website/components/website-experience/SharedVisualLayers.tsx apps/website/tests/content-pool.test.ts apps/website/tests/about-chapter.test.tsx apps/website/tests/shared-layer-contract.test.tsx
git commit -m "feat(website): 国际化首页与介绍内容"
```

---

### Task 3: 国际化下载、反馈与捐款章节

**Files:**
- Modify: `apps/website/components/i18n/messages.ts`
- Modify: `apps/website/components/website-experience/download/download-content.ts`
- Modify: `apps/website/components/website-experience/download/DownloadChapter.tsx`
- Modify: `apps/website/components/website-experience/feedback/feedback-content.ts`
- Modify: `apps/website/components/website-experience/feedback/feedback-preview-source.ts`
- Modify: `apps/website/components/website-experience/feedback/FeedbackChapter.tsx`
- Modify: `apps/website/components/website-experience/feedback/FeedbackComposerDialog.tsx`
- Modify: `apps/website/components/website-experience/feedback/FeedbackListDialog.tsx`
- Modify: `apps/website/components/website-experience/feedback/DiscardDraftDialog.tsx`
- Modify: `apps/website/components/website-experience/donation/donation-content.ts`
- Modify: `apps/website/components/website-experience/donation/DonationChapter.tsx`
- Modify: `apps/website/components/website-experience/donation/QrDialog.tsx`
- Test: `apps/website/tests/download-chapter.test.tsx`
- Test: `apps/website/tests/feedback-chapter.test.tsx`
- Test: `apps/website/tests/feedback-preview-source.test.ts`
- Test: `apps/website/tests/donation-chapter.test.tsx`

**Interfaces:**
- Consumes: `Translate`、`useI18n()`
- Produces: `createDownloadContent(t: Translate)`
- Produces: `localizeOfficialFeedbackEntry(entry: FeedbackEntry, t: Translate): FeedbackEntry`
- Produces: `createPaymentMethods(t: Translate): readonly PaymentMethod[]`

- [ ] **Step 1: 写三个章节的英文渲染失败测试**

```tsx
it('英文环境使用精简下载文案', () => {
  render(
    <I18nProvider initialLocale="en">
      <DownloadChapter interactive staticFallback />
    </I18nProvider>
  );
  expect(screen.getByRole('heading', { name: 'Choose Your Platform' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Download Windows' })).toBeTruthy();
});

it('英文环境翻译官方示例但保留本地投稿原文', () => {
  const official = localizeOfficialFeedbackEntry(officialEntry, (key) => en[key]);
  const local = localizeOfficialFeedbackEntry(localEntry, (key) => en[key]);
  expect(official.content).toBe('Please make the pet quieter in Focus mode.');
  expect(local.content).toBe('这是用户原文');
});
```

- [ ] **Step 2: 运行章节测试并确认仍输出中文**

Run: `pnpm --filter @myself/website test -- tests/download-chapter.test.tsx tests/feedback-chapter.test.tsx tests/feedback-preview-source.test.ts tests/donation-chapter.test.tsx`

Expected: FAIL，英文标题或本地化函数不存在。

- [ ] **Step 3: 国际化下载章节**

将平台摘要、FAQ、安装须知、侧栏标题、按钮、状态和 ARIA 文案迁入语言资源。发行版本、文件名、SHA-256、系统名称和实际下载地址继续来自发行清单，不进入翻译资源。

- [ ] **Step 4: 国际化反馈章节并保护用户原文**

官方示例通过稳定 ID 映射中英文作者名和正文；`source === 'local-user'` 的记录直接返回，不改变作者名和正文。日期格式使用当前 `locale`：

```ts
new Intl.DateTimeFormat(locale, {
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
}).format(date);
```

反馈粒子预览接收 `Translate`，翻译“类型、昵称、正文、点赞”标签和官方示例内容；已经生成的粒子继续保持生成时快照，新生成粒子使用当前语言。

- [ ] **Step 5: 国际化捐款章节**

微信、支付宝和 PayPal 品牌名保持原名或官方英文写法；翻译付款方式、付款码、关闭按钮和未配置状态。继续使用现有 `/Paypal.png`，不改变支付交互。

- [ ] **Step 6: 运行三个章节及反馈仓储回归测试**

Run: `pnpm --filter @myself/website test -- tests/download-chapter.test.tsx tests/feedback-chapter.test.tsx tests/feedback-preview-source.test.ts tests/local-storage-feedback-repository.test.ts tests/donation-chapter.test.tsx`

Expected: PASS。

- [ ] **Step 7: 提交现有章节国际化**

```bash
git add apps/website/components/i18n/messages.ts apps/website/components/website-experience/download apps/website/components/website-experience/feedback apps/website/components/website-experience/donation apps/website/tests/download-chapter.test.tsx apps/website/tests/feedback-chapter.test.tsx apps/website/tests/feedback-preview-source.test.ts apps/website/tests/donation-chapter.test.tsx
git commit -m "feat(website): 完成现有章节中英文适配"
```

---

### Task 4: 定义共享仓库领域模型、校验和分页状态

**Files:**
- Create: `apps/website/components/website-experience/community/shared-pet-types.ts`
- Create: `apps/website/components/website-experience/community/shared-pet-model.ts`
- Test: `apps/website/tests/shared-pet-model.test.ts`

**Interfaces:**
- Produces: `SHARED_PET_PAGE_SIZE = 8`
- Produces: `SharedPetPackageSummary`
- Produces: `CreateSharedPetInput`
- Produces: `SharedPetPage`
- Produces: `SharedPetDownload`
- Produces: `SharedPetRepository`
- Produces: `validateSharedPetDraft(input): SharedPetValidationResult`
- Produces: `SharedPetPageTransition`

- [ ] **Step 1: 写文件边界、文本边界和分页失败测试**

```ts
import { describe, expect, it } from 'vitest';
import {
  buildPageTransitionOrder,
  validateSharedPetDraft
} from '../components/website-experience/community/shared-pet-model';

const zip = new File(['zip'], 'pet.zip', { type: 'application/zip' });
const cover = new File(['image'], 'cover.webp', { type: 'image/webp' });

describe('共享仓库领域模型', () => {
  it('接受边界内的完整投稿', () => {
    expect(validateSharedPetDraft({
      name: 'My Pet',
      description: 'A custom AI Pet package.',
      packageFile: zip,
      coverFile: cover
    }).valid).toBe(true);
  });

  it('拒绝非 ZIP 文件和超长名称', () => {
    const result = validateSharedPetDraft({
      name: 'x'.repeat(31),
      description: 'valid',
      packageFile: new File(['x'], 'pet.7z'),
      coverFile: cover
    });
    expect(result).toMatchObject({ valid: false });
  });

  it('按从上到下、从左到右返回稳定动画顺序', () => {
    expect(buildPageTransitionOrder(8)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});
```

- [ ] **Step 2: 运行模型测试并确认模块尚不存在**

Run: `pnpm --filter @myself/website test -- tests/shared-pet-model.test.ts`

Expected: FAIL，提示无法解析共享仓库模型。

- [ ] **Step 3: 实现领域类型和错误代码**

```ts
export type SharedPetErrorCode =
  | 'INDEXED_DB_UNAVAILABLE'
  | 'DATABASE_OPEN_FAILED'
  | 'STORAGE_QUOTA_EXCEEDED'
  | 'PACKAGE_REQUIRED'
  | 'PACKAGE_TYPE_INVALID'
  | 'PACKAGE_TOO_LARGE'
  | 'COVER_REQUIRED'
  | 'COVER_TYPE_INVALID'
  | 'COVER_TOO_LARGE'
  | 'NAME_REQUIRED'
  | 'NAME_TOO_LONG'
  | 'DESCRIPTION_REQUIRED'
  | 'DESCRIPTION_TOO_LONG'
  | 'PACKAGE_NOT_FOUND'
  | 'FILE_READ_FAILED'
  | 'DOWNLOAD_FAILED';
```

`SharedPetRepository` 提供 `listPage`、`create`、`getById`、`toggleLike`、`getDownload`、`recordDownload` 和 `subscribe`；页面不暴露 `IDBDatabase`。

- [ ] **Step 4: 实现校验、分页和动画状态模型**

大小常量使用字节精确计算：ZIP 为 `100 * 1024 * 1024`，封面为 `5 * 1024 * 1024`。扩展名统一转小写；封面同时检查扩展名和允许的 MIME，ZIP 至少检查 `.zip` 扩展名并接受常见 ZIP MIME。

分页状态只允许 `idle`、`leaving`、`entering`，离场完成前不得写入下一页展示数据。

- [ ] **Step 5: 运行模型测试**

Run: `pnpm --filter @myself/website test -- tests/shared-pet-model.test.ts`

Expected: PASS。

- [ ] **Step 6: 提交共享仓库领域模型**

```bash
git add apps/website/components/website-experience/community/shared-pet-types.ts apps/website/components/website-experience/community/shared-pet-model.ts apps/website/tests/shared-pet-model.test.ts
git commit -m "feat(website): 定义共享仓库领域模型"
```

---

### Task 5: 实现 IndexedDB 双仓库持久化

**Files:**
- Modify: `apps/website/package.json`
- Modify: `pnpm-lock.yaml`
- Create: `apps/website/components/website-experience/community/indexed-db-shared-pet-repository.ts`
- Test: `apps/website/tests/indexed-db-shared-pet-repository.test.ts`

**Interfaces:**
- Consumes: `SharedPetRepository` 及 Task 4 的领域类型
- Produces: `IndexedDbSharedPetRepository`
- Produces: `SHARED_PET_DATABASE_NAME = 'ai-pet-community-v1'`
- Produces: `SHARED_PET_METADATA_STORE = 'sharedPetMetadata'`
- Produces: `SHARED_PET_FILES_STORE = 'sharedPetFiles'`

- [ ] **Step 1: 安装测试用 IndexedDB 实现**

Run: `pnpm --filter @myself/website add -D fake-indexeddb`

Expected: `apps/website/package.json` 和 `pnpm-lock.yaml` 增加 `fake-indexeddb`。

- [ ] **Step 2: 写双仓库事务、分页、点赞和下载失败测试**

```ts
import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { IndexedDbSharedPetRepository } from '../components/website-experience/community/indexed-db-shared-pet-repository';

describe('IndexedDB 共享仓库', () => {
  afterEach(() => indexedDB.deleteDatabase('ai-pet-community-test'));

  it('在同一事务中保存元数据与 ZIP Blob', async () => {
    const repository = new IndexedDbSharedPetRepository({
      databaseName: 'ai-pet-community-test',
      createId: () => 'pet-1',
      now: () => '2026-07-30T00:00:00.000Z'
    });
    await repository.create(validInput());
    expect((await repository.listPage(1, 8)).items[0]?.id).toBe('pet-1');
    expect((await repository.getDownload('pet-1')).file.size).toBeGreaterThan(0);
  });

  it('点赞可切换且计数不低于零', async () => {
    const repository = await repositoryWithOneEntry();
    expect((await repository.toggleLike('pet-1')).likeCount).toBe(1);
    expect((await repository.toggleLike('pet-1')).likeCount).toBe(0);
  });

  it('只返回当前页元数据且不把 ZIP Blob放入列表项', async () => {
    const repository = await repositoryWithEntries(9);
    const first = await repository.listPage(1, 8);
    const second = await repository.listPage(2, 8);
    expect(first.items).toHaveLength(8);
    expect(second.items).toHaveLength(1);
    expect('packageFile' in first.items[0]!).toBe(false);
  });
});
```

- [ ] **Step 3: 运行仓储测试并确认实现尚不存在**

Run: `pnpm --filter @myself/website test -- tests/indexed-db-shared-pet-repository.test.ts`

Expected: FAIL，提示无法解析 IndexedDB 仓储。

- [ ] **Step 4: 实现数据库打开、升级和统一错误映射**

数据库版本为 1。`onupgradeneeded` 创建两个对象仓库；元数据仓库以 `id` 为主键并建立 `createdAt` 索引，文件仓库以 `id` 为主键。把 `QuotaExceededError` 映射为 `STORAGE_QUOTA_EXCEEDED`，打开失败映射为 `DATABASE_OPEN_FAILED`。

- [ ] **Step 5: 实现原子创建、分页和详情读取**

`create` 在同一个 `readwrite` 事务中写入两个仓库。`listPage` 使用 `createdAt` 索引倒序游标，只读取目标页范围；`getById` 只访问元数据仓库。

- [ ] **Step 6: 实现点赞、文件读取、下载计数和订阅**

点赞和下载计数分别通过元数据仓库的读写事务更新。`getDownload` 只在用户请求下载时读取文件仓库。每次成功变更后通知当前仓储实例的订阅者。

- [ ] **Step 7: 运行仓储测试**

Run: `pnpm --filter @myself/website test -- tests/indexed-db-shared-pet-repository.test.ts tests/shared-pet-model.test.ts`

Expected: PASS。

- [ ] **Step 8: 提交 IndexedDB 仓储**

```bash
git add apps/website/package.json pnpm-lock.yaml apps/website/components/website-experience/community/indexed-db-shared-pet-repository.ts apps/website/tests/indexed-db-shared-pet-repository.test.ts
git commit -m "feat(website): 实现本地共享包持久化"
```

---

### Task 6: 实现分享包卡片与两个弹窗

**Files:**
- Create: `apps/website/components/website-experience/community/SharedPetCard.tsx`
- Create: `apps/website/components/website-experience/community/SharedPetDialogShell.tsx`
- Create: `apps/website/components/website-experience/community/SharedPetComposerDialog.tsx`
- Create: `apps/website/components/website-experience/community/SharedPetDetailDialog.tsx`
- Create: `apps/website/components/website-experience/community/use-object-url.ts`
- Create: `apps/website/components/website-experience/community/community.module.css`
- Modify: `apps/website/components/i18n/messages.ts`
- Test: `apps/website/tests/shared-pet-dialogs.test.tsx`
- Test: `apps/website/tests/shared-pet-card.test.tsx`

**Interfaces:**
- Consumes: Task 4 的领域类型和 `useI18n()`
- Produces: `SharedPetDraft`
- Produces: `SharedPetComposerDialog`
- Produces: `SharedPetDetailDialog`
- Produces: `SharedPetCard`
- Produces: `useObjectUrl(blob: Blob | null): string | null`

- [ ] **Step 1: 写表单、事件隔离和对象地址释放失败测试**

```tsx
it('提交完整 ZIP、封面、名称和描述', async () => {
  const onSubmit = vi.fn();
  render(
    <I18nProvider initialLocale="zh-CN">
      <SharedPetComposerDialog onSubmit={onSubmit} onRequestClose={vi.fn()} />
    </I18nProvider>
  );
  fireEvent.change(screen.getByLabelText('AI Pet ZIP 文件'), {
    target: { files: [new File(['zip'], 'pet.zip', { type: 'application/zip' })] }
  });
  fireEvent.change(screen.getByLabelText('封面图片'), {
    target: { files: [new File(['img'], 'cover.png', { type: 'image/png' })] }
  });
  fireEvent.change(screen.getByLabelText('名称'), { target: { value: 'My Pet' } });
  fireEvent.change(screen.getByLabelText('描述'), { target: { value: 'My package' } });
  fireEvent.click(screen.getByRole('button', { name: '发布分享' }));
  expect(onSubmit).toHaveBeenCalledTimes(1);
});

it('卡片操作不会触发详情点击', () => {
  const onOpen = vi.fn();
  render(
    <I18nProvider initialLocale="zh-CN">
      <SharedPetCard
        item={item}
        onOpen={onOpen}
        onLike={vi.fn()}
        onDownload={vi.fn()}
      />
    </I18nProvider>
  );
  fireEvent.click(screen.getByRole('button', { name: /点赞/ }));
  expect(onOpen).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: 运行组件测试并确认组件尚不存在**

Run: `pnpm --filter @myself/website test -- tests/shared-pet-dialogs.test.tsx tests/shared-pet-card.test.tsx`

Expected: FAIL，提示无法解析共享仓库组件。

- [ ] **Step 3: 实现仓库内部共享弹窗外壳**

`SharedPetDialogShell` 统一处理 Portal、遮罩点击、Escape、焦点循环、焦点恢复和局部滚轮隔离。投稿与详情只提供标题、内容和页脚，不重复实现模态交互。

- [ ] **Step 4: 实现投稿表单和本地化字段错误**

文件输入使用可见标签，提交时调用 `validateSharedPetDraft`。失败后保留所有已选文件和文本，并把错误代码映射为当前语言文案。提交期间禁用关闭和再次提交。

- [ ] **Step 5: 实现卡片和详情**

卡片使用 `ThumbsUp`、`Download` 图标；按钮提供 Tooltip 和 ARIA 文案。详情显示封面、名称、描述、原始文件名、格式化大小、按当前语言格式化的日期、点赞数和下载次数。

- [ ] **Step 6: 实现对象地址生命周期**

`useObjectUrl` 在 Blob 变化时创建新地址，在变化前和卸载时调用 `URL.revokeObjectURL`。封面和下载地址不得共用长期缓存。

- [ ] **Step 7: 运行组件测试**

Run: `pnpm --filter @myself/website test -- tests/shared-pet-dialogs.test.tsx tests/shared-pet-card.test.tsx`

Expected: PASS。

- [ ] **Step 8: 提交卡片与弹窗**

```bash
git add apps/website/components/i18n/messages.ts apps/website/components/website-experience/community apps/website/tests/shared-pet-dialogs.test.tsx apps/website/tests/shared-pet-card.test.tsx
git commit -m "feat(website): 构建共享包投稿与详情组件"
```

---

### Task 7: 实现共享仓库章节、分页和顺序动画

**Files:**
- Create: `apps/website/components/website-experience/community/SharedPetChapter.tsx`
- Modify: `apps/website/components/website-experience/community/community.module.css`
- Modify: `apps/website/components/i18n/messages.ts`
- Test: `apps/website/tests/shared-pet-chapter.test.tsx`
- Test: `apps/website/tests/motion-disabled-contract.test.tsx`

**Interfaces:**
- Consumes: `SharedPetRepository`、Task 6 的卡片和弹窗、`PointerTiltText`
- Produces: `SharedPetChapterProps extends ChapterRuntimeProps`

- [ ] **Step 1: 写空状态、分页、上传、点赞和下载失败测试**

```tsx
it('空仓库显示 0/0 并禁用分页', async () => {
  render(
    <I18nProvider initialLocale="zh-CN">
      <SharedPetChapter interactive repository={emptyRepository()} />
    </I18nProvider>
  );
  expect(await screen.findByText('0/0')).toBeTruthy();
  expect((screen.getByRole('button', { name: '上一页' }) as HTMLButtonElement).disabled)
    .toBe(true);
  expect((screen.getByRole('button', { name: '下一页' }) as HTMLButtonElement).disabled)
    .toBe(true);
});

it('离场结束前不替换下一页数据', async () => {
  render(
    <I18nProvider initialLocale="zh-CN">
      <SharedPetChapter interactive repository={repositoryWithEntries(9)} />
    </I18nProvider>
  );
  await screen.findByText('Pet 9');
  fireEvent.click(screen.getByRole('button', { name: '下一页' }));
  expect(screen.queryByText('Pet 1')).toBeNull();
  fireEvent.animationEnd(screen.getAllByTestId('shared-pet-card')[7]!);
  expect(await screen.findByText('Pet 1')).toBeTruthy();
});
```

- [ ] **Step 2: 运行章节测试并确认组件尚不存在**

Run: `pnpm --filter @myself/website test -- tests/shared-pet-chapter.test.tsx`

Expected: FAIL，提示无法解析 `SharedPetChapter`。

- [ ] **Step 3: 实现章节数据状态和标题指针倾斜**

章节挂载后读取第一页，订阅仓储变更；标题使用现有 `PointerTiltText`。非交互、窗口暂停、静态回退或减少动态效果时关闭指针倾斜。

- [ ] **Step 4: 实现稳定的 8 卡片响应式布局**

桌面端使用 4 列、2 行的稳定网格围绕中央焦点区排列，并通过每个槽位的小角度旋转保留参考图的纸张感。窄屏切换为 2 列或 1 列，不允许卡片覆盖标题、按钮和页码。

- [ ] **Step 5: 实现两阶段分页动画**

点击分页后把状态设为 `leaving`，每张卡片通过 `--shared-pet-order` 产生递增延迟并向左退出。最后一张卡片 `animationend` 后加载目标页并切换为 `entering`，从右侧按相同顺序进入；进入完成后恢复 `idle`。动画期间两个分页按钮均禁用。

减少动态效果时直接替换数据，不执行横向位移动画。

- [ ] **Step 6: 接通投稿、详情、点赞和下载**

投稿成功后关闭弹窗并刷新第一页。点赞更新当前卡片。下载流程依次执行 `getDownload`、创建临时地址、触发原文件名下载、释放地址、`recordDownload`；任一步失败都显示本地化状态且不虚增次数。

- [ ] **Step 7: 运行章节和减少动态效果测试**

Run: `pnpm --filter @myself/website test -- tests/shared-pet-chapter.test.tsx tests/motion-disabled-contract.test.tsx`

Expected: PASS。

- [ ] **Step 8: 提交共享仓库章节**

```bash
git add apps/website/components/i18n/messages.ts apps/website/components/website-experience/community apps/website/tests/shared-pet-chapter.test.tsx apps/website/tests/motion-disabled-contract.test.tsx
git commit -m "feat(website): 完成共享仓库章节交互"
```

---

### Task 8: 接入六章节注册、背景和共享视觉模型

**Files:**
- Modify: `apps/website/components/website-experience/types.ts`
- Modify: `apps/website/components/website-experience/chapter-registry.tsx`
- Modify: `apps/website/components/website-experience/WebsiteExperience.tsx`
- Modify: `apps/website/components/website-experience/shared-visual-model.ts`
- Modify: `apps/website/components/website-experience/visual/ChapterBackdrop.tsx`
- Modify: `apps/website/components/website-experience/website-experience.module.css`
- Modify: `apps/website/components/i18n/messages.ts`
- Test: `apps/website/tests/chapter-model.test.ts`
- Test: `apps/website/tests/shared-visual-model.test.ts`
- Test: `apps/website/tests/website-controller.test.tsx`
- Test: `apps/website/tests/website-fallback.test.tsx`

**Interfaces:**
- Consumes: `SharedPetChapter`
- Produces: `ChapterId` 增加 `'community'`
- Produces: `getChapterIndex(id: ChapterId): number`
- Produces: `VISUAL_PROFILES.community`

- [ ] **Step 1: 写六章节顺序和索引失败测试**

```ts
it('按确认顺序注册六个章节', () => {
  expect(CHAPTER_REGISTRY.map((chapter) => chapter.id)).toEqual([
    'home',
    'about',
    'download',
    'community',
    'feedback',
    'donation'
  ]);
});

it('共享仓库拥有独立共享视觉主题', () => {
  expect(resolveSharedVisualProfile(3, 'interactive')?.id).toBe('community');
  expect(getChapterIndex('feedback')).toBe(4);
  expect(getChapterIndex('donation')).toBe(5);
});
```

- [ ] **Step 2: 运行集成测试并确认仍为五章节**

Run: `pnpm --filter @myself/website test -- tests/chapter-model.test.ts tests/shared-visual-model.test.ts tests/website-controller.test.tsx tests/website-fallback.test.tsx`

Expected: FAIL，章节注册仍缺少 `community`。

- [ ] **Step 3: 注册共享仓库并消除硬编码索引**

`ChapterDefinition` 使用 `labelKey`，`WebsiteExperience` 通过 `t(labelKey)` 生成章节 `aria-label`。所有反馈、捐款和共享视觉索引通过 `getChapterIndex` 获取，不保留 `{ feedback: 3, donation: 4 }` 形式的数字映射。

- [ ] **Step 4: 为共享仓库接入背景和共享视觉**

`ChapterBackdrop` 自动接受新 `ChapterId`。新增灰色 `community` 共享视觉配置，复用默认文件预览源和现有安全区参数；反馈仍使用随机反馈预览源，捐款继续使用黄色文件视觉。

- [ ] **Step 5: 调整语言菜单和章节导航层级**

语言菜单仅在首页进度稳定为 0 时显示在右上角，并高于首页焦点内容；离开首页后不渲染入口。控制层只使用现有灰阶变量和边框样式，不新增独立配色。

- [ ] **Step 6: 运行章节集成测试**

Run: `pnpm --filter @myself/website test -- tests/chapter-model.test.ts tests/shared-visual-model.test.ts tests/website-controller.test.tsx tests/website-fallback.test.tsx`

Expected: PASS。

- [ ] **Step 7: 提交六章节集成**

```bash
git add apps/website/components/i18n/messages.ts apps/website/components/website-experience apps/website/tests/chapter-model.test.ts apps/website/tests/shared-visual-model.test.ts apps/website/tests/website-controller.test.tsx apps/website/tests/website-fallback.test.tsx
git commit -m "feat(website): 接入共享仓库章节导航"
```

---

### Task 9: 完成全站语言覆盖和自动化回归

**Files:**
- Modify: `apps/website/components/i18n/messages.ts`
- Modify: `apps/website/tests/i18n.test.tsx`
- Modify: `apps/website/tests/page.test.tsx`
- Modify: `apps/website/tests/shared-pet-chapter.test.tsx`

**Interfaces:**
- Consumes: 前八个任务的全部公开接口
- Produces: 中英文资源键完整性和六章节自动化回归证据

- [ ] **Step 1: 增加语言资源完整性和章节原位切换测试**

```tsx
function installReducedMotionForNavigationTest() {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', vi.fn(() => ({
    matches: true,
    media: '(prefers-reduced-motion: reduce)',
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn()
  } satisfies MediaQueryList)));
}

async function flushControllerFrames() {
  act(() => {
    vi.runOnlyPendingTimers();
  });
  await Promise.resolve();
}

async function navigateByNextButton(target: ChapterId) {
  const root = screen.getByTestId('website-experience');
  const next = screen.getByRole('button', { name: '下一章节' });
  const chapterOrder: ChapterId[] = [
    'home',
    'about',
    'download',
    'community',
    'feedback',
    'donation'
  ];
  const targetIndex = chapterOrder.indexOf(target);

  for (let index = 0; index < targetIndex; index += 1) {
    fireEvent.click(next);
    await flushControllerFrames();
  }
  expect(root.dataset.activeChapter).toBe(target);
}

it('首页切换语言后导航到共享仓库时保持选择并在返回首页恢复入口', async () => {
  installReducedMotionForNavigationTest();
  render(<WebsiteExperience />);
  fireEvent.click(screen.getByRole('button', { name: 'language' }));
  fireEvent.click(screen.getByRole('menuitemradio', { name: 'English' }));
  const next = screen.getByRole('button', { name: 'Next chapter' });
  for (let index = 0; index < 3; index += 1) {
    fireEvent.click(next);
    await flushControllerFrames();
  }
  expect(screen.getByTestId('website-experience').dataset.activeChapter)
    .toBe('community');
  expect(screen.getByRole('heading', { name: 'AI Pet Community' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'language' })).toBeNull();
  const previous = screen.getByRole('button', { name: 'Previous chapter' });
  for (let index = 0; index < 3; index += 1) {
    fireEvent.click(previous);
    await flushControllerFrames();
  }
  expect(screen.getByTestId('website-experience').dataset.activeChapter)
    .toBe('home');
  expect(screen.getByRole('button', { name: 'language' })).toBeTruthy();
});

it('两个语言资源没有空字符串且键集合一致', () => {
  expect(Object.keys(en).sort()).toEqual(Object.keys(zhCN).sort());
  expect(Object.values(en).every((value) => value.trim().length > 0)).toBe(true);
  expect(Object.values(zhCN).every((value) => value.trim().length > 0)).toBe(true);
});
```

- [ ] **Step 2: 运行全站单元测试**

Run: `pnpm --filter @myself/website test`

Expected: PASS，所有网站 Vitest 测试通过。

- [ ] **Step 3: 运行 TypeScript 检查**

Run: `pnpm --filter @myself/website typecheck`

Expected: PASS，无 TypeScript 错误。

- [ ] **Step 4: 运行生产构建**

Run: `pnpm --filter @myself/website build`

Expected: PASS，Next.js 生产构建完成。

- [ ] **Step 5: 检查变更范围**

Run: `git status --short`

Expected: 只出现本计划涉及的源码、测试和依赖文件；`apps/website/.next-corrupt-20260730/` 仍保持未跟踪且未被修改。

- [ ] **Step 6: 提交最终自动化回归修正**

只有前述检查产生必要修正时才创建本任务提交；全部检查首次通过且没有文件变化时，记录“无需最终修正提交”，不创建空提交。

```bash
git add apps/website/components/i18n/messages.ts apps/website/tests/i18n.test.tsx apps/website/tests/page.test.tsx apps/website/tests/shared-pet-chapter.test.tsx
git commit -m "test(website): 完成共享仓库与国际化回归"
```

## 交付说明

完成全部任务后汇总以下结果交给用户验收：

- 当前分支和提交列表。
- 新增共享仓库章节的功能范围。
- IndexedDB 仅限本机浏览器的边界。
- 中英文切换和语言持久化行为。
- Vitest、TypeScript 和 Next.js 构建结果。
- 明确说明未执行逐页浏览、截图对比或人工视觉验收。
