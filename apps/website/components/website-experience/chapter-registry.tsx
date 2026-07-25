import type { ComponentType } from 'react';
import { DownloadChapter } from './download/DownloadChapter';
import type { ChapterId } from './types';

export interface RegisteredChapterProps {
  interactive: boolean;
}

interface ChapterDefinition {
  id: ChapterId;
  label: string;
  component: ComponentType<RegisteredChapterProps> | null;
}

export const CHAPTER_REGISTRY = [
  { id: 'home', label: '首页', component: null },
  { id: 'about', label: 'AI Pet 介绍', component: null },
  {
    id: 'download',
    label: 'AI Pet 下载安装',
    component: DownloadChapter
  },
  { id: 'feedback', label: '用户反馈与建议箱', component: null },
  { id: 'donation', label: '捐款', component: null }
] as const satisfies readonly ChapterDefinition[];
