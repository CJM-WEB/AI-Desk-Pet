import type { ExperiencePhase } from '../home-experience/types';
import type { FileParticle } from '../home-experience/swarm-model';
import { getChapterIndex } from './chapter-registry';
import type { ChapterId } from './types';

export type RgbColor = readonly [number, number, number];

export interface FilePreviewContentSource {
  getPreview(particle: FileParticle): readonly string[];
}

/**
 * 保持既有粒子快照中的预览行，供首页、下载和捐款共享。
 */
export const DEFAULT_FILE_PREVIEW_CONTENT_SOURCE: FilePreviewContentSource = {
  getPreview: (particle) => particle.preview.lines
};

export interface SharedVisualProfile {
  id: Extract<ChapterId, 'home' | 'download' | 'community' | 'donation'>;
  fieldColor: RgbColor;
  maxActive: number;
  safeZoneRatio: number;
  fieldEnabled: boolean;
  previewSource: FilePreviewContentSource;
}

export const VISUAL_PROFILES = {
  home: {
    id: 'home',
    fieldColor: [180, 180, 180],
    maxActive: 10,
    safeZoneRatio: 0.3,
    fieldEnabled: true,
    previewSource: DEFAULT_FILE_PREVIEW_CONTENT_SOURCE
  },
  download: {
    id: 'download',
    fieldColor: [180, 180, 180],
    maxActive: 8,
    safeZoneRatio: 0.34,
    fieldEnabled: false,
    previewSource: DEFAULT_FILE_PREVIEW_CONTENT_SOURCE
  },
  community: {
    id: 'community',
    fieldColor: [180, 180, 180],
    maxActive: 8,
    safeZoneRatio: 0.34,
    fieldEnabled: false,
    previewSource: DEFAULT_FILE_PREVIEW_CONTENT_SOURCE
  },
  donation: {
    id: 'donation',
    fieldColor: [255, 255, 0],
    maxActive: 8,
    safeZoneRatio: 0.34,
    fieldEnabled: false,
    previewSource: DEFAULT_FILE_PREVIEW_CONTENT_SOURCE
  }
} as const satisfies Record<string, SharedVisualProfile>;

/**
 * 在需要文件粒子的章节及其相邻过渡区间提供共享视觉主题。
 */
export function resolveSharedVisualProfile(
  progress: number,
  phase: ExperiencePhase
): SharedVisualProfile | null {
  const downloadIndex = getChapterIndex('download');
  const communityIndex = getChapterIndex('community');
  const feedbackIndex = getChapterIndex('feedback');
  const donationIndex = getChapterIndex('donation');

  if (phase !== 'interactive' && phase !== 'exiting') return null;
  if (progress < 1) return VISUAL_PROFILES.home;
  if (progress > downloadIndex - 1 && progress < communityIndex) {
    return VISUAL_PROFILES.download;
  }
  if (progress >= communityIndex && progress < feedbackIndex) {
    return VISUAL_PROFILES.community;
  }
  if (progress > feedbackIndex && progress <= donationIndex) {
    return VISUAL_PROFILES.donation;
  }
  return null;
}
