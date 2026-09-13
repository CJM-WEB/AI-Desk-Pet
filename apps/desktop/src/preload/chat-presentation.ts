import {
  chatPresentationChannels,
  chatPresentationCommandSchema,
  chatPresentationIntentSchema,
  chatPresentationLayoutSchema,
  chatPresentationReadyResultSchema,
  chatPresentationSnapshotSchema,
  parseChatPresentation,
  type ChatPresentationApi
} from '../shared/chat-presentation';
import type { z } from 'zod';

interface ChatPresentationRendererPort {
  invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  on(channel: string, listener: (event: unknown, value: unknown) => void): unknown;
  removeListener(channel: string, listener: (event: unknown, value: unknown) => void): unknown;
}

/** 仅暴露固定展示通道；展示窗口的身份权限继续由 Main 独立核验。 */
export function createChatPresentationApi(ipc: ChatPresentationRendererPort): ChatPresentationApi {
  function subscribe<T>(channel: string, schema: z.ZodType<T>, listener: (value: T) => void): () => void {
    const handler = (_event: unknown, value: unknown): void => {
      const parsed = schema.safeParse(value);
      if (parsed.success) listener(parsed.data);
    };
    ipc.on(channel, handler);
    return () => { ipc.removeListener(channel, handler); };
  }
  return {
    publish: async snapshot => { await ipc.invoke(chatPresentationChannels.publish, parseChatPresentation(chatPresentationSnapshotSchema, snapshot)); },
    onSnapshot: listener => subscribe(chatPresentationChannels.snapshot, chatPresentationSnapshotSchema.nullable(), listener),
    dispatch: async intent => { await ipc.invoke(chatPresentationChannels.dispatch, parseChatPresentation(chatPresentationIntentSchema, intent)); },
    onIntent: listener => subscribe(chatPresentationChannels.intent, chatPresentationIntentSchema, listener),
    setLayout: async layout => { await ipc.invoke(chatPresentationChannels.layout, parseChatPresentation(chatPresentationLayoutSchema, layout)); },
    onCommand: listener => subscribe(chatPresentationChannels.command, chatPresentationCommandSchema, listener),
    ready: async () => parseChatPresentation(chatPresentationReadyResultSchema, await ipc.invoke(chatPresentationChannels.ready))
  };
}
