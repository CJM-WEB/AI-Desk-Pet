import { describe, expect, it } from 'vitest';
import { PAYMENT_METHODS } from '../components/website-experience/donation/donation-content';
import {
  paymentCardVisual,
  paymentRelativeOffset,
  wrapPaymentIndex
} from '../components/website-experience/donation/payment-model';

describe('支付方式滚筒', () => {
  it('配置微信和支付宝且路径可替换', () => {
    expect(PAYMENT_METHODS.map((item) => item.id)).toEqual(['wechat', 'alipay']);
    expect(PAYMENT_METHODS.every((item) => item.qrImagePath.startsWith('/payments/')))
      .toBe(true);
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
});
