import { createCipheriv, createDecipheriv } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { ConversationSessionStore, type ConversationPersistenceErrorCode } from '../src/main/conversation/conversation-session-store';
import type { SecretEncryptionAdapter } from '../src/main/storage/secret-store';
import { createTaskStore } from '../src/renderer/src/stores/task-store';

const directories: string[] = [];
const encryption: SecretEncryptionAdapter = {
  isEncryptionAvailable: () => true,
  encryptString: async value => {
    const cipher = createCipheriv('aes-256-cbc', Buffer.alloc(32, 7), Buffer.alloc(16, 3));
    return Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  },
  decryptString: async value => {
    const cipher = createDecipheriv('aes-256-cbc', Buffer.alloc(32, 7), Buffer.alloc(16, 3));
    return Buffer.concat([cipher.update(value), cipher.final()]).toString('utf8');
  }
};

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'ai-pet-conversation-'));
  directories.push(directory);
  const file = join(directory, 'conversation.json');
  const store = new ConversationSessionStore(file, encryption);
  await store.initialize('model:a');
  return { file, store };
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true })));
});

describe('当前对话加密持久化', () => {
  test('重建实例恢复完整可见正文与有界模型上下文，磁盘不包含明文', async () => {
    const { file, store } = await fixture();
    for (let index = 0; index < 105; index += 1) {
      store.observe({ type: 'message', role: 'user', text: `持久正文${index}` });
    }
    for (let index = 0; index < 25; index += 1) {
      store.history.append({ userText: `问题${index}`, assistantText: `回答${index}`, providerIdentity: 'provider:a' });
    }
    await store.flush();
    expect((await readFile(file, 'utf8')).includes('持久正文')).toBe(false);
    const restored = new ConversationSessionStore(file, encryption);
    await restored.initialize('model:a');
    expect(restored.snapshot().messages).toHaveLength(105);
    expect(restored.snapshot().messages[0]?.text).toBe('持久正文0');
    expect(restored.history.turns()).toHaveLength(20);
    expect(restored.history.turns()[0]?.userText).toBe('问题5');
    restored.observe({ type: 'message', role: 'assistant', text: '继续' });
    expect(new Set(restored.snapshot().messages.map(message => message.id)).size).toBe(106);
    await restored.flush();
  });

  test('流式片段和权限只在运行内存，正式提交后才可恢复', async () => {
    const { file, store } = await fixture();
    store.observe({ type: 'message', role: 'user', text: '请回答' });
    store.observe({ type: 'assistant_message_start', turnId: 'live' });
    store.observe({ type: 'assistant_message_delta', turnId: 'live', delta: '未完成' });
    store.observe({ type: 'phase', phase: 'awaiting_confirmation' });
    store.observe({ type: 'history_disclosure_required', requestId: 'pending', targetProviderName: '测试', messageCount: 1, characterCount: 3 });
    await store.flush();
    expect(store.snapshot().activeAssistantStreamTurnId).toBe('live');
    const interrupted = new ConversationSessionStore(file, encryption);
    await interrupted.initialize('model:a');
    expect(interrupted.snapshot().messages.map(message => message.text)).toEqual(['请回答']);
    expect(interrupted.snapshot().activeAssistantStreamTurnId).toBeNull();
    store.observe({ type: 'assistant_message_commit', turnId: 'live', text: '最终回答' });
    await store.flush();
    const committed = new ConversationSessionStore(file, encryption);
    await committed.initialize('model:a');
    expect(committed.snapshot().messages.map(message => message.text)).toEqual(['请回答', '最终回答']);
  });

  test('无痕冻结旧快照，关闭后不补存，下一次新对话恢复保存', async () => {
    const { file, store } = await fixture();
    store.observe({ type: 'message', role: 'user', text: '普通内容' });
    store.setIncognito(true);
    store.observe({ type: 'message', role: 'user', text: '无痕内容' });
    store.history.append({ userText: '无痕问题', assistantText: '无痕回答', providerIdentity: 'provider:a' });
    store.setIncognito(false);
    store.observe({ type: 'message', role: 'assistant', text: '同段后续' });
    await store.flush();
    const restored = new ConversationSessionStore(file, encryption);
    await restored.initialize('model:a');
    expect(restored.snapshot().messages.map(message => message.text)).toEqual(['普通内容']);
    expect(restored.history.turns()).toEqual([]);
    await store.reset('model:a');
    store.observe({ type: 'message', role: 'user', text: '新普通会话' });
    await store.flush();
    const next = new ConversationSessionStore(file, encryption);
    await next.initialize('model:a');
    expect(next.snapshot().messages.map(message => message.text)).toEqual(['新普通会话']);
  });

  test('无痕新对话仍清除旧磁盘，排队旧写入不能复活已清正文', async () => {
    const { file, store } = await fixture();
    store.observe({ type: 'message', role: 'user', text: '旧内容' });
    store.setIncognito(true);
    await store.reset('model:a');
    store.observe({ type: 'message', role: 'user', text: '新无痕内容' });
    await store.flush();
    const restored = new ConversationSessionStore(file, encryption);
    await restored.initialize('model:a');
    expect(restored.snapshot().messages).toEqual([]);
  });

  test('模型身份不匹配时不恢复旧模型正文和上下文', async () => {
    const { file, store } = await fixture();
    store.observe({ type: 'message', role: 'user', text: '旧模型内容' });
    store.history.append({ userText: '甲', assistantText: '乙', providerIdentity: 'provider:a' });
    await store.flush();
    const other = new ConversationSessionStore(file, encryption);
    await other.initialize('model:b');
    expect(other.snapshot().messages).toEqual([]);
    expect(other.history.turns()).toEqual([]);
  });

  test.each(['broken-file', 'decrypt-failure'] as const)('加载失败 %s 保留文件且拒绝自动覆盖直到明确新对话', async failure => {
    const { file, store } = await fixture();
    store.observe({ type: 'message', role: 'user', text: '原文件' });
    await store.flush();
    if (failure === 'broken-file') await writeFile(file, '{broken');
    const original = await readFile(file);
    const errors: Array<ConversationPersistenceErrorCode | null> = [];
    let failDecrypt = failure === 'decrypt-failure';
    const adapter = { ...encryption, decryptString: async (value: Buffer) => {
      if (failDecrypt) throw new Error('PRIVATE_CONTENT_MUST_NOT_ESCAPE');
      return encryption.decryptString(value);
    } };
    const restored = new ConversationSessionStore(file, adapter, { onPersistenceChanged: code => errors.push(code) });
    await restored.initialize('model:a');
    restored.observe({ type: 'message', role: 'user', text: '不要覆盖' });
    await expect(restored.flush()).rejects.toThrow('CONVERSATION_LOAD_FAILED');
    expect(await readFile(file)).toEqual(original);
    expect(errors).toEqual(['CONVERSATION_LOAD_FAILED']);
    failDecrypt = false;
    await restored.reset('model:a');
    expect(errors).toEqual(['CONVERSATION_LOAD_FAILED', null]);
    const empty = new ConversationSessionStore(file, encryption);
    await empty.initialize('model:a');
    expect(empty.snapshot().messages).toEqual([]);
  });

  test('写入失败保留可用内存且 flush 只返回安全错误码', async () => {
    const { file } = await fixture();
    const errors: Array<ConversationPersistenceErrorCode | null> = [];
    const store = new ConversationSessionStore(file, {
      ...encryption,
      encryptString: async () => { throw new Error('PRIVATE_ERROR_PATH'); }
    }, { onPersistenceChanged: code => errors.push(code) });
    await store.initialize('model:a');
    store.observe({ type: 'message', role: 'user', text: '仍能聊天' });
    await expect(store.flush()).rejects.toThrow('CONVERSATION_SAVE_FAILED');
    expect(store.snapshot().messages[0]?.text).toBe('仍能聊天');
    expect(errors).toEqual(['CONVERSATION_SAVE_FAILED']);
  });

  test('失败后写入成功只更新保存提示，不清确认卡或新增错误正文，重复成功不通知', async () => {
    const { file } = await fixture();
    const view = createTaskStore();
    let failSave = true;
    const changes: Array<ConversationPersistenceErrorCode | null> = [];
    const store = new ConversationSessionStore(file, {
      ...encryption,
      encryptString: async value => {
        if (failSave) throw new Error('PRIVATE_ERROR_PATH');
        return encryption.encryptString(value);
      }
    }, { onPersistenceChanged: code => {
      changes.push(code);
      view.getState().restoreTranscript(store.snapshot());
    } });
    await store.initialize('model:a');
    const message = { type: 'message', role: 'user', text: '继续对话' } as const;
    store.observe(message);
    view.getState().apply(message);
    view.getState().apply({ type: 'phase', phase: 'awaiting_confirmation' });
    view.getState().apply({ type: 'history_disclosure_required', requestId: 'pending', targetProviderName: '测试', messageCount: 1, characterCount: 4 });
    const pending = view.getState().pendingHistoryDisclosure;
    await expect(store.flush()).rejects.toThrow('CONVERSATION_SAVE_FAILED');
    expect(view.getState().persistenceError).toBe('CONVERSATION_SAVE_FAILED');
    expect(view.getState().pendingHistoryDisclosure).toBe(pending);

    failSave = false;
    store.history.append({ userText: '问题', assistantText: '回答', providerIdentity: 'provider:a' });
    await store.flush();
    expect(changes).toEqual(['CONVERSATION_SAVE_FAILED', null]);
    expect(view.getState().persistenceError).toBeNull();
    expect(store.snapshot().persistenceError).toBeUndefined();
    expect(view.getState().pendingHistoryDisclosure).toBe(pending);
    expect(view.getState().phase).toBe('awaiting_confirmation');
    expect(view.getState().messages.map(item => item.text)).toEqual(['继续对话']);
    store.history.append({ userText: '后续问题', assistantText: '后续回答', providerIdentity: 'provider:a' });
    await store.flush();
    expect(changes).toEqual(['CONVERSATION_SAVE_FAILED', null]);
  });

  test('失败与恢复通知抛错均不干扰保存结果和基础聊天', async () => {
    const { file } = await fixture();
    let failSave = true;
    const onPersistenceChanged = vi.fn(() => { throw new Error('PRIVATE_CALLBACK_ERROR'); });
    const store = new ConversationSessionStore(file, {
      ...encryption,
      encryptString: async value => {
        if (failSave) throw new Error('PRIVATE_SAVE_ERROR');
        return encryption.encryptString(value);
      }
    }, { onPersistenceChanged });
    await store.initialize('model:a');
    store.observe({ type: 'message', role: 'user', text: '仍可聊天' });
    await expect(store.flush()).rejects.toThrow('CONVERSATION_SAVE_FAILED');
    failSave = false;
    store.observe({ type: 'message', role: 'assistant', text: '已经恢复' });
    await expect(store.flush()).resolves.toBeUndefined();
    expect(onPersistenceChanged.mock.calls).toEqual([['CONVERSATION_SAVE_FAILED'], [null]]);
    expect(store.snapshot().messages.map(item => item.text)).toEqual(['仍可聊天', '已经恢复']);
  });

  test('新对话清空旧提示后再次保存失败仍发送保存提示', async () => {
    const { file } = await fixture();
    const view = createTaskStore();
    const store = new ConversationSessionStore(file, {
      ...encryption,
      encryptString: async () => { throw new Error('PRIVATE_SAVE_ERROR'); }
    }, { onPersistenceChanged: () => view.getState().restoreTranscript(store.snapshot()) });
    await store.initialize('model:a');
    store.observe({ type: 'message', role: 'user', text: '旧正文' });
    await expect(store.flush()).rejects.toThrow('CONVERSATION_SAVE_FAILED');
    const reset = { type: 'conversation_reset', generation: 'new' } as const;
    store.observe(reset);
    view.getState().apply(reset);
    expect(view.getState().persistenceError).toBeNull();
    await expect(store.flush()).rejects.toThrow('CONVERSATION_SAVE_FAILED');
    expect(view.getState().persistenceError).toBe('CONVERSATION_SAVE_FAILED');
    expect(view.getState().messages).toEqual([]);
  });

  test.each(['observe', 'history'] as const)('路径规范化同步失败不打断 %s 的基础聊天更新', async entry => {
    const { file } = await fixture();
    const errors: Array<ConversationPersistenceErrorCode | null> = [];
    const store = new ConversationSessionStore(file, encryption, { onPersistenceChanged: code => errors.push(code) });
    await store.initialize('model:a');
    const realpath = vi.spyOn(realpathSync, 'native').mockImplementation(() => {
      throw Object.assign(new Error('PRIVATE_PATH_MUST_NOT_ESCAPE'), { code: 'EACCES' });
    });
    try {
      expect(() => {
        if (entry === 'observe') store.observe({ type: 'message', role: 'user', text: '继续聊天' });
        else store.history.append({ userText: '继续问题', assistantText: '继续回答', providerIdentity: 'provider:a' });
      }).not.toThrow();
      await expect(store.flush()).rejects.toThrow('CONVERSATION_SAVE_FAILED');
      if (entry === 'observe') expect(store.snapshot().messages[0]?.text).toBe('继续聊天');
      else expect(store.history.modelMessages()).toEqual([
        { role: 'user', content: '继续问题' }, { role: 'assistant', content: '继续回答' }
      ]);
      expect(errors).toEqual(['CONVERSATION_SAVE_FAILED']);
    } finally {
      realpath.mockRestore();
    }
  });

  test('配置失效不清正文和上下文，正式新对话事件清除两者', async () => {
    const { file, store } = await fixture();
    store.observe({ type: 'message', role: 'user', text: '保留正文' });
    store.history.append({ userText: '甲', assistantText: '乙', providerIdentity: 'provider:a' });
    store.observe({ type: 'conversation_reset', generation: 'config', preserveMessages: true });
    await store.flush();
    const restored = new ConversationSessionStore(file, encryption);
    await restored.initialize('model:a');
    expect(restored.snapshot().messages.map(message => message.text)).toEqual(['保留正文']);
    expect(restored.history.turns()).toHaveLength(1);
    store.observe({ type: 'conversation_reset', generation: 'new' });
    await store.flush();
    const empty = new ConversationSessionStore(file, encryption);
    await empty.initialize('model:a');
    expect(empty.snapshot().messages).toEqual([]);
    expect(empty.history.turns()).toEqual([]);
  });
});
