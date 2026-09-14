import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatPresentationCommand, ChatPresentationLayout } from '../src/shared/chat-presentation';

// 端口仅保存窗口事实，不启动 Electron，不调用桌宠移动或业务控制函数。
class Window extends EventEmitter {
  bounds = { x: 0, y: 0, width: 520, height: 88 };
  visible = false; destroyed = false;
  webContents = new EventEmitter();
  isDestroyed = () => this.destroyed;
  isVisible = () => this.visible;
  getBounds = () => this.bounds;
  setBounds = vi.fn((value: typeof this.bounds) => { this.bounds = value; });
  setShape = vi.fn(); setIgnoreMouseEvents = vi.fn();
  showInactive = vi.fn(() => { this.visible = true; });
  show = vi.fn(() => { this.visible = true; });
  hide = vi.fn(() => { this.visible = false; });
  focus = vi.fn();
}
const layout = (mode: ChatPresentationLayout['mode'], surface: 'island' | 'bubble' = 'island'): ChatPresentationLayout => ({
  surface, mode, width: 520, height: 88,
  regions: mode === 'hidden' ? [] : [{ x: 24, y: 8, width: 472, height: 48, radius: 24 }]
});
afterEach(() => vi.useRealTimers());
async function setup() {
  vi.useFakeTimers();
  const module = await import('../src/main/windows/chat-presentation-windows');
  expect(module.ChatPresentationWindowController).toBeTypeOf('function');
  const chat = new Window(), bubble = new Window(), pet = new Window(); pet.visible = true;
  const commands: ChatPresentationCommand[] = [];
  const bubbleCommands: ChatPresentationCommand[] = [];
  const pointer = { setEnabled: vi.fn(), dispose: vi.fn(async () => undefined) };
  let cursor = { x: -500, y: -200 };
  const display = { bounds: { x: -1000, y: -200, width: 1000, height: 800 }, workArea: { x: -1000, y: -160, width: 1000, height: 760 } };
  let findDisplay = (_point: { x: number; y: number }) => display;
  const controller = new module.ChatPresentationWindowController({
    getChat: () => chat, getBubble: () => bubble,
    getPetVisible: () => pet.visible && !pet.destroyed,
    getCursorScreenPoint: () => cursor,
    getDisplayNearestPoint: point => findDisplay(point),
    screenToDipPoint: point => ({ x: point.x / 2, y: point.y / 2 }),
    sendCommand: command => commands.push(command), sendBubbleCommand: command => bubbleCommands.push(command), pointer
  });
  return { chat, bubble, pet, commands, bubbleCommands, pointer, controller, setCursor: (value: typeof cursor) => { cursor = value; }, setDisplayResolver: (value: typeof findDisplay) => { findDisplay = value; } };
}

