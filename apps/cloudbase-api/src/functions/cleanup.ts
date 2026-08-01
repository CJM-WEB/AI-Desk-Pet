import cloudbaseWeb from '@cloudbase/js-sdk';
import cloudbaseNode from '@cloudbase/node-sdk';

import {
  CloudBasePostgresRpcClient,
  CloudBasePostgresStore
} from '../adapters/cloudbase-postgres.js';
import { CloudBaseStorage } from '../adapters/cloudbase-storage.js';
import { loadCloudConfig } from '../config.js';
import {
  CleanupService,
  type PurgeResult
} from '../services/cleanup-service.js';

interface CleanupBatchProcessor {
  purgeDue(limit: number): Promise<PurgeResult>;
}

/** 定时入口每批最多清理 20 条，避免函数超时扩大失败范围。 */
export function createCleanupWorker(
  service: CleanupBatchProcessor
): () => Promise<PurgeResult> {
  return () => service.purgeDue(20);
}

let productionWorker: (() => Promise<PurgeResult>) | undefined;

/** CloudBase 三天隔离清理云函数入口。 */
export async function main(): Promise<PurgeResult> {
  productionWorker ??= createProductionWorker();
  return productionWorker();
}

function createProductionWorker(): () => Promise<PurgeResult> {
  const config = loadCloudConfig(process.env);
  const nodeApp = cloudbaseNode.init({ env: config.envId });
  const webApp = cloudbaseWeb.init({ env: config.envId });
  const store = new CloudBasePostgresStore(
    nodeApp.rdb(),
    new CloudBasePostgresRpcClient(config.envId, config.cloudbaseApiKey)
  );
  const service = new CleanupService(
    store,
    new CloudBaseStorage(webApp.storage.from(config.privateBucketId)),
    { now: () => new Date() }
  );
  return createCleanupWorker(service);
}

