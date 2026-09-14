import type { PendingCapabilityAuthorization } from '../stores/task-store';
import { ConfirmationBubble } from './ChatBubbleView';
import { presentCapabilityAuthorization } from './confirmation-presentation';

/** 仅替换呈现；任务范围接纳与取消仍交给原调用方。 */
export function CapabilityAuthorizationCard({
  authorization,
  busy,
  onConfirm,
  onCancel
}: {
  authorization: PendingCapabilityAuthorization;
  busy: boolean;
  onConfirm(): void;
  onCancel(): void;
}) {
  return <ConfirmationBubble value={presentCapabilityAuthorization(authorization, busy)} onConfirm={onConfirm} onReject={onCancel} />;
}
