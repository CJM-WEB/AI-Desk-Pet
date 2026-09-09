import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import type {
  CharacterDraftV3,
  DraftActionClip,
  ResolvedCharacterPresentationV3
} from '@myself/character-runtime';
import { resolveCharacterPresentationV3 } from '@myself/character-runtime';
import type { MyselfApi } from '../../../../shared/myself-api';
import {
  createBrowserPixiCharacterScene,
  resolveDirectionalAnchor,
  type PixiCharacterScene
} from '../player/pixi-character-player';
import {
  DraftPreviewResourceCache,
  type DraftPreviewBundle
} from './draft-preview-resource-cache';
import type { PreviewState } from './PreviewControls';

export interface DraftCharacterPreviewProps {
  characterId: string | null;
  draft: CharacterDraftV3 | null;
  selectedSkinId: string | null;
  stateId: string | null;
  actionId: string | null;
  selectedFrameId: string | null;
  preview: PreviewState;
  api: Pick<MyselfApi, 'readCharacterSource'>;
  onFrameChange?(frameIndex: number): void;
  onPlayingChange?(playing: boolean): void;
}

type CharacterPresentationSource = ResolvedCharacterPresentationV3['source'];

type PreviewStatus = 'loading' | 'ready' | 'empty' | 'error';

type PreviewTarget = {
  stateId: string | null;
  action: DraftActionClip | null;
  source: CharacterPresentationSource | null;
  requestedActionId: string | null;
  emptyMessage: string | null;
  touring: boolean;
};

type AppliedPreview = {
  resourceKey: string;
  direction: 'left' | 'right';
  speed: number;
  frameIndex: number;
  motionMode: 'animated' | 'static';
  loop: boolean;
};

const ANCHOR_NAMES = ['ground', 'focus', 'carry', 'mouth', 'seat'] as const;

/** 将 V3 定义与皮肤表现组合成正式 Pixi 场景仍可复用的动作视图。 */
export function draftActionFromResolvedPresentation(
  resolved: ResolvedCharacterPresentationV3
): DraftActionClip {
  return {
    id: resolved.action.id,
    name: resolved.action.name,
    fps: resolved.presentation.fps,
    loop: resolved.action.loopPolicy !== 'never',
    weight: resolved.action.preference,
    direction: resolved.action.direction,
    anchors: resolved.presentation.anchors,
    ...(resolved.presentation.regions
      ? { regions: resolved.presentation.regions }
      : {}),
    ...(resolved.presentation.playbackRate === undefined
      ? {}
      : { playbackRate: resolved.presentation.playbackRate }),
    ...(resolved.presentation.mirrorX === undefined
      ? {}
      : { mirrorX: resolved.presentation.mirrorX }),
    frames: resolved.presentation.frames
  };
}

type ResolvedPreviewAction = {
  stateId: string;
  action: DraftActionClip;
  source: CharacterPresentationSource;
  requestedActionId: string;
};

function playableActions(
  draft: CharacterDraftV3 | null,
  skinId: string | null
): ResolvedPreviewAction[] {
  if (!draft || !skinId) return [];
  const result: ResolvedPreviewAction[] = [];
  for (const { stateId, requestedActionId } of draft.states.flatMap(state => state.actionIds.map(requestedActionId => ({ stateId: state.id, requestedActionId })))) {
    const resolved = resolveCharacterPresentationV3(draft, skinId, stateId, requestedActionId);
    if (!resolved) continue;
    result.push({
      stateId,
      action: draftActionFromResolvedPresentation(resolved),
      source: resolved.source,
      requestedActionId
    });
  }
  return result;
}

function invalidFrameRectangle(action: DraftActionClip): boolean {
  return action.frames.some(frame => (
    !Number.isInteger(frame.x)
    || !Number.isInteger(frame.y)
    || !Number.isInteger(frame.width)
    || !Number.isInteger(frame.height)
    || frame.x < 0
    || frame.y < 0
    || frame.width <= 0
    || frame.height <= 0
  ));
}

