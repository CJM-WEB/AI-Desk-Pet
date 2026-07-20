# 第一阶段官网实施计划

> **面向执行代理：** 必须使用 `superpowers:subagent-driven-development`（推荐）或 `superpowers:executing-plans`，逐项执行本计划。所有步骤使用复选框（`- [ ]`）跟踪。

**目标：** 构建可静态导出的产品首页，清楚说明桌宠、安全边界、安装预期，以及由版本清单驱动的 Windows 下载卡片。

**架构：** Next.js App Router 使用职责单一的页面模块渲染静态单页。共享 CSS 变量为后续动态效果与 3D 升级保留边界；构建时从本地 JSON 清单验证版本信息，不使用后端、数据库、账号、分析脚本或服务端密钥。

**技术栈：** Next.js、React、TypeScript、Tailwind CSS、Zod、Vitest、Testing Library、Playwright。

## 全局约束

- 静态导出必须在没有运行时服务器的条件下成功。
- 即使没有动画，核心文案和下载信息也必须完整可用。
- 第一阶段官网不收集账号、API Key、文件或分析数据。
- 下载卡片必须显示 `0.1.0-alpha.1`、Windows 10/11 x64、安装包大小、SHA-256 和未签名状态。
- Hero 媒体区域必须是独立组件，以便后续替换为 Rive 或 Three.js。
- `prefers-reduced-motion` 必须禁用非必要动态效果。
- Codex 不执行暂存、提交或推送；用户使用 Fork 验收和提交。
- 面向人的文档、界面文案与代码注释统一使用中文。

---

## 计划文件结构

```text
apps/website/
  package.json                         scripts and dependencies
  next.config.ts                      static export configuration
  tsconfig.json                       Next TypeScript settings
  app/layout.tsx                      metadata and global shell
  app/page.tsx                        ordered section composition
  app/globals.css                     tokens, responsive, reduced motion
  components/SiteHeader.tsx           navigation and primary download CTA
  components/Hero.tsx                 product promise and media seam
  components/HeroPetDemo.tsx          lightweight Phase 1 visual
  components/FeatureGrid.tsx          three product pillars
  components/HowItWorks.tsx           configure/authorize/confirm flow
  components/SafetySection.tsx        local boundary and privacy copy
  components/DownloadCard.tsx         validated manifest display
  components/InstallHelp.tsx          unsigned installer instructions
  components/Faq.tsx                  scoped first-release questions
  components/SiteFooter.tsx           privacy and feedback
  lib/release-manifest.ts             Zod schema and loader
  content/release-manifest.json       Phase 1 release data
  tests/release-manifest.test.ts      build-data contract
  tests/page.test.tsx                 required sections/accessibility
tests/e2e/website.spec.ts             responsive/static user checks
```

### 任务 1：静态 Next.js 外壳与设计变量

**文件：**
- 新建： `apps/website/package.json`
- 新建： `apps/website/next.config.ts`
- 新建： `apps/website/tsconfig.json`
- 新建： `apps/website/app/layout.tsx`
- 新建： `apps/website/app/page.tsx`
- 新建： `apps/website/app/globals.css`
- 新建： `apps/website/tests/page.test.tsx`
- 修改： `pnpm-workspace.yaml` only if `apps/*` is not already present.

**接口：**
- 输入： shared brand tokens if Desktop Task 1 created them; otherwise defines the initial CSS token contract here and Desktop imports it later.
- 输出： a statically buildable page shell and stable section ids.

- [ ] **步骤 1： 创建包配置与静态导出配置**

```json
// apps/website/package.json
{
  "name": "@myself/website",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "next": "^15",
    "react": "^19",
    "react-dom": "^19",
    "zod": "^3"
  },
  "devDependencies": {
    "@testing-library/react": "^16",
    "@types/node": "^22",
    "@types/react": "^19",
    "typescript": "^5",
    "vitest": "^3"
  }
}
```

```ts
// apps/website/next.config.ts
import type { NextConfig } from 'next';

const config: NextConfig = {
  output: 'export',
  images: { unoptimized: true },
  trailingSlash: true
};
export default config;
```

