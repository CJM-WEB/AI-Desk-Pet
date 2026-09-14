// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { TaskPermissionRequiredEvent } from '@myself/shared-types';
import { ConfirmationCard } from '../src/renderer/src/chat/ConfirmationCard';
import { CapabilityAuthorizationCard } from '../src/renderer/src/chat/CapabilityAuthorizationCard';
import { HistoryDisclosureCard } from '../src/renderer/src/chat/HistoryDisclosureCard';
import { presentCapabilityAuthorization, presentHistoryDisclosure, presentTaskPermission } from '../src/renderer/src/chat/confirmation-presentation';
import type { PendingCapabilityAuthorization, PendingHistoryDisclosure } from '../src/renderer/src/stores/task-store';

const authorization: PendingCapabilityAuthorization = {
  requestId: 'scope-one', capability: 'file', requestSummary: '检查项目并运行测试',
  targetProviderName: 'DeepSeek', modelId: 'model-one', directory: 'D:\\项目目录',
  actions: ['read', 'create', 'edit'], approvedCommands: ['pnpm.cmd test', 'pnpm.cmd run build'],
  expiresAt: '2026-09-13T09:00:00.000Z'
};
const disclosure: PendingHistoryDisclosure = {
  requestId: 'disclosure-one', targetProviderName: '模型服务', messageCount: 4, characterCount: 120
};

afterEach(cleanup);

describe('确认信息仅映射现有展示事实', () => {
  test.each([
    ['delete', '待授权操作', '授权', '确认移入回收站', '目标将移入 Windows 回收站；已完成的其他操作不会撤销。'],
    ['overwrite', '明确文件编辑操作', '覆盖', '确认覆盖文件', '本次操作将覆盖已有文件，请核对目标。'],
    ['external_directory', '待授权操作', '授权', '确认访问目标', '本次请求超出原授权目录，仅确认当前具体访问。']
  ] as const)('%s 映射保留每一个目标和原操作后果', (action, title, approveLabel, approveDescription, explanation) => {
    const value = presentTaskPermission({
      type: 'task_permission_required', actionId: `permission-${action}`, summary: '核对两个准确目标',
      request: { action, resources: ['D:\\项目\\第一份.txt', 'D:\\项目\\第二份.txt'] }
    }, false);
    expect(value).toMatchObject({
      id: `permission-${action}`, kind: 'permission', title, approveLabel, approveDescription,
      rejectDescription: '拒绝本次操作', busy: false, error: null
    });
    expect(value.details).toEqual([
      '需要你确认', '核对两个准确目标', 'D:\\项目\\第一份.txt', 'D:\\项目\\第二份.txt', explanation
    ]);
  });

  test('命令许可保留完整多行命令和准确工作目录，不泄露内部资源标识', () => {
    const command = "pnpm.cmd test\nWrite-Output '保持完整命令'";
    const value = presentTaskPermission({
      type: 'task_permission_required', actionId: 'command-one', summary: '运行检查',
      request: { action: 'bash', cwd: 'D:\\项目目录', command, resources: ['command-sha256:内部标识'] }
    }, true, '命令许可处理失败');
    expect(value).toMatchObject({ id: 'command-one', kind: 'permission', title: '待授权操作', approveLabel: '授权',
      approveDescription: '确认运行命令', rejectDescription: '拒绝本次操作', busy: true, error: '命令许可处理失败' });
    expect(value.details).toEqual(['需要你确认', '运行检查', '工作目录', 'D:\\项目目录', command,
      '命令以当前 Windows 用户权限在前台执行，请核对完整命令与工作目录。']);
    expect(JSON.stringify(value)).not.toContain('command-sha256:内部标识');
  });

  test('重复保护保留原工具、重复次数以及结束整项任务的后果', () => {
    const value = presentTaskPermission({
      type: 'task_permission_required', actionId: 'loop-one', summary: '重复操作保护',
      request: { action: 'doom_loop', tool: 'read', repeatCount: 3 }
    }, false);
    expect(value).toMatchObject({ id: 'loop-one', title: '待授权操作', approveLabel: '授权',
      approveDescription: '仅继续这一次', rejectDescription: '结束当前任务' });
    expect(value.details).toEqual(['需要你确认', '重复操作保护', 'read', '连续 3 次',
      '同一操作连续重复；继续仅放行本次，原文件和命令许可仍有效。',
      '结束当前任务不会撤销已完成的本地操作。']);
  });

  test('范围授权保留模型、目录、完整预批准命令与原能力限制', () => {
    const value = presentCapabilityAuthorization(authorization, false);
    expect(value).toMatchObject({ id: 'scope-one', kind: 'capability', title: '待授权操作', approveLabel: '授权',
      approveDescription: '授权并开始任务', rejectDescription: '取消', busy: false, error: null });
    expect(value.details).toEqual(['允许进入本地任务吗？', '检查项目并运行测试', 'DeepSeek · model-one',
      '任务目录：', 'D:\\项目目录',
      '允许在此目录内连续读取、创建和编辑文件；覆盖、删除、目录外访问及其他命令会另行询问。',
      '本任务预先批准的完整命令：', 'pnpm.cmd test', 'pnpm.cmd run build']);
  });

  test('范围授权没有预批准命令时明确保留逐次询问承诺', () => {
    const value = presentCapabilityAuthorization({ ...authorization, approvedCommands: [] }, true, '暂未处理成功');
    expect(value.details.at(-1)).toBe('无；命令执行时单独询问。');
    expect(value).toMatchObject({ busy: true, error: '暂未处理成功' });
  });

  test('历史披露保留目标及计数，两种短文案仍分别对应原共享选择', () => {
    const value = presentHistoryDisclosure(disclosure, false);
    expect(value).toMatchObject({ id: 'disclosure-one', kind: 'disclosure', title: '待授权操作', approveLabel: '授权',
      approveDescription: '仅本次共享历史', rejectDescription: '仅发送当前消息', busy: false, error: null });
    expect(value.details).toEqual(['需要你确认', '是否共享当前会话历史？', '目标服务', '模型服务', '共享摘要',
      '4 条消息', '120 个字符', '你可以只为这一次共享历史，也可以仅发送当前消息。']);
  });

  test('忙碌与失败仅作为显示字段，不改变原请求身份或原对象', () => {
    const original = structuredClone(disclosure);
    const value = presentHistoryDisclosure(disclosure, true, '历史披露处理失败');
    expect(value).toMatchObject({ id: 'disclosure-one', busy: true, error: '历史披露处理失败' });
    expect(disclosure).toEqual(original);
  });
});

