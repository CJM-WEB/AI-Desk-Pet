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
    qrImagePath: '/WechatPay.jpg',
    imageAlt: '微信付款码'
  },
  {
    id: 'alipay',
    name: '支付宝',
    qrImagePath: '/Alipay.jpg',
    imageAlt: '支付宝付款码'
  },
  {
    id: 'paypal',
    name: 'PayPal',
    qrImagePath: '/Paypal.png',
    imageAlt: 'PayPal付款码'
  }
] as const satisfies readonly PaymentMethod[];