- [ ] **步骤 2： 编写失败的页面外壳测试**

```tsx
// apps/website/tests/page.test.tsx
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import Page from '../app/page';

describe('homepage', () => {
  it('contains the product promise and primary download action', () => {
    render(<Page />);
    expect(screen.getByRole('heading', { name: '住在桌面上的 AI 文件小助手' })).toBeTruthy();
    expect(screen.getByRole('link', { name: '下载 Windows 测试版' })).toBeTruthy();
  });
});
```

运行： `pnpm --filter @myself/website test`

预期： FAIL because `app/page.tsx` does not exist.

- [ ] **步骤 3： 实现布局与初始页面**

```tsx
// apps/website/app/layout.tsx
import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Myself — AI 桌宠文件助手',
  description: '在授权目录中安全完成基础文件任务的 Windows AI 桌宠。'
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
```

```tsx
// apps/website/app/page.tsx
export default function Page() {
  return (
    <main>
      <section id="hero">
        <p className="eyebrow">Windows Alpha · 自带模型密钥</p>
        <h1>住在桌面上的 AI 文件小助手</h1>
        <p>授权一个文件夹，用自然语言安全地查看、新建和重命名文件。</p>
        <a className="primary" href="#download">下载 Windows 测试版</a>
      </section>
      <section id="download" aria-label="Windows 下载"><h2>Windows 测试版</h2></section>
    </main>
  );
}
```

- [ ] **步骤 4： 实现全局设计变量与减少动态效果基线**

```css
/* apps/website/app/globals.css */
:root {
  --bg: #0e1220;
  --surface: #171e31;
  --text: #f5f7ff;
  --muted: #b6bfd5;
  --accent: #7968ff;
  --accent-soft: #a99cff;
  --border: #303a55;
  --radius: 18px;
}
* { box-sizing: border-box; }
html { scroll-behavior: smooth; }
body { margin: 0; color: var(--text); background: var(--bg); font-family: system-ui, sans-serif; }
main { overflow: hidden; }
section { width: min(1120px, calc(100% - 32px)); margin: 0 auto; padding: 88px 0; }
h1 { max-width: 760px; font-size: clamp(2.5rem, 7vw, 5.5rem); line-height: 1.04; }
.eyebrow { color: var(--accent-soft); }
.primary { display: inline-flex; padding: 12px 18px; border-radius: 12px; color: white; background: var(--accent); text-decoration: none; }
@media (prefers-reduced-motion: reduce) {
  html { scroll-behavior: auto; }
  *, *::before, *::after { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; transition-duration: 0.01ms !important; }
}
```

- [ ] **步骤 5： 验证测试、类型检查与静态构建**

运行： `pnpm --filter @myself/website test && pnpm --filter @myself/website typecheck && pnpm --filter @myself/website build`

预期： page test PASS, TypeScript exits 0, and `apps/website/out/index.html` exists.

- [ ] **用户验收交接点**

提供本地访问地址、桌面端与移动端截图、静态构建路径和测试输出，由用户验收并决定提交。

### 任务 2：首页完整模块与交互扩展边界

**文件：**
- 新建： `apps/website/components/SiteHeader.tsx`
- 新建： `apps/website/components/Hero.tsx`
- 新建： `apps/website/components/HeroPetDemo.tsx`
- 新建： `apps/website/components/FeatureGrid.tsx`
- 新建： `apps/website/components/HowItWorks.tsx`
- 新建： `apps/website/components/SafetySection.tsx`
- 新建： `apps/website/components/InstallHelp.tsx`
- 新建： `apps/website/components/Faq.tsx`
- 新建： `apps/website/components/SiteFooter.tsx`
- 修改： `apps/website/app/page.tsx`
- 修改： `apps/website/app/globals.css`
- 修改： `apps/website/tests/page.test.tsx`

**接口：**
- 输出： stable `features`, `safety`, `download`, `install`, and `faq` anchors; `HeroPetDemo` accepts no business data and can later be replaced.

