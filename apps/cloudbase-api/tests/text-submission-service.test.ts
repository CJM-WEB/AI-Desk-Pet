import { describe, expect, it, vi } from 'vitest';

import { hashStatusToken } from '../src/crypto/status-token.js';
import { TextSubmissionService } from '../src/services/text-submission-service.js';

function createFixture() {
  const store = {
    createTextSubmission: vi.fn(async () => ({
      id: 'feedback-1',
      status: 'manual_review_pending'
    }))
  };
  return {
    store,
    service: new TextSubmissionService(
      store as never,
      () => 'feedback-1'
    )
  };
}

describe('文本投稿服务', () => {
  it('创建待人工审核的反馈并只保存令牌哈希', async () => {
    const { service, store } = createFixture();

    const receipt = await service.submit({
      kind: 'feedback',
      authorName: '  ',
      content: '  一条反馈  '
    }, { ip: '203.0.113.8' });
    expect(receipt).toMatchObject({
      submissionId: 'feedback-1',
      statusPath: '/submission-status/',
      status: 'manual_review_pending'
    });
    expect(receipt.statusToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(store.createTextSubmission).toHaveBeenCalledWith({
      id: 'feedback-1',
      kind: 'feedback',
      title: '匿名用户',
      body: '一条反馈',
      statusTokenHash: hashStatusToken(receipt.statusToken)
    });
  });

  it.each([
    [{ kind: 'other' }, 'INVALID_REQUEST'],
    [{ authorName: '名'.repeat(31) }, 'INVALID_REQUEST'],
    [{ content: '' }, 'INVALID_REQUEST'],
    [{ content: '字'.repeat(1001) }, 'INVALID_REQUEST']
  ])('输入越界时在写入前拒绝：%o', async (change, code) => {
    const { service, store } = createFixture();

    await expect(service.submit({
      kind: 'feedback',
      authorName: '访客',
      content: '正文',
      ...change
    } as never, { ip: '203.0.113.8' })).rejects.toMatchObject({ code });
    expect(store.createTextSubmission).not.toHaveBeenCalled();
  });
});
