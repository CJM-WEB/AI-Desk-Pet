import {
  selectCharacterAction,
  type CharacterMotionMode,
  type CharacterStateId
} from '@myself/character-runtime';
import {
  useEffect,
  useRef,
  useState,
  type ReactNode
} from 'react';
import type {
  CharacterRuntimeSnapshot
} from '../../../../shared/character-ipc';
import type { CharacterMotionEvent } from '../../../../shared/character-motion-ipc';
import { characterErrorCode } from '../../../../shared/character-recovery';
import type { MyselfApi } from '../../../../shared/myself-api';
import {
  CharacterResourceCache,
  destroyCharacterAssetBundle,
  type CharacterAssetBundle,
  type CharacterAssetLoader
} from './character-resource-cache';
import {
  PixiCharacterPlayer,
  type CharacterPlaybackLifecycleEvent,
  type CharacterPlayerPort
} from './pixi-character-player';
import {
  CharacterMotionController,
  resolveDesktopAnchor
} from './character-motion-controller';
import {
  extensionDefinitionsFromManifest,
  type ExtensionTriggerDefinition
} from './extension-trigger-controller';
import type {
  CharacterHitTestPort
} from '../../pet/pet-interaction-controller';

export type CharacterPlayerPortFactory = (
  container: HTMLElement
) => Promise<CharacterPlayerPort>;

export interface CharacterPlayerProps {
  stateId: CharacterStateId;
  motionMode: CharacterMotionMode;
  behaviorAuthorityMode?: CharacterBehaviorAuthorityMode;
  direction?: 'left' | 'right';
  fallback?: ReactNode;
  api?: MyselfApi;
  createPlayer?: CharacterPlayerPortFactory;
  loadBundle?: CharacterAssetLoader;
  random?: () => number;
  onDesktopAnchors?: (anchors: CharacterDesktopAnchors) => void;
  onExtensionDefinitionsChange?: (
    definitions: readonly ExtensionTriggerDefinition[]
  ) => void;
  onIdleTrigger?: () => void;
  onHitTestPortChange?: (port: CharacterHitTestPort | null) => void;
  onMotionChange?: (motion: CharacterMotionPresentation) => void;
  onRuntimeError?: (errorCode: string | null) => void;
}

export type CharacterDesktopAnchors = {
  carry: { x: number; y: number } | null;
  seat: { x: number; y: number } | null;
  focus: { x: number; y: number } | null;
};

export type CharacterMotionPresentation = {
  position: { x: number; y: number };
  direction: 'left' | 'right';
  moving: boolean;
  carrying: boolean;
};

type ActiveBehaviorPlayback = {
  playbackToken: string;
  actionId: string;
  player: CharacterPlayerPort;
  playerPlaybackId: number | null;
  terminal: boolean;
};

type BehaviorPlaybackTokenState = 'active' | 'terminal';
type BehaviorActionEvent = Extract<CharacterMotionEvent, { type: 'behavior-action' }>;
type PlaybackActionEvent = Extract<
  CharacterMotionEvent,
  { type: 'behavior-action' }
>;
type CharacterProjectionStatus = 'loading' | 'ready' | 'unavailable';

const MAX_RUNTIME_LOAD_ATTEMPTS = 2;
const MAX_TRACKED_PLAYBACK_TOKENS = 128;
const createDefaultPlayer: CharacterPlayerPortFactory = container => (
  PixiCharacterPlayer.create(container)
);

/**
 * React 只编排受限 API、缓存和播放器端口，不持有 Pixi 纹理对象。
 */
