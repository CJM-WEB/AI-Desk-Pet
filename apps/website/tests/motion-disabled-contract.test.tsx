// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { useState } from 'react';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gsap } from 'gsap';
import { DonationChapter } from '../components/website-experience/donation/DonationChapter';
import { DownloadChapter } from '../components/website-experience/download/DownloadChapter';

const downloadCss = readFileSync(
  resolve(
    process.cwd(),
    'components/website-experience/download/download.module.css'
  ),
  'utf8'
);
const donationCss = readFileSync(
  resolve(
    process.cwd(),
    'components/website-experience/donation/donation.module.css'
  ),
  'utf8'
);

describe('章节静态回退禁用内部动效', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('GSAP autoAlpha 残留 visibility hidden 后静态回退仍强制显示侧栏文本', async () => {
    const revert = vi.fn(() => {
      throw new Error('下载 GSAP 部分清理失败');
    });
    const context = { revert } as unknown as gsap.Context;
    const timeline = {
      from: vi.fn((selector: string, vars: { autoAlpha?: number }) => {
        if (vars.autoAlpha === 0) {
          gsap.set(selector, { autoAlpha: 0 });
        }
        return timeline;
      })
    };
    vi.spyOn(gsap, 'timeline').mockReturnValue(
      timeline as unknown as gsap.core.Timeline
    );
    vi.spyOn(gsap, 'context').mockImplementation((callback) => {
      callback?.(context);
      return context;
    });

    function DownloadFallbackHarness({
      interactive
    }: {
      interactive: boolean;
    }) {
      const [staticFallback, setStaticFallback] = useState(false);

      return (
        <DownloadChapter
          interactive={interactive}
          staticFallback={staticFallback}
          onInitializationError={() => setStaticFallback(true)}
        />
      );
    }

    const { rerender } = render(
      <DownloadFallbackHarness interactive />
    );
    const root = screen.getByTestId('download-chapter');
    const faqTrigger = root
      .querySelectorAll<HTMLButtonElement>(':scope > button')[0]!;
    fireEvent.click(faqTrigger);

    const heading = root.querySelector<HTMLElement>('[data-panel-heading]')!;
    const item = root.querySelector<HTMLElement>('[data-panel-item]')!;
    await waitFor(() => {
      expect(heading.style.visibility).toBe('hidden');
      expect(item.style.visibility).toBe('hidden');
    });

    rerender(<DownloadFallbackHarness interactive={false} />);
    await waitFor(() => {
      expect(root.dataset.staticFallback).toBe('true');
    });

    expect(revert).toHaveBeenCalledOnce();
    expect(root.dataset.motionDisabled).toBe('true');
    expect(heading.style.visibility).toBe('');
    expect(item.style.visibility).toBe('');
    expect(getComputedStyle(heading).visibility).toBe('visible');
    expect(getComputedStyle(item).visibility).toBe('visible');
  });

  it('下载静态回退关闭箭头动画与侧栏卡片过渡且保留下载链接', () => {
    render(<DownloadChapter interactive staticFallback />);

    const root = screen.getByTestId('download-chapter');
    expect(root.dataset.motionDisabled).toBe('true');
    expect(downloadCss).toMatch(
      /\.downloadChapter\[data-motion-disabled='true'\] \.sideTrigger:not\(:disabled\) svg\s*\{[^}]*animation:\s*none;/s
    );
    expect(downloadCss).toMatch(
      /\.downloadChapter\[data-motion-disabled='true'\] \.sideTrigger,\s*\.downloadChapter\[data-motion-disabled='true'\] \.sidePanel,\s*\.downloadChapter\[data-motion-disabled='true'\] \.platformStack,\s*\.downloadChapter\[data-motion-disabled='true'\] \.platformCard\s*\{[^}]*transition:\s*none;/s
    );
    expect(
      screen.getByRole('link', { name: '下载 Windows' }).getAttribute('href')
    ).toBeTruthy();
  });

  it('捐款静态回退关闭滚筒与付款码进入动效且保留支付按钮', () => {
    render(<DonationChapter interactive staticFallback />);

    const root = screen.getByTestId('donation-chapter');
    expect(root.dataset.motionDisabled).toBe('true');
    expect(donationCss).toMatch(
      /\.donationChapter\[data-motion-disabled='true'\] \.paymentCard,\s*\.donationChapter\[data-motion-disabled='true'\] \.paymentCard::before\s*\{[^}]*transition:\s*none;/s
    );

    const payment = screen.getByRole('button', { name: '打开微信付款码' });
    expect((payment as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(payment);

    const dialog = screen.getByRole('dialog', { name: '微信付款码' });
    expect(dialog.dataset.motionDisabled).toBe('true');
    expect(donationCss).toMatch(
      /\.qrBackdrop\[data-motion-disabled='true'\],\s*\.qrBackdrop\[data-motion-disabled='true'\] \.qrPanel\s*\{[^}]*animation:\s*none;/s
    );
  });
});
