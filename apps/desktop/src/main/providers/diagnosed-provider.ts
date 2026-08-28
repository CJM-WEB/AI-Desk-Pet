import { randomUUID } from 'node:crypto';
import type { ModelProvider } from '@myself/agent-core';
import {
  ProviderResponseError,
  type ProviderResponseErrorCode,
  type ProviderResponseErrorStage
} from './provider-response-error';

const providerResponseCorrelationIds = new WeakMap<object, string>();

/** 只供 Main 聊天控制边界关联成功返回；弱引用不会进入响应序列化或公开状态。 */
export function providerResponseCorrelationId(response: object): string | undefined {
  return providerResponseCorrelationIds.get(response);
}

/** Main 私有诊断只保留公开 Provider 类型和不可逆推敏感内容的稳定标识。 */
export type ProviderResponseDiagnostic = Readonly<{
  providerType: string;
  stage: ProviderResponseErrorStage;
  code: ProviderResponseErrorCode;
  correlationId: string;
}>;

export type ProviderResponseDiagnosticSink = (
  diagnostic: ProviderResponseDiagnostic
) => void;

export interface ProviderResponseDiagnosticsOptions {
  providerType: string;
  sink: ProviderResponseDiagnosticSink;
  createCorrelationId?: () => string;
}

/** 每次 Provider 调用分配新关联标识；只在稳定格式错误离开边界时报告一次。 */
export class ProviderResponseDiagnostics {
  private readonly createCorrelationId: () => string;

  constructor(private readonly options: ProviderResponseDiagnosticsOptions) {
    this.createCorrelationId = options.createCorrelationId ?? randomUUID;
  }

  wrap(provider: ModelProvider): ModelProvider {
    return {
      respond: async (request, signal) => {
        const correlationId = this.createCorrelationId();
        try {
          const response = await provider.respond(request, signal);
          providerResponseCorrelationIds.set(response, correlationId);
          return response;
        } catch (error) {
          if (error instanceof ProviderResponseError) this.report(error, correlationId);
          throw error;
        }
      }
    };
  }

  report(error: ProviderResponseError, correlationId = this.createCorrelationId()): void {
    try {
      this.options.sink(Object.freeze({
        providerType: this.options.providerType,
        stage: error.stage,
        code: error.code,
        correlationId
      }));
    } catch {
      // 诊断仅尽力执行，不能覆盖原始 Provider 错误路径。
    }
  }
}
