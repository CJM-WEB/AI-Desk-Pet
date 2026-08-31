import { createHash } from 'node:crypto';

import { ims, tms } from 'tencentcloud-sdk-nodejs';

import type { ModerationWorkerConfig } from '../config.js';
import type {
  ContentModerator,
  ModerationImageInput,
  ModerationSignal,
  ModerationTextInput
} from '../ports.js';

type TmsClient = InstanceType<typeof tms.v20201229.Client>;
type ImsClient = InstanceType<typeof ims.v20201229.Client>;
type TmsResponse = Awaited<ReturnType<TmsClient['TextModeration']>>;
type ImsResponse = Awaited<ReturnType<ImsClient['ImageModeration']>>;

export interface TencentTmsClient {
  TextModeration(
    request: Parameters<TmsClient['TextModeration']>[0]
  ): Promise<TmsResponse>;
}

export interface TencentImsClient {
  ImageModeration(
    request: Parameters<ImsClient['ImageModeration']>[0]
  ): Promise<ImsResponse>;
}

type ModerationConfig = Pick<
  ModerationWorkerConfig,
  'tmsBizType' | 'imsBizType'
>;

const forbiddenLabel = /politic|polity|dirtywords|abuse|hate|discrimination|porn|sex|violence|illegal|terror|advert|qr|gambling|fraud|privacy|二维码|政治|辱骂|脏话|仇恨|歧视|色情|暴力|违法|广告|赌博|诈骗|隐私/iu;
const maxTmsChunkBytes = 8 * 1024;
const maxTmsConcurrency = 32;

/** 使用腾讯云真实 TMS/IMS SDK，并只暴露有限的归一化结果。 */
export class TencentContentModerator implements ContentModerator {
  private activeTmsRequests = 0;
  private readonly tmsWaiters: Array<() => void> = [];

  constructor(
    private readonly tmsClient: TencentTmsClient,
    private readonly imsClient: TencentImsClient,
    private readonly config: ModerationConfig
  ) {}

  async reviewText(input: ModerationTextInput): Promise<ModerationSignal> {
    const chunks = splitUtf8(input.text, maxTmsChunkBytes);
    const signals = await mapConcurrentOrdered(
      chunks,
      maxTmsConcurrency,
      chunk => this.reviewTextChunk(chunk)
    );
    return aggregateSignals(signals);
  }

  private async reviewTextChunk(text: string): Promise<ModerationSignal> {
    await this.acquireTmsSlot();
    try {
      const response = await this.tmsClient.TextModeration({
        Content: Buffer.from(text, 'utf8').toString('base64'),
        BizType: this.config.tmsBizType,
        DataId: createHash('sha256').update(text).digest('hex')
      });
      return normalizeSignal(
        response.Suggestion,
        [
          response.Label,
          response.SubLabel,
          ...(response.Keywords ?? []),
          ...(response.DetailResults ?? []).flatMap(detail => [
            detail.Label,
            detail.SubLabel,
            ...(detail.Keywords ?? [])
          ])
        ],
        (response.DetailResults ?? []).map(detail => detail.Suggestion)
      );
    } catch {
      throw new Error('TMS_UNAVAILABLE');
    } finally {
      this.releaseTmsSlot();
    }
  }

  async reviewImage(input: ModerationImageInput): Promise<ModerationSignal> {
    try {
      const response = await this.imsClient.ImageModeration({
        FileUrl: input.imageUrl,
        BizType: this.config.imsBizType,
        DataId: createHash('sha256').update(input.imageUrl).digest('hex'),
        Type: 'IMAGE'
      });
      const detailGroups = [
        ...(response.LabelResults ?? []),
        ...(response.ObjectResults ?? []),
        ...(response.OcrResults ?? [])
      ];
      return normalizeSignal(
        response.Suggestion,
        [
          response.Label,
          response.SubLabel,
          ...detailGroups.flatMap(detail => [
            detail.Label,
            detail.SubLabel,
            detail.Scene
          ])
        ],
        detailGroups.map(detail => detail.Suggestion)
      );
    } catch {
      throw new Error('IMS_UNAVAILABLE');
    }
  }