function stableTarget(
  props: DraftCharacterPreviewProps,
  touringAction: ResolvedPreviewAction | null
): PreviewTarget {
  if (!props.characterId || !props.draft) {
    return {
      stateId: props.stateId,
      action: null,
      source: null,
      requestedActionId: null,
      emptyMessage: '请选择角色',
      touring: false
    };
  }
  if (!props.selectedSkinId || !props.actionId) {
    return {
      stateId: props.stateId,
      action: null,
      source: null,
      requestedActionId: null,
      emptyMessage: '请选择动作',
      touring: false
    };
  }
  const resolved = props.preview.tourAllStates
    ? touringAction
    : (() => {
        const selected = resolveCharacterPresentationV3(
          props.draft!,
          props.selectedSkinId!,
          props.stateId ?? '',
          props.actionId!
        );
        return selected ? {
          stateId: selected.stateId,
          action: draftActionFromResolvedPresentation(selected),
          source: selected.source,
          requestedActionId: props.actionId!
        } : null;
      })();
  if (!resolved) {
    return {
      stateId: props.stateId,
      action: null,
      source: null,
      requestedActionId: props.actionId,
      emptyMessage: '无可播放表现',
      touring: false
    };
  }
  const action = resolved.action;
  if (action.frames.length === 0) {
    return {
      stateId: props.stateId,
      action: null,
      source: null,
      requestedActionId: resolved.requestedActionId,
      emptyMessage: '当前动作没有可预览帧',
      touring: false
    };
  }
  if (invalidFrameRectangle(action)) {
    return {
      stateId: props.stateId,
      action: null,
      source: null,
      requestedActionId: resolved.requestedActionId,
      emptyMessage: '当前帧矩形无效',
      touring: false
    };
  }
  return {
    stateId: resolved.stateId,
    action,
    source: resolved.source,
    requestedActionId: resolved.requestedActionId,
    emptyMessage: null,
    touring: props.preview.tourAllStates
  };
}

const PRESENTATION_SOURCE_MESSAGE: Record<CharacterPresentationSource, string> = {
  'skin-action': '当前使用：当前皮肤精确表现',
  'default-action': '当前使用：默认皮肤同一动作'
};

function actionDurationMs(action: DraftActionClip, speed: number): number {
  const frameDuration = 1_000 / Math.max(1, action.fps);
  return action.frames.reduce(
    (total, frame) => total + (frame.durationMs ?? frameDuration),
    0
  ) / speed;
}

function normalizedFrameIndex(action: DraftActionClip, frameIndex: number): number {
  return Math.min(
    action.frames.length - 1,
    Math.max(0, Math.floor(frameIndex))
  );
}

function normalizedSpeed(speed: number): number {
  return Math.min(2, Math.max(0.25, speed));
}

function applyPreviewToScene(
  scene: PixiCharacterScene,
  action: DraftActionClip,
  resourceKey: string,
  preview: PreviewState,
  motionPaused: boolean,
  touring: boolean,
  preserveCurrentFrame: boolean
): AppliedPreview {
  const current = preserveCurrentFrame
    ? scene.getCurrentFrame()?.frameIndex
    : undefined;
  const frameIndex = normalizedFrameIndex(
    action,
    current ?? preview.frameIndex
  );
  const speed = normalizedSpeed(preview.speed);
  const applied: AppliedPreview = {
    resourceKey,
    direction: preview.direction,
    speed,
    frameIndex,
    motionMode: preview.playing && !motionPaused ? 'animated' : 'static',
    loop: touring ? false : preview.loop
  };
  scene.showAction(action, {
    direction: applied.direction,
    speed: applied.speed,
    frameIndex: applied.frameIndex,
    motionMode: applied.motionMode,
    loop: applied.loop
  });
  return applied;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/**
 * 环境门：页面隐藏或系统要求减少动态时，只暂停连续播放。
 */
function useContinuousMotionPaused(): boolean {
  const [hidden, setHidden] = useState(
    () => typeof document !== 'undefined'
      && document.visibilityState === 'hidden'
  );
  const [reduced, setReduced] = useState(() => (
    typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ));

  useEffect(() => {
    const handleVisibility = (): void => {
      setHidden(document.visibilityState === 'hidden');
    };
    document.addEventListener('visibilitychange', handleVisibility);
    return () => document.removeEventListener(
      'visibilitychange',
      handleVisibility
    );
  }, []);

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handleChange = (event: MediaQueryListEvent): void => {
      setReduced(event.matches);
    };
    setReduced(media.matches);
    media.addEventListener('change', handleChange);
    return () => media.removeEventListener('change', handleChange);
  }, []);

  return hidden || reduced;
}

/**
 * 草稿预览编排器：资源由引用计数缓存管理，渲染始终复用正式 Pixi 场景。
 */
