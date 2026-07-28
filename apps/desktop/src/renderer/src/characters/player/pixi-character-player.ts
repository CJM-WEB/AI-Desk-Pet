import type {
  ActionSelectionResult,
  AnchorPoint,
  AnchorSet,
  CharacterManifestV1,
  CharacterMotionMode
} from '@myself/character-runtime';
import type { CharacterAssetBundle } from './character-resource-cache';

export interface CharacterPlayerPort {
  load(manifest: CharacterManifestV1, assets: CharacterAssetBundle): Promise<void>;
  play(selection: ActionSelectionResult, motionMode: CharacterMotionMode): void;
  setDirection(direction: 'left' | 'right'): void;
  getAnchor(name: keyof AnchorSet): AnchorPoint | null;
  destroy(): void;
}

/**
 * Pixi 场景端口隔离 GPU、纹理与 ticker，单元测试无需创建真实画布。
 */
export interface PixiCharacterScene {
  load(manifest: CharacterManifestV1, assets: CharacterAssetBundle): Promise<void>;
  show(selection: ActionSelectionResult, motionMode: CharacterMotionMode): void;
  setDirection(direction: 'left' | 'right'): void;
  getAnchor(name: keyof AnchorSet): AnchorPoint | null;
  stop(): void;
  destroy(): void;
  isTickerRunning(): boolean;
}

export class PixiCharacterPlayer implements CharacterPlayerPort {
  private destroyed = false;

  constructor(private readonly scene: PixiCharacterScene) {}

  static async create(
    container: HTMLElement,
    sceneFactory: PixiCharacterSceneFactory = createBrowserPixiCharacterScene
  ): Promise<PixiCharacterPlayer> {
    return new PixiCharacterPlayer(await sceneFactory(container));
  }

  load(manifest: CharacterManifestV1, assets: CharacterAssetBundle): Promise<void> {
    return this.scene.load(manifest, assets);
  }

  play(selection: ActionSelectionResult, motionMode: CharacterMotionMode): void {
    this.scene.show(selection, motionMode);
  }

  setDirection(direction: 'left' | 'right'): void {
    this.scene.setDirection(direction);
  }

  getAnchor(name: keyof AnchorSet): AnchorPoint | null {
    return this.scene.getAnchor(name);
  }

  isTickerRunning(): boolean {
    return this.scene.isTickerRunning();
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    try {
      this.scene.stop();
    } finally {
      this.scene.destroy();
    }
  }
}

type PixiModule = typeof import('pixi.js');
type PixiApplication = InstanceType<PixiModule['Application']>;
type PixiTexture = InstanceType<PixiModule['Texture']>;
type PixiAnimatedSprite = InstanceType<PixiModule['AnimatedSprite']>;
export type PixiCharacterSceneFactory = (
  container: HTMLElement
) => Promise<PixiCharacterScene>;
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
  private frameTextures: PixiTexture[] = [];
  private sprite: PixiAnimatedSprite | null = null;
  private selection: ActionSelectionResult | null = null;
  private direction: 'left' | 'right' = 'right';
  private loadRevision = 0;
  private destroyed = false;

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

  async load(
    manifest: CharacterManifestV1,
    assets: CharacterAssetBundle
  ): Promise<void> {
    const revision = ++this.loadRevision;
    const entries: Array<readonly [string, PixiTexture]> = [];
    const atlasAssetIds = new Set(
      manifest.states.flatMap(state => (
        state.actions.flatMap(action => action.frames.map(frame => frame.assetId))
      ))
    );
    try {
      for (const resource of manifest.resources) {
        if (!atlasAssetIds.has(resource.assetId)) continue;
        const url = assets.atlasUrls.get(resource.assetId);
        if (!url) {
          throw new Error('CHARACTER_RUNTIME_ASSET_MISSING');
        }
        const image = await loadImage(url);
        const texture = this.pixi.Texture.from(image, true);
        entries.push([resource.assetId, texture]);
      }
    } catch (error) {
      for (const [, texture] of entries) texture.destroy(true);
      throw error;
    }

    if (this.destroyed || revision !== this.loadRevision) {
      for (const [, texture] of entries) texture.destroy(true);
      return;
    }

    this.releaseAnimation();
    this.releaseBaseTextures();
    for (const [assetId, texture] of entries) {
      this.baseTextures.set(assetId, texture);
    }
  }

  show(selection: ActionSelectionResult, motionMode: CharacterMotionMode): void {
    if (this.destroyed) return;
    this.releaseAnimation();
    this.selection = selection;

    this.frameTextures = selection.action.frames.map(frame => {
      const baseTexture = this.baseTextures.get(frame.assetId);
      if (!baseTexture) throw new Error('CHARACTER_RUNTIME_ASSET_MISSING');
      return new this.pixi.Texture({
        source: baseTexture.source,
        frame: new this.pixi.Rectangle(frame.x, frame.y, frame.width, frame.height)
      });
    });

    const frames = this.frameTextures.map((texture, index) => ({
      texture,
      time: selection.action.frames[index]?.durationMs
        ?? 1_000 / selection.action.fps
    }));
    const sprite = new this.pixi.AnimatedSprite(frames, false);
    sprite.loop = selection.action.loop;
    sprite.anchor.set(
      selection.action.anchors.ground.x,
      selection.action.anchors.ground.y
    );
    this.sprite = sprite;
    this.application.stage.addChild(sprite);
    this.applyLayout();

    if (motionMode === 'animated' && frames.length > 1) {
      sprite.play();
      this.application.ticker.add(sprite.update, sprite);
      this.application.ticker.start();
    } else {
      sprite.gotoAndStop(0);
      this.application.ticker.stop();
    }
    this.application.render();
  }

  setDirection(direction: 'left' | 'right'): void {
    this.direction = direction;
    this.applyLayout();
  }

  getAnchor(name: keyof AnchorSet): AnchorPoint | null {
    if (!this.selection) return null;
    const frameIndex = this.sprite?.currentFrame ?? 0;
    const frameAnchor = this.selection.action.frames[frameIndex]?.anchors?.[name];
    const anchor = frameAnchor ?? this.selection.action.anchors[name] ?? null;
    return anchor ? resolveDirectionalAnchor(anchor, this.direction) : null;
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
    this.application.destroy({ removeView: true }, { children: true });
  }

  private applyLayout(): void {
    if (!this.sprite || !this.selection) return;
    const fit = fitCharacterFrames(
      this.selection.action.frames,
      this.application.screen,
      resolveDirectionalAnchor(
        this.selection.action.anchors.ground,
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
      this.application.stage.removeChild(this.sprite);
      this.sprite.destroy();
      this.sprite = null;
    }
    for (const texture of this.frameTextures) texture.destroy(false);
    this.frameTextures = [];
    this.selection = null;
  }

  private releaseBaseTextures(): void {
    for (const texture of this.baseTextures.values()) texture.destroy(true);
    this.baseTextures.clear();
  }
}

export async function createBrowserPixiCharacterScene(
  container: HTMLElement,
  loadPixi: PixiModuleLoader = () => import('pixi.js')
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
