import type { ComponentType } from 'react';
import type { MessageKey } from '../i18n/i18n-types';
import { AboutChapter } from './about/AboutChapter';
import { DownloadChapter } from './download/DownloadChapter';
import { SharedPetChapter } from './community/SharedPetChapter';
import { CloudSharedPetRepository } from './community/cloud-shared-pet-repository';
import { CloudFeedbackRepository } from './feedback/cloud-feedback-repository';
import { ApiClient } from '../../lib/api-client';
import { SupportChapter } from './support/SupportChapter';
import type { ChapterId, ChapterRuntimeProps } from './types';

/** 公开页面只使用 REST 仓库，不创建用户身份。 */
const sharedPetRepository = new CloudSharedPetRepository(
  new ApiClient(process.env.NEXT_PUBLIC_API_BASE_URL ?? '/api/v1')
);
/** 反馈章节与粒子预览共用此唯一快照仓库。 */
export const feedbackRepository = new CloudFeedbackRepository(
  new ApiClient(process.env.NEXT_PUBLIC_API_BASE_URL ?? '/api/v1')
);
function CommunityChapter(props: ChapterRuntimeProps) {
  return <SharedPetChapter {...props} repository={sharedPetRepository} />;
}

function FeedbackCloudChapter(props: ChapterRuntimeProps) {
  return <SupportChapter {...props} repository={feedbackRepository} />;
}

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
  {
    id: 'community',
    labelKey: 'chapter.community',
    component: CommunityChapter
  },
  { id: 'feedback', labelKey: 'chapter.feedback', component: FeedbackCloudChapter }
] as const satisfies readonly ChapterDefinition[];

export function getChapterIndex(id: ChapterId): number {
  return CHAPTER_REGISTRY.findIndex((chapter) => chapter.id === id);
}