- [ ] **步骤 1： 扩展失败测试以覆盖全部必需模块**

```tsx
it('renders every required trust and support section', () => {
  render(<Page />);
  for (const name of ['它能做什么', '三步开始使用', '文件安全由本地控制', '安装帮助', '常见问题']) {
    expect(screen.getByRole('heading', { name })).toBeTruthy();
  }
});
```

运行： `pnpm --filter @myself/website test`

预期： FAIL until the section components are composed.

- [ ] **步骤 2： 实现语义化页面模块**

每个组件只导出一个函数并包含自己的文案。`FeatureGrid` 只使用三张卡片：桌宠交互、可替换模型、授权文件工具。`HowItWorks` 展示“配置、授权、确认”。`SafetySection` 明确模型不能运行 Shell，写操作必须确认。`InstallHelp` 解释 Windows 未签名警告，不引导用户全局关闭安全功能。`Faq` 覆盖支持的 Windows 版本、API Key 归属、文件访问边界、未签名状态和第一阶段限制。

```tsx
export function FeatureGrid() {
  const features = [
    ['桌宠交互', '角色状态会跟随聆听、思考、执行与结果变化。'],
    ['模型由你选择', '填写自己的兼容模型地址、模型名和 API Key。'],
    ['文件权限可控', '只在你授权的目录中工作，写操作先预览确认。']
  ];
  return <section id="features"><h2>它能做什么</h2><div className="grid">{features.map(([title, text]) => <article key={title}><h3>{title}</h3><p>{text}</p></article>)}</div></section>;
}
export function HowItWorks() {
  return <section><h2>三步开始使用</h2><ol><li>配置兼容模型</li><li>授权一个工作目录</li><li>确认桌宠提出的写操作</li></ol></section>;
}
export function SafetySection() {
  return <section id="safety"><h2>文件安全由本地控制</h2><p>模型不能运行 Shell，也不能越过授权目录。所有写操作由本地客户端校验并等待你的确认。</p></section>;
}
```

- [ ] **步骤 3： 实现第一阶段 Hero 演示扩展边界**

```tsx
// apps/website/components/HeroPetDemo.tsx
export function HeroPetDemo() {
  return (
    <div className="pet-demo" aria-label="桌宠确认文件操作演示">
      <div className="demo-bubble">
        <strong>帮我新建 notes.md</strong>
        <span>等待确认 · 不会覆盖已有文件</span>
      </div>
      <div className="demo-pet" aria-hidden="true">🐾</div>
    </div>
  );
}
```

容器负责尺寸与降级视觉效果，使后续 Rive 或 Three.js 组件只需替换容器内部。

- [ ] **步骤 4： 按批准顺序组合页面**

```tsx
// apps/website/app/page.tsx
import { SiteHeader } from '../components/SiteHeader';
import { Hero } from '../components/Hero';
import { FeatureGrid } from '../components/FeatureGrid';
import { HowItWorks } from '../components/HowItWorks';
import { SafetySection } from '../components/SafetySection';
import { InstallHelp } from '../components/InstallHelp';
import { Faq } from '../components/Faq';
import { SiteFooter } from '../components/SiteFooter';

export default function Page() {
  return <><SiteHeader /><main><Hero /><FeatureGrid /><HowItWorks /><SafetySection /><InstallHelp /><Faq /></main><SiteFooter /></>;
}
```

- [ ] **步骤 5： 验证语义、响应式布局与减少动态效果**

运行： `pnpm --filter @myself/website test && pnpm --filter @myself/website build`

预期： all headings are found exactly once, static build succeeds, no horizontal overflow at 390px, and reduced-motion media query disables demo animation.

- [ ] **用户验收交接点**

提供桌面端与移动端完整页面截图、文案审阅记录、无障碍测试输出和变更文件清单，由用户验收并决定提交。

### 任务 3：版本清单、下载卡片与官网端到端门禁

