import type {
  ActionClip,
  ActionSelectionResult,
  AnchorPoint,
  AnchorSet,
  CharacterManifestV1,
  CharacterMotionMode,
  DraftActionClip
} from '@myself/character-runtime';
import type { CharacterAssetBundle } from './character-resource-cache';
import {
  hitTestCharacterAlpha,
  type AlphaMask,
  type CharacterHitSnapshot
} from './character-alpha-hit-tester';

export interface CharacterPlayerPort {
  load(manifest: CharacterManifestV1, assets: CharacterAssetBundle): Promise<void>;
  play(selection: ActionSelectionResult, motionMode: CharacterMotionMode): number | void;
  setMotionMode?(motionMode: CharacterMotionMode): void;
  setDirection(direction: 'left' | 'right'): void;
  getAnchor(name: keyof AnchorSet): AnchorPoint | null;
  getFrameBounds?(): { x: number; y: number; width: number; height: number } | null;
  hitTest(point: { x: number; y: number }, threshold?: number): boolean;
  subscribeHitRegion(listener: () => void): () => void;
  subscribeFrame?(listener: (frameId: string | null) => void): () => void;
  subscribePlaybackLifecycle?(
    listener: (event: CharacterPlaybackLifecycleEvent) => void
  ): () => void;
  resize?(width: number, height: number): void;
  destroy(): void;
}

export type CharacterPlaybackLifecycleEvent = {
  playbackId: number;
  actionId: string;
  status: 'completed' | 'interrupted' | 'failed';
};

export type CharacterVisualAssets = ReadonlyMap<string, string>;

/**
 * 共享边界：工作台与运行时均通过此接口复用同一条 Pixi 渲染链路。
 */
export interface PixiCharacterScene {
  loadAssets(assets: CharacterVisualAssets): Promise<void>;
  clear(): void;
  showAction(
    action: ActionClip | DraftActionClip,
    options: {
      direction: 'left' | 'right';
      motionMode: CharacterMotionMode;
      frameIndex?: number;
      speed: number;
      loop: boolean;
    }
  ): void;
  getCurrentFrame(): {
    action: ActionClip | DraftActionClip;
    frameIndex: number;
    bounds: { x: number; y: number; width: number; height: number };
  } | null;
  getHitSnapshot?(): CharacterHitSnapshot | null;
  subscribeFrame(listener: () => void): () => void;
  subscribeActionComplete?(listener: () => void): () => void;
  resize?(width: number, height: number): void;
  destroy(): void;
}

/**
 * 兼容边界：旧播放器端口的场景替身与运行时实现仍可被适配器接收。
 */
type LegacyPixiCharacterScene = {
  load(manifest: CharacterManifestV1, assets: CharacterAssetBundle): Promise<void>;
  show(selection: ActionSelectionResult, motionMode: CharacterMotionMode): void;
  setDirection(direction: 'left' | 'right'): void;
  getAnchor(name: keyof AnchorSet): AnchorPoint | null;
  getFrameBounds?(): { x: number; y: number; width: number; height: number } | null;
  stop(): void;
  destroy(): void;
  isTickerRunning(): boolean;
};

export class PixiCharacterPlayer implements CharacterPlayerPort {
  private destroyed = false;
  private direction: 'left' | 'right' = 'right';
  private currentSelection: ActionSelectionResult | null = null;
  private currentMotionMode: CharacterMotionMode | null = null;
  private nextPlaybackId = 0;
  private activePlayback: {
    playbackId: number;
    actionId: string;
    loop: boolean;
  } | null = null;
  private readonly hitRegionListeners = new Set<() => void>();
  private readonly frameListeners = new Set<(frameId: string | null) => void>();
  private readonly playbackLifecycleListeners = new Set<
    (event: CharacterPlaybackLifecycleEvent) => void
  >();
  private readonly unsubscribeSceneFrame: (() => void) | null;
  private readonly unsubscribeSceneComplete: (() => void) | null;

  constructor(private readonly scene: PixiCharacterScene | LegacyPixiCharacterScene) {
    this.unsubscribeSceneFrame = isLegacyScene(scene)
      ? null
      : scene.subscribeFrame(() => {
          this.notifyHitRegion();
          this.notifyFrame();
        });
    this.unsubscribeSceneComplete = isLegacyScene(scene)
      ? null
      : scene.subscribeActionComplete?.(() => this.completeActivePlayback()) ?? null;
  }

