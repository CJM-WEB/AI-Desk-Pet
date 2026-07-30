// @vitest-environment jsdom

import { act, cleanup, render } from '@testing-library/react';
import { createElement, Profiler } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileSwarm } from '../components/home-experience/FileSwarm';
import { SharedVisualLayers } from '../components/website-experience/SharedVisualLayers';
import {
  createFeedbackPreviewSource,
  createFeedbackVisualProfile,
  FEEDBACK_PREVIEW_SUMMARY_MAX_LENGTH,
  localizeFeedbackEntry,
  localizeOfficialFeedbackEntry
} from '../components/website-experience/feedback/feedback-preview-source';
import { en, zhCN } from '../components/i18n/messages';
import { interpolateMessage } from '../components/i18n/I18nProvider';
import { OFFICIAL_EXAMPLE_ENTRIES } from '../components/website-experience/feedback/feedback-content';
import type {
  FeedbackEntry,
  FeedbackKind,
  FeedbackRepository
} from '../components/website-experience/feedback/feedback-types';

function createEntry(overrides: Partial<FeedbackEntry> = {}): FeedbackEntry {
  return {
    id: 'feedback-1',
    kind: 'feedback',
    authorId: 'browser-1',
    authorName: '小满',
    content: '希望桌面宠物在专注模式下更安静一些，也能清晰提示任务进度。',
    likeCount: 12,
    createdAt: '2026-07-26T08:00:00.000Z',
    updatedAt: '2026-07-26T08:00:00.000Z',
    source: 'local-user',
    likedByCurrentBrowser: false,
    ...overrides
  };
}

