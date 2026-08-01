import type { ComponentType } from 'react';
import type { MessageKey } from '../i18n/i18n-types';
import { AboutChapter } from './about/AboutChapter';
import { DonationChapter } from './donation/DonationChapter';
import { DownloadChapter } from './download/DownloadChapter';
import { FeedbackChapter } from './feedback/FeedbackChapter';
import { SharedPetChapter } from './community/SharedPetChapter';
import { CloudSharedPetRepository } from './community/cloud-shared-pet-repository';
import { ApiClient } from '../../lib/api-client';
import { CaptchaClient } from '../../lib/captcha';
import type { ChapterId, ChapterRuntimeProps } from './types';

/** 公开页面只使用 REST 仓库，验证码不承担且不创建用户身份。 */
const sharedPetRepository = new CloudSharedPetRepository(
  new ApiClient(process.env.NEXT_PUBLIC_API_BASE_URL ?? '/api/v1')
);
const sharedPetCaptcha = new CaptchaClient();

function CommunityChapter(props: ChapterRuntimeProps) {
  return <SharedPetChapter {...props} repository={sharedPetRepository} captcha={sharedPetCaptcha} />;
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
  { id: 'feedback', labelKey: 'chapter.feedback', component: FeedbackChapter },
  { id: 'donation', labelKey: 'chapter.donation', component: DonationChapter }
] as const satisfies readonly ChapterDefinition[];

export function getChapterIndex(id: ChapterId): number {
  return CHAPTER_REGISTRY.findIndex((chapter) => chapter.id === id);
}
