/**
 * 章节视觉元素共用的层级令牌，避免重点内容被文件粒子遮挡。
 */
export const CHAPTER_LAYERS = {
  backdrop: 0,
  field: 10,
  files: 20,
  feature: 40,
  focal: 60,
  preview: 80,
  modal: 100
} as const;