describe('原确认卡薄包装保留回调', () => {
  test.each([
    ['delete', '确认移入回收站'], ['overwrite', '确认覆盖文件'], ['external_directory', '确认访问目标']
  ] as const)('%s 详情默认折叠且新视觉仍调用原许可回调', (action, approveName) => {
    const onConfirm = vi.fn(), onCancel = vi.fn();
    render(<ConfirmationCard action={{ type: 'task_permission_required', actionId: 'permission-one', summary: '检查目标',
      request: { action, resources: ['D:\\项目\\文件.txt'] } }} busy={false} onConfirm={onConfirm} onCancel={onCancel} />);
    expect(screen.queryByText('D:\\项目\\文件.txt')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: action === 'overwrite' ? '明确文件编辑操作' : '待授权操作' }));
    expect(screen.getByText('D:\\项目\\文件.txt')).toBeTruthy();
    const approve = screen.getByRole('button', { name: approveName });
    const reject = screen.getByRole('button', { name: '拒绝本次操作' });
    expect(approve.textContent).toBe(action === 'overwrite' ? '覆盖' : '授权');
    expect(reject.textContent).toBe('拒绝');
    fireEvent.click(approve); fireEvent.click(reject);
    expect(onConfirm).toHaveBeenCalledOnce(); expect(onCancel).toHaveBeenCalledOnce();
  });

  test('命令与重复保护仍分别转交现有批准和取消回调', () => {
    const onConfirm = vi.fn(), onCancel = vi.fn();
    const action: TaskPermissionRequiredEvent = { type: 'task_permission_required', actionId: 'command-one', summary: '运行命令',
      request: { action: 'bash', cwd: 'D:\\项目', command: 'pnpm.cmd test', resources: [] } };
    const view = render(<ConfirmationCard action={action} busy={false} onConfirm={onConfirm} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: '确认运行命令' }));
    fireEvent.click(screen.getByRole('button', { name: '拒绝本次操作' }));
    view.rerender(<ConfirmationCard action={{ ...action, actionId: 'loop-one', request: { action: 'doom_loop', tool: 'read', repeatCount: 3 } }}
      busy={false} onConfirm={onConfirm} onCancel={onCancel} />);
    fireEvent.click(screen.getByRole('button', { name: '仅继续这一次' }));
    fireEvent.click(screen.getByRole('button', { name: '结束当前任务' }));
    expect(onConfirm).toHaveBeenCalledTimes(2); expect(onCancel).toHaveBeenCalledTimes(2);
  });

  test('范围授权保留准确目录与原确认取消回调', () => {
    const onConfirm = vi.fn(), onCancel = vi.fn();
    render(<CapabilityAuthorizationCard authorization={authorization} busy={false} onConfirm={onConfirm} onCancel={onCancel} />);
    expect(screen.queryByText('D:\\项目目录')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: '待授权操作' }));
    expect(screen.getByText('D:\\项目目录')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '授权并开始任务' }));
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onConfirm).toHaveBeenCalledOnce(); expect(onCancel).toHaveBeenCalledOnce();
  });

  test.each([null, 'share_once', 'current_message_only'] as const)('历史披露 busyDecision=%s 保留原决策回调和禁用行为', busyDecision => {
    const onShareOnce = vi.fn(), onCurrentMessageOnly = vi.fn();
    render(<HistoryDisclosureCard disclosure={disclosure} busyDecision={busyDecision} disabled={false}
      onShareOnce={onShareOnce} onCurrentMessageOnly={onCurrentMessageOnly} />);
    const share = screen.getByRole('button', { name: '仅本次共享历史' }) as HTMLButtonElement;
    const current = screen.getByRole('button', { name: '仅发送当前消息' }) as HTMLButtonElement;
    expect(share.textContent).toBe('授权'); expect(current.textContent).toBe('拒绝');
    expect(share.disabled).toBe(busyDecision !== null); expect(current.disabled).toBe(busyDecision !== null);
    fireEvent.click(share); fireEvent.click(current);
    expect(onShareOnce).toHaveBeenCalledTimes(busyDecision === null ? 1 : 0);
    expect(onCurrentMessageOnly).toHaveBeenCalledTimes(busyDecision === null ? 1 : 0);
  });

  test('外部disabled继续禁用历史两种决策', () => {
    const onShareOnce = vi.fn(), onCurrentMessageOnly = vi.fn();
    render(<HistoryDisclosureCard disclosure={disclosure} busyDecision={null} disabled
      onShareOnce={onShareOnce} onCurrentMessageOnly={onCurrentMessageOnly} />);
    fireEvent.click(screen.getByRole('button', { name: '仅本次共享历史' }));
    fireEvent.click(screen.getByRole('button', { name: '仅发送当前消息' }));
    expect(onShareOnce).not.toHaveBeenCalled(); expect(onCurrentMessageOnly).not.toHaveBeenCalled();
  });
});
