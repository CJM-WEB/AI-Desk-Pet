import type { FilePreviewContentSource } from '../shared-visual-model';
import type { SharedVisualLayerProfile } from '../SharedVisualLayers';
import type { FeedbackEntry, FeedbackRepository } from './feedback-types';

export const FEEDBACK_PREVIEW_SUMMARY_MAX_LENGTH = 72;

export interface SpawnBoundFilePreviewContentSource extends FilePreviewContentSource {
  bindToSpawn(particleId: string): readonly string[];
  read(particleId: string): readonly string[] | null;
  release(particleId: string): void;
}

const EMPTY_PREVIEW_LINES = [
  '类型 反馈建议',
  '昵称 AI Pet',
  '正文 暂无可展示内容',
  '点赞 0'
] as const;

const UNAVAILABLE_PREVIEW_LINES = [
  '类型 反馈建议',
  '昵称 AI Pet',
  '正文 内容暂时不可读取',
  '点赞 0'
] as const;

function summarizeContent(content: string): string {
  if (content.length <= FEEDBACK_PREVIEW_SUMMARY_MAX_LENGTH) {
    return content;
  }

  return `${content.slice(0, FEEDBACK_PREVIEW_SUMMARY_MAX_LENGTH - 1)}…`;
}

function formatPreviewLines(entry: FeedbackEntry): readonly string[] {
  return [
    `类型 ${entry.kind === 'feedback' ? '反馈' : '建议'}`,
    `昵称 ${entry.authorName}`,
    `正文 ${summarizeContent(entry.content)}`,
    `点赞 ${entry.likeCount}`
  ];
}

function selectEntry(
  repository: FeedbackRepository,
  random: () => number
): readonly string[] {
  try {
    const entries = [
      ...repository.list('feedback'),
      ...repository.list('suggestion')
    ];
    if (entries.length === 0) {
      return EMPTY_PREVIEW_LINES;
    }

    const index = Math.min(
      entries.length - 1,
      Math.max(0, Math.floor(random() * entries.length))
    );
    return formatPreviewLines(entries[index]!);
  } catch {
    return UNAVAILABLE_PREVIEW_LINES;
  }
}

/** 将仓储条目固定为粒子生成时的快照，避免存活期间受列表变化影响。 */
export function createFeedbackPreviewSource(
  repository: FeedbackRepository,
  random: () => number
): SpawnBoundFilePreviewContentSource {
  const bindings = new Map<string, readonly string[]>();

  const bindToSpawn = (particleId: string): readonly string[] => {
    const existing = bindings.get(particleId);
    if (existing) {
      return existing;
    }

    const preview = selectEntry(repository, random);
    bindings.set(particleId, preview);
    return preview;
  };

  return {
    bindToSpawn,
    read: (particleId) => bindings.get(particleId) ?? null,
    release: (particleId) => {
      bindings.delete(particleId);
    },
    getPreview: (particle) => bindings.get(particle.id) ?? bindToSpawn(particle.id)
  };
}

/** 反馈章节通过独立配置传入共享视觉层，不让粒子组件感知章节语义。 */
export function createFeedbackVisualProfile(
  repository: FeedbackRepository,
  random: () => number
): SharedVisualLayerProfile {
  return {
    id: 'feedback',
    fieldColor: [180, 180, 180],
    maxActive: 8,
    safeZoneRatio: 0.34,
    fieldEnabled: false,
    previewSource: createFeedbackPreviewSource(repository, random)
  };
}
