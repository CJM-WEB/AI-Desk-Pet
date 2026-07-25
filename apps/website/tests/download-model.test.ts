import { describe, expect, it } from 'vitest';
import rawManifest from '../content/release-manifest.json';
import { DOWNLOAD_PLATFORMS } from '../components/website-experience/download/download-content';
import { releaseManifestSchema } from '../lib/release-manifest';
import {
  initialDownloadInteraction,
  reduceDownloadInteraction,
  rotatePlatformIndex,
  visibleDownloadSide
} from '../components/website-experience/download/download-model';

describe('下载模块数据与状态', () => {
  it('Windows 可下载而 macOS 只显示即将支持', () => {
    expect(DOWNLOAD_PLATFORMS[0]).toMatchObject({
      id: 'windows-x64',
      status: 'available'
    });
    expect(DOWNLOAD_PLATFORMS[1]).toMatchObject({
      id: 'macos',
      status: 'coming-soon'
    });
    expect('downloadUrl' in DOWNLOAD_PLATFORMS[1]!).toBe(false);
    expect('sizeBytes' in DOWNLOAD_PLATFORMS[1]!).toBe(false);
  });

  it('Windows 平台完整保留真实发行清单字段', () => {
    const release = releaseManifestSchema.parse(rawManifest);

    expect(DOWNLOAD_PLATFORMS[0]).toMatchObject({
      versionLabel: release.version,
      sizeBytes: release.sizeBytes,
      fileName: release.fileName,
      sha256: release.sha256,
      downloadUrl: release.downloadUrl
    });
  });

  it('平台索引可循环且不依赖两个固定项目', () => {
    expect(rotatePlatformIndex(0, -1, 3)).toBe(2);
    expect(rotatePlatformIndex(2, 1, 3)).toBe(0);
  });

  it('临时面板、锁定面板和复位互斥', () => {
    const hovered = reduceDownloadInteraction(initialDownloadInteraction, {
      type: 'SET_PREVIEW_HOLD',
      side: 'faq',
      source: 'pointer',
      held: true
    });
    expect(visibleDownloadSide(hovered)).toBe('faq');

    const locked = reduceDownloadInteraction(hovered, {
      type: 'TOGGLE_LOCK',
      side: 'notice'
    });
    expect(visibleDownloadSide(locked)).toBe('notice');

    expect(reduceDownloadInteraction(locked, { type: 'RESET' }))
      .toEqual(initialDownloadInteraction);
  });

  it('最近激活的临时来源释放后恢复仍持有的另一侧', () => {
    const faqHeld = reduceDownloadInteraction(initialDownloadInteraction, {
      type: 'SET_PREVIEW_HOLD',
      side: 'faq',
      source: 'pointer',
      held: true
    });
    const noticeHeld = reduceDownloadInteraction(faqHeld, {
      type: 'SET_PREVIEW_HOLD',
      side: 'notice',
      source: 'focus',
      held: true
    });
    const noticeReleased = reduceDownloadInteraction(noticeHeld, {
      type: 'SET_PREVIEW_HOLD',
      side: 'notice',
      source: 'focus',
      held: false
    });

    expect(visibleDownloadSide(noticeHeld)).toBe('notice');
    expect(visibleDownloadSide(noticeReleased)).toBe('faq');
  });

  it('解除锁定会抑制现有 hold，全部释放后新 hold 可再次预览', () => {
    const held = reduceDownloadInteraction(initialDownloadInteraction, {
      type: 'SET_PREVIEW_HOLD',
      side: 'faq',
      source: 'focus',
      held: true
    });
    const locked = reduceDownloadInteraction(held, {
      type: 'TOGGLE_LOCK',
      side: 'faq'
    });
    const explicitlyClosed = reduceDownloadInteraction(locked, {
      type: 'TOGGLE_LOCK',
      side: 'faq'
    });
    const released = reduceDownloadInteraction(explicitlyClosed, {
      type: 'SET_PREVIEW_HOLD',
      side: 'faq',
      source: 'focus',
      held: false
    });
    const heldAgain = reduceDownloadInteraction(released, {
      type: 'SET_PREVIEW_HOLD',
      side: 'faq',
      source: 'pointer',
      held: true
    });

    expect(visibleDownloadSide(explicitlyClosed)).toBeNull();
    expect(visibleDownloadSide(heldAgain)).toBe('faq');
  });
});
