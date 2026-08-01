import { createHash } from 'node:crypto';

import { captcha } from 'tencentcloud-sdk-nodejs';

import { captchaProofSchema, type CaptchaProof } from '@myself/shared-types';

import type { CloudConfig } from '../config.js';
import { ApiError } from '../errors.js';
import type { CaptchaVerifier, SecurityStore } from '../ports.js';

type InstalledCaptchaClient = InstanceType<typeof captcha.v20190722.Client>;
type DescribeRequest = Parameters<
  InstalledCaptchaClient['DescribeCaptchaResult']
>[0];
type DescribeResponse = Awaited<
  ReturnType<InstalledCaptchaClient['DescribeCaptchaResult']>
>;

export interface TencentCaptchaClient {
  DescribeCaptchaResult(request: DescribeRequest): Promise<DescribeResponse>;
}

type CaptchaConfig = Pick<CloudConfig, 'captchaAppId' | 'captchaSecretKey'>;
type Now = () => Date;

const replayLifetimeMilliseconds = 5 * 60 * 1000;

/** 使用腾讯真实验票接口，并在数据库中原子阻止本应用内票据重放。 */
export class TencentCaptchaVerifier implements CaptchaVerifier {
  constructor(
    private readonly client: TencentCaptchaClient,
    private readonly securityStore: Pick<SecurityStore, 'consumeCaptchaTicket'>,
    private readonly config: CaptchaConfig,
    private readonly now: Now = () => new Date()
  ) {}

  async verify(proof: CaptchaProof, ip: string): Promise<void> {
    const parsed = captchaProofSchema.safeParse(proof);
    if (
      !parsed.success
      || typeof ip !== 'string'
      || ip.trim().length === 0
      || ip.length > 128
    ) {
      throw new ApiError('INVALID_REQUEST', 400);
    }

    let response: DescribeResponse;
    try {
      response = await this.client.DescribeCaptchaResult({
        CaptchaType: 9,
        Ticket: parsed.data.ticket,
        UserIp: ip,
        Randstr: parsed.data.randstr,
        CaptchaAppId: this.config.captchaAppId,
        AppSecretKey: this.config.captchaSecretKey
      });
    } catch {
      throw new ApiError('CAPTCHA_UNAVAILABLE', 503);
    }
    if (response.CaptchaCode !== 1) {
      throw new ApiError('CAPTCHA_INVALID', 400);
    }

    const consumed = await this.securityStore.consumeCaptchaTicket({
      ticketHash: createHash('sha256')
        .update(parsed.data.ticket)
        .digest('hex'),
      expiresAt: new Date(
        this.now().getTime() + replayLifetimeMilliseconds
      ).toISOString()
    });
    if (!consumed) throw new ApiError('CAPTCHA_REPLAYED', 400);
  }
}

/** CAPTCHA 为非地域服务，SDK 客户端不需要额外地域或账号签名字段。 */
type TencentCredentialConfig = Pick<
  CloudConfig,
  'tencentCloudSecretId'
  | 'tencentCloudSecretKey'
  | 'tencentCloudSessionToken'
>;

type CaptchaClientConstructor = new (
  options: ConstructorParameters<typeof captcha.v20190722.Client>[0]
) => TencentCaptchaClient;

export function createTencentCaptchaClient(
  config: TencentCredentialConfig,
  Client: CaptchaClientConstructor = captcha.v20190722.Client
): TencentCaptchaClient {
  return new Client({
    credential: {
      secretId: config.tencentCloudSecretId,
      secretKey: config.tencentCloudSecretKey,
      ...(config.tencentCloudSessionToken ? {
        token: config.tencentCloudSessionToken
      } : {})
    },
    region: ''
  });
}
