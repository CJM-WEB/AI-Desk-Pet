import { describe, expect, test, vi } from 'vitest';

// 仅替换 Electron 进程边界；Schema、来源裁决、修订和生命周期均执行正式实现。
function port(id = 1) {
  const messages: { channel: string; payload: unknown }[] = [];
  let destroyed = false;
  let failSend = false;
  return {
    id,
    messages,
    isDestroyed: () => destroyed,
    send(channel: string, payload: unknown) {
      if (failSend) throw new Error('私有发送故障正文');
      messages.push({ channel, payload });
    },
    destroy: () => { destroyed = true; },
    fail: () => { failSend = true; }
  };
}

const snapshot = (revision = 1, epoch = 'fixture-epoch') => ({
  epoch, revision,
  conversationRevision: 2,
  reply: { id: 'reply-1', text: '这是一条完整回复。' },
  confirmation: {
    id: 'permission-1', kind: 'permission' as const, title: '明确文件编辑操作',
    details: ['覆盖已有文件', 'D:\\项目\\原始文件.txt'], approveLabel: '覆盖' as const,
    approveDescription: '批准覆盖本次目标文件', rejectDescription: '仅拒绝这一次覆盖',
    busy: false, error: null
  }
});
const intent = (action: 'confirm' | 'reject' | 'toggle-details' | 'dismiss-reply' = 'confirm', epoch = 'fixture-epoch') => ({
  epoch, revision: 1, conversationRevision: 2, targetId: action === 'dismiss-reply' ? 'reply-1' : 'permission-1', action
});
const layout = (surface: 'island' | 'bubble' = 'island') => ({
  surface, width: 600, height: 180,
  regions: [{ x: 20, y: 30, width: 560, height: 100, radius: 20 }], mode: 'open' as const
});

async function fixture() {
  const module = await import('../src/main/windows/chat-presentation-bridge').catch(() => null);
  expect(module, '需要独立展示桥实现来源与修订裁决').not.toBeNull();
  const shared = await import('../src/shared/chat-presentation');
  const chat = port(1), bubble = port(2), pet = port(3);
  let currentChat: typeof chat | null = chat;
  let currentBubble: typeof bubble | null = bubble;
  const layouts: unknown[] = [];
  const readySurfaces: string[] = [];
  const bridge = new module!.ChatPresentationBridge({
    getChat: () => currentChat, getBubble: () => currentBubble,
    onLayout: value => layouts.push(value), onReady: surface => readySurfaces.push(surface)
  });
  const initial = bridge.ready(chat);
  return {
    bridge, chat, bubble, pet, layouts, readySurfaces, shared, module: module!,
    epoch: initial.epoch,
    snapshot: (revision = 1) => snapshot(revision, initial.epoch),
    intent: (action: Parameters<typeof intent>[0] = 'confirm') => intent(action, initial.epoch),
    replaceChat: (value: typeof chat | null) => { currentChat = value; },
    replaceBubble: (value: typeof bubble | null) => { currentBubble = value; }
  };
}