export function CharacterPlayer({
  stateId,
  motionMode,
  behaviorAuthorityMode = 'legacy-v1',
  direction = 'right',
  fallback,
  api = window.myself,
  createPlayer = createDefaultPlayer,
  loadBundle,
  random = Math.random,
  onDesktopAnchors,
  onExtensionDefinitionsChange,
  onIdleTrigger,
  onHitTestPortChange,
  onMotionChange,
  onRuntimeError
}: CharacterPlayerProps) {
  const hostRef = useRef<HTMLSpanElement>(null);
  const activePlayerRef = useRef<CharacterPlayerPort | null>(null);
  const activeStageRef = useRef<HTMLElement | null>(null);
  const activeSnapshotRef = useRef<CharacterRuntimeSnapshot | null>(null);
  const activeBehaviorPlaybackRef = useRef<ActiveBehaviorPlayback | null>(null);
  const behaviorPlaybackTokensRef = useRef(new Map<string, BehaviorPlaybackTokenState>());
  const projectionStatusRef = useRef<CharacterProjectionStatus>('loading');
  const pendingPlaybackActionRef = useRef<PlaybackActionEvent | null>(null);
  const playbackActionConsumerRef = useRef<((event: PlaybackActionEvent) => void) | null>(null);
  const actionRevisionRef = useRef(-1);
  const behaviorAuthorityModeRef = useRef<CharacterBehaviorAuthorityMode>(
    behaviorAuthorityMode
  );
  const behaviorAuthorityCharacterIdRef = useRef<string | null>(null);
  const activeHitTestPortRef = useRef<CharacterHitTestPort | null>(null);
  const hitTestPortOwnerRef = useRef<
    CharacterPlayerProps['onHitTestPortChange']
  >(undefined);
  const playbackRef = useRef({ stateId, motionMode, direction, random });
  const [runtimeDirection, setRuntimeDirection] = useState(direction);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [pageVisible, setPageVisible] = useState(
    () => typeof document === 'undefined' || !document.hidden
  );
  const effectiveMotionMode: CharacterMotionMode = pageVisible
    ? motionMode
    : 'static';

  playbackRef.current = {
    stateId,
    motionMode: effectiveMotionMode,
    direction: runtimeDirection,
    random
  };

  const commitActiveViewport = (refreshFromMain = false): void => {
    const player = activePlayerRef.current;
    const stage = activeStageRef.current;
    if (!player || !stage || typeof api.commitPetViewport !== 'function') return;
    if (refreshFromMain) {
      stage.style.removeProperty('width');
      stage.style.removeProperty('height');
    }
    const viewportInWindowDip = roundedWindowLocalRectangle(stage);
    if (!viewportInWindowDip) return;
    // 拖拽期间 Windows 可能让客户区产生 1 DIP 抖动；舞台锁定权威提交尺寸，避免 Canvas 被 100% 拉伸。
    stage.style.width = `${viewportInWindowDip.width}px`;
    stage.style.height = `${viewportInWindowDip.height}px`;
    player.resize?.(viewportInWindowDip.width, viewportInWindowDip.height);
    void api.commitPetViewport({ viewportInWindowDip }).catch(() => undefined);
  };

  useEffect(() => {
    const previousOwner = hitTestPortOwnerRef.current;
    if (previousOwner && previousOwner !== onHitTestPortChange) {
      previousOwner(null);
    }
    hitTestPortOwnerRef.current = onHitTestPortChange;
    onHitTestPortChange?.(activeHitTestPortRef.current);

    return () => {
      if (hitTestPortOwnerRef.current !== onHitTestPortChange) return;
      onHitTestPortChange?.(null);
      hitTestPortOwnerRef.current = undefined;
    };
  }, [onHitTestPortChange]);

  useEffect(() => {
    const updateVisibility = (): void => setPageVisible(!document.hidden);
    document.addEventListener('visibilitychange', updateVisibility);
    return () => document.removeEventListener('visibilitychange', updateVisibility);
  }, []);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = typeof ResizeObserver === 'undefined'
      ? null
      : new ResizeObserver(() => commitActiveViewport());
    observer?.observe(host);
    const handleWindowResize = (): void => commitActiveViewport();
    window.addEventListener('resize', handleWindowResize);
    const unsubscribe = api.onPetGeometryRender?.(() => commitActiveViewport(true));
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', handleWindowResize);
      unsubscribe?.();
    };
  }, [api]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    let disposed = false;
    let revision = 0;
    const candidates = new Set<CharacterPlayerPort>();
    const destroyedPlayers = new WeakSet<CharacterPlayerPort>();
    const playbackSubscriptions = new WeakMap<CharacterPlayerPort, () => void>();
    const loader = loadBundle ?? createRuntimeAssetLoader(api);
    const cache = new CharacterResourceCache(loader, destroyCharacterAssetBundle);
    const placeholder = document.createElement('span');
    placeholder.className = 'character-player-stage';
    host.appendChild(placeholder);

    /** 当前端口与提交后的回调所有者同步更新，避免旧接收者残留。 */
    const publishHitTestPort = (port: CharacterHitTestPort | null): void => {
      activeHitTestPortRef.current = port;
      hitTestPortOwnerRef.current?.(port);
    };
    publishHitTestPort(null);

    /** 异步完成路径与卸载路径共享同一所有权门，确保播放器只释放一次。 */
    const destroyPlayerOnce = (player: CharacterPlayerPort): void => {
      if (destroyedPlayers.has(player)) return;
      destroyedPlayers.add(player);
      try {
        player.destroy();
      } finally {
        playbackSubscriptions.get(player)?.();
      }
    };

    /** 只接收播放器内部已归属到当前令牌的终态，忽略旧播放实例的迟到事件。 */
    const subscribePlaybackLifecycle = (player: CharacterPlayerPort): void => {
      if (typeof player.subscribePlaybackLifecycle !== 'function') return;
      playbackSubscriptions.set(player, player.subscribePlaybackLifecycle(event => {
        const playback = activeBehaviorPlaybackRef.current;
        if (
          !playback
          || playback.player !== player
          || playback.playerPlaybackId !== event.playbackId
        ) return;
        finishBehaviorPlayback(
          api,
          activeBehaviorPlaybackRef,
          behaviorPlaybackTokensRef,
          event.status
        );
      }));
    };

    const refresh = async (forceReload = false): Promise<void> => {
      const currentRevision = ++revision;
      let candidate: CharacterPlayerPort | null = null;
      let staging: HTMLSpanElement | null = null;
      projectionStatusRef.current = 'loading';
      setStatus('loading');
      publishHitTestPort(null);

      try {
        let snapshot: CharacterRuntimeSnapshot | null = null;
        let assets: CharacterAssetBundle | null = null;

        for (let attempt = 0; attempt < MAX_RUNTIME_LOAD_ATTEMPTS; attempt += 1) {
          snapshot = await api.getCharacterRuntimeSnapshot();
          if (disposed || currentRevision !== revision) return;
          if (!snapshot) throw new Error('CHARACTER_RUNTIME_UNAVAILABLE');

          try {
            assets = await cache.activate(snapshot.activeCharacterId, {
              forceReload: forceReload || attempt > 0,
              context: { snapshot }
            });
            break;
          } catch (error) {
            if (
              !isRuntimeChangedError(error)
              || attempt + 1 >= MAX_RUNTIME_LOAD_ATTEMPTS
            ) {
              throw error;
            }
          }
        }

        if (disposed || currentRevision !== revision || !snapshot || !assets) return;

        staging = document.createElement('span');
        staging.className = 'character-player-stage';
        host.appendChild(staging);
        candidate = await createPlayer(staging);
        candidates.add(candidate);
        subscribePlaybackLifecycle(candidate);
        if (disposed || currentRevision !== revision) {
          destroyPlayerOnce(candidate);
          candidates.delete(candidate);
          staging.remove();
          return;
        }

        await candidate.load(snapshot.manifest, assets);
        if (disposed || currentRevision !== revision) {
          destroyPlayerOnce(candidate);
          candidates.delete(candidate);
          staging.remove();
          return;
        }

        const playback = playbackRef.current;
        candidate.setDirection(playback.direction);
        if (
          behaviorAuthorityModeRef.current === 'legacy-v1'
          && (
            behaviorAuthorityCharacterIdRef.current === null
            || behaviorAuthorityCharacterIdRef.current === snapshot.activeCharacterId
          )
          && pendingPlaybackActionRef.current === null
        ) {
          const selection = selectCharacterAction({
            manifest: snapshot.manifest,
            stateId: playback.stateId,
            direction: playback.direction,
            recentActionIds: [],
            random: playback.random
          });
          candidate.play(selection, playback.motionMode);
        }

        const previous = activePlayerRef.current;
        activePlayerRef.current = candidate;
        activeStageRef.current = staging;
        activeSnapshotRef.current = snapshot;
        projectionStatusRef.current = 'ready';
        flushPendingPlaybackAction(
          projectionStatusRef,
          pendingPlaybackActionRef,
          playbackActionConsumerRef
        );
        onExtensionDefinitionsChange?.(
          extensionDefinitionsFromManifest(snapshot.manifest)
        );
        candidates.delete(candidate);
        staging.classList.add('is-active');
        for (const child of [...host.children]) {
          if (child !== staging) child.remove();
        }
        if (previous) destroyPlayerOnce(previous);
        publishHitTestPort(
          createPlayerHitTestPort(candidate, staging)
        );
        setStatus('ready');
        commitActiveViewport();
        if (forceReload) onRuntimeError?.(null);
      } catch (error) {
        // 候选资源属于本次局部事务，即使修订已过期也必须立即释放。
        if (candidate) {
          destroyPlayerOnce(candidate);
          candidates.delete(candidate);
        }
        staging?.remove();

        if (!disposed && currentRevision === revision) {
          projectionStatusRef.current = 'unavailable';
          settlePendingPlaybackAction(
            api,
            pendingPlaybackActionRef,
            behaviorPlaybackTokensRef,
            'failed'
          );
          if (activePlayerRef.current) {
            setStatus('ready');
          } else {
            activeSnapshotRef.current = null;
            setStatus('error');
            const errorCode = stableRuntimeErrorCode(error);
            console.error(
              '角色运行版本加载失败。',
              errorCode
            );
            onRuntimeError?.(errorCode);
          }
        }
      }
    };

    const unsubscribe = api.subscribeCharacterEvents(event => {
      if (event.type === 'active-character-changed') {
        behaviorAuthorityModeRef.current = behaviorAuthorityMode;
        behaviorAuthorityCharacterIdRef.current = null;
        settlePendingPlaybackAction(
          api,
          pendingPlaybackActionRef,
          behaviorPlaybackTokensRef,
          'interrupted'
        );
        finishBehaviorPlayback(
          api,
          activeBehaviorPlaybackRef,
          behaviorPlaybackTokensRef,
          'interrupted'
        );
        actionRevisionRef.current = -1;
        void refresh(true);
        return;
      }
      if (
        event.type === 'compile-result'
        && event.ok
        && event.characterId === activeSnapshotRef.current?.activeCharacterId
      ) {
        finishBehaviorPlayback(
          api,
          activeBehaviorPlaybackRef,
          behaviorPlaybackTokensRef,
          'interrupted'
        );
        void refresh(true);
      }
    });
    void refresh();

    return () => {
      disposed = true;
      ++revision;
      projectionStatusRef.current = 'unavailable';
      settlePendingPlaybackAction(
        api,
        pendingPlaybackActionRef,
        behaviorPlaybackTokensRef,
        'interrupted'
      );
      finishBehaviorPlayback(
        api,
        activeBehaviorPlaybackRef,
        behaviorPlaybackTokensRef,
        'interrupted'
      );
      publishHitTestPort(null);
      unsubscribe();
      cache.destroy();
      for (const candidate of candidates) destroyPlayerOnce(candidate);
      candidates.clear();
      if (activePlayerRef.current) destroyPlayerOnce(activePlayerRef.current);
      activePlayerRef.current = null;
      activeStageRef.current = null;
      activeSnapshotRef.current = null;
      host.replaceChildren();
    };
  }, [
    api,
    behaviorAuthorityMode,
    createPlayer,
    loadBundle,
    onExtensionDefinitionsChange,
    onRuntimeError
  ]);

  useEffect(() => {
    if (projectionStatusRef.current !== 'ready') return;
    const player = activePlayerRef.current;
    const snapshot = activeSnapshotRef.current;
    if (!player || !snapshot) return;

    try {
      player.setDirection(runtimeDirection);
    } catch {
      // 方向重建失败已由播放器收敛生命周期，本轮属性同步不再抢播。
      return;
    }
    if (behaviorAuthorityMode !== 'legacy-v1') {
      // Main-v2 既可能携带动作令牌，也可能只下发基础/循环权威动作；两者都必须冻结。
      player.setMotionMode?.(effectiveMotionMode);
      return;
    }
    const selection = selectCharacterAction({
      manifest: snapshot.manifest,
      stateId,
      direction: runtimeDirection,
      recentActionIds: [],
      random
    });
    player.play(selection, effectiveMotionMode);
  }, [behaviorAuthorityMode, effectiveMotionMode, random, runtimeDirection, stateId]);

  useEffect(() => {
    if (
      typeof api.subscribeCharacterMotion !== 'function'
      || typeof api.getCharacterMotionSnapshot !== 'function'
    ) {
      return;
    }
    let disposed = false;
    let controller: CharacterMotionController | null = null;
    let latestMotionSnapshot: Awaited<
      ReturnType<MyselfApi['getCharacterMotionSnapshot']>
    > | null = null;
    let animationFrame: number | null = null;

    const acceptSnapshot = (
      snapshot: Awaited<ReturnType<MyselfApi['getCharacterMotionSnapshot']>>
    ): void => {
      if (disposed) return;
      if (!controller) {
        controller = new CharacterMotionController({
          position: snapshot.position
        });
      }
      if (controller.accept(snapshot)) {
        latestMotionSnapshot = snapshot;
        setRuntimeDirection(snapshot.direction);
        onMotionChange?.({
          position: { ...snapshot.position },
          direction: snapshot.direction,
          moving: snapshot.moving,
          carrying: snapshot.carrying
        });
      }
    };

    const renderMotion = (timestampMs: number): void => {
      if (disposed) return;
      try {
        const snapshot = latestMotionSnapshot;
        const visual = controller?.advance(timestampMs);
        const player = activePlayerRef.current;
        const host = hostRef.current;
        if (!snapshot || !visual || !player || !host) return;
        player.setDirection(visual.direction);
        const frameBounds = player.getFrameBounds?.();
        const residualX = visual.position.x - snapshot.position.x;
        const residualY = visual.position.y - snapshot.position.y;
        host.style.transform = `translate(${residualX}px, ${residualY}px)`;
        const hostBounds = host.getBoundingClientRect();
        const frame = {
          // getBoundingClientRect 已包含 host transform，只再加 Main 窗口原点。
          x: snapshot.position.x + hostBounds.left + (frameBounds?.x ?? 0),
          y: snapshot.position.y + hostBounds.top + (frameBounds?.y ?? 0),
          width: frameBounds?.width ?? 0,
          height: frameBounds?.height ?? 0
        };
        const coordinate = (name: 'carry' | 'seat' | 'focus') => {
          const anchor = player.getAnchor(name);
          return anchor
            ? resolveDesktopAnchor(anchor, frame, visual.direction)
            : null;
        };
        onDesktopAnchors?.({
          carry: coordinate('carry'),
          seat: coordinate('seat'),
          focus: coordinate('focus')
        });
      } catch {
        // 单帧表现异常不终止运动循环；下一帧仍可从最新快照恢复。
      } finally {
        if (!disposed) animationFrame = scheduleAnimationFrame(renderMotion);
      }
    };

    /** 行为动作只在 player 与 snapshot 同步提交后消费，避免跨投影串播。 */
    const consumeBehaviorAction = (event: BehaviorActionEvent): void => {
      finishBehaviorPlayback(
        api,
        activeBehaviorPlaybackRef,
        behaviorPlaybackTokensRef,
        'interrupted'
      );
      const player = activePlayerRef.current;
      const snapshot = activeSnapshotRef.current;
      const playback = playbackRef.current;
      // V2 状态 ID 可能在 V1 投影时按语义改名；始终以投影内 actionId 为播放权威。
      const states = snapshot?.manifest.states ?? [];
      const state = states.find(candidate => (
        candidate.id === event.stateId
        && candidate.actions.some(action => action.id === event.actionId)
      )) ?? states.find(candidate => (
        candidate.actions.some(action => action.id === event.actionId)
      ));
      const action = state?.actions.find(candidate => candidate.id === event.actionId);
      if (!player || !snapshot || !state || !action) {
        settleBehaviorPlaybackToken(api, behaviorPlaybackTokensRef, {
          playbackToken: event.playbackToken,
          actionId: event.actionId,
          status: 'failed'
        });
        return;
      }

      const current: ActiveBehaviorPlayback = {
        playbackToken: event.playbackToken,
        actionId: event.actionId,
        player,
        playerPlaybackId: null,
        terminal: false
      };
      activeBehaviorPlaybackRef.current = current;
      try {
        const playbackId = player.play({
          stateId: state.id,
          action,
          reason: 'matched'
        }, playback.motionMode);
        current.playerPlaybackId = typeof playbackId === 'number' ? playbackId : null;
        void reportActionFeedback(api, {
          playbackToken: current.playbackToken,
          actionId: current.actionId,
          status: 'started'
        });
      } catch {
        finishBehaviorPlayback(
          api,
          activeBehaviorPlaybackRef,
          behaviorPlaybackTokensRef,
          'failed'
        );
      }
    };
    const consumePlaybackAction = (event: PlaybackActionEvent): void => {
      consumeBehaviorAction(event);
    };
    playbackActionConsumerRef.current = consumePlaybackAction;
    flushPendingPlaybackAction(
      projectionStatusRef,
      pendingPlaybackActionRef,
      playbackActionConsumerRef
    );

    const unsubscribe = api.subscribeCharacterMotion(event => {
      if (event.type === 'behavior-authority') {
        behaviorAuthorityModeRef.current = event.mode;
        behaviorAuthorityCharacterIdRef.current = event.characterId;
        const player = activePlayerRef.current;
        const snapshot = activeSnapshotRef.current;
        const playback = playbackRef.current;
        if (
          projectionStatusRef.current !== 'ready'
          || snapshot?.activeCharacterId !== event.characterId
          || !player
        ) return;
        const selection = selectCharacterAction({
          manifest: snapshot.manifest,
          stateId: playback.stateId,
          direction: playback.direction,
          recentActionIds: [],
          random: playback.random
        });
        player.play(selection, playback.motionMode);
        return;
      }
      if (event.type === 'snapshot') {
        acceptSnapshot(event.snapshot);
        return;
      }
      if (event.revision <= actionRevisionRef.current) return;
      actionRevisionRef.current = event.revision;

      behaviorAuthorityCharacterIdRef.current = null;
      if (!beginBehaviorPlaybackToken(behaviorPlaybackTokensRef, event.playbackToken)) return;
      if (projectionStatusRef.current === 'unavailable') {
        if (event.type === 'behavior-action') {
          settleBehaviorPlaybackToken(api, behaviorPlaybackTokensRef, {
            playbackToken: event.playbackToken,
            actionId: event.actionId,
            status: 'failed'
          });
        }
        return;
      }
      if (projectionStatusRef.current === 'loading') {
        const pending = pendingPlaybackActionRef.current;
        if (pending?.type === 'behavior-action') {
          settleBehaviorPlaybackToken(api, behaviorPlaybackTokensRef, {
            playbackToken: pending.playbackToken,
            actionId: pending.actionId,
            status: 'interrupted'
          });
        }
        pendingPlaybackActionRef.current = event;
        return;
      }
      consumePlaybackAction(event);
    });
    void api.getCharacterMotionSnapshot()
      .then(snapshot => {
        acceptSnapshot(snapshot);
        if (animationFrame === null) {
          animationFrame = scheduleAnimationFrame(renderMotion);
        }
      })
      .catch(() => {
        // 运动快照不可用不影响角色画面和聊天入口。
      });
    return () => {
      disposed = true;
      if (animationFrame !== null) cancelScheduledAnimationFrame(animationFrame);
      if (hostRef.current) hostRef.current.style.transform = '';
      if (playbackActionConsumerRef.current === consumePlaybackAction) {
        playbackActionConsumerRef.current = null;
      }
      unsubscribe();
    };
  }, [api, onDesktopAnchors, onIdleTrigger, onMotionChange]);

  return (
    <span
      className="character-player"
      data-status={status}
      aria-busy={status === 'loading'}
    >
      <span ref={hostRef} className="character-player-host" aria-hidden="true" />
      {status === 'error' ? fallback : null}
    </span>
  );
}

