import { describe, expect, it } from 'vitest';
import { CONTENT_POOL, pickPreview } from '../components/home-experience/content-pool';

const FILE_KINDS = ['txt', 'pdf', 'ppt', 'xls', 'img', 'empty', 'folder'] as const;

describe('CONTENT_POOL', () => {
  it('精确覆盖七种文件类型', () => {
    expect(Object.keys(CONTENT_POOL)).toEqual([...FILE_KINDS]);
  });

  it('每种文件类型至少包含两个预览条目', () => {
    for (const kind of FILE_KINDS) {
      expect(CONTENT_POOL[kind].length).toBeGreaterThan(1);
    }
  });
});

describe('pickPreview', () => {
  it('随机值为零时返回首个条目对象', () => {
    const first = CONTENT_POOL.txt[0]!;

    expect(pickPreview('txt', () => 0)).toBe(first);
  });

  it('接近一时返回末个条目对象', () => {
    const last = CONTENT_POOL.pdf.at(-1)!;

    expect(pickPreview('pdf', () => 0.999)).toBe(last);
  });

  it('选择条目时不复制或改写内容', () => {
    const entry = CONTENT_POOL.ppt[1]!;
    const snapshot = { ...entry, lines: [...entry.lines] };

    expect(pickPreview('ppt', () => 0.999)).toBe(entry);
    expect(entry).toEqual(snapshot);
  });
});