function createRepository(entries: Partial<Record<FeedbackKind, readonly FeedbackEntry[]>> = {}): FeedbackRepository {
  return {
    list: (kind) => entries[kind] ?? [],
    create: () => createEntry(),
    toggleLike: () => createEntry(),
    subscribe: () => () => {}
  };
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('反馈文件预览内容源', () => {
  it('英文环境翻译官方示例但保留本地投稿原文', () => {
    const official = localizeOfficialFeedbackEntry(
      OFFICIAL_EXAMPLE_ENTRIES[0]!,
      (key) => en[key]
    );
    const local = localizeOfficialFeedbackEntry(createEntry({
      authorName: '本地作者',
      content: '这是用户原文'
    }), (key) => en[key]);

    expect(official.content).toBe('Please make the pet quieter in Focus mode.');
    expect(local.authorName).toBe('本地作者');
    expect(local.content).toBe('这是用户原文');
  });

  it('将空本地昵称显示为当前语言的匿名名称', () => {
    const anonymous = localizeFeedbackEntry(createEntry({
      authorName: '',
      content: '这是用户原文'
    }), (key) => en[key]);

    expect(anonymous.authorName).toBe('Anonymous');
    expect(anonymous.content).toBe('这是用户原文');
  });

  it('语言切换后只让新生成粒子使用当前语言快照', () => {
    const profile = createFeedbackVisualProfile(createRepository({
      feedback: [createEntry({ content: '本地原文' })]
    }), () => 0, (key, values) => interpolateMessage(zhCN[key], values));
    const source = profile.previewSource as ReturnType<typeof createFeedbackPreviewSource>;
    const firstSnapshot = source.bindToSpawn('particle-zh');

    profile.setTranslate((key, values) => interpolateMessage(en[key], values));
    const secondSnapshot = source.bindToSpawn('particle-en');

    expect(firstSnapshot[0]).toBe('类型 反馈');
    expect(source.read('particle-zh')).toEqual(firstSnapshot);
    expect(secondSnapshot[0]).toBe('Type feedback');
  });

  it('为同一粒子绑定稳定快照，且不会受到仓储后续变化影响', () => {
    const feedback = createEntry({ authorName: '反馈用户', likeCount: 8 });
    const suggestion = createEntry({
      id: 'suggestion-1',
      kind: 'suggestion',
      authorName: '建议用户',
      likeCount: 21
    });
    const repository = createRepository({
      feedback: [feedback],
      suggestion: [suggestion]
    });
    const random = vi.fn(() => 0.99);
    const source = createFeedbackPreviewSource(repository, random);

    const bound = source.bindToSpawn('particle-1');
    suggestion.likeCount = 999;

    expect(source.read('particle-1')).toEqual(bound);
    expect(bound).toEqual([
      '类型 建议',
      '昵称 建议用户',
      expect.stringContaining('正文 '),
      '点赞 21'
    ]);
    expect(source.getPreview({ id: 'particle-1' } as never)).toEqual(bound);
    expect(random).toHaveBeenCalledTimes(1);
  });

  it('释放后允许同一粒子标识重新随机绑定，并钳制随机边界', () => {
    const feedback = createEntry({ id: 'feedback-1', authorName: '第一位' });
    const suggestion = createEntry({
      id: 'suggestion-1',
      kind: 'suggestion',
      authorName: '第二位'
    });
    const random = vi.fn()
      .mockReturnValueOnce(-1)
      .mockReturnValueOnce(1);
    const source = createFeedbackPreviewSource(createRepository({
      feedback: [feedback],
      suggestion: [suggestion]
    }), random);

    expect(source.bindToSpawn('particle-1')[1]).toBe('昵称 第一位');
    source.release('particle-1');

    expect(source.bindToSpawn('particle-1')[1]).toBe('昵称 第二位');
    expect(random).toHaveBeenCalledTimes(2);
  });

  it('格式化反馈与建议，并将长正文限制为紧凑摘要', () => {
    const random = vi.fn()
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0.99);
    const source = createFeedbackPreviewSource(createRepository({
      feedback: [createEntry({ content: '反'.repeat(120) })],
      suggestion: [createEntry({
        id: 'suggestion-1',
        kind: 'suggestion',
        content: '建'.repeat(120)
      })]
    }), random);

    const feedbackLines = source.bindToSpawn('feedback-particle');
    source.release('feedback-particle');
    const suggestionLines = source.bindToSpawn('suggestion-particle');

    expect(feedbackLines[0]).toBe('类型 反馈');
    expect(suggestionLines[0]).toBe('类型 建议');
    expect(feedbackLines[2]?.replace('正文 ', '').length)
      .toBeLessThanOrEqual(FEEDBACK_PREVIEW_SUMMARY_MAX_LENGTH);
  });

  it('在空仓储或读取异常时提供明确且非空的降级预览', () => {
    const emptySource = createFeedbackPreviewSource(createRepository(), () => 0);
    const failedSource = createFeedbackPreviewSource({
      ...createRepository(),
      list: () => {
        throw new Error('读取失败');
      }
    }, () => 0);

    expect(emptySource.bindToSpawn('empty-particle')).toEqual([
      '类型 反馈建议',
      '昵称 AI Pet',
      '正文 暂无可展示内容',
      '点赞 0'
    ]);
    expect(failedSource.bindToSpawn('failed-particle')).toEqual([
      '类型 反馈建议',
      '昵称 AI Pet',
      '正文 内容暂时不可读取',
      '点赞 0'
    ]);
  });

  it('为反馈章节提供关闭光场并注入内容源的文件粒子配置', () => {
    const profile = createFeedbackVisualProfile(createRepository(), () => 0);

    expect(profile.id).toBe('feedback');
    expect(profile.fieldEnabled).toBe(false);
    expect(profile.previewSource).toBeDefined();
  });
});

