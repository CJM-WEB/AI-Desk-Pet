import { describe, expect, it } from 'vitest';
import { releaseManifestSchema } from '@myself/shared-types/release-manifest';
import rawManifest from '../content/release-manifest.json';
import { zhCN } from '../components/i18n/messages';
import { createDownloadContent } from '../components/website-experience/download/download-content';

const platforms = createDownloadContent((key) => zhCN[key]).platforms;

describe('下载模块数据接口', () => {
  it('未发布 Windows 版本和 macOS 都不提供下载链接', () => {
    expect(platforms[0]).toMatchObject({
      id: 'windows-x64',
      status: 'unpublished'
    });
    expect('downloadUrl' in platforms[0]!).toBe(false);
    expect(platforms[1]).toMatchObject({
      id: 'macos',
      status: 'coming-soon'
    });
    expect('downloadUrl' in platforms[1]!).toBe(false);
  });

  it('未发布 Windows 平台仅保留未来目标资产名称', () => {
    const release = releaseManifestSchema.parse(rawManifest);

    expect(platforms[0]).toMatchObject({
      versionLabel: release.version,
      fileName: release.fileName,
      status: 'unpublished'
    });
    expect('plannedReleaseTag' in platforms[0]!).toBe(false);
  });

});
