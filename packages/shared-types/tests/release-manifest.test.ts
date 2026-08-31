import { describe, expect, it } from 'vitest';
import { releaseManifestSchema } from '../src/release-manifest';

describe('发行清单契约', () => {
  it('接受不含计划标签的未发布 Windows Alpha 清单', () => {
    expect(releaseManifestSchema.parse({
      version: '0.1.0-alpha.1',
      platform: 'windows-x64',
      status: 'unpublished',
      fileName: 'AI-Pet-0.1.0-alpha.1-windows-x64.exe'
    }).status).toBe('unpublished');
  });

  it('拒绝未发布清单中的冗余计划标签', () => {
    expect(releaseManifestSchema.safeParse({
      version: '0.1.0-alpha.1',
      platform: 'windows-x64',
      status: 'unpublished',
      fileName: 'AI-Pet-0.1.0-alpha.1-windows-x64.exe',
      plannedReleaseTag: 'v0.1.0-alpha.1'
    }).success).toBe(false);
  });
});
