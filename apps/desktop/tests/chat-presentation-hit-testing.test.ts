import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Rectangle } from 'electron';
import { ChatPresentationWindowController } from '../src/main/windows/chat-presentation-windows';
import type { ChatPresentationCommand, ChatPresentationLayout } from '../src/shared/chat-presentation';

// 原生端口替身只记录系统调用；实际区域计算、状态切换和关闭裁决均由正式控制器执行。
class PresentationWindow {
  bounds = { x: 0, y: 0, width: 464, height: 120 };
  visible = false;
  destroyed = false;
  isDestroyed = () => this.destroyed;
  isVisible = () => this.visible;
  getBounds = () => this.bounds;
  setBounds = (bounds: Rectangle) => { this.bounds = bounds; };
  setShape = vi.fn<(rectangles: Rectangle[]) => void>();
  setIgnoreMouseEvents = vi.fn<(ignore: boolean, options?: { forward: boolean }) => void>();
  showInactive = () => { this.visible = true; };
  hide = () => { this.visible = false; };
  focus = () => undefined;
}
const layout = (surface: 'island' | 'bubble'): ChatPresentationLayout => ({
  surface, mode: 'open', width: 464, height: 120,
  regions: [{ x: 40, y: 24, width: 48, height: 48, radius: 24 }]
});
afterEach(() => vi.useRealTimers());
function setup() {
  vi.useFakeTimers();
  const chat = new PresentationWindow(), bubble = new PresentationWindow();
  const commands: ChatPresentationCommand[] = [];
  let cursor = { x: 0, y: 0 };
  const controller = new ChatPresentationWindowController({
    getChat: () => chat, getBubble: () => bubble, getPetVisible: () => true,
    getCursorScreenPoint: () => cursor,
    getDisplayNearestPoint: () => ({ bounds: { x: 0, y: 0, width: 1000, height: 800 }, workArea: { x: 0, y: 0, width: 1000, height: 800 } }),
    screenToDipPoint: point => point,
    sendCommand: command => commands.push(command),
    pointer: { setEnabled: () => undefined, dispose: async () => undefined }
  });
  controller.markReady('island'); controller.markReady('bubble');
  controller.updatePetGeometry({ x: 450, y: 300, width: 100, height: 120 });
  controller.setLayout(layout('island')); controller.setLayout(layout('bubble'));
  return { chat, bubble, commands, controller, setCursor: (point: { x: number; y: number }) => { cursor = point; } };
}

describe('聊天绘制阴影与原始命中边界分离', () => {
  it('圆球底部阴影处可绘制，但点击仍按原圆球轮廓触发外部关闭', async () => {
    const x = setup();
    const shapes = x.chat.setShape.mock.calls.at(-1)![0];
    expect(shapes.some(rect => rect.x <= 64 && rect.x + rect.width > 64 && rect.y <= 80 && rect.y + rect.height > 80)).toBe(true);
    x.controller.onPointerDown({ x: x.chat.bounds.x + 64, y: x.chat.bounds.y + 80 });
    expect(x.commands).toContainEqual({ type: 'close' });
    await x.controller.dispose();
  });

  it.each(['island', 'bubble'] as const)('%s 在圆角和阴影处穿透，进入正文即恢复交互，重复移动不调用原生切换', async surface => {
    const x = setup(), window = surface === 'island' ? x.chat : x.bubble;
    x.controller.onMouseEvent(surface, { type: 'mouseMove', x: 64, y: 48 });
    expect(window.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false, { forward: true });
    window.setIgnoreMouseEvents.mockClear();
    for (let index = 0; index < 500; index++) x.controller.onMouseEvent(surface, { type: 'mouseMove', x: 64, y: 48 });
    expect(window.setIgnoreMouseEvents).not.toHaveBeenCalled();
    x.controller.onMouseEvent(surface, { type: 'mouseMove', x: 40, y: 24 });
    expect(window.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true });
    window.setIgnoreMouseEvents.mockClear();
    x.controller.onMouseEvent(surface, { type: 'mouseMove', x: 64, y: 80 });
    expect(window.setIgnoreMouseEvents).not.toHaveBeenCalled();
    await x.controller.dispose();
  });

  it('轮询只作为边界变化兜底，不反复提交相同原生状态', async () => {
    const x = setup();
    x.setCursor({ x: x.chat.bounds.x + 64, y: x.chat.bounds.y + 48 });
    x.controller.poll();
    expect(x.chat.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false, { forward: true });
    x.chat.setIgnoreMouseEvents.mockClear(); x.bubble.setIgnoreMouseEvents.mockClear();
    for (let index = 0; index < 20; index++) x.controller.poll();
    expect(x.chat.setIgnoreMouseEvents).not.toHaveBeenCalled();
    expect(x.bubble.setIgnoreMouseEvents).not.toHaveBeenCalled();
    x.setCursor({ x: x.chat.bounds.x + 64, y: x.chat.bounds.y + 80 }); x.controller.poll();
    expect(x.chat.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true });
    await x.controller.dispose();
  });

  it('正文内按下后拖出仍接收抬起，释放后恢复阴影穿透', async () => {
    const x = setup();
    x.controller.onMouseEvent('island', { type: 'mouseDown', button: 'left', x: 64, y: 48 });
    x.chat.setIgnoreMouseEvents.mockClear();
    x.controller.onMouseEvent('island', { type: 'mouseMove', modifiers: ['leftbuttondown'], x: 120, y: 90 });
    x.setCursor({ x: x.chat.bounds.x + 120, y: x.chat.bounds.y + 90 }); x.controller.poll();
    expect(x.chat.setIgnoreMouseEvents).not.toHaveBeenCalled();
    x.controller.onMouseEvent('island', { type: 'mouseUp', button: 'left', x: 120, y: 90 });
    expect(x.chat.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true });
    await x.controller.dispose();
  });

  it('窗口隐藏会撤销旧按下状态，重新展示不会保留整窗交互', async () => {
    const x = setup();
    x.controller.onMouseEvent('island', { type: 'mouseDown', button: 'left', x: 64, y: 48 });
    x.controller.setLayout({ ...layout('island'), mode: 'hidden', regions: [] });
    x.chat.setIgnoreMouseEvents.mockClear();
    x.controller.setLayout(layout('island'));
    expect(x.chat.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true });
    await x.controller.dispose();
  });

  it('新对话清理撤销旧文本选择，后续布局的阴影恢复穿透', async () => {
    const x = setup();
    x.controller.onMouseEvent('island', { type: 'mouseDown', button: 'left', x: 64, y: 48 });
    x.chat.setIgnoreMouseEvents.mockClear(); x.controller.clear();
    x.controller.setLayout(layout('island'));
    expect(x.chat.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true });
    await x.controller.dispose();
  });

  it('隐藏后关闭鼠标转发，持续轮询不重启转发或重复原生切换', async () => {
    const x = setup();
    x.controller.setLayout({ ...layout('island'), mode: 'hidden', regions: [] });
    x.controller.setLayout({ ...layout('bubble'), mode: 'hidden', regions: [] });
    expect(x.chat.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true);
    expect(x.bubble.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true);
    x.chat.setIgnoreMouseEvents.mockClear(); x.bubble.setIgnoreMouseEvents.mockClear();
    for (let index = 0; index < 20; index++) x.controller.poll();
    expect(x.chat.setIgnoreMouseEvents).not.toHaveBeenCalled();
    expect(x.bubble.setIgnoreMouseEvents).not.toHaveBeenCalled();
    x.controller.setLayout(layout('island'));
    expect(x.chat.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, { forward: true });
    await x.controller.dispose();
  });
});
