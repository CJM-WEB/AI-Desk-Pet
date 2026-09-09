import { describe, expect, it } from 'vitest';
import { releaseManifestSchema } from '@myself/shared-types/release-manifest';
import rawManifest from '../content/release-manifest.json';
import { zhCN } from '../components/i18n/messages';
import { createDownloadContent } from '../components/website-experience/download/download-content';

const platforms = createDownloadContent((key) => zhCN[key]).platforms;
const release = releaseManifestSchema.parse(rawManifest);

describe('下载模块数据接口', () => {
  it('已发布 Windows 版本提供完整下载信息而 macOS 仍无链接', () => {
    expect(platforms[0]).toMatchObject({
      id: 'windows-x64',
      status: 'available',
      downloadUrl: release.status === 'published' ? release.downloadUrl : undefined,
      sizeBytes: release.status === 'published' ? release.sizeBytes : undefined,
      sha256: release.status === 'published' ? release.sha256 : undefined
    });
    expect(platforms[1]).toMatchObject({
      id: 'macos',
      status: 'coming-soon'
    });
    expect('downloadUrl' in platforms[1]!).toBe(false);
  });

  it('Windows 平台展示信息与已发布清单一致', () => {
    expect(platforms[0]).toMatchObject({
      versionLabel: release.version,
      fileName: release.fileName,
      status: 'available',
      downloadUrl: release.status === 'published' ? release.downloadUrl : undefined,
      sizeBytes: release.status === 'published' ? release.sizeBytes : undefined,
      sha256: release.status === 'published' ? release.sha256 : undefined
    });
  });

});