/** Renderer 只提交四边量化后的窗口局部整数矩形，不推导全局位置。 */
export function roundedWindowLocalRectangle(element: HTMLElement): {
  x: number; y: number; width: number; height: number;
} | null {
  try {
    const bounds = element.getBoundingClientRect();
    const layoutOrigin = windowLocalLayoutOrigin(element);
    const unroundedLeft = layoutOrigin?.x ?? bounds.left;
    const unroundedTop = layoutOrigin?.y ?? bounds.top;
    const left = Math.round(unroundedLeft);
    const top = Math.round(unroundedTop);
    const right = Math.round(unroundedLeft + bounds.width);
    const bottom = Math.round(unroundedTop + bounds.height);
    if (
      ![left, top, right, bottom].every(Number.isSafeInteger)
      || left < 0 || top < 0 || right <= left || bottom <= top
    ) return null;
    return { x: left, y: top, width: right - left, height: bottom - top };
  } catch {
    return null;
  }
}

/** offset 布局链不包含运动表现 transform，与窗口客户区坐标保持同一语义。 */
function windowLocalLayoutOrigin(
  element: HTMLElement
): Readonly<{ x: number; y: number }> | null {
  if (!element.offsetParent) return null;
  let x = 0;
  let y = 0;
  let current: HTMLElement | null = element;
  while (current) {
    x += current.offsetLeft;
    y += current.offsetTop;
    const parent: Element | null = current.offsetParent;
    current = parent instanceof HTMLElement ? parent : null;
  }
  const scrollX = Number.isFinite(window.scrollX) ? window.scrollX : 0;
  const scrollY = Number.isFinite(window.scrollY) ? window.scrollY : 0;
  return { x: x - scrollX, y: y - scrollY };
}

