import type { ChapterId } from './types';

interface ChapterDefinition {
  id: ChapterId;
  label: string;
}

export const CHAPTER_REGISTRY = [
  { id: 'home', label: '首页' },
  { id: 'about', label: 'AI Pet 介绍' },
  { id: 'download', label: 'AI Pet 下载安装' },
  { id: 'feedback', label: '用户反馈与建议箱' },
  { id: 'donation', label: '捐款' }
] as const satisfies readonly ChapterDefinition[];
