import { describe, expect, it } from 'vitest';
import data from '../content/release-manifest.json';
import { releaseManifestSchema } from '../lib/release-manifest';

describe('官网版本清单', () => {
  it('包含有效的未签名 Windows Alpha 版本信息', () => {
    const release = releaseManifestSchema.parse(data);

    expect(release.version).toBe('0.1.0-alpha.1');
    expect(release.platform).toBe('windows-x64');
    expect(release.fileName).toBe('Myself-0.1.0-alpha.1-windows-x64.exe');
    expect(release.downloadUrl).toMatch(/\.exe$/);
    expect(release.sizeBytes).toBeGreaterThan(0);
    expect(release.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(release.signed).toBe(false);
  });
});
