import { zhCN } from '../../i18n/messages';
import type { Translate } from '../../i18n/i18n-types';

export interface PaymentMethod {
  id: string;
  name: string;
  qrImagePath: string;
  imageAlt: string;
}

/** 仅本地化支付显示名称与替代文本，付款资源路径保持稳定。 */
export function createPaymentMethods(t: Translate): readonly PaymentMethod[] {
  const methods = [
    { id: 'wechat', name: t('donation.wechat'), qrImagePath: '/WechatPay.jpg' },
    { id: 'alipay', name: t('donation.alipay'), qrImagePath: '/Alipay.jpg' },
    { id: 'paypal', name: t('donation.paypal'), qrImagePath: '/Paypal.png' }
  ] as const;

  return methods.map((method) => ({
    ...method,
    imageAlt: t('donation.qrCode', { method: method.name })
  }));
}

// 兼容现有支付模型测试；界面渲染使用 createPaymentMethods(t)。
export const PAYMENT_METHODS = createPaymentMethods((key, values) => {
  const message = zhCN[key];
  return values
    ? message.replace(/\{([^{}]+)\}/g, (_, name: string) => String(values[name] ?? `{${name}}`))
    : message;
});
