import type { ModelProvider } from '@myself/agent-core';
import { describe, expect, test, vi } from 'vitest';
import type { AgentFileTools } from '../src/main/agent/agent-service';
import type { PowerShellTool } from '../src/main/agent/powershell-tool';
import { createMainAgentSession } from '../src/main/agent/main-agent-session-factory';

const provider: ModelProvider = {
  respond: vi.fn()
};

const fileTools: AgentFileTools = {
  executeRead: vi.fn(),
  preview: vi.fn(),
  executeWrite: vi.fn()
};

function input(taskKind: 'file' | 'powershell') {
  return {
    taskKind,
    authorizedRootPath: 'D:\\authorized',
    generation: 'generation-1',
    fileDisclosureAllowed: true,
    provider,
    fallbackProviders: [],
    createFileTools: vi.fn(async () => fileTools),
    createPowerShellTool: vi.fn(() => ({}) as PowerShellTool)
  };
}

describe('Main 能力会话工厂', () => {
  test('PowerShell 会话只注册 builtin.powershell.run 且不构造文件能力', async () => {
    const options = input('powershell');

    const session = await createMainAgentSession(options);

    expect(session.taskKind).toBe('powershell');
    expect(session.tools.map(tool => tool.function.name)).toEqual(['builtin.powershell.run']);
    expect(options.createPowerShellTool).toHaveBeenCalledOnce();
    expect(options.createFileTools).not.toHaveBeenCalled();
  });

  test('文件会话只注册五个文件工具且不构造 PowerShell', async () => {
    const options = input('file');

    const session = await createMainAgentSession(options);

    expect(session.taskKind).toBe('file');
    expect(session.tools.map(tool => tool.function.name).sort()).toEqual([
      'builtin.files.apply_patch',
      'builtin.files.create_file',
      'builtin.files.delete_file',
      'builtin.files.list_files',
      'builtin.files.read_file'
    ]);
    expect(options.createFileTools).toHaveBeenCalledOnce();
    expect(options.createPowerShellTool).not.toHaveBeenCalled();
  });
});
