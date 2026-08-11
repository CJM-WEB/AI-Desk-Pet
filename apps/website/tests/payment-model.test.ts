import { describe, expect, it } from 'vitest';
import { PAYMENT_METHODS } from '../components/website-experience/donation/donation-content';
import {
  paymentCardVisual,
  paymentDepthIndex,
  paymentRelativeOffset,
  wrapPaymentIndex
} from '../components/website-experience/donation/payment-model';

describe('支付方式滚筒', () => {
  it('配置微信、支付宝和 PayPal 且路径可替换', () => {
    expect(PAYMENT_METHODS.map((item) => item.id)).toEqual([
      'wechat',
      'alipay',
      'paypal'
    ]);
    expect(PAYMENT_METHODS.map((item) => item.qrImagePath)).toEqual([
      '/WechatPay.jpg',
      '/Alipay.jpg',
      '/Paypal.png'
    ]);
  });

  it('任意数量都能循环并计算最短相对距离', () => {
    expect(wrapPaymentIndex(-1, 3)).toBe(2);
    expect(wrapPaymentIndex(3, 3)).toBe(0);
    expect(wrapPaymentIndex(4, 5)).toBe(4);
    expect(wrapPaymentIndex(-6, 5)).toBe(4);
    expect(wrapPaymentIndex(2, 0)).toBe(0);
    expect(paymentRelativeOffset(3, 0, 4)).toBe(-1);
    expect(paymentRelativeOffset(1, 0, 2)).toBe(1);
    expect(paymentRelativeOffset(5, 0, 6)).toBe(-1);
    expect(paymentRelativeOffset(3, 0, 0)).toBe(0);
    expect(paymentRelativeOffset(3, 0, -3)).toBe(0);
  });

  it('当前卡片最大且只有当前卡片可打开付款码', () => {
    expect(paymentCardVisual(0)).toMatchObject({
      scale: 1,
      opacity: 1,
      zIndex: 10,
      activatable: true
    });
    expect(paymentCardVisual(1)).toMatchObject({
      scale: 0.88,
      activatable: false
    });
  });
  it('按循环前后顺序给三个按钮分配清晰、中层和最深层', () => {
    expect(paymentDepthIndex(0, 0, 3)).toBe(0);
    expect(paymentDepthIndex(1, 0, 3)).toBe(1);
    expect(paymentDepthIndex(2, 0, 3)).toBe(2);
    expect(paymentCardVisual(0, 0).blurPx).toBe(0);
    expect(paymentCardVisual(1, 1).blurPx).toBe(2.5);
    expect(paymentCardVisual(-1, 2).blurPx).toBe(5);
  });
});
