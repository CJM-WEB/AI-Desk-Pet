import type { HistoryDisclosureDecision } from '@myself/shared-types';
import type { PendingHistoryDisclosure } from '../stores/task-store';
import { ConfirmationBubble } from './ChatBubbleView';
import { presentHistoryDisclosure } from './confirmation-presentation';

export interface HistoryDisclosureCardProps {
  disclosure: PendingHistoryDisclosure;
  busyDecision: HistoryDisclosureDecision | null;
  disabled: boolean;
  onShareOnce(): void;
  onCurrentMessageOnly(): void;
}

/** 保留两种原披露回调及禁用条件，展示不接纳任何历史正文。 */
export function HistoryDisclosureCard({
  disclosure,
  busyDecision,
  disabled,
  onShareOnce,
  onCurrentMessageOnly
}: HistoryDisclosureCardProps) {
  return <ConfirmationBubble value={presentHistoryDisclosure(disclosure, disabled || busyDecision !== null)}
    onConfirm={onShareOnce} onReject={onCurrentMessageOnly} />;
}
