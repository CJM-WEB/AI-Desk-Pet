import { describe, expect, it, vi } from 'vitest';
import type { CaptchaProof } from '@myself/shared-types';
import type { ApiClient } from '../lib/api-client';
import { CloudFeedbackRepository } from '../components/website-experience/feedback/cloud-feedback-repository';
import { feedbackRepository } from '../components/website-experience/chapter-registry';
import { createProductionFeedbackVisualProfile } from '../components/website-experience/WebsiteExperience';
import type { SpawnBoundFilePreviewContentSource } from '../components/website-experience/feedback/feedback-preview-source';

const captcha: CaptchaProof = { ticket: 'captcha-ticket', randstr: 'captcha-randstr' };

function createApi(...responses: unknown[]) {
  return {
    request: vi.fn().mockImplementation(() => Promise.resolve(responses.shift()))
  } as unknown as ApiClient;
}

describe('云端反馈仓库', () => {
  it('只把公开接口返回的已发布反馈装入同步快照', async () => {
    const api = createApi({
      items: [{
        id: 'published-1', kind: 'feedback', authorName: '公开用户', content: '已经审核发布的反馈。',
        likeCount: 3, createdAt: '2026-08-01T00:00:00.000Z'
      }],
      nextCursor: null
    });
    const repository = new CloudFeedbackRepository(api);

    await repository.refresh('feedback');

    expect(repository.list('feedback')).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'published-1', source: 'local-user', likeCount: 3 })
    ]));
    expect(vi.mocked(api.request)).toHaveBeenCalledWith('/feedback?kind=feedback&limit=100');
  });

  it('读取所有公开分页，并在游标循环时失败关闭', async () => {
    const api = createApi(
      {
        items: [{
          id: 'published-1', kind: 'feedback', authorName: '第一页', content: '第一页公开反馈。',
          likeCount: 1, createdAt: '2026-08-01T00:00:00.000Z'
        }], nextCursor: 100
      },
      {
        items: [{
          id: 'published-2', kind: 'feedback', authorName: '第二页', content: '第二页公开反馈。',
          likeCount: 2, createdAt: '2026-08-02T00:00:00.000Z'
        }], nextCursor: null
      }
    );
    const repository = new CloudFeedbackRepository(api);

    await repository.refresh('feedback');

    expect(repository.list('feedback')).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'published-1' }),
      expect.objectContaining({ id: 'published-2' })
    ]));
    expect(vi.mocked(api.request)).toHaveBeenNthCalledWith(2, '/feedback?kind=feedback&limit=100&cursor=100');
  });

  it('反馈和建议并发刷新时保留各自的失败状态', async () => {
    const api = {
      request: vi.fn((path: string) => {
        if (path.includes('kind=feedback')) {
          return Promise.resolve({ items: [], nextCursor: null });
        }
        return Promise.reject(new Error('SUGGESTION_NETWORK_FAILED'));
      })
    } as unknown as ApiClient;
    const repository = new CloudFeedbackRepository(api);

    await Promise.allSettled([
      repository.refresh('feedback'),
      repository.refresh('suggestion')
    ]);

    expect(repository.getStatusNotice('feedback')).toBeNull();
    expect(repository.getStatusNotice('suggestion')).toMatchObject({
      code: 'CLOUD_READ_FAILED'
    });
  });

  it('重复游标时清空网络快照并拒绝继续读取', async () => {
    const api = createApi({ items: [], nextCursor: 100 }, { items: [], nextCursor: 100 });
    const repository = new CloudFeedbackRepository(api);

    await expect(repository.refresh('feedback')).rejects.toThrow('FEEDBACK_CURSOR_LOOP');

    expect(repository.list('feedback').every((entry) => entry.source === 'official-example')).toBe(true);
  });

  it('未审核反馈提交成功后不进入公开快照', async () => {
    const api = createApi({
      submissionId: 'submission-1', statusToken: 'a'.repeat(43),
      statusPath: '/submission-status/', status: 'system_reviewing'
    });
    const repository = new CloudFeedbackRepository(api);
    const before = repository.list('feedback');

    const receipt = await repository.create({
      kind: 'feedback', authorName: '匿名用户', content: '等待系统审核的反馈内容。'
    }, captcha);

    expect(receipt.status).toBe('system_reviewing');
    expect(repository.list('feedback')).toEqual(before);
    expect(vi.mocked(api.request)).toHaveBeenCalledWith('/feedback', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({
        kind: 'feedback', authorName: '匿名用户', content: '等待系统审核的反馈内容。', captcha
      })
    }));
  });

  it('点赞等待独立反馈接口完成后更新快照并通知订阅者', async () => {
    const api = createApi(
      { items: [{
        id: 'published-1', kind: 'feedback', authorName: '公开用户', content: '已经审核发布的反馈。',
        likeCount: 3, createdAt: '2026-08-01T00:00:00.000Z'
      }], nextCursor: null },
      { liked: true, likeCount: 4 }
    );
    const repository = new CloudFeedbackRepository(api);
    const listener = vi.fn();
    repository.subscribe(listener);
    await repository.refresh('feedback');
    listener.mockClear();

    await expect(repository.toggleLike('published-1')).resolves.toMatchObject({
      likedByCurrentBrowser: true, likeCount: 4
    });

    expect(vi.mocked(api.request)).toHaveBeenLastCalledWith('/feedback/published-1/like', {
      method: 'POST', body: '{}'
    });
    expect(listener).toHaveBeenCalledOnce();
  });

  it('公开读取失败时清空网络快照，仅保留官方示例', async () => {
    const api = createApi(
      { items: [{
        id: 'published-1', kind: 'feedback', authorName: '公开用户', content: '已经审核发布的反馈。',
        likeCount: 3, createdAt: '2026-08-01T00:00:00.000Z'
      }], nextCursor: null },
      Promise.reject(new Error('NETWORK_FAILED'))
    );
    const repository = new CloudFeedbackRepository(api);
    await repository.refresh('feedback');

    await expect(repository.refresh('feedback')).rejects.toThrow('NETWORK_FAILED');

    expect(repository.list('feedback').every((entry) => entry.source === 'official-example')).toBe(true);
  });

  it('生产章节注册与粒子预览读取同一云端快照仓库', () => {
    const list = vi.spyOn(feedbackRepository, 'list').mockReturnValue([]);
    const profile = createProductionFeedbackVisualProfile((key) => key);
    const previewSource = profile.previewSource as SpawnBoundFilePreviewContentSource;

    previewSource.bindToSpawn('feedback-particle');

    expect(feedbackRepository).toBeInstanceOf(CloudFeedbackRepository);
    expect(list).toHaveBeenCalledWith('feedback');
    expect(list).toHaveBeenCalledWith('suggestion');
  });
});
