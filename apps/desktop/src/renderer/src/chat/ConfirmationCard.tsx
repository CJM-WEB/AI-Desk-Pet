import type { TaskPermissionRequiredEvent } from '@myself/shared-types';
import { ConfirmationBubble } from './ChatBubbleView';
import { presentTaskPermission } from './confirmation-presentation';

export interface ConfirmationCardProps {
  action: TaskPermissionRequiredEvent;
  busy: boolean;
  onConfirm(): void;
  onCancel(): void;
}

/** 原具体许可回调保持不变，详情与短文案统一由展示映射提供。 */
export function ConfirmationCard({ action, busy, onConfirm, onCancel }: ConfirmationCardProps) {
  return <ConfirmationBubble value={presentTaskPermission(action, busy)} onConfirm={onConfirm} onReject={onCancel} />;
}
