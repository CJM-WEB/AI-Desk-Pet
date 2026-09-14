import type { MouseInputEvent, Rectangle } from 'electron';
import type { ChatPresentationCommand, ChatPresentationLayout } from '../../shared/chat-presentation';

export interface ChatPresentationWindowPort {
  isDestroyed(): boolean;
  isVisible(): boolean;
  getBounds(): Rectangle;
  setBounds(bounds: Rectangle): void;
  setShape(rectangles: Rectangle[]): void;
  setIgnoreMouseEvents(ignore: boolean, options?: { forward: boolean }): void;
  showInactive(): void;
  hide(): void;
  focus(): void;
}
type Point = { x: number; y: number };
type Display = { bounds: Rectangle; workArea: Rectangle };
export interface ChatPresentationWindowControllerOptions {
  getChat(): ChatPresentationWindowPort | null;
  getBubble(): ChatPresentationWindowPort | null;
  getPetVisible(): boolean;
  getCursorScreenPoint(): Point;
  getDisplayNearestPoint(point: Point): Display;
  screenToDipPoint(point: Point): Point;
  sendCommand(command: ChatPresentationCommand): void;
  sendBubbleCommand?(command: ChatPresentationCommand): void;
  onBubbleUnavailable?(): void;
  pointer: { setEnabled(enabled: boolean): void; dispose(): Promise<void> };
}
type Region = ChatPresentationLayout['regions'][number];
const available = (window: ChatPresentationWindowPort | null): window is ChatPresentationWindowPort => Boolean(window && !window.isDestroyed());
const clamp = (value: number, minimum: number, maximum: number) => Math.max(minimum, Math.min(value, Math.max(minimum, maximum)));

/** 屏幕坐标命中严格复用 Renderer 的局部圆角区域，不以整窗矩形假装可交互。 */
function contains(region: Region, x: number, y: number): boolean {
  if (x < region.x || y < region.y || x >= region.x + region.width || y >= region.y + region.height) return false;
  const radius = region.radius ?? 0;
  const dx = x - clamp(x, region.x + radius, region.x + region.width - radius);
  const dy = y - clamp(y, region.y + radius, region.y + region.height - radius);
  return dx * dx + dy * dy <= radius * radius;
}

/** 原生裁区只限制绘制范围，外扩留出 CSS 抗锯齿与阴影；命中始终使用原始区域。 */
function shape(regions: Region[]): Rectangle[] {
  const halo = 16;
  return regions.flatMap(source => {
    const region = { x: source.x - halo, y: source.y - halo, width: source.width + halo * 2,
      height: source.height + halo * 2, radius: (source.radius ?? 0) + halo };
    const rows: Rectangle[] = [];
    const radius = region.radius ?? 0;
    for (let y = Math.floor(region.y); y < Math.ceil(region.y + region.height); y++) {
      const dy = Math.max(region.y + radius - y - 0.5, y + 0.5 - (region.y + region.height - radius), 0);
      const inset = radius ? radius - Math.sqrt(Math.max(0, radius * radius - dy * dy)) : 0;
      const x = Math.ceil(region.x + inset), right = Math.floor(region.x + region.width - inset);
      const last = rows.at(-1);
      if (right <= x) continue;
      if (last && last.x === x && last.width === right - x) last.height += 1;
      else rows.push({ x, y, width: right - x, height: 1 });
    }
    return rows;
  });
}

/** 只调度聊天表现窗口；没有桌宠移动、授权、模型或任务能力端口。 */
export class ChatPresentationWindowController {
  private disposed = false;
  private disposal: Promise<void> | null = null;
  private islandReady = false;
  private bubbleReady = false;
  private petUnavailable = false;
  private islandShapeDisabled = false;
  private pointerAvailable = true;
  private pendingOpen = false;
  private mode: ChatPresentationLayout['mode'] = 'hidden';
  private island: ChatPresentationLayout | null = null;
  private bubble: ChatPresentationLayout | null = null;
  private bubbleAnchor = '';
  private display: Display | null = null;
  private pet: Rectangle | null = null;
  private concealTimer: ReturnType<typeof setTimeout> | undefined;
  private closeTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly boundsCache = new WeakMap<ChatPresentationWindowPort, string>();
  private readonly shapeCache = new WeakMap<ChatPresentationWindowPort, string>();
  private readonly ignoreCache = new WeakMap<ChatPresentationWindowPort, boolean | 'hidden'>();
  private readonly pressedButtons = new WeakMap<ChatPresentationWindowPort, number>();
  constructor(private readonly options: ChatPresentationWindowControllerOptions) {}

