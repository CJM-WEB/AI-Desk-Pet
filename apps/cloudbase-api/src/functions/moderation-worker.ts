import {
  CloudBasePostgresRpcClient,
  CloudBasePostgresStore,
  DEFAULT_RPC_CLIENT_OPTIONS
} from '../adapters/cloudbase-postgres.js';
import { createCloudBaseServerRuntime } from '../adapters/cloudbase-runtime.js';
import type { CloudBaseFunctionContext } from '../adapters/cloudbase-runtime.js';
import { CloudBaseStorage } from '../adapters/cloudbase-storage.js';
import { ScannerClient } from '../adapters/scanner-client.js';
import { createTencentContentModerator } from '../adapters/tencent-content-moderation.js';
import { loadModerationWorkerConfig } from '../config.js';
import {
  ModerationService,
  type BatchResult
} from '../services/moderation-service.js';

interface ModerationBatchProcessor {
  processNextBatch(limit: number): Promise<BatchResult>;
}

/** 创建可注入的定时入口，响应只包含批次计数。 */
export function createModerationWorker(
  service: ModerationBatchProcessor
): () => Promise<BatchResult> {
  return async () => {
    const result = await service.processNextBatch(3);
    return {
      claimed: result.claimed,
      succeeded: result.succeeded,
      failed: result.failed
    };
  };
}

/** CloudBase 定时云函数入口。 */
export async function main(
  _event: unknown,
  context: CloudBaseFunctionContext
): Promise<BatchResult> {
  return createProductionWorker(context)();
}

/** 组合自动审核的生产依赖；每次调用绑定本次临时身份。 */
export function createProductionWorker(
  context: CloudBaseFunctionContext
): () => Promise<BatchResult> {
  const config = loadModerationWorkerConfig(process.env);
  const runtime = createCloudBaseServerRuntime(config, context);
  const store = new CloudBasePostgresStore(
    runtime.rdb,
    new CloudBasePostgresRpcClient(config.envId, config.cloudbaseApiKey, {
      ...DEFAULT_RPC_CLIENT_OPTIONS,
      timeoutMs: config.cloudbaseSdkTimeoutMs
    })
  );
  const service = new ModerationService(
    store,
    new CloudBaseStorage(runtime.bucket),
    createTencentContentModerator(config),
    new ScannerClient(config.scannerUrl, config.scannerHmacSecret),
    { now: () => new Date() }
  );
  return createModerationWorker(service);
}