describe('FileSwarm 预览内容源生命周期', () => {
  it('普通 RAF 帧不提交，进入离场与自然移除各提交一次并更新 DOM', () => {
    vi.useFakeTimers();
    let frameCallback: FrameRequestCallback | null = null;
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frameCallback = callback;
      return 1;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const onRender = vi.fn();
    const { getByTestId } = render(createElement(
      Profiler,
      { id: 'file-swarm', onRender },
      createElement(FileSwarm, {
        running: true,
        generating: true,
        exitProgress: 0,
        pointer: { x: 0, y: 0 },
        isPaused: false,
        maxActive: 1,
        safeZoneRatio: 0,
        reducedMotion: false
      })
    ));

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    act(() => {
      const baselineFrame = frameCallback as FrameRequestCallback | null;
      baselineFrame?.(0);
      const enteringFrame = frameCallback as FrameRequestCallback | null;
      enteringFrame?.(16);
    });
    expect(getByTestId('file-icon').getAttribute('data-phase')).toBe('floating');
    const commitCountBeforeOrdinaryFrame = onRender.mock.calls.length;

    act(() => {
      const ordinaryFrame = frameCallback as FrameRequestCallback | null;
      ordinaryFrame?.(32);
    });

    expect(onRender).toHaveBeenCalledTimes(commitCountBeforeOrdinaryFrame);

    let frameAt = 32;
    while (getByTestId('file-icon').getAttribute('data-phase') !== 'leaving') {
      frameAt += 250;
      act(() => {
        const leavingFrame = frameCallback as FrameRequestCallback | null;
        leavingFrame?.(frameAt);
      });
    }

    expect(onRender).toHaveBeenCalledTimes(commitCountBeforeOrdinaryFrame + 1);
    expect(getByTestId('file-icon').getAttribute('data-phase')).toBe('leaving');

    act(() => {
      const removalFrame = frameCallback as FrameRequestCallback | null;
      removalFrame?.(frameAt + 500);
    });

    expect(onRender).toHaveBeenCalledTimes(commitCountBeforeOrdinaryFrame + 2);
    expect(document.querySelector('[data-testid="file-icon"]')).toBeNull();
  });

  it('在粒子生成、移除和卸载时绑定并释放内容快照', () => {
    vi.useFakeTimers();
    const bindToSpawn = vi.fn(() => ['类型 反馈', '昵称 小满', '正文 内容', '点赞 1']);
    const release = vi.fn();
    const source = {
      getPreview: () => ['类型 反馈', '昵称 小满', '正文 内容', '点赞 1'],
      bindToSpawn,
      read: () => null,
      release
    };
    const baseProps = {
      running: true,
      generating: true,
      exitProgress: 0,
      pointer: { x: 0, y: 0 },
      isPaused: false,
      maxActive: 1,
      safeZoneRatio: 0,
      reducedMotion: true,
      previewSource: source
    };
    const { rerender, unmount } = render(createElement(FileSwarm, baseProps));

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(bindToSpawn).toHaveBeenCalledTimes(1);

    rerender(createElement(FileSwarm, {
      ...baseProps,
      generating: false,
      exitProgress: 1
    }));
    expect(release).toHaveBeenCalledTimes(1);

    unmount();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('粒子在 RAF 推进中自然过期时立即释放已绑定快照', () => {
    vi.useFakeTimers();
    let frameCallback: FrameRequestCallback | null = null;
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => {
      frameCallback = callback;
      return 1;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const release = vi.fn();
    const source = {
      getPreview: () => ['类型 反馈', '昵称 小满', '正文 内容', '点赞 1'],
      bindToSpawn: vi.fn(() => ['类型 反馈', '昵称 小满', '正文 内容', '点赞 1']),
      read: () => null,
      release
    };
    const { unmount } = render(createElement(FileSwarm, {
      running: true,
      generating: true,
      exitProgress: 0,
      pointer: { x: 0, y: 0 },
      isPaused: false,
      maxActive: 1,
      safeZoneRatio: 0,
      reducedMotion: false,
      previewSource: source
    }));

    act(() => {
      vi.advanceTimersByTime(2_000);
    });
    expect(source.bindToSpawn).toHaveBeenCalledTimes(1);

    act(() => {
      const firstFrame = frameCallback as FrameRequestCallback | null;
      firstFrame?.(0);
      const expiryFrame = frameCallback as FrameRequestCallback | null;
      expiryFrame?.(12_000);
    });

    expect(release).toHaveBeenCalledTimes(1);
    unmount();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('SharedVisualLayers 将反馈配置中的内容源传给真实 FileSwarm', () => {
    vi.useFakeTimers();
    const list = vi.fn((kind: FeedbackKind) => (
      kind === 'feedback' ? [createEntry()] : []
    ));
    const profile = createFeedbackVisualProfile({
      ...createRepository(),
      list
    }, () => 0);

    render(createElement(SharedVisualLayers, {
      profile,
      running: true,
      generating: true,
      exitProgress: 0,
      pointer: { x: 0, y: 0 },
      isPaused: false,
      reducedMotion: true,
      onInitializationError: vi.fn()
    }));

    act(() => {
      vi.advanceTimersByTime(2_000);
    });

    expect(list).toHaveBeenCalledWith('feedback');
    expect(list).toHaveBeenCalledWith('suggestion');
  });
});
