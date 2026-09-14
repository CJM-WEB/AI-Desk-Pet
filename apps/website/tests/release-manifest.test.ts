import { describe, expect, it } from 'vitest';
import { releaseManifestSchema } from '@myself/shared-types/release-manifest';
import data from '../content/release-manifest.json';

describe('官网版本清单', () => {
  it('固定已发布 Windows Alpha 安装包的最终身份', () => {
    const release = releaseManifestSchema.parse(data);

    expect(release.version).toBe('0.1.0-alpha.1');
    expect(release.platform).toBe('windows-x64');
    expect(release.status).toBe('published');
    expect(release.fileName).toBe('AI-Pet-0.1.0-alpha.1-windows-x64.exe');
    if (release.status !== 'published') throw new Error('Windows Alpha 安装包尚未发布');
    expect(release.downloadUrl).toBe(
      'https://cjmwebsite.cn/releases/0.1.0-alpha.1/AI-Pet-0.1.0-alpha.1-windows-x64.exe'
    );
    expect(release.sizeBytes).toBe(2982126566);
    expect(release.sha256).toBe(
      '17e1516a086c65d212a30c27206c6414fc2d127aefbb2d98a4030e1faa818cef'
    );
    expect(release.signed).toBe(false);
  });
});