  static async create(
    container: HTMLElement,
    sceneFactory: PixiCharacterSceneFactory = createBrowserPixiCharacterScene
  ): Promise<PixiCharacterPlayer> {
    return new PixiCharacterPlayer(await sceneFactory(container));
  }

  load(manifest: CharacterManifestV1, assets: CharacterAssetBundle): Promise<void> {
    if (isLegacyScene(this.scene)) return this.scene.load(manifest, assets);
    const actionAssetIds = new Set(
      manifest.states.flatMap(state => (
        state.actions.flatMap(action => action.frames.map(frame => frame.assetId))
      ))
    );
    for (const assetId of actionAssetIds) {
      if (!assets.atlasUrls.has(assetId)) {
        return Promise.reject(new Error('CHARACTER_RUNTIME_ASSET_MISSING'));
      }
    }
    const visualAssets = new Map<string, string>();
    for (const [assetId, url] of assets.atlasUrls) {
      if (actionAssetIds.has(assetId)) visualAssets.set(assetId, url);
    }
    return this.scene.loadAssets(visualAssets).then(() => this.notifyHitRegion());
  }

  play(selection: ActionSelectionResult, motionMode: CharacterMotionMode): number {
    this.finishActivePlayback('interrupted');
    const playbackId = ++this.nextPlaybackId;
    this.activePlayback = {
      playbackId,
      actionId: selection.action.id,
      loop: selection.action.loop
    };
    this.currentSelection = selection;
    this.currentMotionMode = motionMode;
    try {
      if (isLegacyScene(this.scene)) {
        this.scene.show(selection, motionMode);
      } else {
        this.scene.showAction(
          selection.action,
          resolvePublishedPlaybackOptions(selection.action, this.direction, motionMode)
        );
        this.notifyHitRegion();
        // AnimatedSprite 首帧可能不会触发 onFrameChange，展示成功后显式发布当前稳定帧。
        this.notifyFrame();
      }
    } catch (error) {
      this.finishActivePlayback('failed');
      throw error;
    }
    return playbackId;
  }

  setDirection(direction: 'left' | 'right'): void {
    const changed = this.direction !== direction;
    this.direction = direction;
    if (isLegacyScene(this.scene)) {
      this.scene.setDirection(direction);
      return;
    }
    // 终态动作仅保留只读快照供锚点查询，不能再通过方向切换恢复播放。
    if (!changed || !this.activePlayback || !this.currentSelection || !this.currentMotionMode) return;
    const frameIndex = this.scene.getCurrentFrame()?.frameIndex;
    try {
      this.scene.showAction(
        this.currentSelection.action,
        resolvePublishedPlaybackOptions(
          this.currentSelection.action,
          direction,
          this.currentMotionMode,
          frameIndex
        )
      );
      this.notifyHitRegion();
    } catch (error) {
      // 方向重建失败即终结当前播放；播放器仍保留调用方提交的新方向。
      this.finishActivePlayback('failed');
      throw error;
    }
  }

  /** 切换静态播放时复用当前动作与帧，避免拖拽打断 Main 已裁决的播放令牌。 */
  setMotionMode(motionMode: CharacterMotionMode): void {
    if (
      this.destroyed
      || isLegacyScene(this.scene)
      || this.currentMotionMode === motionMode
      || !this.activePlayback
      || !this.currentSelection
    ) return;
    const frameIndex = this.scene.getCurrentFrame()?.frameIndex;
    this.currentMotionMode = motionMode;
    try {
      this.scene.showAction(
        this.currentSelection.action,
        resolvePublishedPlaybackOptions(
          this.currentSelection.action,
          this.direction,
          motionMode,
          frameIndex
        )
      );
      this.notifyHitRegion();
      this.notifyFrame();
    } catch (error) {
      this.finishActivePlayback('failed');
      throw error;
    }
  }

  getAnchor(name: keyof AnchorSet): AnchorPoint | null {
    if (isLegacyScene(this.scene)) return this.scene.getAnchor(name);
    const currentFrame = this.scene.getCurrentFrame();
    const action = currentFrame?.action ?? this.currentSelection?.action;
    if (!action) return null;
    const frameAnchor = currentFrame
      ? action.frames[currentFrame.frameIndex]?.anchors?.[name]
      : undefined;
    const anchor = frameAnchor ?? action.anchors[name] ?? null;
    return anchor
      ? resolveDirectionalAnchor(anchor, resolveEffectiveDirection(action, this.direction))
      : null;
  }

