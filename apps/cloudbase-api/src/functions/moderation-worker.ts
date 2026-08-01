import { CloudBasePostgresRpcClient, CloudBasePostgresStore } from '../adapters/cloudbase-postgres.js';
import { createCloudBaseServerRuntime } from '../adapters/cloudbase-runtime.js';
import { CloudBaseStorage } from '../adapters/cloudbase-storage.js';
import { ScannerClient } from '../adapters/scanner-client.js';
import { createTencentContentModerator } from '../adapters/tencent-content-moderation.js';
import { loadCloudConfig } from '../config.js';
import {
  ModerationService,
  type BatchResult
} from '../services/moderation-service.js';
import { KeywordRelevanceClassifier } from '../services/keyword-relevance.js';

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

let productionWorker: (() => Promise<BatchResult>) | undefined;

/** CloudBase 定时云函数入口。 */
export async function main(): Promise<BatchResult> {
  productionWorker ??= createProductionWorker();
  return productionWorker();
}

/** 仅用于组合测试的生产依赖工厂，部署入口仍通过 main 保持惰性单例。 */
export function createProductionWorker(): () => Promise<BatchResult> {
  const config = loadCloudConfig(process.env);
  const runtime = createCloudBaseServerRuntime(config);
  const store = new CloudBasePostgresStore(
    runtime.rdb,
    new CloudBasePostgresRpcClient(config.envId, config.cloudbaseApiKey)
  );
  const service = new ModerationService(
    store,
    new CloudBaseStorage(runtime.bucket),
    createTencentContentModerator(config),
    new KeywordRelevanceClassifier(),
    new ScannerClient(config.scannerUrl, config.scannerHmacSecret),
    { now: () => new Date() }
  );
  return createModerationWorker(service);
}