describe('最小聊天展示桥', () => {
  test('Main 局部尾部锚点只发往当前气泡且拒绝越界或私有字段', async () => {
    const f = await fixture(); f.bridge.ready(f.bubble);
    f.chat.messages.length = 0; f.bubble.messages.length = 0;
    f.bridge.sendCommand({ type: 'bubble-anchor', bodyLeft: 12, tailX: 38, side: 'top' } as never, 'bubble');
    expect(f.bubble.messages).toEqual([{ channel: 'chat-presentation:command', payload: { type: 'bubble-anchor', bodyLeft: 12, tailX: 38, side: 'top' } }]);
    expect(f.chat.messages).toEqual([]); expect(f.pet.messages).toEqual([]);
    for (const invalid of [{ type: 'bubble-anchor', bodyLeft: 12, tailX: -1, side: 'top' }, { type: 'bubble-anchor', bodyLeft: 12, tailX: 4097, side: 'top' }, { type: 'bubble-anchor', bodyLeft: 12, tailX: 38, side: 'top', path: '私有路径' }]) {
      expect(() => f.bridge.sendCommand(invalid as never, 'bubble')).toThrow('CHAT_PRESENTATION_PAYLOAD_INVALID');
    }
  });

  test('仅当前 chat 发布，直到 bubble ready 才交付当前快照且从不发给 pet', async () => {
    const f = await fixture();
    for (const sender of [f.bubble, f.pet, port(f.chat.id)]) {
      expect(() => f.bridge.publish(sender, f.snapshot())).toThrow('CHAT_PRESENTATION_SENDER_INVALID');
    }
    f.bridge.publish(f.chat, f.snapshot());
    expect(f.bubble.messages).toEqual([]);
    expect(f.bridge.ready(f.chat)).toEqual({ epoch: f.epoch, revisionFloor: 1 });
    expect(f.bridge.ready(f.bubble)).toEqual({ epoch: f.epoch, revisionFloor: 1 });
    expect(f.bubble.messages).toEqual([{ channel: 'chat-presentation:snapshot', payload: f.snapshot() }]);
    expect(f.pet.messages).toEqual([]);
    expect(f.readySurfaces).toEqual(['island', 'island', 'bubble']);
  });

  test('拒绝未知和超限字段且不把正文放进错误，不静默截断', async () => {
    const f = await fixture();
    const privateText = '仅用于拒绝检查的私有正文';
    const invalid = [
      { ...f.snapshot(), secret: privateText },
      { ...f.snapshot(), reply: { ...f.snapshot().reply, role: 'tool' } },
      { ...f.snapshot(), reply: { id: 'reply-1', text: privateText.repeat(10_000) } },
      { ...f.snapshot(), confirmation: { ...f.snapshot().confirmation, rawArguments: { path: privateText } } },
      { ...f.snapshot(), confirmation: { ...f.snapshot().confirmation, details: ['x'.repeat(100_000)] } },
      { ...f.snapshot(), revision: Number.POSITIVE_INFINITY }
    ];
    for (const value of invalid) {
      expect(() => f.bridge.publish(f.chat, value)).toThrow(/^CHAT_PRESENTATION_PAYLOAD_INVALID$/u);
    }
    f.bridge.publish(f.chat, f.snapshot());
    f.bridge.ready(f.bubble);
    expect(f.bubble.messages.at(-1)?.payload).toEqual(f.snapshot());
  });

  test('合法长正文和完整命令原样交付，调用者后续修改不污染已接纳快照', async () => {
    const f = await fixture();
    const value = f.snapshot();
    value.reply.text = '原样正文'.repeat(3_000);
    value.confirmation.details = ['完整命令'.repeat(2_000), 'D:\\原始路径'];
    const original = structuredClone(value);
    f.bridge.publish(f.chat, value);
    value.reply.text = '后来修改';
    value.confirmation.details[0] = '后来修改';
    f.bridge.ready(f.bubble);
    expect(f.bubble.messages.at(-1)?.payload).toEqual(original);
  });

  test('仅当前且已 ready 的 bubble 可提交匹配修订、会话和目标的意图', async () => {
    const f = await fixture();
    f.bridge.publish(f.chat, f.snapshot());
    expect(() => f.bridge.dispatch(f.bubble, f.intent())).toThrow();
    f.bridge.ready(f.bubble);
    for (const sender of [f.chat, f.pet, port(f.bubble.id)]) {
      expect(() => f.bridge.dispatch(sender, f.intent())).toThrow('CHAT_PRESENTATION_SENDER_INVALID');
    }
    for (const value of [
      { ...f.intent(), revision: 0 }, { ...f.intent(), conversationRevision: 1 },
      { ...f.intent(), targetId: 'other' }, { ...f.intent(), action: 'append' },
      { ...f.intent(), command: '任意命令' }
    ]) expect(() => f.bridge.dispatch(f.bubble, value)).toThrow();
    expect(f.chat.messages.filter(item => item.channel === 'chat-presentation:intent')).toEqual([]);
    f.bridge.dispatch(f.bubble, f.intent());
    expect(f.chat.messages.at(-1)).toEqual({ channel: 'chat-presentation:intent', payload: f.intent() });
  });

  test('确认重复点击在新快照前封闭，ready 不重放点击；新修订失败反馈允许重试', async () => {
    const f = await fixture();
    f.bridge.publish(f.chat, f.snapshot());
    f.bridge.ready(f.bubble);
    f.bridge.dispatch(f.bubble, f.intent());
    expect(() => f.bridge.dispatch(f.bubble, f.intent('reject'))).toThrow();
    f.bridge.ready(f.bubble);
    f.bridge.ready(f.bubble);
    expect(f.chat.messages.filter(item => item.channel === 'chat-presentation:intent')).toHaveLength(1);
    f.bridge.publish(f.chat, { ...f.snapshot(2), confirmation: { ...f.snapshot().confirmation, error: '处理失败，可重试' } });
    f.bridge.dispatch(f.bubble, { ...f.intent('reject'), revision: 2 });
    expect(f.chat.messages.filter(item => item.channel === 'chat-presentation:intent')).toHaveLength(2);
  });

  test('忙碌确认不能执行，但展开详情与关闭普通回复仍绑定各自目标', async () => {
    const f = await fixture();
    f.bridge.publish(f.chat, { ...f.snapshot(), confirmation: { ...f.snapshot().confirmation, busy: true } });
    f.bridge.ready(f.bubble);
    expect(() => f.bridge.dispatch(f.bubble, f.intent())).toThrow();
    f.bridge.dispatch(f.bubble, f.intent('toggle-details'));
    f.bridge.dispatch(f.bubble, f.intent('dismiss-reply'));
    expect(f.chat.messages.filter(item => item.channel === 'chat-presentation:intent').map(item => item.payload))
      .toEqual([f.intent('toggle-details'), f.intent('dismiss-reply')]);
  });

  test('clear 撤销快照与旧点击并保留修订水位，不能重发旧修订复活', async () => {
    const f = await fixture();
    f.bridge.publish(f.chat, f.snapshot(5));
    f.bridge.ready(f.bubble);
    f.bridge.clear();
    expect(f.bubble.messages.at(-1)).toEqual({ channel: 'chat-presentation:snapshot', payload: null });
    expect(() => f.bridge.dispatch(f.bubble, { ...f.intent(), revision: 5 })).toThrow();
    expect(() => f.bridge.publish(f.chat, f.snapshot(5))).toThrow();
    const renewed = f.bridge.ready(f.chat);
    expect(renewed.revisionFloor).toBe(5);
    expect(renewed.epoch).not.toBe(f.epoch);
    const freshSnapshot = { ...f.snapshot(6), epoch: renewed.epoch };
    f.bridge.publish(f.chat, freshSnapshot);
    expect(f.bubble.messages.at(-1)?.payload).toEqual(freshSnapshot);
  });

  test('clear 撤销此前已排队的更高修订快照，并通知 chat 以新代次恢复发布', async () => {
    const f = await fixture();
    f.bridge.publish(f.chat, f.snapshot(5));
    f.bridge.ready(f.bubble);
    const queuedBeforeClear = f.snapshot(6);
    f.bridge.clear();
    const reset = f.chat.messages.at(-1)?.payload as { type: string; epoch: string; revisionFloor: number };
    expect(() => f.bridge.publish(f.chat, queuedBeforeClear)).toThrow('CHAT_PRESENTATION_STALE');
    expect(reset.type).toBe('reset');
    expect(reset.epoch).toBeTypeOf('string');
    expect(reset.epoch).not.toBe(f.epoch);
    expect(reset.revisionFloor).toBe(5);
    expect(f.bubble.messages.at(-1)?.payload).toBeNull();
    const current = { ...f.snapshot(6), epoch: reset.epoch };
    f.bridge.publish(f.chat, current);
    expect(() => f.bridge.dispatch(f.bubble, { ...f.intent(), revision: 6 })).toThrow('CHAT_PRESENTATION_STALE');
    f.bridge.dispatch(f.bubble, { ...f.intent(), revision: 6, epoch: reset.epoch });
    expect(f.chat.messages.at(-1)?.payload).toEqual({ ...f.intent(), revision: 6, epoch: reset.epoch });
  });

  test('chat 重建撤销旧对象和快照，新 chat 必须从 ready 水位之后发布', async () => {
    const f = await fixture();
    f.bridge.publish(f.chat, f.snapshot(9));
    f.bridge.ready(f.bubble);
    const nextChat = port(f.chat.id);
    f.replaceChat(nextChat);
    expect(() => f.bridge.dispatch(f.bubble, { ...f.intent(), revision: 9 })).toThrow();
    expect(() => f.bridge.publish(f.chat, f.snapshot(10))).toThrow('CHAT_PRESENTATION_SENDER_INVALID');
    const renewed = f.bridge.ready(nextChat);
    expect(renewed.revisionFloor).toBe(9);
    expect(renewed.epoch).not.toBe(f.epoch);
    expect(f.bubble.messages.at(-1)?.payload).toBeNull();
    expect(() => f.bridge.publish(nextChat, f.snapshot(1))).toThrow();
    f.bridge.publish(nextChat, { ...f.snapshot(10), epoch: renewed.epoch });
    f.bridge.dispatch(f.bubble, { ...f.intent(), revision: 10, epoch: renewed.epoch });
    expect(nextChat.messages.at(-1)?.payload).toEqual({ ...f.intent(), revision: 10, epoch: renewed.epoch });
  });

  test('bubble 重建只向新对象交当前快照，旧对象即便 id 相同也不能点击', async () => {
    const f = await fixture();
    f.bridge.publish(f.chat, f.snapshot());
    f.bridge.ready(f.bubble);
    const nextBubble = port(f.bubble.id);
    f.replaceBubble(nextBubble);
    expect(() => f.bridge.dispatch(f.bubble, f.intent())).toThrow('CHAT_PRESENTATION_SENDER_INVALID');
    expect(() => f.bridge.dispatch(nextBubble, f.intent())).toThrow();
    f.bridge.ready(nextBubble);
    expect(nextBubble.messages).toEqual([{ channel: 'chat-presentation:snapshot', payload: f.snapshot() }]);
    expect(f.chat.messages.filter(item => item.channel === 'chat-presentation:intent')).toEqual([]);
  });

  test('销毁的 chat 或 bubble 不接纳任何展示调用', async () => {
    const f = await fixture();
    f.chat.destroy();
    expect(() => f.bridge.publish(f.chat, f.snapshot())).toThrow();
    f.bubble.destroy();
    expect(() => f.bridge.ready(f.bubble)).toThrow();
    expect(() => f.bridge.setLayout(f.bubble, layout('bubble'))).toThrow();
  });

  test('布局只接纳匹配来源的局部有限矩形，不携带屏幕位置或句柄', async () => {
    const f = await fixture();
    f.bridge.setLayout(f.chat, layout());
    f.bridge.setLayout(f.bubble, layout('bubble'));
    expect(f.layouts).toEqual([layout(), layout('bubble')]);
    for (const [sender, value] of [
      [f.pet, layout()], [f.bubble, layout()], [f.chat, layout('bubble')],
      [f.chat, { ...layout(), x: 100 }], [f.chat, { ...layout(), hwnd: '10' }],
      [f.chat, { ...layout(), width: Infinity }], [f.chat, { ...layout(), height: 99_999 }],
      [f.chat, { ...layout(), regions: [{ x: -1, y: 0, width: 5, height: 5 }] }],
      [f.chat, { ...layout(), regions: [{ x: 590, y: 0, width: 20, height: 5 }] }],
      [f.chat, { ...layout(), regions: [{ x: 0, y: 0, width: 20, height: 5, radius: 8 }] }]
    ] as const) expect(() => f.bridge.setLayout(sender, value)).toThrow();
    expect(f.layouts).toHaveLength(2);
  });

  test('气泡交付失败发送固定不可用状态，chat 保有回退入口且私有异常不外泄', async () => {
    const f = await fixture();
    f.bridge.ready(f.chat);
    f.bridge.publish(f.chat, f.snapshot());
    f.bubble.fail();
    expect(() => f.bridge.ready(f.bubble)).toThrow(/^CHAT_PRESENTATION_UNAVAILABLE$/u);
    expect(f.chat.messages.at(-1)).toEqual({ channel: 'chat-presentation:command', payload: { type: 'availability', available: false } });
    expect(() => f.bridge.dispatch(f.bubble, f.intent())).toThrow();
    expect(f.readySurfaces).not.toContain('bubble');
  });

  test('原生气泡失效撤销旧代次，重新 ready 不重放回复，只接纳 chat 重发的有效确认', async () => {
    const f = await fixture();
    f.bridge.publish(f.chat, f.snapshot());
    f.bridge.ready(f.bubble);
    expect(f.bridge.invalidateBubble).toBeTypeOf('function');
    f.bridge.invalidateBubble();
    expect(f.bubble.messages.at(-1)?.payload).toBeNull();
    const reset = f.chat.messages.at(-1)?.payload as { type: string; epoch: string; revisionFloor: number; preserveConfirmation?: boolean };
    expect(() => f.bridge.publish(f.chat, f.snapshot(2))).toThrow('CHAT_PRESENTATION_STALE');
    expect(reset).toMatchObject({ type: 'reset', revisionFloor: 1, preserveConfirmation: true });
    expect(reset.epoch).not.toBe(f.epoch);
    expect(f.chat.messages).toContainEqual({ channel: 'chat-presentation:command', payload: { type: 'availability', available: false } });
    expect(() => f.bridge.dispatch(f.bubble, f.intent())).toThrow('CHAT_PRESENTATION_STALE');
    expect(f.chat.messages.filter(item => item.channel === 'chat-presentation:intent')).toEqual([]);
    expect(f.bridge.ready(f.bubble)).toEqual({ epoch: reset.epoch, revisionFloor: 1 });
    expect(f.bubble.messages.at(-1)?.payload).toBeNull();
    expect(() => f.bridge.publish(f.chat, f.snapshot(2))).toThrow('CHAT_PRESENTATION_STALE');
    expect(() => f.bridge.dispatch(f.bubble, f.intent())).toThrow('CHAT_PRESENTATION_STALE');
    const current = { ...f.snapshot(2), epoch: reset.epoch, reply: null };
    f.bridge.publish(f.chat, current);
    expect(f.bubble.messages.at(-1)?.payload).toEqual(current);
    f.bridge.dispatch(f.bubble, { ...f.intent(), revision: 2, epoch: reset.epoch });
    expect(f.chat.messages.at(-1)?.payload).toEqual({ ...f.intent(), revision: 2, epoch: reset.epoch });
    f.bubble.fail();
    expect(() => f.bridge.invalidateBubble()).not.toThrow();
    expect(() => f.bridge.dispatch(f.bubble, f.intent('toggle-details'))).toThrow('CHAT_PRESENTATION_STALE');
  });

  test('气泡 ready 的原生装配失败不能留下可提交旧点击的 ready 状态', async () => {
    const f = await fixture();
    const bridge = new f.module.ChatPresentationBridge({
      getChat: () => f.chat, getBubble: () => f.bubble,
      onReady: surface => { if (surface === 'bubble') throw new Error('原生窗口故障'); }
    });
    const { epoch } = bridge.ready(f.chat);
    bridge.publish(f.chat, snapshot(1, epoch));
    expect(() => bridge.ready(f.bubble)).toThrow('CHAT_PRESENTATION_UNAVAILABLE');
    expect(() => bridge.dispatch(f.bubble, intent('confirm', epoch))).toThrow('CHAT_PRESENTATION_STALE');
    expect(f.chat.messages).toContainEqual({ channel: 'chat-presentation:command', payload: { type: 'availability', available: false } });
  });

  test('reset 保留确认提示仅接受可选布尔值，普通 clear 仍不保留旧确认', async () => {
    const f = await fixture();
    const command = { type: 'reset', epoch: f.epoch, revisionFloor: 1, preserveConfirmation: true };
    expect(f.shared.chatPresentationCommandSchema.safeParse(command).success).toBe(true);
    expect(f.shared.chatPresentationCommandSchema.safeParse({ ...command, preserveConfirmation: false }).success).toBe(true);
    expect(f.shared.chatPresentationCommandSchema.safeParse({ ...command, preserveConfirmation: 'true' }).success).toBe(false);
    expect(f.shared.chatPresentationCommandSchema.safeParse({ ...command, permission: 'confirm' }).success).toBe(false);
    f.bridge.clear();
    expect(f.chat.messages.at(-1)?.payload).toMatchObject({ type: 'reset', revisionFloor: 0 });
    expect(f.chat.messages.at(-1)?.payload).not.toHaveProperty('preserveConfirmation');
  });

  test('历史材质区域只允许顶部界面声明一个，气泡和未知区域种类拒绝', async () => {
    const f = await fixture();
    const region = { x: 20, y: 30, width: 560, height: 100, radius: 20, kind: 'history' };
    const valid = { ...layout(), regions: [region] };
    f.bridge.setLayout(f.chat, valid);
    expect(f.layouts).toEqual([valid]);
    for (const [sender, invalid] of [
      [f.chat, { ...valid, regions: [region, region] }],
      [f.bubble, { ...valid, surface: 'bubble' }],
      [f.chat, { ...valid, regions: [{ ...region, kind: 'arbitrary' }] }]
    ] as const) expect(() => f.bridge.setLayout(sender, invalid)).toThrow('CHAT_PRESENTATION_PAYLOAD_INVALID');
    expect(f.layouts).toHaveLength(1);
  });

  test('窗口命令只交当前 chat 且释放后不保留快照、点击或调用', async () => {
    const f = await fixture();
    f.bridge.publish(f.chat, f.snapshot());
    f.bridge.ready(f.bubble);
    f.bridge.sendCommand({ type: 'open' });
    expect(f.chat.messages.at(-1)).toEqual({ channel: 'chat-presentation:command', payload: { type: 'open' } });
    f.bridge.sendCommand({ type: 'pointer-availability', available: false });
    expect(f.chat.messages.at(-1)).toEqual({ channel: 'chat-presentation:command', payload: { type: 'pointer-availability', available: false } });
    expect(() => f.bridge.sendCommand({ type: 'open', command: '不能执行' } as never)).toThrow();
    f.bridge.dispose();
    f.bridge.dispose();
    expect(f.bubble.messages.at(-1)?.payload).toBeNull();
    expect(() => f.bridge.publish(f.chat, f.snapshot(2))).toThrow();
    expect(() => f.bridge.dispatch(f.bubble, f.intent())).toThrow();
    expect(() => f.bridge.ready(f.chat)).toThrow();
  });

  test('独立 IPC 注册严格限制参数数量并释放所有展示 handler，不修改业务通道', async () => {
    const f = await fixture();
    type Handler = (event: { sender: ReturnType<typeof port> }, ...args: unknown[]) => unknown;
    const handlers = new Map<string, Handler>();
    const businessHandler: Handler = () => '原业务';
    handlers.set('chat:submit', businessHandler);
    const removeHandler = vi.fn((name: string) => { handlers.delete(name); });
    const release = f.module.registerChatPresentationIpc({
      handle: (name: string, handler: Handler) => { handlers.set(name, handler); }, removeHandler
    } as never, f.bridge);
    expect([...handlers.keys()]).toEqual(['chat:submit', 'chat-presentation:publish', 'chat-presentation:dispatch', 'chat-presentation:layout', 'chat-presentation:ready']);
    const publish = handlers.get('chat-presentation:publish')!;
    const ready = handlers.get('chat-presentation:ready')!;
    for (const args of [[], [f.snapshot(), {}], [f.snapshot(), undefined]]) {
      expect(() => publish({ sender: f.chat }, ...args)).toThrow();
    }
    publish({ sender: f.chat }, f.snapshot());
    for (const args of [[undefined], [{}], [{ secret: '不能进入ready' }]]) {
      expect(() => ready({ sender: f.bubble }, ...args)).toThrow();
    }
    expect(ready({ sender: f.bubble })).toEqual({ epoch: f.epoch, revisionFloor: 1 });
    release();
    expect([...handlers.entries()]).toEqual([['chat:submit', businessHandler]]);
    expect(removeHandler).toHaveBeenCalledTimes(4);
  });
});

