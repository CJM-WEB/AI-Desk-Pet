import type {
  ExplorerPetLayerObservation,
  ExplorerPetLayerSnapshot
} from './explorer-pet-layer-coordinator';

interface ExplorerBridgePort {
  start(): Promise<void>;
  startObserving(): Promise<{ ok: true }>;
  close(): Promise<void>;
}

interface ExplorerCoordinatorPort {
  accept(observation: ExplorerPetLayerObservation): Promise<void>;
  close(): Promise<void>;
}

type PetLayerPreferenceError =
  | 'PET_LAYER_PREFERENCE_RESTORE_FAILED'
  | 'PET_LAYER_PREFERENCE_FALLBACK_FAILED';

/** 启动偏好恢复失败时回到普通动态图层，任何失败都不得阻断桌宠显示。 */
export async function restorePetLayerPreference(options: {
  read(): Promise<boolean>;
  apply(enabled: boolean): Promise<void>;
  reportError(code: PetLayerPreferenceError): void;
}): Promise<void> {
  try {
    await options.apply(await options.read());
    return;
  } catch {
    try { options.reportError('PET_LAYER_PREFERENCE_RESTORE_FAILED'); } catch { /* 日志不得阻断恢复。 */ }
  }
  try {
    await options.apply(false);
  } catch {
    try { options.reportError('PET_LAYER_PREFERENCE_FALLBACK_FAILED'); } catch { /* 日志不得阻断启动。 */ }
  }
}

/** Main 只组合 Explorer 桥接与相邻图层，不持有任何目录状态或窗口可见性策略。 */
export function createExplorerMainComposition(options: {
  bridge: ExplorerBridgePort;
  coordinator: ExplorerCoordinatorPort;
  showPet(): void;
  reportError(code: 'EXPLORER_BRIDGE_FAILED'): void;
}): {
  start(): Promise<void>;
  onExplorerSnapshot(snapshot: ExplorerPetLayerSnapshot): Promise<void>;
  onExplorerError(error: Error): Promise<void>;
  close(): Promise<void>;
} {
  let closePromise: Promise<void> | undefined;
  const reportBridgeFailure = (): void => {
    try { options.reportError('EXPLORER_BRIDGE_FAILED'); } catch { /* 日志端口不得影响桌宠。 */ }
  };
  return {
    async start(): Promise<void> {
      try {
        await options.bridge.start();
        await options.bridge.startObserving();
      } catch {
        reportBridgeFailure();
      } finally {
        options.showPet();
      }
    },
    onExplorerSnapshot: snapshot => options.coordinator.accept(snapshot),
    async onExplorerError(error): Promise<void> {
      reportBridgeFailure();
      await options.coordinator.accept(error);
    },
    close(): Promise<void> {
      closePromise ??= (async () => {
        const errors: unknown[] = [];
        try { await options.coordinator.close(); } catch (error) { errors.push(error); }
        try { await options.bridge.close(); } catch (error) { errors.push(error); }
        if (errors.length > 0) {
          throw new AggregateError(errors, 'EXPLORER_COMPOSITION_CLOSE_INCOMPLETE');
        }
      })();
      return closePromise;
    }
  };
}
