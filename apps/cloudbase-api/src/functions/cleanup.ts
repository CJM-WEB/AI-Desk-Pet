import {
  CloudBasePostgresRpcClient,
  CloudBasePostgresStore,
  DEFAULT_RPC_CLIENT_OPTIONS
} from '../adapters/cloudbase-postgres.js';
import { createCloudBaseServerRuntime } from '../adapters/cloudbase-runtime.js';
import type { CloudBaseFunctionContext } from '../adapters/cloudbase-runtime.js';
import { CloudBaseStorage } from '../adapters/cloudbase-storage.js';
import { loadCleanupConfig } from '../config.js';
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

/** CloudBase 三天隔离清理云函数入口。 */
export async function main(
  _event: unknown,
  context: CloudBaseFunctionContext
): Promise<PurgeResult> {
  return createProductionWorker(context)();
}

/** 组合隔离清理的生产依赖；服务端 API Key 统一访问 RDB 与私有存储。 */
export function createProductionWorker(
  _context: CloudBaseFunctionContext
): () => Promise<PurgeResult> {
  const config = loadCleanupConfig(process.env);
  const runtime = createCloudBaseServerRuntime(config);
  const store = new CloudBasePostgresStore(
    runtime.rdb,
    new CloudBasePostgresRpcClient(config.envId, config.cloudbaseApiKey, {
      ...DEFAULT_RPC_CLIENT_OPTIONS,
      timeoutMs: config.cloudbaseSdkTimeoutMs
    })
  );
  const service = new CleanupService(
    store,
    new CloudBaseStorage(runtime.bucket),
    { now: () => new Date() }
  );
  return createCleanupWorker(service);
}
