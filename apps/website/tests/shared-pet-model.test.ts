import { describe, expect, it } from 'vitest';
import {
  buildPageTransitionOrder,
  SHARED_PET_PAGE_SIZE,
  validateSharedPetDraft
} from '../components/website-experience/community/shared-pet-model';

const zip = new File(['zip'], 'pet.zip', { type: 'application/zip' });
const cover = new File(['image'], 'cover.webp', { type: 'image/webp' });

function fileWithSize(
  name: string,
  type: string,
  size: number
): File {
  const file = new File(['file'], name, { type });
  Object.defineProperty(file, 'size', { configurable: true, value: size });
  return file;
}

describe('共享仓库领域模型', () => {
  it('固定使用八个共享包展示槽位', () => {
    expect(SHARED_PET_PAGE_SIZE).toBe(8);
  });

  it('接受边界内的完整投稿', () => {
    expect(validateSharedPetDraft({
      name: 'My Pet',
      description: 'A custom AI Pet package.',
      packageFile: zip,
      coverFile: cover
    }).valid).toBe(true);
  });

  it('拒绝非 ZIP 文件和超长名称', () => {
    const result = validateSharedPetDraft({
      name: 'x'.repeat(31),
      description: 'valid',
      packageFile: new File(['x'], 'pet.7z'),
      coverFile: cover
    });
    expect(result).toMatchObject({ valid: false });
  });

  it('按从上到下、从左到右返回稳定动画顺序', () => {
    expect(buildPageTransitionOrder(8)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('按 trim 后的文本判断必填和长度边界', () => {
    expect(validateSharedPetDraft({
      name: `  ${'名'.repeat(30)}  `,
      description: `  ${'描'.repeat(500)}  `,
      packageFile: zip,
      coverFile: cover
    })).toMatchObject({
      valid: true,
      value: {
        name: '名'.repeat(30),
        description: '描'.repeat(500)
      }
    });
    expect(validateSharedPetDraft({
      name: '   ',
      description: 'valid',
      packageFile: zip,
      coverFile: cover
    })).toMatchObject({ valid: false, code: 'NAME_REQUIRED' });
    expect(validateSharedPetDraft({
      name: 'valid',
      description: '   ',
      packageFile: zip,
      coverFile: cover
    })).toMatchObject({ valid: false, code: 'DESCRIPTION_REQUIRED' });
    expect(validateSharedPetDraft({
      name: 'x'.repeat(31),
      description: 'valid',
      packageFile: zip,
      coverFile: cover
    })).toMatchObject({ valid: false, code: 'NAME_TOO_LONG' });
    expect(validateSharedPetDraft({
      name: 'valid',
      description: 'x'.repeat(501),
      packageFile: zip,
      coverFile: cover
    })).toMatchObject({ valid: false, code: 'DESCRIPTION_TOO_LONG' });
  });

  it('为缺失文件返回对应的必填错误代码', () => {
    expect(validateSharedPetDraft({
      name: 'valid',
      description: 'valid'
    })).toMatchObject({ valid: false, code: 'PACKAGE_REQUIRED' });
    expect(validateSharedPetDraft({
      name: 'valid',
      description: 'valid',
      packageFile: zip
    })).toMatchObject({ valid: false, code: 'COVER_REQUIRED' });
  });

  it('按扩展名和允许的 MIME 校验 ZIP 与封面', () => {
    expect(validateSharedPetDraft({
      name: 'valid',
      description: 'valid',
      packageFile: new File(['zip'], 'PET.ZIP', { type: 'application/x-zip-compressed' }),
      coverFile: new File(['image'], 'COVER.JPG', { type: 'image/jpeg' })
    }).valid).toBe(true);
    expect(validateSharedPetDraft({
      name: 'valid',
      description: 'valid',
      packageFile: new File(['zip'], 'pet.zip', { type: 'image/png' }),
      coverFile: cover
    })).toMatchObject({ valid: false, code: 'PACKAGE_TYPE_INVALID' });
    expect(validateSharedPetDraft({
      name: 'valid',
      description: 'valid',
      packageFile: zip,
      coverFile: new File(['image'], 'cover.gif', { type: 'image/gif' })
    })).toMatchObject({ valid: false, code: 'COVER_TYPE_INVALID' });
  });

  it('使用字节精确限制 ZIP 和封面大小', () => {
    const maxZip = fileWithSize('pet.zip', 'application/zip', 100 * 1024 * 1024);
    const oversizedZip = fileWithSize('pet.zip', 'application/zip', 100 * 1024 * 1024 + 1);
    const maxCover = fileWithSize('cover.webp', 'image/webp', 5 * 1024 * 1024);
    const oversizedCover = fileWithSize('cover.webp', 'image/webp', 5 * 1024 * 1024 + 1);

    expect(validateSharedPetDraft({
      name: 'valid',
      description: 'valid',
      packageFile: maxZip,
      coverFile: maxCover
    }).valid).toBe(true);
    expect(validateSharedPetDraft({
      name: 'valid',
      description: 'valid',
      packageFile: oversizedZip,
      coverFile: cover
    })).toMatchObject({ valid: false, code: 'PACKAGE_TOO_LARGE' });
    expect(validateSharedPetDraft({
      name: 'valid',
      description: 'valid',
      packageFile: zip,
      coverFile: oversizedCover
    })).toMatchObject({ valid: false, code: 'COVER_TOO_LARGE' });
  });

  it('按固定状态模型生成分页动画顺序', () => {
    expect(buildPageTransitionOrder(0)).toEqual([]);
    expect(buildPageTransitionOrder(3)).toEqual([0, 1, 2]);
  });
});
