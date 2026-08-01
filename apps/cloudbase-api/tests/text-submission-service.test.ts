import { describe, expect, it, vi } from 'vitest';

import { hashStatusToken } from '../src/crypto/status-token.js';
import { TextSubmissionService } from '../src/services/text-submission-service.js';

function createFixture() {
  const store = {
    createTextSubmission: vi.fn(async () => ({
      id: 'feedback-1',
      status: 'system_reviewing'
    }))
  };
  const captcha = {
    verify: vi.fn(async () => undefined)
  };
  return {
    store,
    captcha,
    service: new TextSubmissionService(
      store as never,
      captcha,
      () => 'feedback-1'
    )
  };
}

describe('文本投稿服务', () => {
  it('服务端验票后创建系统审核中的反馈并只保存令牌哈希', async () => {
    const { service, store, captcha } = createFixture();

    const receipt = await service.submit({
      kind: 'feedback',
      authorName: '  ',
      content: '  一条反馈  ',
      captcha: { ticket: 'ticket', randstr: 'randstr' }
    }, { ip: '203.0.113.8' });

    expect(captcha.verify).toHaveBeenCalledWith(
      { ticket: 'ticket', randstr: 'randstr' },
      '203.0.113.8'
    );
    expect(receipt).toMatchObject({
      submissionId: 'feedback-1',
      statusPath: '/submission-status/',
      status: 'system_reviewing'
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
    [{ content: '字'.repeat(1001) }, 'INVALID_REQUEST'],
    [{ captcha: undefined }, 'INVALID_REQUEST']
  ])('输入越界时在验票前拒绝：%o', async (change, code) => {
    const { service, store, captcha } = createFixture();

    await expect(service.submit({
      kind: 'feedback',
      authorName: '访客',
      content: '正文',
      captcha: { ticket: 'ticket', randstr: 'randstr' },
      ...change
    } as never, { ip: '203.0.113.8' })).rejects.toMatchObject({ code });
    expect(captcha.verify).not.toHaveBeenCalled();
    expect(store.createTextSubmission).not.toHaveBeenCalled();
  });
});
