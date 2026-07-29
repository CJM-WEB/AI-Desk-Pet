import { describe, expect, it } from 'vitest';
import { en } from '../components/i18n/messages';
import {
  CONTENT_POOL,
  createContentPool,
  pickPreview
} from '../components/home-experience/content-pool';

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

describe('createContentPool', () => {
  it('英文文件预览池不包含中文内建文案', () => {
    const pool = createContentPool((key) => en[key]);

    expect(JSON.stringify(pool)).not.toMatch(/\p{Script=Han}/u);
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

  it('从调用方提供的内容池中选择条目', () => {
    const pool = createContentPool((key) => en[key]);

    expect(pickPreview('txt', () => 0, pool)).toBe(pool.txt[0]);
  });
});