describe('正式聊天原生窗口表现', () => {
  it('短正文贴边时调整正文位置，保持完整可见且尾部对准宠物中心', async () => {
    const x = await setup(); x.controller.markReady('bubble');
    x.controller.updatePetGeometry({ x: -1000, y: 200, width: 100, height: 100 });
    x.controller.setLayout({ surface: 'bubble', mode: 'open', width: 464, height: 90,
      regions: [{ x: 182, y: 12, width: 100, height: 56, radius: 22 }] });
    const anchor = x.bubbleCommands.at(-1) as unknown as { bodyLeft?: number; tailX: number };
    expect(x.bubble.getBounds().x + (anchor.bodyLeft ?? 182) + anchor.tailX).toBe(-950);
    expect(anchor.bodyLeft).toBeGreaterThanOrEqual(12);
    expect((anchor.bodyLeft ?? 182) + 100).toBeLessThanOrEqual(452);
    await x.controller.dispose();
  });

  it('贴左右边界时尾部仍指向宠物，顶部空间不足时移到下方且不移动宠物', async () => {
    const x = await setup(); x.controller.markReady('bubble');
    x.controller.setLayout({ surface: 'bubble', mode: 'open', width: 464, height: 120,
      regions: [{ x: 12, y: 12, width: 440, height: 86, radius: 22 }] });
    x.controller.updatePetGeometry({ x: -1000, y: 200, width: 100, height: 100 });
    expect(x.bubbleCommands.at(-1)).toEqual({ type: 'bubble-anchor', bodyLeft: 12, tailX: 38, side: 'bottom' });
    x.controller.updatePetGeometry({ x: -100, y: 200, width: 100, height: 100 });
    expect(x.bubbleCommands.at(-1)).toEqual({ type: 'bubble-anchor', bodyLeft: 12, tailX: 402, side: 'bottom' });
    x.controller.updatePetGeometry({ x: -1000, y: -160, width: 100, height: 100 });
    expect(x.bubble.getBounds().y).toBeGreaterThanOrEqual(-60);
    expect(x.bubbleCommands.at(-1)).toEqual({ type: 'bubble-anchor', bodyLeft: 12, tailX: 38, side: 'top' });
    expect(x.pet.setBounds).not.toHaveBeenCalled();
    await x.controller.dispose();
  });

  it('仅中央display.bounds顶边触发peek，加载前不发送，提示不抢焦点', async () => {
    const x = await setup();
    x.controller.updatePetGeometry({ x: -650, y: 200, width: 100, height: 120 });
    x.controller.poll(); expect(x.commands).toEqual([]);
    x.controller.markReady('island'); x.controller.poll();
    expect(x.commands).toContainEqual({ type: 'peek' });
    x.controller.setLayout(layout('peek'));
    expect(x.chat.getBounds().x).toBe(-856); expect(x.chat.getBounds().y).toBe(-200);
    expect(x.chat.showInactive).toHaveBeenCalled(); expect(x.chat.focus).not.toHaveBeenCalled();
    expect(x.commands).not.toContainEqual({ type: 'open' });
    x.setCursor({ x: -900, y: -200 }); x.controller.poll();
    await vi.advanceTimersByTimeAsync(301);
    expect(x.commands).toContainEqual({ type: 'conceal' });
    await x.controller.dispose();
  });

  it('打开与关闭遵循动画：hidden布局之后才隐藏，不取消气泡', async () => {
    const x = await setup(); x.controller.markReady('island');
    x.controller.requestOpen(); expect(x.commands).toContainEqual({ type: 'open' });
    x.controller.setLayout(layout('opening')); expect(x.chat.focus).toHaveBeenCalled();
    x.bubble.visible = true; x.chat.hide.mockClear();
    x.controller.requestClose(); expect(x.commands).toContainEqual({ type: 'close' });
    expect(x.chat.hide).not.toHaveBeenCalled(); expect(x.bubble.hide).not.toHaveBeenCalled();
    x.controller.setLayout(layout('hidden')); expect(x.chat.hide).toHaveBeenCalledOnce();
    expect(x.bubble.hide).not.toHaveBeenCalled(); await x.controller.dispose();
  });

  it('真实物理点转DIP后按圆角命中；bubble内部不触发外点关闭', async () => {
    const x = await setup(); x.controller.markReady('island'); x.controller.markReady('bubble');
    x.controller.setLayout(layout('open')); x.controller.setLayout(layout('open', 'bubble'));
    x.controller.updatePetGeometry({ x: -700, y: 300, width: 100, height: 120 });
    const chatBounds = x.chat.getBounds();
    x.controller.onPointerDown({ x: (chatBounds.x + 250) * 2, y: (chatBounds.y + 30) * 2 });
    expect(x.commands).not.toContainEqual({ type: 'close' });
    const b = x.bubble.getBounds(); x.controller.onPointerDown({ x: (b.x + 250) * 2, y: (b.y + 30) * 2 });
    expect(x.commands).not.toContainEqual({ type: 'close' });
    x.controller.onPointerDown({ x: (chatBounds.x + 24) * 2, y: (chatBounds.y + 8) * 2 });
    expect(x.commands).toContainEqual({ type: 'close' });
    expect(x.chat.setShape).toHaveBeenCalled(); await x.controller.dispose();
  });

  it('气泡在头顶跟随并限位，桌宠只读；隐藏桌宠不移动它', async () => {
    const x = await setup(); x.controller.markReady('bubble'); x.controller.setLayout(layout('open', 'bubble'));
    x.controller.updatePetGeometry({ x: -970, y: -150, width: 100, height: 120 });
    expect(x.bubble.getBounds().x).toBeGreaterThanOrEqual(-1000);
    expect(x.bubble.getBounds().y).toBeGreaterThanOrEqual(-160);
    x.controller.updatePetGeometry({ x: -400, y: 400, width: 100, height: 120 });
    expect(x.bubble.getBounds().y).toBe(304);
    expect(x.pet.setBounds).not.toHaveBeenCalled();
    x.pet.visible = false; x.controller.poll(); expect(x.bubble.hide).toHaveBeenCalled();
    await x.controller.dispose();
  });

  it('透明历史仍保持内容窗口的点击区域与展开状态', async () => {
    const x = await setup(); x.controller.markReady('island');
    x.controller.setLayout({ surface: 'island', mode: 'open', width: 520, height: 360, regions: [{ x: 80, y: 8, width: 360, height: 280, radius: 8 }] });
    const bounds = x.chat.getBounds();
    x.controller.onPointerDown({ x: (bounds.x + 200) * 2, y: (bounds.y + 100) * 2 });
    expect(x.commands).not.toContainEqual({ type: 'close' });
    expect(x.chat.visible).toBe(true);
    await x.controller.dispose();
  });

  it('观察器失败明确通知并保留输入，关闭超时有界且反向打开撤销旧隐藏', async () => {
    const x = await setup(); x.controller.markReady('island'); x.controller.onPointerFailure();
    expect(x.commands).toContainEqual({ type: 'pointer-availability', available: false });
    expect(x.commands).toContainEqual({ type: 'open' });
    x.controller.setLayout(layout('open')); x.controller.requestClose();
    await vi.advanceTimersByTimeAsync(300); x.controller.requestOpen();
    await vi.advanceTimersByTimeAsync(700); expect(x.chat.visible).toBe(true);
    x.controller.requestClose(); await vi.advanceTimersByTimeAsync(701); expect(x.chat.visible).toBe(false);
    await x.controller.dispose(); expect(x.pointer.dispose).toHaveBeenCalledOnce();
  });

  it('气泡布局原生失败撤销展示并打开原聊天，不重放旧交互', async () => {
    const x = await setup(); x.controller.markReady('island'); x.controller.markReady('bubble');
    x.controller.updatePetGeometry({ x: -500, y: 300, width: 100, height: 120 });
    x.bubble.setShape.mockImplementationOnce(() => { throw new Error('private-detail'); });
    expect(() => x.controller.setLayout(layout('open', 'bubble'))).toThrow('CHAT_PRESENTATION_UNAVAILABLE');
    expect(x.commands).toContainEqual({ type: 'availability', available: false });
    expect(x.commands).toContainEqual({ type: 'open' });
    expect(x.bubble.visible).toBe(false); await x.controller.dispose();
  });

  it('气泡透明画布固定宽度，短回复后长回复不会被上次viewport限制', async () => {
    const x = await setup(); x.controller.markReady('bubble');
    x.controller.updatePetGeometry({ x: -500, y: 300, width: 100, height: 120 });
    x.controller.setLayout({ ...layout('open', 'bubble'), width: 180 });
    expect(x.bubble.getBounds().width).toBe(464);
    x.controller.setLayout({ ...layout('open', 'bubble'), width: 464 });
    expect(x.bubble.getBounds().width).toBe(464); await x.controller.dispose();
  });

  it('reset撤销旧历史命中；初次气泡加载不擅自展开聊天', async () => {
    const x = await setup(); x.controller.markReady('island'); x.controller.markUnavailable('bubble');
    expect(x.commands).not.toContainEqual({ type: 'open' });
    x.controller.setLayout({ ...layout('open'), height: 360, regions: [{ x: 80, y: 8, width: 360, height: 280, radius: 8 }] });
    const bounds = x.chat.getBounds();
    x.controller.clear(); x.controller.poll();
    x.controller.onPointerDown({ x: (bounds.x + 200) * 2, y: (bounds.y + 100) * 2 });
    expect(x.commands).toContainEqual({ type: 'close' });
    await x.controller.dispose();
  });

  it('隐藏宠物时气泡确认回退原聊天，重新显示恢复展示且不改宠物', async () => {
    const x = await setup(); x.controller.markReady('island'); x.controller.markReady('bubble');
    x.controller.updatePetGeometry({ x: -500, y: 300, width: 100, height: 120 });
    x.controller.setLayout(layout('open', 'bubble')); x.commands.length = 0;
    x.pet.visible = false; x.controller.poll();
    expect(x.commands).toContainEqual({ type: 'availability', available: false });
    expect(x.commands).toContainEqual({ type: 'open' });
    x.pet.visible = true; x.controller.poll();
    expect(x.commands).toContainEqual({ type: 'availability', available: true });
    expect(x.pet.setBounds).not.toHaveBeenCalled(); await x.controller.dispose();
  });

  it('顶边入口覆盖展开组宽度且只接受宠物所在屏幕，不跟随外屏光标', async () => {
    const x = await setup();
    x.setDisplayResolver(point => point.x < 0
      ? { bounds: { x: -1000, y: -200, width: 1000, height: 800 }, workArea: { x: -1000, y: -160, width: 1000, height: 760 } }
      : { bounds: { x: 0, y: 0, width: 1000, height: 800 }, workArea: { x: 0, y: 40, width: 1000, height: 760 } });
    x.controller.updatePetGeometry({ x: -700, y: 300, width: 100, height: 120 }); x.controller.markReady('island');
    x.setCursor({ x: 500, y: 0 }); x.controller.poll(); expect(x.commands).not.toContainEqual({ type: 'peek' });
    x.setCursor({ x: -300, y: -200 }); x.controller.poll(); expect(x.commands).toContainEqual({ type: 'peek' });
    await x.controller.dispose();
  });

  it('顶部透明画布跨窄屏再回宽屏恢复712，保留向左菜单余量', async () => {
    const x = await setup(); let wide = false;
    x.setDisplayResolver(() => ({ bounds: { x: -1000, y: -200, width: wide ? 1000 : 360, height: 800 }, workArea: { x: -1000, y: -160, width: wide ? 1000 : 360, height: 760 } }));
    x.controller.updatePetGeometry({ x: -800, y: 300, width: 100, height: 120 }); x.controller.markReady('island');
    x.controller.setLayout({ ...layout('open'), width: 360 }); expect(x.chat.getBounds().width).toBe(360);
    wide = true; x.controller.poll(); expect(x.chat.getBounds().width).toBe(712);
    await x.controller.dispose();
  });

  it('展开裁形失败在同一chat重置矩形并降级，不销毁业务owner或保留旧peek裁形', async () => {
    const x = await setup(); x.controller.markReady('island'); x.controller.setLayout({ ...layout('peek'), regions: [{ x: 224, y: 0, width: 72, height: 28, radius: 14 }] });
    x.chat.setShape.mockImplementationOnce(() => { throw new Error('native-shape'); });
    expect(() => x.controller.setLayout(layout('open'))).toThrow('CHAT_PRESENTATION_UNAVAILABLE');
    expect(x.chat.setShape).toHaveBeenLastCalledWith([]); expect(x.chat.visible).toBe(true);
    x.chat.setShape.mockClear(); x.controller.setLayout(layout('open'));
    expect(x.chat.setShape).not.toHaveBeenCalled(); expect(x.chat.destroyed).toBe(false);
    const bounds = x.chat.getBounds();
    x.controller.onPointerDown({ x: (bounds.x + 24) * 2, y: (bounds.y + 8) * 2 }); expect(x.commands).toContainEqual({ type: 'close' });
    await x.controller.dispose();
  });
});