  getFrameBounds() {
    if (isLegacyScene(this.scene)) return this.scene.getFrameBounds?.() ?? null;
    return this.scene.getCurrentFrame()?.bounds ?? null;
  }

  /** 仅复用正式场景已生成的快照；旧场景或掩码不可用时默认穿透。 */
  hitTest(point: { x: number; y: number }, threshold?: number): boolean {
    if (this.destroyed || isLegacyScene(this.scene) || !this.scene.getHitSnapshot) return false;
    return hitTestCharacterAlpha(this.scene.getHitSnapshot(), point, threshold);
  }

  /** 订阅动作、帧、方向及资源变化后的命中区域更新。 */
  subscribeHitRegion(listener: () => void): () => void {
    if (this.destroyed) return () => undefined;
    this.hitRegionListeners.add(listener);
    return () => this.hitRegionListeners.delete(listener);
  }

  /** 只发布清单中的稳定帧 ID，不把 Pixi 数组索引扩散到 Renderer 业务层。 */
  subscribeFrame(listener: (frameId: string | null) => void): () => void {
    if (this.destroyed) return () => undefined;
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  /** 生命周期订阅只暴露播放编号、动作标识与收敛状态。 */
  subscribePlaybackLifecycle(
    listener: (event: CharacterPlaybackLifecycleEvent) => void
  ): () => void {
    if (this.destroyed) return () => undefined;
    this.playbackLifecycleListeners.add(listener);
    return () => this.playbackLifecycleListeners.delete(listener);
  }

  isTickerRunning(): boolean {
    if (isLegacyScene(this.scene)) return this.scene.isTickerRunning();
    return hasTickerState(this.scene) && this.scene.isTickerRunning();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.finishActivePlayback('interrupted');
    this.destroyed = true;
    this.unsubscribeSceneFrame?.();
    this.unsubscribeSceneComplete?.();
    this.hitRegionListeners.clear();
    this.frameListeners.clear();
    this.playbackLifecycleListeners.clear();
    if (isLegacyScene(this.scene)) {
      try {
        this.scene.stop();
      } finally {
        this.scene.destroy();
      }
      return;
    }
    this.scene.destroy();
  }

  private notifyHitRegion(): void {
    if (this.destroyed) return;
    for (const listener of this.hitRegionListeners) listener();
  }

  resize(width: number, height: number): void {
    if (this.destroyed || isLegacyScene(this.scene)) return;
    this.scene.resize?.(width, height);
    this.notifyHitRegion();
  }

  private notifyFrame(): void {
    if (this.destroyed || isLegacyScene(this.scene)) return;
    const current = this.scene.getCurrentFrame();
    const frameId = current?.action.frames[current.frameIndex]?.id ?? null;
    for (const listener of this.frameListeners) listener(frameId);
  }

  private completeActivePlayback(): void {
    if (this.activePlayback?.loop) return;
    this.finishActivePlayback('completed');
  }

  private finishActivePlayback(
    status: CharacterPlaybackLifecycleEvent['status']
  ): void {
    const playback = this.activePlayback;
    if (!playback) return;
    this.activePlayback = null;
    const event: CharacterPlaybackLifecycleEvent = {
      playbackId: playback.playbackId,
      actionId: playback.actionId,
      status
    };
    for (const listener of this.playbackLifecycleListeners) listener(event);
  }
}

/**
 * 正式播放入口统一在此解析发布表现，避免首次播放与方向重建出现不同的画面语义。
 */
function resolvePublishedPlaybackOptions(
  action: ActionClip,
  motionDirection: 'left' | 'right',
  motionMode: CharacterMotionMode,
  frameIndex?: number
): Parameters<PixiCharacterScene['showAction']>[1] {
  return {
    direction: resolveEffectiveDirection(action, motionDirection),
    motionMode,
    ...(frameIndex === undefined ? {} : { frameIndex }),
    speed: action.playbackRate ?? 1,
    loop: action.loop
  };
}

function resolveEffectiveDirection(
  action: Pick<ActionClip, 'mirrorX'>,
  motionDirection: 'left' | 'right'
): 'left' | 'right' {
  if (!action.mirrorX) return motionDirection;
  return motionDirection === 'left' ? 'right' : 'left';
}

type PixiModule = typeof import('pixi.js');
type PixiApplication = InstanceType<PixiModule['Application']>;
type PixiTexture = InstanceType<PixiModule['Texture']>;
type PixiAnimatedSprite = InstanceType<PixiModule['AnimatedSprite']>;
export type PixiCharacterSceneFactory = (container: HTMLElement) => Promise<PixiCharacterScene>;
export type PixiModuleLoader = () => Promise<PixiModule>;

export type CharacterFrameFit = {
  scale: number;
  x: number;
  y: number;
  width: number;
  height: number;
};

export function resolveDirectionalAnchor(
  anchor: AnchorPoint,
  direction: 'left' | 'right'
): AnchorPoint {
  return direction === 'left'
    ? { x: 1 - anchor.x, y: anchor.y }
    : anchor;
}

/**
 * 适配判定：运行时旧端口以 load 方法为特征，避免要求既有调用方同步迁移。
 */
function isLegacyScene(
  scene: PixiCharacterScene | LegacyPixiCharacterScene
): scene is LegacyPixiCharacterScene {
  return 'load' in scene;
}

/**
 * 内部能力：不扩展共享公开接口，同时保留旧播放器的 ticker 状态查询。
 */
function hasTickerState(
  scene: PixiCharacterScene
): scene is PixiCharacterScene & { isTickerRunning(): boolean } {
  return 'isTickerRunning' in scene && typeof scene.isTickerRunning === 'function';
}

/**
 * 使用动作最大帧包围盒求统一缩放，避免播放时尺寸变化或越出画布。
 */
export function fitCharacterFrames(
  frames: readonly { width: number; height: number }[],
  screen: { width: number; height: number },
  ground: AnchorPoint
): CharacterFrameFit {
  const width = Math.max(1, ...frames.map(frame => frame.width));
  const height = Math.max(1, ...frames.map(frame => frame.height));
  const scale = Math.min(screen.width / width, screen.height / height);
  const scaledWidth = width * scale;
  const scaledHeight = height * scale;
  const minimumX = scaledWidth * ground.x;
  const maximumX = screen.width - scaledWidth * (1 - ground.x);
  const minimumY = scaledHeight * ground.y;
  const maximumY = screen.height - scaledHeight * (1 - ground.y);

  return {
    scale,
    x: clamp(screen.width / 2, minimumX, maximumX),
    y: clamp(screen.height, minimumY, maximumY),
    width,
    height
  };
}

/**
 * 浏览器实现只接收白名单 API 生成的 Blob URL，不解析或读取文件系统路径。
 */
class BrowserPixiCharacterScene implements PixiCharacterScene {
  private readonly baseTextures = new Map<string, PixiTexture>();
  private readonly alphaMasks = new Map<string, AlphaMask>();
  private frameTextures: PixiTexture[] = [];
  private sprite: PixiAnimatedSprite | null = null;
  private action: ActionClip | DraftActionClip | null = null;
  private direction: 'left' | 'right' = 'right';
  private loadRevision = 0;
  private destroyed = false;
  private readonly frameListeners = new Set<() => void>();
  private readonly actionCompleteListeners = new Set<() => void>();

