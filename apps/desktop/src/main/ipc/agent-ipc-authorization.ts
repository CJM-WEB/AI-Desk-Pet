import type { IpcMainInvokeEvent, WebContents } from 'electron';

export class AgentIpcAuthorization {
  constructor(
    private readonly getCurrentChatWebContents: () => WebContents | null
  ) {}

  assertCurrentChatSender(event: Pick<IpcMainInvokeEvent, 'sender'>): void {
    const current = this.getCurrentChatWebContents();
    if (!current || current.isDestroyed() || event.sender !== current) {
      throw new Error('AGENT_IPC_SENDER_INVALID');
    }
  }
}
