import type { WebContents } from 'electron';
import { describe, expect, test } from 'vitest';
import { AgentIpcAuthorization } from '../src/main/ipc/agent-ipc-authorization';

function webContents(destroyed = false): WebContents {
  return { isDestroyed: () => destroyed } as WebContents;
}

describe('Agent IPC 当前聊天窗口授权', () => {
  test('拒绝未注册的聊天窗口且不缓存空身份', () => {
    const sender = webContents();
    let current: WebContents | null = null;
    const authorization = new AgentIpcAuthorization(() => current);

    expect(() => authorization.assertCurrentChatSender({ sender }))
      .toThrow('AGENT_IPC_SENDER_INVALID');

    current = sender;

    expect(() => authorization.assertCurrentChatSender({ sender })).not.toThrow();
  });

  test('拒绝已销毁的当前聊天 WebContents', () => {
    const sender = webContents(true);
    const authorization = new AgentIpcAuthorization(() => sender);

    expect(() => authorization.assertCurrentChatSender({ sender }))
      .toThrow('AGENT_IPC_SENDER_INVALID');
  });

  test('窗口替换后旧 sender 立即失效且新 sender 立即生效', () => {
    const oldChat = webContents();
    const newChat = webContents();
    let current: WebContents | null = oldChat;
    const authorization = new AgentIpcAuthorization(() => current);

    expect(() => authorization.assertCurrentChatSender({ sender: oldChat })).not.toThrow();

    current = newChat;

    expect(() => authorization.assertCurrentChatSender({ sender: oldChat }))
      .toThrow('AGENT_IPC_SENDER_INVALID');
    expect(() => authorization.assertCurrentChatSender({ sender: newChat })).not.toThrow();
  });

  test.each(['pet', 'settings', 'workshop'])(
    '拒绝 %s 等非当前聊天 sender',
    () => {
      const currentChat = webContents();
      const other = webContents();
      const authorization = new AgentIpcAuthorization(() => currentChat);

      expect(() => authorization.assertCurrentChatSender({ sender: other }))
        .toThrow('AGENT_IPC_SENDER_INVALID');
    }
  );
});