  private constructor(
    private readonly pixi: PixiModule,
    private readonly application: PixiApplication
  ) {}

  static async initialize(
    container: HTMLElement,
    pixi: PixiModule,
    application: PixiApplication
  ): Promise<BrowserPixiCharacterScene> {
    const size = measureContainer(container);
    await application.init({
      width: size.width,
      height: size.height,
      backgroundAlpha: 0,
      antialias: true,
      autoStart: false,
      preference: 'webgl'
    });
    application.ticker.stop();
    container.appendChild(application.canvas);
    return new BrowserPixiCharacterScene(pixi, application);
  }

  async loadAssets(assets: CharacterVisualAssets): Promise<void> {
    const revision = ++this.loadRevision;
    const entries: Array<{ assetId: string; texture: PixiTexture; mask: AlphaMask | null }> = [];
    try {
      for (const [assetId, url] of assets) {
        const image = await loadImage(url);
        const texture = this.pixi.Texture.from(image, true);
        entries.push({ assetId, texture, mask: extractAlphaMask(image) });
      }
    } catch (error) {
      for (const { texture } of entries) texture.destroy(true);
      throw error;
    }

    if (this.destroyed || revision !== this.loadRevision) {
      for (const { texture } of entries) texture.destroy(true);
      return;
    }

    this.releaseAnimation();
    this.releaseBaseTextures();
    this.alphaMasks.clear();
    for (const { assetId, texture, mask } of entries) {
      this.baseTextures.set(assetId, texture);
      if (mask) this.alphaMasks.set(assetId, mask);
    }
  }

