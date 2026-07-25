export interface PaymentMethod {
  id: string;
  name: string;
  qrImagePath: string;
  imageAlt: string;
}

export const PAYMENT_METHODS = [
  {
    id: 'wechat',
    name: '微信',
    qrImagePath: '/payments/wechat.png',
    imageAlt: '微信付款码'
  },
  {
    id: 'alipay',
    name: '支付宝',
    qrImagePath: '/payments/alipay.png',
    imageAlt: '支付宝付款码'
  }
] as const satisfies readonly PaymentMethod[];
