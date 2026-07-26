// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
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
  afterEach(() => cleanup());

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