  /** 清除当前动作，保留应用和已加载的基础纹理供下一次预览复用。 */
  clear(): void {
    if (this.destroyed) return;
    this.releaseAnimation();
    this.application.render();
    this.notifyFrameListeners();
  }

  showAction(
    action: ActionClip | DraftActionClip,
    options: {
      direction: 'left' | 'right';
      motionMode: CharacterMotionMode;
      frameIndex?: number;
      speed: number;
      loop: boolean;
    }
  ): void {
    if (this.destroyed) return;
    this.releaseAnimation();
    this.action = action;
    this.direction = options.direction;
    if (action.frames.length === 0) {
      this.application.render();
      return;
    }

    const frameTextures: PixiTexture[] = [];
    try {
      for (const frame of action.frames) {
        const baseTexture = this.baseTextures.get(frame.assetId);
        if (!baseTexture) throw new Error('CHARACTER_RUNTIME_ASSET_MISSING');
        frameTextures.push(new this.pixi.Texture({
          source: baseTexture.source,
          frame: new this.pixi.Rectangle(frame.x, frame.y, frame.width, frame.height)
        }));
      }
    } catch (error) {
      for (const texture of frameTextures) texture.destroy(false);
      this.action = null;
      throw error;
    }
    this.frameTextures = frameTextures;

    const frames = this.frameTextures.map((texture, index) => ({
      texture,
      time: action.frames[index]?.durationMs ?? 1_000 / action.fps
    }));
    const sprite = new this.pixi.AnimatedSprite(frames, false);
    sprite.loop = options.loop;
    sprite.animationSpeed = options.speed;
    sprite.anchor.set(
      action.anchors.ground.x,
      action.anchors.ground.y
    );
    this.sprite = sprite;
    sprite.onFrameChange = () => this.notifyFrameListeners();
    if (!options.loop) {
      sprite.onComplete = () => this.notifyActionCompleteListeners();
    }
    this.application.stage.addChild(sprite);
    this.applyLayout();
    const frameIndex = clamp(
      options.frameIndex ?? 0,
      0,
      Math.max(0, frames.length - 1)
    );

    if (options.motionMode === 'animated' && frames.length > 1) {
      sprite.gotoAndStop(frameIndex);
      sprite.play();
      this.application.ticker.add(sprite.update, sprite);
      this.application.ticker.start();
    } else {
      sprite.gotoAndStop(frameIndex);
      this.application.ticker.stop();
      if (options.motionMode === 'animated' && !options.loop) {
        queueMicrotask(() => {
          if (!this.destroyed && this.sprite === sprite) {
            this.notifyActionCompleteListeners();
          }
        });
      }
    }
    this.application.render();
  }

  getCurrentFrame(): {
    action: ActionClip | DraftActionClip;
    frameIndex: number;
    bounds: { x: number; y: number; width: number; height: number };
  } | null {
    if (!this.action || !this.sprite) return null;
    const bounds = this.sprite.getBounds();
    return {
      action: this.action,
      frameIndex: this.sprite.currentFrame,
      bounds: {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height
      }
    };
  }

  /** 由 Pixi 实际布局边界、当前源帧和资源 Alpha 掩码组成命中快照。 */
  getHitSnapshot(): CharacterHitSnapshot | null {
    const currentFrame = this.getCurrentFrame();
    if (!currentFrame) return null;
    const sourceRect = currentFrame.action.frames[currentFrame.frameIndex];
    if (!sourceRect) return null;
    const mask = this.alphaMasks.get(sourceRect.assetId);
    if (!mask) return null;
    return {
      mask,
      sourceRect: {
        x: sourceRect.x,
        y: sourceRect.y,
        width: sourceRect.width,
        height: sourceRect.height
      },
      frameBounds: currentFrame.bounds,
      direction: this.direction
    };
  }

