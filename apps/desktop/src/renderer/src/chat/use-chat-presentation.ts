import { useEffect, useRef, useState } from 'react';
import type { MyselfApi } from '../../../shared/myself-api';
import type { ChatPresentationReadyResult, ChatPresentationSnapshot } from '../../../shared/chat-presentation';
import { ChatReplyPresentationController, type ChatReplyPresentation } from './chat-presentation-controller';

interface Options {
  api: MyselfApi;
  conversationRevision: number;
  confirmation: ChatPresentationSnapshot['confirmation'];
  readCurrentRevision?(): number;
  onConfirm(): void;
  onReject(): void;
}

/** 正式聊天界面保有业务处理器；展示层只转交当前快照绑定的点击。 */
export function useChatPresentation(options: Options) {
  const { api, conversationRevision, confirmation } = options;
  const presentation = api.chatPresentation;
  const latest = useRef(options);
  latest.current = options;
  const [reply, setReply] = useState<ChatReplyPresentation | null>(null);
  const [handshake, setHandshake] = useState<ChatPresentationReadyResult | null>(null);
  const [available, setAvailable] = useState(false);
  const [failed, setFailed] = useState(false);
  const [pointerAvailable, setPointerAvailable] = useState(true);
  const [materialAvailable, setMaterialAvailable] = useState(true);
  const suppressedConfirmation = useRef<{ id: string; revision: number } | null>(null);
  const controller = useRef<ChatReplyPresentationController | null>(null);
  const published = useRef<ChatPresentationSnapshot | null>(null);
  const revision = useRef(0);

  useEffect(() => {
    const replies = new ChatReplyPresentationController({ onChange: setReply });
    controller.current = replies;
    const unsubscribe = api.onTaskEvent?.(event => replies.accept(event));
    return () => { unsubscribe?.(); replies.dispose(); controller.current = null; };
  }, [api]);

  useEffect(() => {
    if (!presentation) return;
    let active = true;
    let resetReceived = false;
    const receiveHandshake = (value: ChatPresentationReadyResult) => {
      revision.current = Math.max(revision.current, value.revisionFloor);
      published.current = null;
      setHandshake(value);
    };
    const commands = presentation.onCommand(command => {
      if (command.type === 'availability') setAvailable(command.available);
      else if (command.type === 'pointer-availability') setPointerAvailable(command.available);
      else if (command.type === 'material-availability') setMaterialAvailable(command.available);
      else if (command.type === 'reset') {
        resetReceived = true;
        if (!command.preserveConfirmation) {
          suppressedConfirmation.current = latest.current.confirmation
            ? { id: latest.current.confirmation.id, revision: latest.current.conversationRevision } : null;
        }
        const previous = controller.current?.snapshot();
        if (previous) controller.current?.dismiss(previous.id);
        receiveHandshake(command);
      }
    });
    const intents = presentation.onIntent(intent => {
      const shown = published.current;
      const current = latest.current;
      if (!shown || intent.epoch !== shown.epoch || intent.revision !== shown.revision
        || intent.conversationRevision !== current.conversationRevision
        || intent.conversationRevision !== (current.readCurrentRevision?.() ?? current.conversationRevision)) return;
      if (intent.action === 'dismiss-reply' && shown.reply?.id === intent.targetId) {
        controller.current?.dismiss(intent.targetId);
      } else if (shown.confirmation?.id === intent.targetId && current.confirmation?.id === intent.targetId
        && !current.confirmation.busy
        && !(suppressedConfirmation.current?.id === intent.targetId && suppressedConfirmation.current.revision === current.conversationRevision)) {
        if (intent.action === 'confirm') current.onConfirm();
        else if (intent.action === 'reject') current.onReject();
      }
    });
    void presentation.ready().then(value => {
      if (active && !resetReceived) receiveHandshake(value);
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; commands(); intents(); published.current = null; };
  }, [presentation]);

  useEffect(() => {
    if (!presentation || !handshake) return;
    const visibleConfirmation = confirmation?.id === suppressedConfirmation.current?.id
      && conversationRevision === suppressedConfirmation.current?.revision ? null : confirmation;
    const snapshot: ChatPresentationSnapshot = {
      epoch: handshake.epoch, revision: ++revision.current, conversationRevision, reply, confirmation: visibleConfirmation
    };
    published.current = snapshot;
    // 不裁剪原正文；协议或窗口失败时由正式聊天界面保留完整展示与原操作。
    void presentation.publish(snapshot).then(() => {
      if (published.current === snapshot) setFailed(false);
    }).catch(() => { if (published.current === snapshot) setFailed(true); });
  }, [presentation, handshake, conversationRevision, confirmation, reply]);

  return { fallback: !presentation || !available || failed, reply, pointerAvailable, materialAvailable };
}
