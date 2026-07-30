import { describe, expect, it } from 'vitest';
import rawManifest from '../content/release-manifest.json';
import { DOWNLOAD_PLATFORMS } from '../components/website-experience/download/download-content';
import { releaseManifestSchema } from '../lib/release-manifest';
import {
  initialDownloadInteraction,
  reduceDownloadInteraction,
  resolveDownloadSideMode,
  rotatePlatformIndex
} from '../components/website-experience/download/download-model';

describe('下载模块数据与状态', () => {
  it('未发布 Windows 版本和 macOS 都不提供下载链接', () => {
    expect(DOWNLOAD_PLATFORMS[0]).toMatchObject({
      id: 'windows-x64',
      status: 'unpublished'
    });
    expect('downloadUrl' in DOWNLOAD_PLATFORMS[0]!).toBe(false);
    expect(DOWNLOAD_PLATFORMS[1]).toMatchObject({
      id: 'macos',
      status: 'coming-soon'
    });
    expect('downloadUrl' in DOWNLOAD_PLATFORMS[1]!).toBe(false);
  });

  it('未发布 Windows 平台仅保留未来目标资产名称', () => {
    const release = releaseManifestSchema.parse(rawManifest);

    expect(DOWNLOAD_PLATFORMS[0]).toMatchObject({
      versionLabel: release.version,
      fileName: release.fileName,
      status: 'unpublished'
    });
  });

  it('平台索引可循环且不依赖两个固定项目', () => {
    expect(rotatePlatformIndex(0, -1, 3)).toBe(2);
    expect(rotatePlatformIndex(2, 1, 3)).toBe(0);
  });

  it('桌面侧栏只在 pointer 或 focus 持有期间临时显示', () => {
    const held = reduceDownloadInteraction(initialDownloadInteraction, {
      type: 'SET_DESKTOP_PREVIEW_HOLD',
      side: 'faq',
      source: 'pointer',
      held: true
    });
    expect(resolveDownloadSideMode(held, false)).toEqual({
      kind: 'desktop-preview',
      side: 'faq'
    });

    const released = reduceDownloadInteraction(held, {
      type: 'SET_DESKTOP_PREVIEW_HOLD',
      side: 'faq',
      source: 'pointer',
      held: false
    });
    expect(resolveDownloadSideMode(released, false)).toEqual({
      kind: 'desktop-preview',
      side: null
    });
  });

  it('移动端仅由轻触打开并可由空白复位', () => {
    const opened = reduceDownloadInteraction(initialDownloadInteraction, {
      type: 'OPEN_MOBILE_SIDE',
      side: 'notice'
    });
    expect(resolveDownloadSideMode(opened, true)).toEqual({
      kind: 'mobile-open',
      side: 'notice'
    });

    const closed = reduceDownloadInteraction(opened, {
      type: 'CLOSE_MOBILE_SIDE'
    });
    expect(resolveDownloadSideMode(closed, true)).toEqual({
      kind: 'mobile-open',
      side: null
    });
  });
});
