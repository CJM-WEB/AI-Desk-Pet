import type { ModelProvider } from '@myself/agent-core';
import { describe, expect, test, vi } from 'vitest';
import type { AgentFileTools } from '../src/main/agent/agent-service';
import type { PowerShellTool } from '../src/main/agent/powershell-tool';
import { createMainAgentSession } from '../src/main/agent/main-agent-session-factory';

const provider: ModelProvider = {
  respond: vi.fn()
};

const fileTools: AgentFileTools = {
  executeRead: vi.fn(async () => undefined),
  preview: vi.fn(),
  executeWrite: vi.fn()
};

function input(initialCapability: 'file' | 'powershell') {
  return {
    initialCapability,
    authorizedRootPath: 'D:\\authorized',
    generation: 'generation-1',
    provider,
    fallbackProviders: [],
    createFileTools: vi.fn(async () => fileTools),
    createPowerShellTool: vi.fn(() => ({}) as PowerShellTool)
  };
}

describe('Main 能力会话工厂', () => {
  test('统一 Agent 会话同时注册文件与 PowerShell 能力', async () => {
    const options = input('powershell');

    const session = await createMainAgentSession(options);

    expect(session).toMatchObject({ taskKind: 'agent', initialCapability: 'powershell' });
    expect(session.tools.map(tool => tool.function.name)).toEqual(expect.arrayContaining([
      'builtin.powershell.run',
      'builtin.files.create_file',
      'builtin.files.read_file'
    ]));
    expect(options.createPowerShellTool).toHaveBeenCalledOnce();
    expect(options.createFileTools).toHaveBeenCalledOnce();
  });

  test('PowerShell 会话把高风险命令交给确认而非权限拒绝', async () => {
    const session = await createMainAgentSession(input('powershell'));

    const prepared = session.toolRuntime.prepare({
      requestId: 'shell-1',
      toolName: 'builtin.powershell.run',
      arguments: { command: 'Get-ChildItem' }
    });

    expect(prepared.decision).toBe('confirm');
    expect(prepared.executionRequest.toolName).toBe('powershell');
  });

  test('文件首选会话仍保留统一 PowerShell 工具供可信结果后的组合任务', async () => {
    const options = input('file');

    const session = await createMainAgentSession(options);

    expect(session).toMatchObject({ taskKind: 'agent', initialCapability: 'file' });
    expect(session.tools.map(tool => tool.function.name).sort()).toEqual([
      'builtin.files.apply_patch',
      'builtin.files.create_directory',
      'builtin.files.create_file',
      'builtin.files.delete_file',
      'builtin.files.edit_file',
      'builtin.files.glob_files',
      'builtin.files.grep_files',
      'builtin.files.list_files',
      'builtin.files.move_file',
      'builtin.files.read_file',
      'builtin.powershell.run'
    ]);
    expect(options.createFileTools).toHaveBeenCalledOnce();
    expect(options.createPowerShellTool).toHaveBeenCalledOnce();
  });

  test('显式文件会话始终调用受控读取端口', async () => {
    const session = await createMainAgentSession(input('file'));

    expect(session.tools.map(tool => tool.function.name).sort()).toEqual([
      'builtin.files.apply_patch',
      'builtin.files.create_directory',
      'builtin.files.create_file',
      'builtin.files.delete_file',
      'builtin.files.edit_file',
      'builtin.files.glob_files',
      'builtin.files.grep_files',
      'builtin.files.list_files',
      'builtin.files.move_file',
      'builtin.files.read_file',
      'builtin.powershell.run'
    ]);
    await expect(session.toolRuntime.executeRead({
      requestId: 'read-private-file',
      toolName: 'read_file',
      arguments: { relativePath: 'private.txt' }
    })).resolves.toEqual(undefined);
    expect(fileTools.executeRead).toHaveBeenCalledWith({
      requestId: 'read-private-file',
      toolName: 'read_file',
      arguments: { relativePath: 'private.txt' }
    });
  });

  test('文件会话保持仅可确认的可恢复写入策略', async () => {
    const session = await createMainAgentSession(input('file'));

    const prepared = session.toolRuntime.prepare({
      requestId: 'file-1',
      toolName: 'builtin.files.create_file',
      arguments: { relativePath: 'note.txt', content: '内容' }
    });

    expect(prepared.decision).toBe('confirm');
    expect(prepared.executionRequest.toolName).toBe('create_file');

    const directory = session.toolRuntime.prepare({
      requestId: 'directory-1',
      toolName: 'builtin.files.create_directory',
      arguments: { relativePath: 'abc' }
    });
    expect(directory.decision).toBe('confirm');
    expect(directory.executionRequest.toolName).toBe('create_directory');

    const move = session.toolRuntime.prepare({
      requestId: 'move-1',
      toolName: 'builtin.files.move_file',
      arguments: { sourceRelativePath: 'note.txt', targetDirectoryRelativePath: 'archive' }
    });
    expect(move.decision).toBe('confirm');
    expect(move.executionRequest.toolName).toBe('move_file');

    const edit = session.toolRuntime.prepare({
      requestId: 'edit-1',
      toolName: 'builtin.files.edit_file',
      arguments: { relativePath: 'note.txt', oldString: '旧', newString: '新' }
    });
    expect(edit.decision).toBe('confirm');
    expect(edit.executionRequest.toolName).toBe('edit_file');
  });

  test.each(['file', 'powershell'] as const)(
    '%s 能力规划提示把工具调用与宿主确认职责严格分开',
    async taskKind => {
      const session = await createMainAgentSession(input(taskKind));
      const systemPrompt = session.messages[0]?.content ?? '';

      expect(systemPrompt).toContain('参数齐全时立即调用工具');
      expect(systemPrompt).toContain('绝不能自行索要操作确认');
      expect(systemPrompt).toContain('确认完全由宿主在工具调用后生成确认卡');
      expect(systemPrompt).toContain('澄清仅用于缺失执行必需参数');
    }
  );
});