  subscribeFrame(listener: () => void): () => void {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  subscribeActionComplete(listener: () => void): () => void {
    this.actionCompleteListeners.add(listener);
    return () => this.actionCompleteListeners.delete(listener);
  }

  /** 同步渲染器内部像素尺寸，并重新应用正式布局。 */
  resize(width: number, height: number): void {
    if (this.destroyed) return;
    const nextWidth = Math.max(1, Math.round(width));
    const nextHeight = Math.max(1, Math.round(height));
    if (
      this.application.screen.width === nextWidth
      && this.application.screen.height === nextHeight
    ) return;
    this.application.renderer.resize(nextWidth, nextHeight);
    this.applyLayout();
    this.application.render();
    this.notifyFrameListeners();
  }

  stop(): void {
    this.application.ticker.stop();
    if (this.sprite) {
      this.application.ticker.remove(this.sprite.update, this.sprite);
      this.sprite.stop();
    }
  }

  isTickerRunning(): boolean {
    return this.application.ticker.started;
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    ++this.loadRevision;
    this.stop();
    this.releaseAnimation();
    this.releaseBaseTextures();
    this.alphaMasks.clear();
    this.frameListeners.clear();
    this.actionCompleteListeners.clear();
    this.application.destroy({ removeView: true }, { children: true });
  }

  private applyLayout(): void {
    if (!this.sprite || !this.action) return;
    const fit = fitCharacterFrames(
      this.action.frames,
      this.application.screen,
      resolveDirectionalAnchor(
        this.action.anchors.ground,
        this.direction
      )
    );
    this.sprite.scale.set(
      this.direction === 'left' ? -fit.scale : fit.scale,
      fit.scale
    );
    this.sprite.position.set(fit.x, fit.y);
  }

  private releaseAnimation(): void {
    this.stop();
    if (this.sprite) {
      delete this.sprite.onFrameChange;
      delete this.sprite.onComplete;
      this.application.stage.removeChild(this.sprite);
      this.sprite.destroy();
      this.sprite = null;
    }
    for (const texture of this.frameTextures) texture.destroy(false);
    this.frameTextures = [];
    this.action = null;
  }

  private releaseBaseTextures(): void {
    for (const texture of this.baseTextures.values()) texture.destroy(true);
    this.baseTextures.clear();
  }

  private notifyFrameListeners(): void {
    for (const listener of this.frameListeners) listener();
  }

  private notifyActionCompleteListeners(): void {
    for (const listener of this.actionCompleteListeners) listener();
  }
}

export async function createBrowserPixiCharacterScene(
  container: HTMLElement,
  loadPixi: PixiModuleLoader = async () => {
    // Electron 的严格 CSP 禁止 unsafe-eval；Pixi 官方适配模块改用解释执行着色器程序。
    await import('pixi.js/unsafe-eval');
    return import('pixi.js');
  }
): Promise<PixiCharacterScene> {
  const pixi = await loadPixi();
  const application = new pixi.Application();
  try {
    return await BrowserPixiCharacterScene.initialize(container, pixi, application);
  } catch (error) {
    bestEffort(() => application.ticker.stop());
    bestEffort(() => application.canvas.remove());
    bestEffort(() => application.destroy(
      { removeView: true },
      { children: true }
    ));
    throw error;
  }
}

function measureContainer(container: HTMLElement): { width: number; height: number } {
  const bounds = container.getBoundingClientRect();
  const parentBounds = container.parentElement?.getBoundingClientRect();
  return {
    width: Math.max(
      1,
      Math.round(bounds.width || parentBounds?.width || container.clientWidth)
    ),
    height: Math.max(
      1,
      Math.round(bounds.height || parentBounds?.height || container.clientHeight)
    )
  };
}

function bestEffort(operation: () => void): void {
  try {
    operation();
  } catch {
    // 初始化错误优先返回原始异常，清理步骤之间彼此隔离。
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

async function loadImage(url: string): Promise<HTMLImageElement> {
  const image = new Image();
  image.src = url;
  if (typeof image.decode === 'function') {
    await image.decode();
    return image;
  }
  await new Promise<void>((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error('CHARACTER_RUNTIME_ASSET_DECODE_FAILED'));
  });
  return image;
}

/** 在图片解码后采样一次 Alpha；Canvas 不可用时保留渲染并让命中默认穿透。 */
function extractAlphaMask(image: HTMLImageElement): AlphaMask | null {
  try {
    const width = image.naturalWidth || image.width;
    const height = image.naturalHeight || image.height;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      return null;
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) return null;
    context.drawImage(image, 0, 0);
    const rgba = context.getImageData(0, 0, width, height).data;
    const bytes = new Uint8Array(width * height);
    for (let pixel = 0; pixel < bytes.length; pixel += 1) {
      bytes[pixel] = rgba[pixel * 4 + 3]!;
    }
    return { width, height, bytes };
  } catch {
    return null;
  }
}