/**
 * 将浏览器客户区坐标转换为正式播放器容器局部坐标，并复用逐帧命中订阅。
 */
function createPlayerHitTestPort(
  player: CharacterPlayerPort,
  container: HTMLElement
): CharacterHitTestPort {
  return {
    kind: 'alpha',
    hitTest(point) {
      if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return false;
      try {
        const bounds = container.getBoundingClientRect();
        return player.hitTest({
          x: point.x - bounds.left,
          y: point.y - bounds.top
        });
      } catch {
        return false;
      }
    },
    subscribe(listener) {
      try {
        return player.subscribeHitRegion(listener);
      } catch {
        return () => undefined;
      }
    }
  };
}

export type CharacterBehaviorAuthorityMode = 'main-v2' | 'legacy-v1';

function reportActionFeedback(
  api: MyselfApi,
  feedback: Parameters<MyselfApi['reportCharacterActionFeedback']>[0]
): Promise<boolean> {
  if (typeof api.reportCharacterActionFeedback !== 'function') return Promise.resolve(false);
  return api.reportCharacterActionFeedback(feedback).then(() => true).catch(() => {
    // 生命周期回报失败不影响当前画面，Main 会继续按令牌超时规则收敛。
    return false;
  });
}

/** 每个令牌只允许一次终态，started 不会提前关闭后续自然完成回报。 */
function finishBehaviorPlayback(
  api: MyselfApi,
  playbackRef: { current: ActiveBehaviorPlayback | null },
  tokenStatesRef: { current: Map<string, BehaviorPlaybackTokenState> },
  status: CharacterPlaybackLifecycleEvent['status']
): void {
  const playback = playbackRef.current;
  if (!playback || playback.terminal) return;
  playback.terminal = true;
  settleBehaviorPlaybackToken(api, tokenStatesRef, {
    playbackToken: playback.playbackToken,
    actionId: playback.actionId,
    status
  });
}

