import type {
  CleanupStore,
  Clock,
  ObjectStorage
} from '../ports.js';

export interface PurgeResult {
  claimed: number;
  purged: number;
  failed: number;
  expiredOperationsPurged: number;
}

const cleanupLeaseMilliseconds = 10 * 60 * 1000;
const defaultDeleteTimeoutMilliseconds = 15_000;

/** 先删除私有对象，再原子清空正文，任一对象失败都不会提前标记清理。 */
export class CleanupService {
  constructor(
    private readonly store: CleanupStore,
    private readonly storage: Pick<ObjectStorage, 'delete'>,
    private readonly clock: Clock,
    private readonly deleteTimeoutMilliseconds = defaultDeleteTimeoutMilliseconds
  ) {
    if (
      !Number.isSafeInteger(deleteTimeoutMilliseconds)
      || deleteTimeoutMilliseconds < 1
      || deleteTimeoutMilliseconds > 60_000
    ) {
      throw new RangeError('对象删除超时必须在 1 到 60000 毫秒之间');
    }
  }

  async purgeDue(limit: number): Promise<PurgeResult> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError('清理批量必须在 1 到 100 之间');
    }
    const expiredOperationsPurged =
      await this.store.purgeExpiredPublicInteractionOperations(500);
    const now = this.clock.now();
    const rows = await this.store.claimCleanupJobs(
      limit,
      new Date(now.getTime() + cleanupLeaseMilliseconds).toISOString()
    );
    let purged = 0;
    let failed = 0;

    for (const row of rows) {
      try {
        for (const asset of row.assets) {
          await withTimeout(
            this.storage.delete(asset.storageKey),
            this.deleteTimeoutMilliseconds
          );
        }
        const applied = await this.store.markPurged({
          submissionId: row.id,
          expectedVersion: row.statusVersion ?? 0
        });
        if (applied) purged += 1;
        else failed += 1;
      } catch {
        failed += 1;
      }
    }
    return {
      claimed: rows.length,
      purged,
      failed,
      expiredOperationsPurged
    };
  }
}

async function withTimeout<T>(
  operation: Promise<T>,
  timeoutMilliseconds: number
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('STORAGE_DELETE_TIMEOUT')),
          timeoutMilliseconds
        );
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
