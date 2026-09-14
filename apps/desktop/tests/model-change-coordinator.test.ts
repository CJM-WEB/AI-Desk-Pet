import { describe, expect, test, vi } from 'vitest';
import { ModelChangeCoordinator, conversationModelIdentity, type ModelConfiguration } from '../src/main/settings/model-change-coordinator';

function configuration(): ModelConfiguration {
  return {
    localModelEnabled: false,
    profiles: ['a', 'b'].map(id => ({ id, displayName: id, mode: 'custom' as const,
      protocol: 'openai-compatible' as const, baseUrl: 'https://example.com/v1', modelId: id,
      additionalParameters: {}, hasStoredSecret: true })),
    route: { primaryProfileId: 'a', chatProfileId: null, agentProfileId: null,
      visionProfileId: null, fallbackProfileIds: [], allowCrossProviderFallback: false }
  };
}

function fixture() {
  let stored = configuration();
  const order: string[] = [];
  const confirm = vi.fn(async (_signal: AbortSignal) => { order.push('confirm'); return true; });
  const invalidate = vi.fn(async () => { order.push('invalidate'); });
  const changed = vi.fn(async () => { order.push('changed'); });
  const coordinator = new ModelChangeCoordinator({ readConfiguration: async () => structuredClone(stored),
    confirmModelChange: confirm, invalidateConfiguration: invalidate, onModelChanged: changed });
  return { coordinator, order, confirm, invalidate, changed,
    get: () => stored, set: (next: ModelConfiguration) => { stored = next; } };
}

