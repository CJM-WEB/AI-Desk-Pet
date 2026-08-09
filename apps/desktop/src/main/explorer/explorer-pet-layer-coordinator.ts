import type { ExplorerSnapshot } from './explorer-space-protocol';

/** 协调器只消费已通过桥协议校验的快照，或桥端传出的异常。 */
export interface ExplorerPetLayerSnapshot {
  nonce: string;
  sequence: number;
  status: ExplorerSnapshot['status'];
  instanceId?: string;
  hwnd?: string;
  foreground?: boolean;
  minimized?: boolean;
}

export type ExplorerPetLayerObservation = ExplorerPetLayerSnapshot | Error | null | undefined;

/** 图层端口只允许调整相邻层级和释放资源，不包含任何窗口可见性操作。 */
export interface ExplorerPetLayerPort {
  activate(target: { explorerHwnd: string }): Promise<void>;
  dispose(): Promise<void>;
}

export interface ExplorerPetLayerCoordinatorOptions {
  layer: ExplorerPetLayerPort;
  reportError(code: 'EXPLORER_LAYER_FAILED'): void;
}

/**
 * 按桥消息顺序串行处理 Explorer 层级；每个 nonce 独立维护严格递增的序号水位。
 */
export class ExplorerPetLayerCoordinator {
  private queue: Promise<void> = Promise.resolve();
  private nonce: string | undefined;
  private sequence = 0;
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(private readonly options: ExplorerPetLayerCoordinatorOptions) {}

  accept(observation: ExplorerPetLayerObservation): Promise<void> {
    if (this.closed) return Promise.reject(new Error('EXPLORER_LAYER_CLOSED'));
    return this.enqueue(async () => this.apply(observation));
  }

  close(): Promise<void> {
    if (this.closePromise !== undefined) return this.closePromise;
    this.closed = true;
    this.closePromise = this.enqueue(async () => this.options.layer.dispose());
    return this.closePromise;
  }

  private enqueue(action: () => Promise<void>): Promise<void> {
    const result = this.queue.then(action);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async apply(observation: ExplorerPetLayerObservation): Promise<void> {
    if (!this.isSnapshot(observation)) return;
    if (observation.nonce !== this.nonce) {
      this.nonce = observation.nonce;
      this.sequence = 0;
    }
    if (observation.sequence <= this.sequence) return;
    this.sequence = observation.sequence;
    if (
      observation.status !== 'ready'
      || typeof observation.instanceId !== 'string'
      || observation.instanceId.length === 0
      || typeof observation.hwnd !== 'string'
      || observation.foreground !== true
      || observation.minimized !== false
    ) return;
    try {
      await this.options.layer.activate({ explorerHwnd: observation.hwnd });
    } catch {
      try {
        this.options.reportError('EXPLORER_LAYER_FAILED');
      } catch {
        // 错误上报不得破坏队列，后续快照仍可推进水位。
      }
    }
  }

  private isSnapshot(
    observation: ExplorerPetLayerObservation
  ): observation is ExplorerPetLayerSnapshot {
    return observation !== null && observation !== undefined && !(observation instanceof Error);
  }
}
