import type { ComponentType } from 'react';
import type { MessageKey } from '../i18n/i18n-types';
import { AboutChapter } from './about/AboutChapter';
import { DonationChapter } from './donation/DonationChapter';
import { DownloadChapter } from './download/DownloadChapter';
import { FeedbackChapter } from './feedback/FeedbackChapter';
import type { ChapterId, ChapterRuntimeProps } from './types';

interface ChapterDefinition {
  id: ChapterId;
  labelKey: MessageKey;
  component: ComponentType<ChapterRuntimeProps> | null;
}

export const CHAPTER_REGISTRY = [
  { id: 'home', labelKey: 'chapter.home', component: null },
  { id: 'about', labelKey: 'chapter.about', component: AboutChapter },
  {
    id: 'download',
    labelKey: 'chapter.download',
    component: DownloadChapter
  },
  { id: 'feedback', labelKey: 'chapter.feedback', component: FeedbackChapter },
  { id: 'donation', labelKey: 'chapter.donation', component: DonationChapter }
] as const satisfies readonly ChapterDefinition[];