/** 有界状态表同时拒绝活动令牌与已终态令牌的重复事件。 */
function beginBehaviorPlaybackToken(
  tokenStatesRef: { current: Map<string, BehaviorPlaybackTokenState> },
  playbackToken: string
): boolean {
  const states = tokenStatesRef.current;
  if (states.has(playbackToken)) return false;
  states.set(playbackToken, 'active');
  while (states.size > MAX_TRACKED_PLAYBACK_TOKENS) {
    const oldest = states.keys().next().value;
    if (oldest === undefined) break;
    states.delete(oldest);
  }
  return true;
}

function settleBehaviorPlaybackToken(
  api: MyselfApi,
  tokenStatesRef: { current: Map<string, BehaviorPlaybackTokenState> },
  feedback: Parameters<MyselfApi['reportCharacterActionFeedback']>[0]
): void {
  const states = tokenStatesRef.current;
  if (states.get(feedback.playbackToken) === 'terminal') return;
  states.set(feedback.playbackToken, 'terminal');
  reportActionFeedback(api, feedback);
}

/** 投影与消费器均就绪后，仅提交切换窗口内保留的最新播放动作。 */
function flushPendingPlaybackAction(
  projectionStatusRef: { current: CharacterProjectionStatus },
  pendingRef: { current: PlaybackActionEvent | null },
  consumerRef: { current: ((event: PlaybackActionEvent) => void) | null }
): void {
  const pending = pendingRef.current;
  const consumer = consumerRef.current;
  if (projectionStatusRef.current !== 'ready' || !pending || !consumer) return;
  pendingRef.current = null;
  consumer(pending);
}