  markReady(surface: 'island' | 'bubble'): void {
    if (this.disposed) return;
    if (surface === 'bubble') { this.bubbleAnchor = ''; this.bubbleReady = true; this.positionBubble(); return; }
    this.islandReady = true;
    this.command({ type: 'pointer-availability', available: this.pointerAvailable });
    if (this.pendingOpen) this.requestOpen();
  }
  markUnavailable(surface: 'island' | 'bubble'): void {
    if (this.disposed) return;
    if (surface === 'island') {
      this.islandReady = false; this.island = null; this.mode = 'hidden';
      this.options.pointer.setEnabled(false); this.hide(this.options.getChat());
    } else {
      const wasReady = this.bubbleReady;
      this.bubbleReady = false; this.bubble = null; this.hide(this.options.getBubble());
      if (wasReady) {
        this.options.onBubbleUnavailable?.();
        this.command({ type: 'availability', available: false }); this.requestOpen();
      }
    }
  }
  requestOpen(): void {
    if (this.disposed) return;
    clearTimeout(this.closeTimer); clearTimeout(this.concealTimer);
    this.pendingOpen = true;
    if (!this.islandReady) return;
    this.pendingOpen = false; this.mode = 'opening';
    this.display ??= this.petDisplay();
    this.positionIsland();
    const chat = this.options.getChat();
    if (available(chat)) { if (!chat.isVisible()) chat.showInactive(); chat.focus(); }
    this.command({ type: 'open' });
  }
  requestClose(): void {
    if (this.disposed || !this.islandReady) return;
    this.mode = 'closing'; this.pendingOpen = false;
    this.command({ type: 'close' }); this.armClose();
  }
  setLayout(layout: ChatPresentationLayout): void {
    if (this.disposed) return;
    if (layout.surface === 'bubble') { this.bubble = layout; this.positionBubble(); return; }
    const previous = this.mode;
    this.mode = layout.mode; this.island = layout;
    if (layout.mode === 'hidden') {
      clearTimeout(this.closeTimer); this.hide(this.options.getChat());
      this.options.pointer.setEnabled(false); return;
    }
    if (!this.islandReady) return;
    this.display ??= this.petDisplay();
    this.positionIsland();
    const chat = this.options.getChat();
    let shapeFailed = false;
    if (available(chat)) {
      this.applyMouseState(chat, layout);
      if (layout.regions.length && !this.islandShapeDisabled) {
        try { this.applyShape(chat, layout.regions); }
        catch {
          this.islandShapeDisabled = true; shapeFailed = true;
          // 官方 [] 恢复矩形；只修表现，不销毁或替换原 chat 业务 owner。
          try { chat.setShape([]); } catch { throw new Error('CHAT_PRESENTATION_UNAVAILABLE'); }
        }
      }
      if (!chat.isVisible()) chat.showInactive();
      if (layout.mode === 'opening' && previous !== 'opening' && previous !== 'open') chat.focus();
    }
    this.options.pointer.setEnabled(this.pointerAvailable);
    if (layout.mode === 'closing' && previous !== 'closing') this.armClose();
    if (shapeFailed) throw new Error('CHAT_PRESENTATION_UNAVAILABLE');
  }
  poll(): void {
    if (this.disposed) return;
    this.positionBubble();
    if (!this.islandReady) return;
    if (!this.pet) return;
    const display = this.petDisplay();
    if (this.display) {
      this.display = display;
      this.positionIsland();
    }
    const cursor = this.options.getCursorScreenPoint();
    const chat = this.options.getChat();
    if (available(chat) && chat.isVisible()) this.applyMouseState(chat, this.island);
    const center = display.bounds.x + display.bounds.width / 2;
    // 菜单透明留白只增加绘制画布，不扩大原有顶边入口。
    const halfWidth = Math.min(528, display.bounds.width) / 2;
    if (this.mode === 'hidden' && Math.abs(cursor.x - center) <= halfWidth && cursor.y >= display.bounds.y && cursor.y <= display.bounds.y + 1) {
      this.display = display; this.mode = 'peek'; this.command({ type: 'peek' }); return;
    }
    if (this.mode !== 'peek') return;
    const selected = this.display ?? display;
    const inPeek = Math.abs(cursor.x - (selected.bounds.x + selected.bounds.width / 2)) <= halfWidth
      && cursor.y >= selected.bounds.y && cursor.y <= selected.bounds.y + 60;
    if (inPeek) { clearTimeout(this.concealTimer); this.concealTimer = undefined; }
    else if (!this.concealTimer) this.concealTimer = setTimeout(() => {
      this.concealTimer = undefined;
      if (!this.disposed && this.mode === 'peek') this.command({ type: 'conceal' });
    }, 300);
  }
  onPointerDown(physical: Point): void {
    if (this.disposed || !this.pointerAvailable || this.mode === 'hidden' || this.mode === 'closing') return;
    const point = this.options.screenToDipPoint(physical);
    for (const [window, layout] of [[this.options.getChat(), this.island], [this.options.getBubble(), this.bubble]] as const) {
      if (!available(window) || !window.isVisible() || !layout || layout.mode === 'hidden') continue;
      const bounds = window.getBounds();
      if (layout.regions.some(region => contains(region, point.x - bounds.x, point.y - bounds.y))) return;
    }
    this.requestClose();
  }
  /** 仅消费 Main 原生鼠标事件，复用已缓存布局；不测量 DOM、不发送高频 IPC。 */
  onMouseEvent(surface: 'island' | 'bubble', mouse: MouseInputEvent): void {
    if (this.disposed) return;
    const window = surface === 'island' ? this.options.getChat() : this.options.getBubble();
    const layout = surface === 'island' ? this.island : this.bubble;
    if (!available(window) || !window.isVisible() || !layout || layout.mode === 'hidden') return;
    const inside = layout.regions.some(region => contains(region, mouse.x, mouse.y));
    const button = mouse.button === 'middle' ? 2 : mouse.button === 'right' ? 4 : 1;
    let pressed = this.pressedButtons.get(window) ?? 0;
    if (mouse.type === 'mouseDown' && inside) pressed |= button;
    if (mouse.type === 'mouseUp') pressed &= ~button;
    if (mouse.type === 'mouseMove' && mouse.modifiers) {
      const held = (mouse.modifiers.includes('leftbuttondown') ? 1 : 0)
        | (mouse.modifiers.includes('middlebuttondown') ? 2 : 0)
        | (mouse.modifiers.includes('rightbuttondown') ? 4 : 0);
      pressed &= held;
    }
    this.pressedButtons.set(window, pressed);
    this.applyMouseState(window, layout, mouse);
  }
  onPointerFailure(): void {
    if (this.disposed) return;
    this.pointerAvailable = false; this.options.pointer.setEnabled(false);
    this.command({ type: 'pointer-availability', available: false }); this.requestOpen();
  }
  updatePetGeometry(visualBoundsScreenDip: Rectangle | null): void {
    if (this.disposed) return;
    this.pet = visualBoundsScreenDip; this.positionBubble();
  }
  clear(): void {
    if (this.disposed) return;
    this.island = null; this.bubble = null; this.hide(this.options.getBubble());
    const chat = this.options.getChat();
    if (available(chat)) {
      this.pressedButtons.delete(chat);
      if (chat.isVisible()) this.applyMouseState(chat, null);
    }
  }
  snapshot(): Readonly<{ mode: ChatPresentationLayout['mode']; pointerAvailable: boolean; disposed: boolean }> {
    return { mode: this.mode, pointerAvailable: this.pointerAvailable, disposed: this.disposed };
  }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.disposed = true; clearTimeout(this.closeTimer); clearTimeout(this.concealTimer);
    this.hide(this.options.getChat()); this.hide(this.options.getBubble());
    this.disposal = this.options.pointer.dispose(); return this.disposal;
  }
  private command(value: ChatPresentationCommand): void {
    if (!this.islandReady) return;
    try { this.options.sendCommand(value); }
    catch { this.islandReady = false; this.options.pointer.setEnabled(false); }
  }
  private hide(window: ChatPresentationWindowPort | null): void {
    try {
      if (window) this.pressedButtons.delete(window);
      if (!available(window)) return;
      // 隐藏状态不需要 Chromium 鼠标转发，明确关闭其原生钩子，轮询不得重新开启。
      try {
        if (this.ignoreCache.get(window) !== 'hidden') {
          window.setIgnoreMouseEvents(true);
          this.ignoreCache.set(window, 'hidden');
        }
      } finally { if (window.isVisible()) window.hide(); }
    } catch { /* 销毁并发中继续清理其他资源。 */ }
  }
  private applyMouseState(window: ChatPresentationWindowPort, layout: ChatPresentationLayout | null, local?: Point): void {
    const bounds = local ? null : window.getBounds();
    const cursor = local ?? this.options.getCursorScreenPoint();
    const point = local ?? { x: cursor.x - bounds!.x, y: cursor.y - bounds!.y };
    // 原区域内按下后的文本选择/滚动条拖拽保留抬起事件，阴影不扩大交互范围。
    const interactive = layout?.mode !== 'hidden' && Boolean(layout?.regions.length)
      && (Boolean(this.pressedButtons.get(window)) || layout!.regions.some(region => contains(region, point.x, point.y)));
    const ignore = !interactive;
    if (this.ignoreCache.get(window) === ignore) return;
    window.setIgnoreMouseEvents(ignore, { forward: true });
    this.ignoreCache.set(window, ignore);
  }
  private applyBounds(window: ChatPresentationWindowPort, bounds: Rectangle): void {
    const key = JSON.stringify(bounds);
    if (this.boundsCache.get(window) === key) return;
    window.setBounds(bounds); this.boundsCache.set(window, key);
  }
  private applyShape(window: ChatPresentationWindowPort, regions: Region[]): void {
    const key = JSON.stringify(regions);
    if (this.shapeCache.get(window) === key) return;
    window.setShape(shape(regions)); this.shapeCache.set(window, key);
  }
  private armClose(): void {
    clearTimeout(this.closeTimer);
    const chat = this.options.getChat();
    this.closeTimer = setTimeout(() => {
      if (this.disposed || this.mode !== 'closing' || chat !== this.options.getChat()) return;
      this.mode = 'hidden'; this.hide(chat); this.options.pointer.setEnabled(false);
    }, 700);
  }
  private positionIsland(): void {
    const chat = this.options.getChat(), display = this.display;
    if (!available(chat) || !display) return;
    const width = Math.min(712, display.bounds.width);
    const height = Math.min(this.island?.height ?? 88, display.bounds.height);
    this.applyBounds(chat, { x: Math.round(display.bounds.x + (display.bounds.width - width) / 2), y: display.bounds.y, width: Math.ceil(width), height: Math.ceil(height) });
  }
  private petDisplay(): Display {
    return this.options.getDisplayNearestPoint(this.pet
      ? { x: this.pet.x + this.pet.width / 2, y: this.pet.y }
      : this.options.getCursorScreenPoint());
  }
  private positionBubble(): void {
    try { this.applyBubble(); }
    catch {
      this.markUnavailable('bubble');
      throw new Error('CHAT_PRESENTATION_UNAVAILABLE');
    }
  }
  private applyBubble(): void {
    const bubble = this.options.getBubble(), layout = this.bubble, pet = this.pet;
    if (!available(bubble) || !this.bubbleReady || !layout || layout.mode === 'hidden') { this.hide(bubble); return; }
    if (!pet || !this.options.getPetVisible()) {
      this.hide(bubble);
      if (!this.petUnavailable) {
        this.petUnavailable = true;
        this.command({ type: 'availability', available: false }); this.requestOpen();
      }
      return;
    }
    if (this.petUnavailable) { this.petUnavailable = false; this.command({ type: 'availability', available: true }); }
    const area = this.options.getDisplayNearestPoint({ x: pet.x + pet.width / 2, y: pet.y }).workArea;
    // 固定透明画布避免短回复缩小 viewport 后限制下一条长回复；背景尺寸由局部形状决定。
    const width = Math.min(464, area.width), height = Math.min(layout.height, area.height);
    const above = pet.y - height - 8, below = pet.y + pet.height + 8;
    const useBelow = above < area.y && (below + height <= area.y + area.height
      || area.y + area.height - below > pet.y - area.y);
    const bounds = { x: Math.round(clamp(pet.x + (pet.width - width) / 2, area.x, area.x + area.width - width)),
      y: Math.round(clamp(useBelow ? below : above, area.y, area.y + area.height - height)), width: Math.ceil(width), height: Math.ceil(height) };
    this.applyBounds(bubble, bounds);
    // 首个区域是正文轮廓；只下发正文与尾部局部坐标，不公开宠物或其他窗口事实。
    const body = layout.regions[0];
    if (body && this.options.sendBubbleCommand) {
      const inset = Math.min(body.radius ?? 22, body.width / 2);
      const bodyLeft = Math.round(clamp(pet.x + pet.width / 2 - bounds.x - body.width / 2, 12, width - body.width - 12));
      const command = { type: 'bubble-anchor' as const, bodyLeft,
        tailX: Math.round(clamp(pet.x + pet.width / 2 - bounds.x - bodyLeft, inset, body.width - inset)),
        side: useBelow ? 'top' as const : 'bottom' as const };
      const anchor = JSON.stringify(command);
      if (anchor !== this.bubbleAnchor) { this.options.sendBubbleCommand(command); this.bubbleAnchor = anchor; }
    }
    this.applyMouseState(bubble, layout);
    if (layout.regions.length) this.applyShape(bubble, layout.regions);
    if (!bubble.isVisible()) bubble.showInactive();
  }
}