export function DraftCharacterPreview(props: DraftCharacterPreviewProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<PixiCharacterScene | null>(null);
  const cacheRef = useRef<DraftPreviewResourceCache | null>(null);
  const activeBundleRef = useRef<DraftPreviewBundle | null>(null);
  const loadRevisionRef = useRef(0);
  const previewRef = useRef(props.preview);
  previewRef.current = props.preview;
  const motionPausedRef = useRef(false);
  const frameChangeRef = useRef(props.onFrameChange);
  frameChangeRef.current = props.onFrameChange;
  const playingChangeRef = useRef(props.onPlayingChange);
  playingChangeRef.current = props.onPlayingChange;
  const appliedRef = useRef<AppliedPreview | null>(null);
  const previousPlayingRef = useRef(props.preview.playing);
  const touringRef = useRef(false);
  const requestedFrameRef = useRef(props.preview.frameIndex);
  const previousSelectionIdentityRef = useRef<string | null>(null);

  const [sceneRevision, setSceneRevision] = useState(0);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [status, setStatus] = useState<PreviewStatus>('loading');
  const [message, setMessage] = useState('正在初始化预览');
  const [, setFrameRevision] = useState(0);
  const [tourIndex, setTourIndex] = useState(0);
  const [tourEnded, setTourEnded] = useState(false);
  const [appliedPreview, setAppliedPreview] = useState<AppliedPreview | null>(
    null
  );
  const continuousMotionPaused = useContinuousMotionPaused();
  motionPausedRef.current = continuousMotionPaused;

  const tourActions = useMemo(
    () => playableActions(props.draft, props.selectedSkinId),
    [props.draft, props.selectedSkinId]
  );
  const tourOrderKey = useMemo(
    () => tourActions.map(item => (
      `${item.stateId}\u0000${item.requestedActionId}\u0000${item.action.id}\u0000${item.source}`
    )).join('\u0001'),
    [tourActions]
  );
  const touringAction = props.preview.tourAllStates
    ? tourActions[tourIndex] ?? null
    : null;
  const target = useMemo(() => stableTarget(props, touringAction), [
    props.actionId,
    props.stateId,
    props.characterId,
    props.draft,
    props.preview.tourAllStates,
    props.selectedSkinId,
    touringAction
  ]);
  touringRef.current = target.touring;
  const resourceKey = target.action
    ? JSON.stringify([
        props.characterId,
        props.selectedSkinId,
        target.source,
        target.action
      ])
    : null;
  const selectionIdentity = JSON.stringify([
    props.characterId,
    props.draft?.id ?? null,
    props.selectedSkinId,
    props.stateId,
    target.stateId,
    target.requestedActionId ?? props.actionId,
    target.action?.id ?? null,
    target.source
  ]);

  useEffect(() => {
    setTourIndex(0);
    setTourEnded(false);
  }, [props.preview.tourAllStates, tourOrderKey]);

  useEffect(() => {
    const rising = props.preview.playing && !previousPlayingRef.current;
    previousPlayingRef.current = props.preview.playing;
    if (target.touring && tourEnded && rising) {
      setTourIndex(0);
      setTourEnded(false);
    }
  }, [props.preview.playing, target.touring, tourEnded]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const cache = new DraftPreviewResourceCache(props.api);
    cacheRef.current = cache;
    let active = true;
    let scene: PixiCharacterScene | null = null;
    let unsubscribeFrame: (() => void) | null = null;
    let resizeObserver: ResizeObserver | null = null;

    void createBrowserPixiCharacterScene(container).then(createdScene => {
      if (!active) {
        createdScene.destroy();
        return;
      }
      scene = createdScene;
      sceneRef.current = createdScene;
      unsubscribeFrame = createdScene.subscribeFrame(() => {
        const frameIndex = createdScene.getCurrentFrame()?.frameIndex;
        if (frameIndex !== undefined) {
          if (appliedRef.current) {
            appliedRef.current = { ...appliedRef.current, frameIndex };
          }
          if (!touringRef.current) {
            frameChangeRef.current?.(frameIndex);
          }
        }
        setFrameRevision(revision => revision + 1);
      });
      if (
        createdScene.resize
        && typeof ResizeObserver !== 'undefined'
      ) {
        resizeObserver = new ResizeObserver(entries => {
          const bounds = entries[0]?.contentRect;
          if (bounds) createdScene.resize?.(bounds.width, bounds.height);
        });
        resizeObserver.observe(container);
      }
      setSceneRevision(revision => revision + 1);
    }).catch(() => {
      if (!active) return;
      setStatus('error');
      setMessage('预览场景初始化失败');
    });

    return () => {
      active = false;
      ++loadRevisionRef.current;
      resizeObserver?.disconnect();
      unsubscribeFrame?.();
      activeBundleRef.current?.release();
      activeBundleRef.current = null;
      cache.destroy();
      if (cacheRef.current === cache) cacheRef.current = null;
      scene?.destroy();
      appliedRef.current = null;
      if (sceneRef.current === scene) sceneRef.current = null;
    };
  }, [props.api]);

  useLayoutEffect(() => {
    const scene = sceneRef.current;
    const cache = cacheRef.current;
    const revision = ++loadRevisionRef.current;
    const abort = new AbortController();

    if (!scene || !cache) return () => abort.abort();

    const identityChanged = previousSelectionIdentityRef.current
      !== selectionIdentity;
    previousSelectionIdentityRef.current = selectionIdentity;
    if (identityChanged || !target.action) scene.clear();
    if (identityChanged) {
      activeBundleRef.current?.release();
      activeBundleRef.current = null;
    }

    if (!target.action || !resourceKey || !props.characterId) {
      setLoadedKey(null);
      appliedRef.current = null;
      setAppliedPreview(null);
      setStatus('empty');
      setMessage(target.emptyMessage ?? '请选择动作');
      activeBundleRef.current?.release();
      activeBundleRef.current = null;
      void scene.loadAssets(new Map()).catch(() => undefined);
      return () => abort.abort();
    }

    const action = target.action;
    const assetIds = [...new Set(action.frames.map(frame => frame.assetId))];
    setLoadedKey(null);
    setStatus('loading');
    setMessage('正在加载预览素材');

    void cache.load(
      props.characterId,
      assetIds,
      abort.signal
    ).then(async bundle => {
      if (revision !== loadRevisionRef.current) {
        bundle.release();
        return;
      }
      try {
        await scene.loadAssets(bundle.urls);
      } catch (error) {
        bundle.release();
        throw error;
      }
      if (revision !== loadRevisionRef.current) {
        bundle.release();
        return;
      }
      let applied: AppliedPreview;
      try {
        applied = applyPreviewToScene(
          scene,
          action,
          resourceKey,
          previewRef.current,
          motionPausedRef.current,
          target.touring,
          false
        );
      } catch {
        const previousBundle = activeBundleRef.current;
        activeBundleRef.current = null;
        previousBundle?.release();
        bundle.release();
        scene.clear();
        appliedRef.current = null;
        setAppliedPreview(null);
        setLoadedKey(null);
        setStatus('error');
        setMessage('预览渲染失败');
        return;
      }
      activeBundleRef.current?.release();
      activeBundleRef.current = bundle;
      appliedRef.current = applied;
      setAppliedPreview(applied);
      setLoadedKey(resourceKey);
      setStatus('ready');
      setMessage('预览已就绪');
      setFrameRevision(current => current + 1);
    }).catch(error => {
      if (isAbortError(error) || revision !== loadRevisionRef.current) return;
      activeBundleRef.current?.release();
      activeBundleRef.current = null;
      scene.clear();
      appliedRef.current = null;
      setAppliedPreview(null);
      setLoadedKey(null);
      setStatus('error');
      setMessage('预览素材读取失败');
      void scene.loadAssets(new Map()).catch(() => undefined);
    });

    return () => abort.abort();
  }, [
    props.characterId,
    props.api,
    resourceKey,
    sceneRevision,
    selectionIdentity,
    target.action,
    target.emptyMessage
  ]);

  useEffect(() => {
    const scene = sceneRef.current;
    const action = target.action;
    if (
      !scene
      || !action
      || !resourceKey
      || loadedKey !== resourceKey
      || status !== 'ready'
    ) {
      return;
    }
    const speed = normalizedSpeed(props.preview.speed);
    const motionMode = props.preview.playing && !continuousMotionPaused
      ? 'animated'
      : 'static';
    const loop = target.touring ? false : props.preview.loop;
    const requestedFrame = normalizedFrameIndex(
      action,
      props.preview.frameIndex
    );
    const frameRequestChanged = requestedFrameRef.current !== requestedFrame;
    requestedFrameRef.current = requestedFrame;
    const applied = appliedRef.current;
    const sameControls = applied?.resourceKey === resourceKey
      && applied.direction === props.preview.direction
      && applied.speed === speed
      && applied.motionMode === motionMode
      && applied.loop === loop;
    if (sameControls && applied?.frameIndex === requestedFrame) return;
    const preserveTourFrame = !frameRequestChanged
      && target.touring
      && applied?.resourceKey === resourceKey
      && (
        props.preview.playing
        || applied.motionMode === 'animated'
      );
    const preserveCurrentFrame = requestedFrame === applied?.frameIndex
      || preserveTourFrame;
    try {
      const nextApplied = applyPreviewToScene(
        scene,
        action,
        resourceKey,
        props.preview,
        continuousMotionPaused,
        target.touring,
        preserveCurrentFrame
      );
      appliedRef.current = nextApplied;
      setAppliedPreview(nextApplied);
      setStatus('ready');
      setMessage('预览已就绪');
      setFrameRevision(revision => revision + 1);
    } catch {
      scene.clear();
      setStatus('error');
      setMessage('预览渲染失败');
    }
  }, [
    continuousMotionPaused,
    loadedKey,
    props.preview.direction,
    props.preview.frameIndex,
    props.preview.loop,
    props.preview.playing,
    props.preview.speed,
    resourceKey,
    status,
    target.action,
    target.touring
  ]);

  useEffect(() => {
    if (
      !target.touring
      || !target.action
      || !props.preview.playing
      || continuousMotionPaused
      || status !== 'ready'
      || tourEnded
    ) {
      return;
    }
    const speed = Math.min(2, Math.max(0.25, props.preview.speed));
    const timer = window.setTimeout(() => {
      if (tourIndex + 1 < tourActions.length) {
        setTourIndex(tourIndex + 1);
        return;
      }
      if (props.preview.loop && tourActions.length > 0) {
        setTourIndex(0);
        return;
      }
      setTourEnded(true);
      playingChangeRef.current?.(false);
    }, actionDurationMs(target.action, speed));
    return () => window.clearTimeout(timer);
  }, [
    continuousMotionPaused,
    props.preview.loop,
    props.preview.playing,
    props.preview.speed,
    status,
    target.action,
    target.touring,
    tourActions.length,
    tourEnded,
    tourIndex
  ]);

  const currentFrame = sceneRef.current?.getCurrentFrame() ?? null;
  const currentSourceFrame = currentFrame?.action.frames[
    currentFrame.frameIndex
  ];
  const anchors = currentFrame ? {
    ...currentFrame.action.anchors,
    ...currentSourceFrame?.anchors
  } : null;
  const renderedStatus = target.emptyMessage
    ? 'empty'
    : status === 'error'
      ? 'error'
      : appliedPreview?.resourceKey !== resourceKey
        ? 'loading'
        : status;
  const renderedMessage = target.emptyMessage ?? message;
  const renderedDirection = appliedPreview?.direction ?? 'right';
  const renderedSpeed = appliedPreview?.speed
    ?? normalizedSpeed(props.preview.speed);

  return (
    <div
      ref={containerRef}
      className={[
        'draft-character-preview',
        props.preview.darkBackground
          ? 'draft-character-preview--dark'
          : ''
      ].filter(Boolean).join(' ')}
      data-testid="draft-character-preview"
      data-preview-status={renderedStatus}
      data-preview-direction={renderedDirection}
      data-preview-speed={String(renderedSpeed)}
      aria-label="草稿角色预览"
    >
      <p className="draft-preview-status" aria-live="polite">
        {renderedMessage}
      </p>
      {renderedStatus === 'ready' && target.source ? (
        <p className="draft-preview-source" aria-live="polite">
          {PRESENTATION_SOURCE_MESSAGE[target.source]}
        </p>
      ) : null}
      {props.preview.showAnchors && currentFrame && anchors
        ? ANCHOR_NAMES.map(name => {
          const anchor = anchors[name];
          if (!anchor) return null;
          const directional = resolveDirectionalAnchor(
            anchor,
            renderedDirection
          );
          const position = {
            left: `${currentFrame.bounds.x
              + directional.x * currentFrame.bounds.width}px`,
            top: `${currentFrame.bounds.y
              + directional.y * currentFrame.bounds.height}px`
          };
          return (
            <span
              key={name}
              className={`draft-preview-anchor draft-preview-anchor--${name}`}
              aria-label={`锚点 ${name}`}
              style={position}
            />
          );
        })
        : null}
      {props.preview.mountedFile && currentFrame && anchors?.carry
        ? (() => {
          const carry = resolveDirectionalAnchor(
            anchors.carry,
            renderedDirection
          );
          return (
            <span
              className="draft-preview-mounted-file"
              aria-label="模拟挂载文件"
              style={{
                left: `${currentFrame.bounds.x
                  + carry.x * currentFrame.bounds.width}px`,
                top: `${currentFrame.bounds.y
                  + carry.y * currentFrame.bounds.height}px`
              }}
            >
              📄
            </span>
          );
        })()
        : null}
    </div>
  );
}
