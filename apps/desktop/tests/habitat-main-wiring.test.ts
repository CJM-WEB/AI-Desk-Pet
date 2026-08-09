import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, expect, test } from 'vitest';

const integrityUrl = new URL(
  '../resources/windows/explorer-space-integrity.json',
  import.meta.url
);

describe('目录空间生产 Main 组合根', () => {
  test('固定清单中的两个生产资源 SHA-256 与真实文件一致', async () => {
    const manifest = JSON.parse(await readFile(integrityUrl, 'utf8')) as {
      version: number;
      files: Record<string, string>;
    };
    expect(manifest).toEqual({
      version: 1,
      files: {
        'explorer-space-bridge.ps1': expect.stringMatching(/^[a-f0-9]{64}$/u),
        'explorer-space-shell-tab-helper.cs': expect.stringMatching(/^[a-f0-9]{64}$/u)
      }
    });

    for (const [name, expected] of Object.entries(manifest.files)) {
      const content = await readFile(new URL(`../resources/windows/${name}`, import.meta.url));
      expect(createHash('sha256').update(content).digest('hex')).toBe(expected);
    }
  });
});
