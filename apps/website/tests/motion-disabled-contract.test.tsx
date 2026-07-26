// @vitest-environment jsdom

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  cleanup,
  fireEvent,
  render,
  screen
} from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('下载静态回退保留侧栏标题与列表项的可见语义节点', () => {
    render(<DownloadChapter interactive staticFallback />);
    const root = screen.getByTestId('download-chapter');
    const heading = root.querySelector<HTMLElement>('[data-panel-heading]')!;
    const item = root.querySelector<HTMLElement>('[data-panel-item]')!;

    expect(root.dataset.motionDisabled).toBe('true');
    expect(heading).toBeTruthy();
    expect(item).toBeTruthy();
    expect(heading.style.visibility).toBe('');
    expect(item.style.visibility).toBe('');
  });

  it('下载静态回退关闭感应区与侧栏卡片过渡且保留下载链接', () => {
    render(<DownloadChapter interactive staticFallback />);

    const root = screen.getByTestId('download-chapter');
    expect(root.dataset.motionDisabled).toBe('true');
    expect(downloadCss).toMatch(
      /\.downloadChapter\[data-motion-disabled='true'\] \.sideSensor,\s*\.downloadChapter\[data-motion-disabled='true'\] \.sidePanel,\s*\.downloadChapter\[data-motion-disabled='true'\] \.platformStack,\s*\.downloadChapter\[data-motion-disabled='true'\] \.platformCard\s*\{[^}]*transition:\s*none;/s
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
      /\.donationChapter\[data-motion-disabled='true'\] \.paymentCard\s*\{[^}]*transition:\s*none;/s
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

  it('窗口暂停会下发到下载与捐款章节并关闭 CSS 动画和过渡', () => {
    const { rerender } = render(
      <DownloadChapter interactive isPaused />
    );
    const download = screen.getByTestId('download-chapter');

    expect(download.dataset.paused).toBe('true');
    expect(download.dataset.motionDisabled).toBe('true');
    expect(downloadCss).toMatch(
      /\.downloadChapter\[data-motion-disabled='true'\] \.sideSensor,\s*\.downloadChapter\[data-motion-disabled='true'\] \.sidePanel,\s*\.downloadChapter\[data-motion-disabled='true'\] \.platformStack,\s*\.downloadChapter\[data-motion-disabled='true'\] \.platformCard\s*\{[^}]*transition:\s*none;/s
    );

    rerender(<DonationChapter interactive isPaused />);
    const donation = screen.getByTestId('donation-chapter');
    expect(donation.dataset.paused).toBe('true');
    expect(donation.dataset.motionDisabled).toBe('true');
    expect(donationCss).toMatch(
      /\.donationChapter\[data-paused='true'\] \.paymentCard\s*\{[^}]*transition:\s*none;/s
    );
    expect(donationCss).toMatch(
      /\.qrBackdrop\[data-paused='true'\],\s*\.qrBackdrop\[data-paused='true'\] \.qrPanel\s*\{[^}]*animation-play-state:\s*paused;/s
    );
  });

  it('下载章节暂停时关闭标题倾斜且恢复后重新启用', () => {
    const { rerender } = render(
      <DownloadChapter interactive isPaused />
    );

    expect(screen.getAllByTestId('pointer-tilt-text').every(
      (element) => element.dataset.motionEnabled === 'false'
    )).toBe(true);

    rerender(<DownloadChapter interactive isPaused={false} />);
    expect(screen.getAllByTestId('pointer-tilt-text').every(
      (element) => element.dataset.motionEnabled === 'true'
    )).toBe(true);
  });
});
