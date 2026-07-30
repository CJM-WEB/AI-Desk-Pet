import type { captcha } from 'tencentcloud-sdk-nodejs';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import { TencentCaptchaVerifier } from '../src/adapters/tencent-captcha.js';

type CaptchaClient = InstanceType<typeof captcha.v20190722.Client>;

describe('腾讯验证码适配器', () => {
  it('真实 SDK 的验票方法兼容适配器依赖', () => {
    type DescribeCaptchaResult = CaptchaClient['DescribeCaptchaResult'];

    expectTypeOf<DescribeCaptchaResult>().toBeFunction();
  });

  it('CaptchaCode 非 1 时拒绝投稿', async () => {
    const captchaClient = {
      DescribeCaptchaResult: vi.fn(async () => ({ CaptchaCode: 8 }))
    };
    const securityStore = {
      consumeCaptchaTicket: vi.fn()
    };
    const verifier = new TencentCaptchaVerifier(
      captchaClient,
      securityStore,
      {
        captchaAppId: 123456,
        captchaSecretKey: '测试配置值'
      }
    );

    await expect(verifier.verify(
      { ticket: 'expired', randstr: 'r' },
      '203.0.113.8'
    )).rejects.toMatchObject({ code: 'CAPTCHA_INVALID' });
    expect(securityStore.consumeCaptchaTicket).not.toHaveBeenCalled();
  });

  it('只有腾讯验票通过后才保存五分钟票据哈希', async () => {
    const captchaClient = {
      DescribeCaptchaResult: vi.fn(async () => ({
        CaptchaCode: 1,
        CaptchaMsg: 'OK',
        RequestId: 'captcha-request-1'
      }))
    };
    const securityStore = {
      consumeCaptchaTicket: vi.fn(async () => true)
    };
    const verifier = new TencentCaptchaVerifier(
      captchaClient,
      securityStore,
      {
        captchaAppId: 123456,
        captchaSecretKey: '测试配置值'
      },
      () => new Date('2026-07-31T00:00:00.000Z')
    );

    await verifier.verify(
      { ticket: 'valid-ticket', randstr: 'valid-randstr' },
      '203.0.113.8'
    );

    expect(captchaClient.DescribeCaptchaResult).toHaveBeenCalledWith({
      CaptchaType: 9,
      Ticket: 'valid-ticket',
      UserIp: '203.0.113.8',
      Randstr: 'valid-randstr',
      CaptchaAppId: 123456,
      AppSecretKey: '测试配置值'
    });
    expect(securityStore.consumeCaptchaTicket).toHaveBeenCalledWith({
      ticketHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
      expiresAt: '2026-07-31T00:05:00.000Z'
    });
    expect(JSON.stringify(securityStore.consumeCaptchaTicket.mock.calls))
      .not.toContain('valid-ticket');
  });

  it('数据库发现票据重放时返回稳定错误', async () => {
    const verifier = new TencentCaptchaVerifier(
      {
        DescribeCaptchaResult: vi.fn(async () => ({ CaptchaCode: 1 }))
      },
      {
        consumeCaptchaTicket: vi.fn(async () => false)
      },
      {
        captchaAppId: 123456,
        captchaSecretKey: '测试配置值'
      }
    );

    await expect(verifier.verify(
      { ticket: 'replayed-ticket', randstr: 'r' },
      '203.0.113.8'
    )).rejects.toMatchObject({ code: 'CAPTCHA_REPLAYED' });
  });

  it('腾讯验票网络失败时失败关闭且不泄露原始错误', async () => {
    const verifier = new TencentCaptchaVerifier(
      {
        DescribeCaptchaResult: vi.fn(async () => {
          throw new Error('上游内部信息');
        })
      },
      {
        consumeCaptchaTicket: vi.fn()
      },
      {
        captchaAppId: 123456,
        captchaSecretKey: '测试配置值'
      }
    );

    await expect(verifier.verify(
      { ticket: 'ticket', randstr: 'r' },
      '203.0.113.8'
    )).rejects.toMatchObject({
      code: 'CAPTCHA_UNAVAILABLE',
      statusCode: 503
    });
  });
});