describe('展示 preload 契约', () => {
  test('Main 固定气泡参数使正式 preload 只暴露展示 API，不提供业务方法', async () => {
    let exposed: object | undefined;
    const argv = [...process.argv];
    vi.resetModules();
    vi.doMock('electron', () => ({
      contextBridge: { exposeInMainWorld: (_name: string, api: object) => { exposed = api; } },
      ipcRenderer: { invoke: vi.fn(), send: vi.fn(), on: vi.fn(), removeListener: vi.fn() }
    }));
    try {
      process.argv.push('--myself-chat-bubble');
      await import('../src/preload/index');
      expect(Object.keys(exposed ?? {})).toEqual(['chatPresentation']);
    } finally {
      process.argv.splice(0, process.argv.length, ...argv);
      vi.doUnmock('electron');
      vi.resetModules();
    }
  });

  test('仅调用固定展示通道，忽略调用结果中的正文，监听事件严格校验并精确解除', async () => {
    const module = await import('../src/preload/chat-presentation').catch(() => null);
    expect(module, '需要独立且严格的展示 preload 适配器').not.toBeNull();
    const handlers = new Map<string, (event: unknown, value: unknown) => void>();
    const invoke = vi.fn(async (channel: string) => channel.endsWith(':ready') ? { epoch: 'fixture-epoch', revisionFloor: 7 } : { private: '不可回传' });
    const removeListener = vi.fn();
    const api = module!.createChatPresentationApi({
      invoke, on: (channel: string, handler: (event: unknown, value: unknown) => void) => { handlers.set(channel, handler); }, removeListener
    });
    await expect(api.publish(snapshot())).resolves.toBeUndefined();
    await expect(api.dispatch(intent())).resolves.toBeUndefined();
    await expect(api.setLayout(layout())).resolves.toBeUndefined();
    await expect(api.ready()).resolves.toEqual({ epoch: 'fixture-epoch', revisionFloor: 7 });
    expect(invoke.mock.calls.map(call => call[0])).toEqual(['chat-presentation:publish', 'chat-presentation:dispatch', 'chat-presentation:layout', 'chat-presentation:ready']);
    const received: unknown[] = [];
    const release = api.onSnapshot(value => received.push(value));
    const handler = handlers.get('chat-presentation:snapshot')!;
    handler({}, snapshot());
    handler({}, { ...snapshot(), hidden: '私有字段' });
    handler({}, null);
    expect(received).toEqual([snapshot(), null]);
    release();
    expect(removeListener).toHaveBeenCalledExactlyOnceWith('chat-presentation:snapshot', handler);
    const intents: unknown[] = [], commands: unknown[] = [];
    api.onIntent(value => intents.push(value));
    api.onCommand(value => commands.push(value));
    handlers.get('chat-presentation:intent')!({}, intent());
    handlers.get('chat-presentation:intent')!({}, { ...intent(), action: 'execute' });
    handlers.get('chat-presentation:command')!({}, { type: 'close' });
    handlers.get('chat-presentation:command')!({}, { type: 'close', secret: true });
    expect(intents).toEqual([intent()]);
    expect(commands).toEqual([{ type: 'close' }]);
  });
});
