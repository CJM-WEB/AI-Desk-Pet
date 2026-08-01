import { describe, expect, it, vi } from 'vitest';

import {
  createTencentContentModerator,
  TencentContentModerator
} from '../src/adapters/tencent-content-moderation.js';

describe('腾讯云内容安全适配器', () => {
  it('创建 TMS 和 IMS 客户端时透传显式临时凭据及超时', () => {
    const received: unknown[] = [];
    class TestClient {
      constructor(options: unknown) {
        received.push(options);
      }
    }
    createTencentContentModerator({
      moderationRegion: 'ap-shanghai',
      tmsBizType: 'tms',
      imsBizType: 'ims',
      tencentCloudSecretId: 'secret-id',
      tencentCloudSecretKey: 'secret-key',
      tencentCloudSessionToken: 'session-token'
    }, {
      TmsClient: TestClient as never,
      ImsClient: TestClient as never
    });

    expect(received).toHaveLength(2);
    expect(received).toEqual([
      expect.objectContaining({
        credential: {
          secretId: 'secret-id',
          secretKey: 'secret-key',
          token: 'session-token'
        },
        profile: { httpProfile: { reqTimeout: 8 } }
      }),
      expect.objectContaining({
        credential: {
          secretId: 'secret-id',
          secretKey: 'secret-key',
          token: 'session-token'
        },
        profile: { httpProfile: { reqTimeout: 8 } }
      })
    ]);
  });

  it('把文本政治标签强制归一为拦截', async () => {
    const moderator = new TencentContentModerator({
      TextModeration: vi.fn().mockResolvedValue({
        Suggestion: 'Pass',
        Label: 'Politics'
      })
    }, {
      ImageModeration: vi.fn()
    }, {
      tmsBizType: 'ai-pet-text',
      imsBizType: 'ai-pet-image'
    });

    await expect(moderator.reviewText({ text: '待审核文本' })).resolves.toEqual({
      suggestion: 'Block',
      label: 'Politics'
    });
  });

  it('把图片二维码广告标签强制归一为拦截', async () => {
    const moderator = new TencentContentModerator({
      TextModeration: vi.fn()
    }, {
      ImageModeration: vi.fn().mockResolvedValue({
        Suggestion: 'Review',
        Label: 'QRcode'
      })
    }, {
      tmsBizType: 'ai-pet-text',
      imsBizType: 'ai-pet-image'
    });

    await expect(moderator.reviewImage({
      imageUrl: 'https://storage.example.com/private-cover?sig=1'
    })).resolves.toEqual({
      suggestion: 'Block',
      label: 'QRcode'
    });
  });

  it('未知建议保持人工复核而不放行', async () => {
    const moderator = new TencentContentModerator({
      TextModeration: vi.fn().mockResolvedValue({
        Suggestion: 'Unknown',
        Label: 'Unknown'
      })
    }, {
      ImageModeration: vi.fn()
    }, {
      tmsBizType: 'ai-pet-text',
      imsBizType: 'ai-pet-image'
    });

    await expect(moderator.reviewText({ text: '待审核文本' })).resolves.toEqual({
      suggestion: 'Review',
      label: 'Unknown'
    });
  });

  it('检查文本详情建议和关键词而非只看顶层标签', async () => {
    const moderator = new TencentContentModerator({
      TextModeration: vi.fn().mockResolvedValue({
        Suggestion: 'Pass',
        Label: 'Normal',
        DetailResults: [{
          Suggestion: 'Block',
          Label: 'Abuse',
          SubLabel: 'DirtyWords',
          Keywords: ['命中词']
        }]
      })
    }, {
      ImageModeration: vi.fn()
    }, {
      tmsBizType: 'ai-pet-text',
      imsBizType: 'ai-pet-image'
    });

    await expect(moderator.reviewText({ text: '待审核文本' })).resolves.toEqual({
      suggestion: 'Block',
      label: expect.stringContaining('Abuse')
    });
  });

  it('检查图片详情建议和二维码子标签而非只看顶层标签', async () => {
    const moderator = new TencentContentModerator({
      TextModeration: vi.fn()
    }, {
      ImageModeration: vi.fn().mockResolvedValue({
        Suggestion: 'Pass',
        Label: 'Normal',
        LabelResults: [{
          Suggestion: 'Block',
          Label: 'Ad',
          SubLabel: 'QRcode'
        }]
      })
    }, {
      tmsBizType: 'ai-pet-text',
      imsBizType: 'ai-pet-image'
    });

    await expect(moderator.reviewImage({
      imageUrl: 'https://storage.example.com/private-cover?sig=1'
    })).resolves.toEqual({
      suggestion: 'Block',
      label: expect.stringContaining('QRcode')
    });
  });

  it.each([
    'Polity',
    'DirtyWords',
    'Hate',
    'Discrimination',
    'Gambling',
    'Fraud',
    'Privacy',
    '政治',
    '脏话',
    '赌博',
    '诈骗',
    '隐私'
  ])('真实禁止标签 %s 一律拦截', async (label) => {
    const moderator = new TencentContentModerator({
      TextModeration: vi.fn().mockResolvedValue({
        Suggestion: 'Pass',
        Label: 'Normal',
        DetailResults: [{ Suggestion: 'Pass', Label: label }]
      })
    }, { ImageModeration: vi.fn() }, {
      tmsBizType: 'ai-pet-text',
      imsBizType: 'ai-pet-image'
    });
    await expect(moderator.reviewText({ text: '待审核文本' }))
      .resolves.toMatchObject({ suggestion: 'Block' });
  });

  it('长文本按 UTF-8 安全分块且最多并发 32 个请求', async () => {
    let active = 0;
    let maximumActive = 0;
    const calls: string[] = [];
    const moderator = new TencentContentModerator({
      TextModeration: vi.fn(async request => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        calls.push(Buffer.from(request.Content, 'base64').toString('utf8'));
        await new Promise(resolve => setTimeout(resolve, 1));
        active -= 1;
        return { Suggestion: 'Pass', Label: 'Normal' };
      })
    }, { ImageModeration: vi.fn() }, {
      tmsBizType: 'ai-pet-text',
      imsBizType: 'ai-pet-image'
    });
    const text = '你'.repeat(120_000);

    await expect(moderator.reviewText({ text })).resolves.toMatchObject({
      suggestion: 'Pass'
    });
    expect(calls.length).toBeGreaterThan(32);
    expect(maximumActive).toBeLessThanOrEqual(32);
    expect(calls.every(
      value => Buffer.byteLength(value, 'utf8') <= 8 * 1024
    )).toBe(true);
    expect(calls.join('')).toBe(text);
  });

  it('调用腾讯云失败时抛出受控依赖错误且不泄露原始响应', async () => {
    const moderator = new TencentContentModerator({
      TextModeration: vi.fn().mockRejectedValue(new Error('SecretId=leaked'))
    }, {
      ImageModeration: vi.fn()
    }, {
      tmsBizType: 'ai-pet-text',
      imsBizType: 'ai-pet-image'
    });

    await expect(moderator.reviewText({ text: '待审核文本' }))
      .rejects.toThrow('TMS_UNAVAILABLE');
  });
});
