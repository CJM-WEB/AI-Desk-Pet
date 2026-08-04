import type { ExperiencePhase } from '../home-experience/types';
import type { FileParticle } from '../home-experience/swarm-model';
import { getChapterIndex } from './chapter-registry';
import type { ChapterId } from './types';

export type RgbColor = readonly [number, number, number];

export interface FilePreviewContentSource {
  getPreview(particle: FileParticle): readonly string[];
}

/**
 * 保持后续章节既有粒子快照中的预览行，供下载、社区和捐款共享。
 */
export const DEFAULT_FILE_PREVIEW_CONTENT_SOURCE: FilePreviewContentSource = {
  getPreview: (particle) => particle.preview.lines
};

export interface SharedVisualProfile {
  id: Extract<ChapterId, 'download' | 'community' | 'donation'>;
  fieldColor: RgbColor;
  maxActive: number;
  safeZoneRatio: number;
  fieldEnabled: boolean;
  previewSource: FilePreviewContentSource;
}

export const VISUAL_PROFILES = {
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
 * 在需要文件粒子的后续章节及其相邻过渡区间提供共享视觉主题。
 * 首页稳定态改由独立液态玻璃画布承载，不再启动旧文件粒子与光场。
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
  if (progress < 1) return null;
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