**文件：**
- 新建： `apps/website/content/release-manifest.json`
- 新建： `apps/website/lib/release-manifest.ts`
- 新建： `apps/website/components/DownloadCard.tsx`
- 新建： `apps/website/tests/release-manifest.test.ts`
- 新建： `tests/e2e/website.spec.ts`
- 修改： `apps/website/app/page.tsx`
- 修改： root `package.json` scripts

**接口：**
- 输入： a static release manifest later generated by the packaging plan.
- 输出： a validated download URL and metadata UI; website build fails on an invalid manifest.

- [ ] **步骤 1： 编写版本清单契约测试**

```ts
// apps/website/tests/release-manifest.test.ts
import { describe, expect, it } from 'vitest';
import data from '../content/release-manifest.json';
import { releaseManifestSchema } from '../lib/release-manifest';

describe('release manifest', () => {
  it('contains a valid unsigned Windows alpha release', () => {
    const release = releaseManifestSchema.parse(data);
    expect(release.version).toBe('0.1.0-alpha.1');
    expect(release.platform).toBe('windows-x64');
    expect(release.signed).toBe(false);
    expect(release.sha256).toMatch(/^[a-f0-9]{64}$/);
  });
});
```

- [ ] **步骤 2： 增加 Schema 与本地开发清单**

```ts
// apps/website/lib/release-manifest.ts
import { z } from 'zod';

export const releaseManifestSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+-alpha\.\d+$/),
  platform: z.literal('windows-x64'),
  fileName: z.string().endsWith('.exe'),
  downloadUrl: z.string().url(),
  sizeBytes: z.number().int().positive(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  publishedAt: z.string().datetime(),
  signed: z.literal(false)
}).strict();
export type ReleaseManifest = z.infer<typeof releaseManifestSchema>;
```

纳入版本管理的开发清单使用有文档说明的本地或示例产物地址，以及确定性的测试校验和。只有生成真实安装包后，打包流程才能替换该清单。

- [ ] **步骤 3： 使用已验证数据实现 `DownloadCard`**

The server component imports JSON, calls `releaseManifestSchema.parse`, and renders version, Windows 10/11 x64, formatted size, SHA-256 with copy affordance, unsigned warning, and a link whose accessible name is `下载 Myself 0.1.0-alpha.1`.

```tsx
// apps/website/components/DownloadCard.tsx
import rawManifest from '../content/release-manifest.json';
import { releaseManifestSchema } from '../lib/release-manifest';

export function DownloadCard() {
  const release = releaseManifestSchema.parse(rawManifest);
  const size = `${(release.sizeBytes / 1024 / 1024).toFixed(1)} MB`;
  return (
    <section id="download">
      <h2>Windows 测试版</h2>
      <p>{release.version} · Windows 10/11 x64 · {size}</p>
      <p className="warning">未签名测试版；安装前请核对文件名和 SHA-256。</p>
      <code>{release.sha256}</code>
      <a className="primary" href={release.downloadUrl}>下载 Myself {release.version}</a>
    </section>
  );
}
```

- [ ] **步骤 4： 编写 Playwright 官网检查**

```ts
// tests/e2e/website.spec.ts
import { expect, test } from '@playwright/test';

test('homepage presents trust information and a real download target', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '住在桌面上的 AI 文件小助手' })).toBeVisible();
  await expect(page.getByText('文件安全由本地控制')).toBeVisible();
  const download = page.getByRole('link', { name: '下载 Myself 0.1.0-alpha.1' });
  await expect(download).toHaveAttribute('href', /\.exe$/);
  await expect(page.getByText(/未签名测试版/)).toBeVisible();
});
```

- [ ] **步骤 5： 增加并运行官网验证门禁**

根级脚本为：`verify:website = pnpm --filter @myself/website typecheck && pnpm --filter @myself/website test && pnpm --filter @myself/website build && playwright test tests/e2e/website.spec.ts`。

运行： `pnpm verify:website`

预期： typecheck, unit tests, static export, and Playwright tests PASS; `out/index.html` contains the product heading and download metadata.

- [ ] **用户验收交接点**

交付静态输出位置、清单内容、测试输出和响应式截图，由用户在 Fork 中验收并决定提交。
