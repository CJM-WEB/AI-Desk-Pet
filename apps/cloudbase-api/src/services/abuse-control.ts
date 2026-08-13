import { ApiError } from '../errors.js';
import type { SecurityStore } from '../ports.js';

interface LimitPolicy {
  maximum: number;
  windowSeconds: number;
}

/** 把公开 API 的固定风控基线下推到 PostgreSQL 原子计数。 */
export class AbuseControl {
  constructor(
    private readonly store: Pick<SecurityStore, 'consumeAbuseLimit'>
  ) {}

  async consume(scope: string, fingerprint: string): Promise<void> {
    const policy = policyFor(scope);
    if (!/^[a-f0-9]{64}$/u.test(fingerprint)) {
      throw new ApiError('INVALID_REQUEST', 400);
    }

    const result = await this.store.consumeAbuseLimit({
      scope,
      fingerprintHash: fingerprint,
      ...policy
    });
    if (!result.allowed) {
      throw new ApiError(
        'RATE_LIMITED',
        429,
        '请求超过固定窗口限制',
        result.retryAfterSeconds
      );
    }
  }
}

function policyFor(scope: string): LimitPolicy {
  if (scope === 'submission_prepare') {
    return { maximum: 5, windowSeconds: 600 };
  }
  if (scope === 'status_query') {
    return { maximum: 30, windowSeconds: 60 };
  }
  if (/^(?:like|download):[A-Za-z0-9_-]{1,128}$/u.test(scope)) {
    return { maximum: 10, windowSeconds: 60 };
  }
  throw new ApiError('INVALID_REQUEST', 400);
}