/** 投影结束当前装载阶段时，V2 排队令牌通过统一终态路径结算。 */
function settlePendingPlaybackAction(
  api: MyselfApi,
  pendingRef: { current: PlaybackActionEvent | null },
  tokenStatesRef: { current: Map<string, BehaviorPlaybackTokenState> },
  status: CharacterPlaybackLifecycleEvent['status']
): void {
  const pending = pendingRef.current;
  if (!pending) return;
  pendingRef.current = null;
  if (pending.type !== 'behavior-action') return;
  settleBehaviorPlaybackToken(api, tokenStatesRef, {
    playbackToken: pending.playbackToken,
    actionId: pending.actionId,
    status
  });
}

function scheduleAnimationFrame(callback: FrameRequestCallback): number {
  if (typeof globalThis.requestAnimationFrame === 'function') {
    return globalThis.requestAnimationFrame(callback);
  }
  return globalThis.setTimeout(() => callback(performance.now()), 16) as unknown as number;
}

function cancelScheduledAnimationFrame(handle: number): void {
  if (typeof globalThis.cancelAnimationFrame === 'function') {
    globalThis.cancelAnimationFrame(handle);
    return;
  }
  clearTimeout(handle);
}

export function createRuntimeAssetLoader(api: MyselfApi): CharacterAssetLoader {
  return async (characterId, signal, context): Promise<CharacterAssetBundle> => {
    const expected = context?.snapshot;
    if (!expected || expected.activeCharacterId !== characterId) {
      throw new Error('CHARACTER_RUNTIME_CHANGED');
    }

    const expectedFingerprint = runtimeSnapshotFingerprint(expected);
    const atlasAssetIds = new Set(
      expected.manifest.states.flatMap(state => (
        state.actions.flatMap(action => action.frames.map(frame => frame.assetId))
      ))
    );
    const resources = expected.manifest.resources.filter(resource => (
      atlasAssetIds.has(resource.assetId)
    ));
    const urls = new Map<string, string>();

    try {
      for (const resource of resources) {
        throwIfAborted(signal);
        const bytes = await api.readCharacterRuntimeAsset(resource.assetId);
        throwIfAborted(signal);
        if (await sha256Hex(bytes) !== resource.sha256) {
          throw new Error('CHARACTER_RUNTIME_ASSET_HASH_MISMATCH');
        }
        const mimeType = resource.fileName.endsWith('.webp')
          ? 'image/webp'
          : 'image/png';
        const blob = new Blob([new Uint8Array(bytes).buffer], { type: mimeType });
        urls.set(resource.assetId, URL.createObjectURL(blob));
      }

      throwIfAborted(signal);
      const confirmed = await api.getCharacterRuntimeSnapshot();
      throwIfAborted(signal);
      if (!confirmed || runtimeSnapshotFingerprint(confirmed) !== expectedFingerprint) {
        throw new Error('CHARACTER_RUNTIME_CHANGED');
      }
      return { characterId, atlasUrls: urls };
    } catch (error) {
      for (const url of urls.values()) URL.revokeObjectURL(url);
      throw error;
    }
  };
}

export function runtimeSnapshotFingerprint(snapshot: CharacterRuntimeSnapshot): string {
  return stableSerialize({
    activeCharacterId: snapshot.activeCharacterId,
    manifest: snapshot.manifest,
    resourceHashes: snapshot.manifest.resources
      .map(resource => `${resource.assetId}:${resource.sha256}:${resource.byteLength}`)
      .sort()
  });
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', copy.buffer);
  return [...new Uint8Array(digest)]
    .map(value => value.toString(16).padStart(2, '0'))
    .join('');
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    throw new DOMException('已取消角色资源加载', 'AbortError');
  }
}

function isRuntimeChangedError(error: unknown): boolean {
  return error instanceof Error && (
    error.message === 'CHARACTER_RUNTIME_CHANGED'
    || error.message === 'CHARACTER_RUNTIME_ASSET_HASH_MISMATCH'
  );
}

function stableRuntimeErrorCode(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  return characterErrorCode(message);
}
