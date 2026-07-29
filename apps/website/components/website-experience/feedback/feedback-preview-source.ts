import type { FilePreviewContentSource } from '../shared-visual-model';
import type { SharedVisualLayerProfile } from '../SharedVisualLayers';
import type { FeedbackEntry, FeedbackRecord, FeedbackRepository } from './feedback-types';
import type { Translate } from '../../i18n/i18n-types';
import { zhCN } from '../../i18n/messages';
import { interpolateMessage } from '../../i18n/I18nProvider';

export const FEEDBACK_PREVIEW_SUMMARY_MAX_LENGTH = 72;

export interface SpawnBoundFilePreviewContentSource extends FilePreviewContentSource {
  bindToSpawn(particleId: string): readonly string[];
  read(particleId: string): readonly string[] | null;
  release(particleId: string): void;
}

const OFFICIAL_MESSAGE_KEYS = {
  'official-feedback-01': ['feedback.official.official-feedback-01.author', 'feedback.official.official-feedback-01.content'],
  'official-feedback-02': ['feedback.official.official-feedback-02.author', 'feedback.official.official-feedback-02.content'],
  'official-feedback-03': ['feedback.official.official-feedback-03.author', 'feedback.official.official-feedback-03.content'],
  'official-feedback-04': ['feedback.official.official-feedback-04.author', 'feedback.official.official-feedback-04.content'],
  'official-feedback-05': ['feedback.official.official-feedback-05.author', 'feedback.official.official-feedback-05.content'],
  'official-feedback-06': ['feedback.official.official-feedback-06.author', 'feedback.official.official-feedback-06.content'],
  'official-suggestion-01': ['feedback.official.official-suggestion-01.author', 'feedback.official.official-suggestion-01.content'],
  'official-suggestion-02': ['feedback.official.official-suggestion-02.author', 'feedback.official.official-suggestion-02.content'],
  'official-suggestion-03': ['feedback.official.official-suggestion-03.author', 'feedback.official.official-suggestion-03.content'],
  'official-suggestion-04': ['feedback.official.official-suggestion-04.author', 'feedback.official.official-suggestion-04.content'],
  'official-suggestion-05': ['feedback.official.official-suggestion-05.author', 'feedback.official.official-suggestion-05.content'],
  'official-suggestion-06': ['feedback.official.official-suggestion-06.author', 'feedback.official.official-suggestion-06.content']
} as const;

const defaultTranslate: Translate = (key, values) => (
  interpolateMessage(zhCN[key], values)
);

function createFallbackPreviewLines(t: Translate, contentKey: 'feedback.preview.emptyContent' | 'feedback.preview.unavailableContent') {
  return [
    t('feedback.preview.type', { kind: t('feedback.preview.defaultKind') }),
    t('feedback.preview.author', { author: t('feedback.preview.defaultAuthor') }),
    t('feedback.preview.content', { content: t(contentKey) }),
    t('feedback.preview.likes', { count: 0 })
  ] as const;
}

/** 仅对稳定官方示例 ID 替换文案；本地用户记录始终保留原作者和正文。 */
export function localizeOfficialFeedbackEntry<T extends FeedbackRecord>(
  entry: T,
  t: Translate
): T {
  if (entry.source === 'local-user') return entry;
  const messageKeys = OFFICIAL_MESSAGE_KEYS[entry.id as keyof typeof OFFICIAL_MESSAGE_KEYS];
  if (!messageKeys) return entry;
  const [authorKey, contentKey] = messageKeys;
  return {
    ...entry,
    authorName: t(authorKey),
    content: t(contentKey)
  } as T;
}

/** 本地空昵称是稳定数据状态，仅在展示时替换为当前语言的匿名名称。 */
export function localizeFeedbackEntry<T extends FeedbackRecord>(
  entry: T,
  t: Translate
): T {
  const localizedEntry = localizeOfficialFeedbackEntry(entry, t);
  if (localizedEntry.source !== 'local-user' || localizedEntry.authorName) {
    return localizedEntry;
  }
  return {
    ...localizedEntry,
    authorName: t('feedback.anonymous')
  } as T;
}

function summarizeContent(content: string): string {
  if (content.length <= FEEDBACK_PREVIEW_SUMMARY_MAX_LENGTH) {
    return content;
  }

  return `${content.slice(0, FEEDBACK_PREVIEW_SUMMARY_MAX_LENGTH - 1)}…`;
}

function formatPreviewLines(entry: FeedbackEntry, t: Translate): readonly string[] {
  const localizedEntry = localizeFeedbackEntry(entry, t);
  return [
    t('feedback.preview.type', {
      kind: t(localizedEntry.kind === 'feedback'
        ? 'feedback.kind.feedback'
        : 'feedback.kind.suggestion')
    }),
    t('feedback.preview.author', { author: localizedEntry.authorName }),
    t('feedback.preview.content', { content: summarizeContent(localizedEntry.content) }),
    t('feedback.preview.likes', { count: localizedEntry.likeCount })
  ];
}

function selectEntry(
  repository: FeedbackRepository,
  random: () => number,
  t: Translate
): readonly string[] {
  try {
    const entries = [
      ...repository.list('feedback'),
      ...repository.list('suggestion')
    ];
    if (entries.length === 0) {
      return createFallbackPreviewLines(t, 'feedback.preview.emptyContent');
    }

    const index = Math.min(
      entries.length - 1,
      Math.max(0, Math.floor(random() * entries.length))
    );
    return formatPreviewLines(entries[index]!, t);
  } catch {
    return createFallbackPreviewLines(t, 'feedback.preview.unavailableContent');
  }
}

/** 将仓储条目固定为粒子生成时的快照，避免存活期间受列表变化影响。 */
export function createFeedbackPreviewSource(
  repository: FeedbackRepository,
  random: () => number,
  t: Translate = defaultTranslate
): SpawnBoundFilePreviewContentSource {
  const bindings = new Map<string, readonly string[]>();

  const bindToSpawn = (particleId: string): readonly string[] => {
    const existing = bindings.get(particleId);
    if (existing) {
      return existing;
    }

    const preview = selectEntry(repository, random, t);
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
export interface LocalizedFeedbackVisualProfile extends SharedVisualLayerProfile {
  setTranslate(t: Translate): void;
}

export function createFeedbackVisualProfile(
  repository: FeedbackRepository,
  random: () => number,
  initialTranslate: Translate = defaultTranslate
): LocalizedFeedbackVisualProfile {
  let translate = initialTranslate;
  const previewSource = createFeedbackPreviewSource(repository, random, (key, values) => translate(key, values));

  return {
    id: 'feedback',
    fieldColor: [180, 180, 180],
    maxActive: 8,
    safeZoneRatio: 0.34,
    fieldEnabled: false,
    previewSource,
    setTranslate: (nextTranslate) => {
      translate = nextTranslate;
    }
  };
}
