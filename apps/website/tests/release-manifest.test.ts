import { describe, expect, it } from 'vitest';
import { releaseManifestSchema } from '@myself/shared-types/release-manifest';
import data from '../content/release-manifest.json';

describe('官网版本清单', () => {
  it('将尚未上传的 Windows Alpha 版本明确标记为未发布', () => {
    const release = releaseManifestSchema.parse(data);

    expect(release.version).toBe('0.1.0-alpha.1');
    expect(release.platform).toBe('windows-x64');
    expect(release.status).toBe('unpublished');
    expect(release.fileName).toBe('AI-Pet-0.1.0-alpha.1-windows-x64.exe');
    expect('downloadUrl' in release).toBe(false);
    expect('sizeBytes' in release).toBe(false);
    expect('sha256' in release).toBe(false);
    expect('plannedReleaseTag' in release).toBe(false);
  });
});
