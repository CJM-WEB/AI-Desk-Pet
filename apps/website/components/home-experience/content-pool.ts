import { zhCN } from '../i18n/messages';
import type { Translate } from '../i18n/i18n-types';
import type { FileKind } from './types';

export interface PreviewContent {
  title: string;
  meta: string;
  lines: readonly string[];
}

/** 按当前翻译函数生成预览文案，保持文件种类与随机抽取结构稳定。 */
export function createContentPool(
  t: Translate
): Record<FileKind, readonly PreviewContent[]> {
  return {
    txt: [
      { title: t('home.preview.txt.0.title'), meta: t('home.preview.txt.0.meta'), lines: [t('home.preview.txt.0.line.0'), t('home.preview.txt.0.line.1')] },
      { title: t('home.preview.txt.1.title'), meta: t('home.preview.txt.1.meta'), lines: [t('home.preview.txt.1.line.0')] }
    ],
    pdf: [
      { title: t('home.preview.pdf.0.title'), meta: t('home.preview.pdf.0.meta'), lines: [t('home.preview.pdf.0.line.0')] },
      { title: t('home.preview.pdf.1.title'), meta: t('home.preview.pdf.1.meta'), lines: [t('home.preview.pdf.1.line.0')] }
    ],
    ppt: [
      { title: t('home.preview.ppt.0.title'), meta: t('home.preview.ppt.0.meta'), lines: [t('home.preview.ppt.0.line.0'), t('home.preview.ppt.0.line.1'), t('home.preview.ppt.0.line.2')] },
      { title: t('home.preview.ppt.1.title'), meta: t('home.preview.ppt.1.meta'), lines: [t('home.preview.ppt.1.line.0'), t('home.preview.ppt.1.line.1')] }
    ],
    xls: [
      { title: t('home.preview.xls.0.title'), meta: t('home.preview.xls.0.meta'), lines: [t('home.preview.xls.0.line.0'), t('home.preview.xls.0.line.1')] },
      { title: t('home.preview.xls.1.title'), meta: t('home.preview.xls.1.meta'), lines: [t('home.preview.xls.1.line.0'), t('home.preview.xls.1.line.1')] }
    ],
    img: [
      { title: t('home.preview.img.0.title'), meta: t('home.preview.img.0.meta'), lines: [t('home.preview.img.0.line.0'), t('home.preview.img.0.line.1')] },
      { title: t('home.preview.img.1.title'), meta: t('home.preview.img.1.meta'), lines: [t('home.preview.img.1.line.0')] }
    ],
    empty: [
      { title: t('home.preview.empty.0.title'), meta: t('home.preview.empty.0.meta'), lines: [t('home.preview.empty.0.line.0')] },
      { title: t('home.preview.empty.1.title'), meta: t('home.preview.empty.1.meta'), lines: [t('home.preview.empty.1.line.0')] }
    ],
    folder: [
      { title: t('home.preview.folder.0.title'), meta: t('home.preview.folder.0.meta'), lines: [t('home.preview.folder.0.line.0'), t('home.preview.folder.0.line.1')] },
      { title: t('home.preview.folder.1.title'), meta: t('home.preview.folder.1.meta'), lines: [t('home.preview.folder.1.line.0'), t('home.preview.folder.1.line.1')] }
    ]
  };
}

// 兼容现有粒子模型及其测试；渲染层会基于当前语言重取对应条目。
export const CONTENT_POOL = createContentPool((key) => zhCN[key]);

/** 将随机源映射到调用方提供的内容池，并保证索引不会超过最后一项。 */
export function pickPreview(
  kind: FileKind,
  random: () => number,
  pool: Record<FileKind, readonly PreviewContent[]> = CONTENT_POOL
): PreviewContent {
  const entries = pool[kind];
  const index = Math.min(entries.length - 1, Math.floor(random() * entries.length));

  return entries[index]!;
}
