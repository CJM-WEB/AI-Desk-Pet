import type { LocalModelPublicStatus } from '../../shared/local-model-ipc';
import type { ProviderSettingsSnapshot } from '../storage/settings-store';
import { createLocalModelRoutingSnapshot } from './local-model-route';

export interface LocalModelServiceRuntime {
  start(): Promise<void>;
  stop(): Promise<void>;
  close(): Promise<void>;
  getStatus(): LocalModelPublicStatus;
  subscribe(listener: (status: LocalModelPublicStatus) => void): () => void;
}

export interface LocalModelServiceOptions {
  initialEnabled: boolean;
  runtime: LocalModelServiceRuntime;
  readCloudProviderSettings(): Promise<ProviderSettingsSnapshot>;
  saveEnabled(enabled: boolean): Promise<void>;
  resetForConfigurationChange(): Promise<void>;
  publishStatus(status: LocalModelPublicStatus): void;
}

function serviceError(code: 'LOCAL_MODEL_SWITCHING' | 'LOCAL_MODEL_SERVICE_CLOSED'): Error {
  return Object.assign(new Error(code), { code });
}

/**
 * Service 是设置、会话 generation、内存路由与 Runtime 之间的唯一切换事务边界。
 * 失败时保留当前路由，绝不把本地故障转换成云端回退。
 */
export class LocalModelService {
  readonly #options: LocalModelServiceOptions;
  readonly #unsubscribeStatus: () => void;
  #enabled: boolean;
  #pendingSwitches = 0;
  #switchQueue = Promise.resolve();
  #startPromise: Promise<void> | undefined;
  #closePromise: Promise<void> | undefined;
  #closed = false;

  constructor(options: LocalModelServiceOptions) {
    this.#options = options;
    this.#enabled = options.initialEnabled;
    this.#unsubscribeStatus = options.runtime.subscribe(status => options.publishStatus(status));
    options.publishStatus(options.runtime.getStatus());
  }

  /** Main 只在所有首屏窗口完成加载后调用；启动失败保留本地路由和 Runtime 故障态。 */
  start(): Promise<void> {
    this.#assertOpen();
    if (!this.#enabled) return Promise.resolve();
    if (this.#startPromise !== undefined) return this.#startPromise;
    const operation = Promise.resolve().then(async () => {
      while (this.#pendingSwitches > 0) await this.#switchQueue;
      this.#assertOpen();
      if (!this.#enabled) return;
      await this.#options.runtime.start();
    });
    const tracked = operation.finally(() => {
      if (this.#startPromise === tracked) this.#startPromise = undefined;
    });
    this.#startPromise = tracked;
    return tracked;
  }

  providerSettingsSnapshot(): Promise<ProviderSettingsSnapshot> {
    this.#assertOpen();
    if (this.#pendingSwitches > 0) return Promise.reject(serviceError('LOCAL_MODEL_SWITCHING'));
    return this.#options.readCloudProviderSettings().then(cloud => {
      this.#assertOpen();
      if (this.#pendingSwitches > 0) throw serviceError('LOCAL_MODEL_SWITCHING');
      return createLocalModelRoutingSnapshot(cloud, this.#enabled);
    });
  }

  setEnabled(enabled: boolean): Promise<void> {
    this.#assertOpen();
    this.#pendingSwitches += 1;
    const operation = this.#switchQueue.then(() => this.#switchEnabled(enabled));
    const tracked = operation.finally(() => {
      this.#pendingSwitches -= 1;
    });
    this.#switchQueue = tracked.catch(() => undefined);
    return tracked;
  }

  close(): Promise<void> {
    if (this.#closePromise !== undefined) return this.#closePromise;
    this.#closed = true;
    // close 不排在可能等待 Runtime.start 的事务之后，必须立即触发 Runtime 的取消与精确进程清理。
    const runtimeClose = Promise.resolve().then(() => this.#options.runtime.close());
    this.#closePromise = Promise.allSettled([runtimeClose, this.#switchQueue]).then(results => {
      this.#unsubscribeStatus();
      const failures = results
        .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map(result => result.reason);
      if (failures.length > 0) throw new AggregateError(failures, 'LOCAL_MODEL_SERVICE_CLOSE_INCOMPLETE');
    });
    return this.#closePromise;
  }

  async #switchEnabled(enabled: boolean): Promise<void> {
    this.#assertOpen();
    await this.#options.resetForConfigurationChange();
    this.#assertOpen();
    if (!enabled) {
      await this.#options.runtime.stop();
      this.#assertOpen();
      await this.#options.saveEnabled(false);
      this.#assertOpen();
      this.#enabled = false;
      return;
    }

    await this.#options.saveEnabled(true);
    this.#assertOpen();
    // 路由先切到本地；start 失败后继续暴露本地 faulted，而不是恢复云端。
    this.#enabled = true;
    await this.#options.runtime.start();
  }

  #assertOpen(): void {
    if (this.#closed) throw serviceError('LOCAL_MODEL_SERVICE_CLOSED');
  }
}
