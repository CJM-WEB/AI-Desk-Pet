// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type CaptchaResult = { ret: number; ticket?: string; randstr?: string };

function installCaptcha(result: CaptchaResult) {
  window.TencentCaptcha = class {
    constructor(_appId: string, private readonly callback: (value: CaptchaResult) => void) {}
    show() { this.callback(result); }
  };
}

describe('浏览器验证码客户端', () => {
  beforeEach(() => {
    vi.resetModules();
    delete window.TencentCaptcha;
    document.head.querySelectorAll('script[src="https://turing.captcha.qcloud.com/TCaptcha.js"]')
      .forEach(script => script.remove());
  });

  afterEach(() => {
    delete window.TencentCaptcha;
    vi.unstubAllEnvs();
  });

  it('脚本加载成功后只返回后端需要的 ticket 与 randstr', async () => {
    const { CaptchaClient } = await import('../lib/captcha');
    const pending = new CaptchaClient('public-app-id').verify();
    const script = document.head.querySelector<HTMLScriptElement>('script[src="https://turing.captcha.qcloud.com/TCaptcha.js"]')!;
    installCaptcha({ ret: 0, ticket: 'ticket-1', randstr: 'randstr-1' });
    script.dispatchEvent(new Event('load'));
    await expect(pending).resolves.toEqual({ ticket: 'ticket-1', randstr: 'randstr-1' });
  });

  it('用户取消验证码时拒绝投稿', async () => {
    const { CaptchaClient } = await import('../lib/captcha');
    installCaptcha({ ret: 2 });
    await expect(new CaptchaClient('public-app-id').verify()).rejects.toThrow('CAPTCHA_CANCELLED');
  });

  it('脚本加载失败后清除状态并允许重试', async () => {
    const { CaptchaClient } = await import('../lib/captcha');
    const client = new CaptchaClient('public-app-id');
    const failed = client.verify();
    document.head.querySelector<HTMLScriptElement>('script[src="https://turing.captcha.qcloud.com/TCaptcha.js"]')!
      .dispatchEvent(new Event('error'));
    await expect(failed).rejects.toThrow('CAPTCHA_LOAD_FAILED');

    const retried = client.verify();
    const scripts = document.head.querySelectorAll('script[src="https://turing.captcha.qcloud.com/TCaptcha.js"]');
    installCaptcha({ ret: 0, ticket: 'ticket-2', randstr: 'randstr-2' });
    scripts[scripts.length - 1]!.dispatchEvent(new Event('load'));
    await expect(retried).resolves.toEqual({ ticket: 'ticket-2', randstr: 'randstr-2' });
  });

  it('缺少公开 App ID 时拒绝启动验证码', async () => {
    const { CaptchaClient } = await import('../lib/captcha');
    await expect(new CaptchaClient('').verify()).rejects.toThrow('CAPTCHA_CONFIG_REQUIRED');
  });
});