describe('模型切换事务', () => {
  test('取消模型切换不写设置、不取消旧运行、不清空对话', async () => {
    const f = fixture(); f.confirm.mockResolvedValue(false);
    const commit = vi.fn(async () => 'saved');
    const route = { ...f.get().route, primaryProfileId: 'b' };
    await expect(f.coordinator.run({ type: 'route', route }, commit)).rejects.toMatchObject({ code: 'MODEL_CHANGE_CANCELLED' });
    expect(commit).not.toHaveBeenCalled(); expect(f.invalidate).not.toHaveBeenCalled();
    expect(f.changed).not.toHaveBeenCalled();
    expect(f.coordinator.isChanging()).toBe(false);
  });

  test('接纳后至失效、提交与收尾完成期间冻结新请求，异常也释放冻结', async () => {
    const f = fixture(); const states: boolean[] = [];
    f.confirm.mockImplementation(async () => { states.push(f.coordinator.isChanging()); return true; });
    f.invalidate.mockImplementation(async () => { states.push(f.coordinator.isChanging()); });
    f.changed.mockImplementation(async () => { states.push(f.coordinator.isChanging()); throw new Error('FINALIZE_FAILED'); });
    await expect(f.coordinator.run({ type: 'local', enabled: true }, async () => {
      states.push(f.coordinator.isChanging()); f.set({ ...f.get(), localModelEnabled: true });
    })).rejects.toThrow('FINALIZE_FAILED');
    expect(states).toEqual([false, true, true, true]);
    expect(f.coordinator.isChanging()).toBe(false);
    f.invalidate.mockRejectedValue(new Error('INVALIDATE_FAILED'));
    await expect(f.coordinator.run({ type: 'local', enabled: false }, async () => undefined)).rejects.toThrow('INVALIDATE_FAILED');
    expect(f.coordinator.isChanging()).toBe(false);
  });

  test('确认后等待旧运行失效，实际提交后才新建对话', async () => {
    const f = fixture();
    const route = { ...f.get().route, agentProfileId: 'b' };
    await f.coordinator.run({ type: 'route', route }, async () => {
      f.order.push('commit'); f.set({ ...f.get(), route });
    });
    expect(f.order).toEqual(['confirm', 'invalidate', 'commit', 'changed']);
  });

  test('同值、非活动档案和本地覆盖下云配置保存只失效旧运行', async () => {
    const f = fixture(); const route = f.get().route;
    await f.coordinator.run({ type: 'route', route }, async () => undefined);
    await f.coordinator.run({ type: 'profile-save', profile: { ...f.get().profiles[1]!, modelId: 'other' } }, async () => undefined);
    f.set({ ...f.get(), localModelEnabled: true });
    const cloudRoute = { ...route, primaryProfileId: 'b' };
    await f.coordinator.run({ type: 'route', route: cloudRoute }, async () => { f.set({ ...f.get(), route: cloudRoute }); });
    expect(f.confirm).not.toHaveBeenCalled(); expect(f.changed).not.toHaveBeenCalled();
    expect(f.invalidate).toHaveBeenCalledTimes(3);
  });

  test('保存失败且身份未变保留旧对话；本地身份已提交但启动失败仍新建对话', async () => {
    const f = fixture();
    await expect(f.coordinator.run({ type: 'local', enabled: true }, async () => { throw new Error('SAVE_FAILED'); })).rejects.toThrow('SAVE_FAILED');
    expect(f.changed).not.toHaveBeenCalled();
    await expect(f.coordinator.run({ type: 'local', enabled: true }, async () => {
      f.set({ ...f.get(), localModelEnabled: true }); throw new Error('START_FAILED');
    })).rejects.toThrow('START_FAILED');
    expect(f.changed).toHaveBeenCalledOnce();
  });

  test('模型身份忽略密钥标记、名称和同模型档案ID，但识别模型与端点变化', () => {
    const before = configuration();
    const renamed = { ...before, profiles: before.profiles.map(p => ({ ...p, displayName: 'renamed', hasStoredSecret: false })) };
    expect(conversationModelIdentity(renamed)).toBe(conversationModelIdentity(before));
    expect(conversationModelIdentity({ ...before, profiles: before.profiles.map(p => ({ ...p, modelId: 'new' })) })).not.toBe(conversationModelIdentity(before));
    expect(conversationModelIdentity({ ...before, profiles: before.profiles.map(p => ({ ...p, baseUrl: 'https://other.example/v1' })) })).not.toBe(conversationModelIdentity(before));
  });

  test('删除活动对话档案按主模型回退进行确认，旧保存入口启用主模型也确认', async () => {
    const f = fixture(); f.set({ ...f.get(), route: { ...f.get().route, chatProfileId: 'b' } });
    f.confirm.mockResolvedValue(false);
    const commit = vi.fn(async () => undefined);
    await expect(f.coordinator.run({ type: 'profile-delete', profileId: 'b' }, commit)).rejects.toMatchObject({ code: 'MODEL_CHANGE_CANCELLED' });
    await expect(f.coordinator.run({ type: 'profile-save', profile: f.get().profiles[1]!, activatePrimary: true }, commit)).rejects.toMatchObject({ code: 'MODEL_CHANGE_CANCELLED' });
    expect(f.confirm).toHaveBeenCalledTimes(2); expect(commit).not.toHaveBeenCalled();
  });

  test('多个模型切换串行确认，后一个比较前一个已提交的身份', async () => {
    const f = fixture(); let release!: () => void;
    f.confirm.mockImplementationOnce(async () => { f.order.push('confirm'); await new Promise<void>(resolve => { release = resolve; }); return true; });
    const route = { ...f.get().route, primaryProfileId: 'b' };
    const first = f.coordinator.run({ type: 'route', route }, async () => { f.order.push('first'); f.set({ ...f.get(), route }); });
    const second = f.coordinator.run({ type: 'route', route }, async () => { f.order.push('second'); });
    await vi.waitFor(() => expect(f.confirm).toHaveBeenCalledOnce());
    expect(f.invalidate).not.toHaveBeenCalled(); release(); await Promise.all([first, second]);
    expect(f.confirm).toHaveBeenCalledOnce(); expect(f.changed).toHaveBeenCalledOnce();
    expect(f.order).toEqual(['confirm', 'invalidate', 'first', 'changed', 'invalidate', 'second']);
  });

  test('关闭中止尚未确认的对话框并拒绝队列及后续切换，未确认不产生副作用', async () => {
    const f = fixture();
    let confirmationSignal: AbortSignal | undefined;
    f.confirm.mockImplementation(async signal => {
      confirmationSignal = signal;
      return new Promise<boolean>(() => undefined);
    });
    const commit = vi.fn(async () => undefined);
    const first = f.coordinator.run({ type: 'local', enabled: true }, commit);
    const firstResult = expect(first).rejects.toMatchObject({ code: 'MODEL_CHANGE_CANCELLED' });
    const queued = f.coordinator.run({ type: 'local', enabled: true }, commit);
    const queuedResult = expect(queued).rejects.toMatchObject({ code: 'MODEL_CHANGE_CLOSED' });
    await vi.waitFor(() => expect(confirmationSignal).toBeDefined());
    const closing = f.coordinator.close();
    expect(confirmationSignal?.aborted).toBe(true);
    await expect(f.coordinator.run({ type: 'local', enabled: true }, commit)).rejects.toMatchObject({ code: 'MODEL_CHANGE_CLOSED' });
    await Promise.all([closing, firstResult, queuedResult]);
    expect(commit).not.toHaveBeenCalled();
    expect(f.invalidate).not.toHaveBeenCalled();
    expect(f.changed).not.toHaveBeenCalled();
  });

  test('关闭等待已接纳的提交及真实身份收尾，不让后续排队操作改写模型', async () => {
    const f = fixture();
    let releaseCommit!: () => void;
    const barrier = new Promise<void>(resolve => { releaseCommit = resolve; });
    const active = f.coordinator.run({ type: 'local', enabled: true }, async () => {
      await barrier;
      f.set({ ...f.get(), localModelEnabled: true });
      f.order.push('commit');
    });
    await vi.waitFor(() => expect(f.invalidate).toHaveBeenCalledOnce());
    let drained = false;
    const closing = f.coordinator.close().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    releaseCommit();
    await Promise.all([active, closing]);
    expect(f.order).toEqual(['confirm', 'invalidate', 'commit', 'changed']);
    expect(f.get().localModelEnabled).toBe(true);
  });
});
