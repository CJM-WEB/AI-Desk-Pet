import type { CaptchaProof } from '@myself/shared-types';

export interface CaptchaVerifier {
  verify(): Promise<CaptchaProof>;
}

interface TencentCaptchaInstance {
  show(): void;
}

interface TencentCaptchaConstructor {
  new (
    appId: string,
    callback: (result: { ret: number; ticket?: string; randstr?: string }) => void
  ): TencentCaptchaInstance;
}

declare global {
  interface Window {
    TencentCaptcha?: TencentCaptchaConstructor;
  }
}

/** 浏览器 CAPTCHA 适配器，只产出后端既有的 ticket/randstr 契约。 */
export class CaptchaClient {
  constructor(private readonly appId = process.env.NEXT_PUBLIC_CAPTCHA_APP_ID) {}

  async verify(): Promise<CaptchaProof> {
    if (!this.appId) throw new Error('CAPTCHA_CONFIG_REQUIRED');
    await loadTencentCaptcha();
    const Constructor = window.TencentCaptcha;
    if (!Constructor) throw new Error('CAPTCHA_LOAD_FAILED');

    return new Promise((resolve, reject) => {
      const captcha = new Constructor(this.appId!, result => {
        if (result.ret !== 0 || !result.ticket || !result.randstr) {
          reject(new Error('CAPTCHA_CANCELLED'));
          return;
        }
        resolve({ ticket: result.ticket, randstr: result.randstr });
      });
      captcha.show();
    });
  }
}

let loading: Promise<void> | undefined;

/** 验证码脚本全局复用，避免每次投稿重复插入脚本标签。 */
function loadTencentCaptcha(): Promise<void> {
  if (typeof window === 'undefined' || typeof document === 'undefined') {
    return Promise.reject(new Error('CAPTCHA_BROWSER_ONLY'));
  }
  if (window.TencentCaptcha) return Promise.resolve();
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://turing.captcha.qcloud.com/TCaptcha.js';
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => {
      loading = undefined;
      reject(new Error('CAPTCHA_LOAD_FAILED'));
    };
    document.head.append(script);
  });
  return loading;
}