  private async acquireTmsSlot(): Promise<void> {
    if (this.activeTmsRequests < maxTmsConcurrency) {
      this.activeTmsRequests += 1;
      return;
    }
    await new Promise<void>(resolve => this.tmsWaiters.push(resolve));
  }

  private releaseTmsSlot(): void {
    const next = this.tmsWaiters.shift();
    if (next) {
      next();
      return;
    }
    this.activeTmsRequests -= 1;
  }
}

/** 使用运行身份凭据创建真实 SDK 客户端，密钥不进入代码或日志。 */
export function createTencentContentModerator(
  config: Pick<
    ModerationWorkerConfig,
    'moderationRegion'
    | 'tmsBizType'
    | 'imsBizType'
    | 'tencentCloudSecretId'
    | 'tencentCloudSecretKey'
    | 'tencentCloudSessionToken'
  >,
  constructors: {
    TmsClient: new (
      options: ConstructorParameters<typeof tms.v20201229.Client>[0]
    ) => TencentTmsClient;
    ImsClient: new (
      options: ConstructorParameters<typeof ims.v20201229.Client>[0]
    ) => TencentImsClient;
  } = {
    TmsClient: tms.v20201229.Client,
    ImsClient: ims.v20201229.Client
  }
): TencentContentModerator {
  const credential = {
    secretId: config.tencentCloudSecretId,
    secretKey: config.tencentCloudSecretKey,
    ...(config.tencentCloudSessionToken ? {
      token: config.tencentCloudSessionToken
    } : {})
  };
  return new TencentContentModerator(
    new constructors.TmsClient({
      credential,
      region: config.moderationRegion,
      profile: {
        httpProfile: { reqTimeout: 8 }
      }
    }),
    new constructors.ImsClient({
      credential,
      region: config.moderationRegion,
      profile: {
        httpProfile: { reqTimeout: 8 }
      }
    }),
    config
  );
}

function normalizeSignal(
  suggestion: string | undefined,
  rawLabels: readonly (string | undefined)[],
  nestedSuggestions: readonly (string | undefined)[]
): ModerationSignal {
  const labels = [...new Set(
    rawLabels
      .map(label => label?.trim())
      .filter((label): label is string => Boolean(label))
  )];
  const label = (labels.join(',') || 'Unknown').slice(0, 100);
  if (
    forbiddenLabel.test(labels.join(','))
    || [suggestion, ...nestedSuggestions].some(
      value => value?.toLocaleLowerCase('en-US') === 'block'
    )
  ) {
    return { suggestion: 'Block', label };
  }
  const normalized = suggestion?.toLocaleLowerCase('en-US');
  const nested = nestedSuggestions.map(
    value => value?.toLocaleLowerCase('en-US')
  );
  if (
    normalized === 'pass'
    && nested.every(value => value === 'pass')
  ) {
    return { suggestion: 'Pass', label };
  }
  return { suggestion: 'Review', label };
}

function splitUtf8(text: string, maximumBytes: number): string[] {
  if (!text) return [''];
  const chunks: string[] = [];
  let current = '';
  let bytes = 0;
  for (const character of text) {
    const characterBytes = Buffer.byteLength(character, 'utf8');
    if (bytes + characterBytes > maximumBytes && current) {
      chunks.push(current);
      current = '';
      bytes = 0;
    }
    current += character;
    bytes += characterBytes;
  }
  if (current) chunks.push(current);
  return chunks;
}

async function mapConcurrentOrdered<T, R>(
  values: readonly T[],
  concurrency: number,
  operation: (value: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (nextIndex < values.length) {
        const index = nextIndex;
        nextIndex += 1;
        results[index] = await operation(values[index]!, index);
      }
    }
  );
  await Promise.all(workers);
  return results;
}

function aggregateSignals(
  signals: readonly ModerationSignal[]
): ModerationSignal {
  const suggestion = signals.some(signal => signal.suggestion === 'Block')
    ? 'Block' as const
    : signals.some(signal => signal.suggestion === 'Review')
      ? 'Review' as const
      : 'Pass' as const;
  const label = [...new Set(signals.map(signal => signal.label))]
    .join(',')
    .slice(0, 100) || 'Unknown';
  return { suggestion, label };
}
