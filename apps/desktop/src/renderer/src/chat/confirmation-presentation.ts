import type { TaskPermissionRequiredEvent } from '@myself/shared-types';
import type { ChatPresentationSnapshot } from '../../../shared/chat-presentation';
import type { PendingCapabilityAuthorization, PendingHistoryDisclosure } from '../stores/task-store';

export type ConfirmationPresentation = NonNullable<ChatPresentationSnapshot['confirmation']>;

/** 仅搬运原许可卡的可见文字与按钮含义，不决定是否批准或执行操作。 */
export function presentTaskPermission(
  action: TaskPermissionRequiredEvent,
  busy: boolean,
  error: string | null = null
): ConfirmationPresentation {
  const request = action.request;
  const deletion = request.action === 'delete';
  const loop = request.action === 'doom_loop';
  const approveDescription = loop ? '仅继续这一次' : request.action === 'bash' ? '确认运行命令'
    : deletion ? '确认移入回收站' : request.action === 'overwrite' ? '确认覆盖文件' : '确认访问目标';
  const explanation = loop ? '同一操作连续重复；继续仅放行本次，原文件和命令许可仍有效。'
    : deletion ? '目标将移入 Windows 回收站；已完成的其他操作不会撤销。'
    : request.action === 'overwrite' ? '本次操作将覆盖已有文件，请核对目标。'
    : request.action === 'external_directory' ? '本次请求超出原授权目录，仅确认当前具体访问。'
    : '命令以当前 Windows 用户权限在前台执行，请核对完整命令与工作目录。';
  const targets = request.action === 'doom_loop' ? [request.tool, `连续 ${request.repeatCount} 次`]
    : request.action === 'bash' ? ['工作目录', request.cwd, request.command] : [...request.resources];
  return {
    id: action.actionId,
    kind: 'permission',
    title: request.action === 'overwrite' ? '明确文件编辑操作' : '待授权操作',
    details: ['需要你确认', action.summary, ...targets, explanation,
      ...(loop ? ['结束当前任务不会撤销已完成的本地操作。'] : [])],
    approveLabel: request.action === 'overwrite' ? '覆盖' : '授权',
    approveDescription,
    rejectDescription: loop ? '结束当前任务' : '拒绝本次操作',
    busy,
    error
  };
}

/** 完整命令与目录保持原样；展示限额由桥拒绝后转原界面回退，不在此截断。 */
export function presentCapabilityAuthorization(
  authorization: PendingCapabilityAuthorization,
  busy: boolean,
  error: string | null = null
): ConfirmationPresentation {
  return {
    id: authorization.requestId,
    kind: 'capability',
    title: '待授权操作',
    details: ['允许进入本地任务吗？', authorization.requestSummary,
      `${authorization.targetProviderName} · ${authorization.modelId}`, '任务目录：', authorization.directory,
      '允许在此目录内连续读取、创建和编辑文件；覆盖、删除、目录外访问及其他命令会另行询问。',
      '本任务预先批准的完整命令：',
      ...(authorization.approvedCommands.length ? authorization.approvedCommands : ['无；命令执行时单独询问。'])],
    approveLabel: '授权',
    approveDescription: '授权并开始任务',
    rejectDescription: '取消',
    busy,
    error
  };
}

/** 左侧拒绝仅对应拒绝共享历史，仍保留原“仅发送当前消息”回调含义。 */
export function presentHistoryDisclosure(
  disclosure: PendingHistoryDisclosure,
  busy: boolean,
  error: string | null = null
): ConfirmationPresentation {
  return {
    id: disclosure.requestId,
    kind: 'disclosure',
    title: '待授权操作',
    details: ['需要你确认', '是否共享当前会话历史？', '目标服务', disclosure.targetProviderName,
      '共享摘要', `${disclosure.messageCount} 条消息`, `${disclosure.characterCount} 个字符`,
      '你可以只为这一次共享历史，也可以仅发送当前消息。'],
    approveLabel: '授权',
    approveDescription: '仅本次共享历史',
    rejectDescription: '仅发送当前消息',
    busy,
    error
  };
}
