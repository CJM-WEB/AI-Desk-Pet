import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { lstat, mkdir, readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import {
  startProviderServer,
  type ProviderStep
} from '../fixtures/provider-server';

type ElectronFixtureModule = {
  createElectronLaunchPlan(options: {
    workspaceRoot: string;
    cdpPort: number;
    userDataDirectory: string;
    authorizedRootDirectory: string;
    parentEnvironment?: NodeJS.ProcessEnv;
  }): {
    executablePath: string;
    applicationEntry: string;
    cdpEndpoint: string;
    args: string[];
    environment: NodeJS.ProcessEnv;
  };
  redactElectronLog(
    text: string,
    secrets: { apiKey: string; authorizedRootDirectory: string }
  ): string;
  waitForCdpReady(options: {
    endpoint: string;
    timeoutMs: number;
    intervalMs?: number;
    probe?: (endpoint: string) => Promise<boolean>;
  }): Promise<void>;
  probeWindowsProcess(
    processId: number,
    options?: {
      signal?: AbortSignal;
      runCommand?(file: string, args: string[], signal?: AbortSignal): Promise<{
        exitCode: number;
        stdout: string;
        stderr: string;
      }>;
    }
  ): Promise<
    | { status: 'absent' }
    | { status: 'running'; executablePath: string }
  >;
  terminateElectronProcess(
    process: FakeElectronProcess,
    executablePath: string,
    options?: {
      platform?: NodeJS.Platform;
      gracefulExitTimeoutMs?: number;
      taskkillTimeoutMs?: number;
      helperExitTimeoutMs?: number;
      processExitTimeoutMs?: number;
      probeTimeoutMs?: number;
      probeIntervalMs?: number;
      spawnCommand?(file: string, args: string[]): FakeCommandProcess;
      processProbe?(processId: number, signal?: AbortSignal): Promise<
        | { status: 'absent' }
        | { status: 'running'; executablePath: string }
      >;
      onDiagnostic?(message: string): void;
    }
  ): Promise<void>;
  createElectronAppFixture(options: {
    workspaceRoot: string;
    apiKey: string;
    launchTimeoutMs?: number;
    operationTimeoutMs?: number;
    dependencies?: {
      allocateLoopbackPort(): Promise<number>;
      createTemporaryDirectories(): Promise<{
        baseDirectory: string;
        userDataDirectory: string;
        authorizedRootDirectory: string;
      }>;
      spawnProcess(plan: ElectronLaunchPlan): FakeElectronProcess;
      waitForReady(options: { endpoint: string; timeoutMs: number }): Promise<void>;
      connectOverCdp(endpoint: string): Promise<{ close(): Promise<void> }>;
      terminateProcess(process: FakeElectronProcess, executablePath: string): Promise<void>;
      removeTemporaryBase(baseDirectory: string): Promise<void>;
    };
  }): Promise<{
    browser: {
      contexts(): Array<{ pages(): Page[] }>;
      close(): Promise<void>;
    };
    processId: number;
    executablePath: string;
    userDataDirectory: string;
    authorizedRootDirectory: string;
    logs: readonly string[];
    restart(): Promise<void>;
    dispose(): Promise<void>;
  }>;
};

type ElectronLaunchPlan = ReturnType<ElectronFixtureModule['createElectronLaunchPlan']>;

type FakeElectronProcess = EventEmitter & {
  pid: number;
  spawnfile: string;
  stdout: PassThrough;
  stderr: PassThrough;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill?: (signal?: NodeJS.Signals | number) => boolean;
};

type FakeCommandProcess = EventEmitter & {
  exitCode: number | null;
  signalCode?: NodeJS.Signals | null;
  kill?: (signal?: NodeJS.Signals | number) => boolean;
};

function fakeElectronProcess(pid: number, spawnfile: string): FakeElectronProcess {
  return Object.assign(new EventEmitter(), {
    pid,
    spawnfile,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    exitCode: null as number | null,
    signalCode: null as NodeJS.Signals | null
  });
}

function emitFakeExit(process: FakeElectronProcess | FakeCommandProcess, code: number): void {
  process.exitCode = code;
  process.emit('exit', code, null);
}

type JourneyToolName = 'list_directory' | 'create_file' | 'rename_entry';

function runtimeDiagnosticKey(): string {
  return `myself-e2e-${randomBytes(24).toString('hex')}`;
}

function toolResponse(
  requestId: string,
  toolName: JourneyToolName,
  arguments_: Record<string, unknown>
): ProviderStep['response'] {
  return {
    type: 'tool_request',
    request: { requestId, toolName, arguments: arguments_ }
  };
}

function lastToolResult(request: Parameters<NonNullable<ProviderStep['inspect']>>[0]): unknown {
  const message = request.messages.at(-1);
  if (!message || message.role !== 'tool') throw new Error('缺少工具结果消息');
  return JSON.parse(message.content) as unknown;
}

async function pathExistsForAssertion(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw new Error('文件系统存在性检查失败');
  }
}

async function readTextForAssertion(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch {
    throw new Error('文件系统文本读取失败');
  }
}

function sanitizeCapturedDiagnostic(
  text: string,
  apiKey: string,
  authorizedRootDirectory: string
): string {
  return text
    .replace(/authorization\s*:[^\r\n]*/giu, '[已脱敏]')
    .replaceAll(apiKey, '[已脱敏]')
    .replaceAll(authorizedRootDirectory, '[已脱敏]');
}

async function submitChatMessage(page: Page, text: string): Promise<void> {
  await page.getByLabel('和我说点什么').fill(text);
  await page.getByRole('button', { name: '发送给 Myself' }).click();
}

async function loadElectronFixtureModule(): Promise<ElectronFixtureModule | null> {
  try {
    const moduleUrl = pathToFileURL(
      resolve(process.cwd(), 'tests/fixtures/electron-app.ts')
    ).href;
    return await import(moduleUrl) as ElectronFixtureModule;
  } catch {
    return null;
  }
}

test.describe('直接启动 Electron 的 CDP 夹具边界', () => {
  test('使用项目精确 Electron 路径、构建入口、随机回环 CDP 参数和隔离环境', async () => {
    const fixture = await loadElectronFixtureModule();
    expect(fixture, '应提供直接启动 Electron 的 CDP 夹具').not.toBeNull();
    if (!fixture) return;

    const workspaceRoot = resolve(process.cwd());
    const userDataDirectory = resolve('C:\\Temp\\myself-user-data');
    const authorizedRootDirectory = resolve('C:\\Temp\\myself-authorized-root');
    const requireFromDesktop = createRequire(resolve(workspaceRoot, 'apps/desktop/package.json'));
    const expectedExecutable = requireFromDesktop('electron') as string;
    const plan = fixture.createElectronLaunchPlan({
      workspaceRoot,
      cdpPort: 43123,
      userDataDirectory,
      authorizedRootDirectory,
      parentEnvironment: { PATH: process.env['PATH'] }
    });

    expect(plan.executablePath).toBe(expectedExecutable);
    expect(plan.applicationEntry).toBe(resolve(workspaceRoot, 'apps/desktop/out/main/index.js'));
    expect(plan.cdpEndpoint).toBe('http://127.0.0.1:43123');
    expect(plan.args).toEqual([
      '--remote-debugging-address=127.0.0.1',
      '--remote-debugging-port=43123',
      '--disable-gpu',
      '--disable-software-rasterizer',
      '--no-sandbox',
      plan.applicationEntry
    ]);
    expect(plan.args.join(' ')).not.toMatch(/--inspect(?:-brk)?(?:=|\s|$)/u);
    expect(plan.environment).toMatchObject({
      MYSELF_E2E: '1',
      MYSELF_E2E_USER_DATA: userDataDirectory,
      MYSELF_E2E_AUTHORIZED_ROOT: authorizedRootDirectory
    });
  });

  test('拒绝非回环 CDP 端点且等待使用有界超时', async () => {
    const fixture = await loadElectronFixtureModule();
    expect(fixture, '应提供直接启动 Electron 的 CDP 夹具').not.toBeNull();
    if (!fixture) return;

    await expect(fixture.waitForCdpReady({
      endpoint: 'http://0.0.0.0:9222',
      timeoutMs: 20,
      probe: async () => true
    })).rejects.toThrow('CDP_ENDPOINT_NOT_LOOPBACK');

    const startedAt = Date.now();
    await expect(fixture.waitForCdpReady({
      endpoint: 'http://127.0.0.1:43123',
      timeoutMs: 20,
      intervalMs: 1,
      probe: async () => false
    })).rejects.toThrow('CDP_READY_TIMEOUT');
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  test('捕获日志时清除 API Key、Authorization Header 和授权根绝对路径', async () => {
    const fixture = await loadElectronFixtureModule();
    expect(fixture, '应提供直接启动 Electron 的 CDP 夹具').not.toBeNull();
    if (!fixture) return;

    const apiKey = runtimeDiagnosticKey();
    const authorizedRootDirectory = 'C:\\Temp\\myself-authorized-root';
    const sanitized = fixture.redactElectronLog(
      `Authorization: Bearer ${apiKey}\nroot=${authorizedRootDirectory}\nkey=${apiKey}`,
      { apiKey, authorizedRootDirectory }
    );

    expect(sanitized).not.toContain(apiKey);
    expect(sanitized).not.toContain(authorizedRootDirectory);
    expect(sanitized).not.toMatch(/Authorization\s*:/iu);
    expect(sanitized).toContain('[已脱敏]');
  });

  test('跨 chunk 拆分的动态 key、Authorization Header 与授权根在所有可观察诊断中仍脱敏', async () => {
    const fixtureModule = await loadElectronFixtureModule();
    expect(typeof fixtureModule?.createElectronAppFixture).toBe('function');
    if (!fixtureModule?.createElectronAppFixture) return;

    const workspaceRoot = resolve(process.cwd());
    const requireFromDesktop = createRequire(resolve(workspaceRoot, 'apps/desktop/package.json'));
    const expectedExecutable = requireFromDesktop('electron') as string;
    const fakeProcess = fakeElectronProcess(6050, expectedExecutable);
    const baseDirectory = resolve('C:\\Temp\\myself-fixture-split-secret');
    const authorizedRootDirectory = resolve(baseDirectory, 'authorized-root-secret');
    const apiKey = runtimeDiagnosticKey();
    let closeCalls = 0;
    const fixture = await fixtureModule.createElectronAppFixture({
      workspaceRoot,
      apiKey,
      operationTimeoutMs: 20,
      dependencies: {
        allocateLoopbackPort: async () => 43133,
        createTemporaryDirectories: async () => ({
          baseDirectory,
          userDataDirectory: resolve(baseDirectory, 'user-data'),
          authorizedRootDirectory
        }),
        spawnProcess: () => {
          queueMicrotask(() => {
            fakeProcess.stdout.write('Authori');
            fakeProcess.stderr.write(`zation: Bearer ${apiKey.slice(0, 11)}`);
            fakeProcess.stdout.write(`${apiKey.slice(11, 35)}`);
            fakeProcess.stderr.write(`${apiKey.slice(35)}\nroot=${authorizedRootDirectory.slice(0, 17)}`);
            fakeProcess.stdout.write(authorizedRootDirectory.slice(17));
          });
          return fakeProcess;
        },
        waitForReady: async () => undefined,
        connectOverCdp: async () => ({
          close: () => {
            closeCalls += 1;
            return closeCalls === 1
              ? new Promise<void>(() => undefined)
              : Promise.resolve();
          }
        }),
        terminateProcess: async child => emitFakeExit(child, 0),
        removeTemporaryBase: async () => undefined
      }
    });

    let caught: unknown;
    try {
      await fixture.dispose();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);

    const observableText = [
      fixture.logs.join(''),
      String(caught),
      caught instanceof Error ? caught.message : '',
      caught instanceof Error ? caught.stack ?? '' : ''
    ].join('\n');
    expect(observableText).not.toContain(apiKey);
    expect(observableText).not.toContain(authorizedRootDirectory);
    expect(observableText).not.toMatch(/Authorization\s*:/iu);
    expect(observableText).toContain('[已脱敏]');

    await fixture.dispose();
  });

  test('自然退出宽限期内 child 退出时不启动任何强制清理', async () => {
    const fixture = await loadElectronFixtureModule();
    expect(typeof fixture?.terminateElectronProcess).toBe('function');
    if (!fixture?.terminateElectronProcess) return;

    const executablePath = resolve('C:\\project\\electron.exe');
    const child = fakeElectronProcess(6105, executablePath);
    let spawnCalls = 0;
    let probeCalls = 0;
    let killCalls = 0;
    child.kill = () => {
      killCalls += 1;
      return true;
    };
    const naturalExit = setTimeout(() => {
      child.signalCode = 'SIGTERM';
      child.emit('exit', null, 'SIGTERM');
    }, 5);

    try {
      await fixture.terminateElectronProcess(child, executablePath, {
        platform: 'win32',
        gracefulExitTimeoutMs: 20,
        taskkillTimeoutMs: 20,
        processExitTimeoutMs: 10,
        spawnCommand: () => {
          spawnCalls += 1;
          const command = Object.assign(new EventEmitter(), {
            exitCode: null as number | null
          });
          setTimeout(() => emitFakeExit(command, 0), 10);
          return command;
        },
        processProbe: async () => {
          probeCalls += 1;
          return { status: 'running', executablePath };
        }
      });
    } finally {
      clearTimeout(naturalExit);
    }

    expect(spawnCalls).toBe(0);
    expect(probeCalls).toBe(0);
    expect(killCalls).toBe(0);
    expect(child.signalCode).toBe('SIGTERM');
  });

  test('taskkill 非零时仅回退终止原 PID，并确认原 child 退出', async () => {
    const fixture = await loadElectronFixtureModule();
    expect(typeof fixture?.terminateElectronProcess).toBe('function');
    if (!fixture?.terminateElectronProcess) return;

    const executablePath = resolve('C:\\project\\electron.exe');
    const child = fakeElectronProcess(6101, executablePath);
    const command = Object.assign(new EventEmitter(), {
      exitCode: null as number | null
    });
    const commandCalls: Array<{ file: string; args: string[] }> = [];
    const killSignals: Array<NodeJS.Signals | number | undefined> = [];
    child.kill = signal => {
      killSignals.push(signal);
      queueMicrotask(() => emitFakeExit(child, 137));
      return true;
    };

    await fixture.terminateElectronProcess(child, executablePath, {
      platform: 'win32',
      gracefulExitTimeoutMs: 1,
      taskkillTimeoutMs: 20,
      processExitTimeoutMs: 20,
      processProbe: async () => ({ status: 'running', executablePath }),
      spawnCommand: (file, args) => {
        commandCalls.push({ file, args });
        queueMicrotask(() => emitFakeExit(command, 1));
        return command;
      }
    });

    expect(commandCalls).toEqual([{
      file: 'taskkill.exe',
      args: ['/PID', '6101', '/T', '/F']
    }]);
    expect(killSignals).toEqual(['SIGKILL']);
    expect(child.exitCode).toBe(137);
  });

  test('taskkill 异步报错后原 PID 已消失时成功收敛并清理监听器', async () => {
    const fixture = await loadElectronFixtureModule();
    expect(typeof fixture?.terminateElectronProcess).toBe('function');
    if (!fixture?.terminateElectronProcess) return;

    const executablePath = resolve('C:\\project\\electron.exe');
    const child = fakeElectronProcess(6107, executablePath);
    const command = Object.assign(new EventEmitter(), {
      exitCode: null as number | null
    });
    let probeCalls = 0;
    let killCalls = 0;
    child.kill = () => {
      killCalls += 1;
      return true;
    };

    await fixture.terminateElectronProcess(child, executablePath, {
      platform: 'win32',
      gracefulExitTimeoutMs: 1,
      taskkillTimeoutMs: 20,
      processExitTimeoutMs: 10,
      processProbe: async () => {
        probeCalls += 1;
        return probeCalls === 1
          ? { status: 'running', executablePath }
          : { status: 'absent' };
      },
      spawnCommand: () => {
        queueMicrotask(() => command.emit('error', new Error('TASKKILL_ASYNC_FAILED')));
        return command;
      }
    });

    expect(probeCalls).toBe(2);
    expect(killCalls).toBe(0);
    expect(command.listenerCount('exit')).toBe(0);
    expect(command.listenerCount('error')).toBe(0);
  });

  test('taskkill 异步报错后原 PID 仍精确匹配时安全回退并脱敏诊断', async () => {
    const fixture = await loadElectronFixtureModule();
    expect(typeof fixture?.terminateElectronProcess).toBe('function');
    if (!fixture?.terminateElectronProcess) return;

    const apiKey = runtimeDiagnosticKey();
    const authorizedRootDirectory = resolve(
      'C:\\Temp',
      apiKey,
      'authorized-root'
    );
    const executablePath = resolve('C:\\project\\electron.exe');
    const child = fakeElectronProcess(6108, executablePath);
    const command = Object.assign(new EventEmitter(), {
      exitCode: null as number | null
    });
    let killCalls = 0;
    child.kill = signal => {
      expect(signal).toBe('SIGKILL');
      killCalls += 1;
      return true;
    };

    let thrownError: unknown;
    try {
      await fixture.terminateElectronProcess(child, executablePath, {
        platform: 'win32',
        gracefulExitTimeoutMs: 1,
        taskkillTimeoutMs: 20,
        processExitTimeoutMs: 5,
        probeIntervalMs: 1,
        processProbe: async () => ({ status: 'running', executablePath }),
        spawnCommand: () => {
          queueMicrotask(() => command.emit(
            'error',
            new Error(
              `Authorization: Bearer ${apiKey}\n`
              + `root=${authorizedRootDirectory}\n`
              + 'TASKKILL_ASYNC_FAILED'
            )
          ));
          return command;
        }
      });
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(Error);
    const diagnostic = (thrownError as Error).message;
    expect(diagnostic).toContain('ELECTRON_PROCESS_STILL_RUNNING:6108:TASKKILL_FAILED:');
    expect(diagnostic).toContain('[已脱敏]');
    expect(diagnostic).not.toContain(apiKey);
    expect(diagnostic).not.toContain(authorizedRootDirectory);
    expect(diagnostic).not.toContain('Authorization:');
    expect(killCalls).toBe(1);
    expect(command.listenerCount('exit')).toBe(0);
    expect(command.listenerCount('error')).toBe(0);
  });

  test('OS 进程探针：grace 后 PID 不存在时不得启动 taskkill', async () => {
    const fixture = await loadElectronFixtureModule();
    expect(typeof fixture?.terminateElectronProcess).toBe('function');
    if (!fixture?.terminateElectronProcess) return;

    const executablePath = resolve('C:\\project\\electron.exe');
    const child = fakeElectronProcess(6110, executablePath);
    const command = Object.assign(new EventEmitter(), {
      exitCode: null as number | null
    });
    let spawnCalls = 0;
    let killCalls = 0;
    let probeCalls = 0;
    child.kill = () => {
      killCalls += 1;
      return true;
    };

    await fixture.terminateElectronProcess(child, executablePath, {
      platform: 'win32',
      gracefulExitTimeoutMs: 1,
      taskkillTimeoutMs: 20,
      processExitTimeoutMs: 10,
      spawnCommand: () => {
        spawnCalls += 1;
        queueMicrotask(() => emitFakeExit(command, 255));
        return command;
      },
      processProbe: async processId => {
        expect(processId).toBe(6110);
        probeCalls += 1;
        return { status: 'absent' };
      }
    });

    expect(probeCalls).toBe(1);
    expect(spawnCalls).toBe(0);
    expect(killCalls).toBe(0);
    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBeNull();
  });

  test('OS 进程探针：默认预算覆盖 PowerShell 冷启动后仍能确认 PID 不存在', async () => {
    const fixture = await loadElectronFixtureModule();
    expect(typeof fixture?.terminateElectronProcess).toBe('function');
    if (!fixture?.terminateElectronProcess) return;

    const executablePath = resolve('C:\\project\\electron.exe');
    const child = fakeElectronProcess(6114, executablePath);
    const command = Object.assign(new EventEmitter(), {
      exitCode: null as number | null
    });
    let killCalls = 0;
    child.kill = () => {
      killCalls += 1;
      return true;
    };

    await fixture.terminateElectronProcess(child, executablePath, {
      platform: 'win32',
      gracefulExitTimeoutMs: 1,
      taskkillTimeoutMs: 20,
      processExitTimeoutMs: 10,
      spawnCommand: () => {
        queueMicrotask(() => emitFakeExit(command, 255));
        return command;
      },
      processProbe: () => new Promise(resolveProbe => {
        // 模拟本机 PowerShell 冷启动耗时超过旧的 750ms 默认预算。
        setTimeout(() => resolveProbe({ status: 'absent' }), 800);
      })
    });

    expect(killCalls).toBe(0);
  });

  test('OS 进程探针：精确项目进程仍存活时才 fallback，并轮询至 PID 不存在', async () => {
    const fixture = await loadElectronFixtureModule();
    expect(typeof fixture?.terminateElectronProcess).toBe('function');
    if (!fixture?.terminateElectronProcess) return;

    const executablePath = resolve('C:\\project\\electron.exe');
    const child = fakeElectronProcess(6111, executablePath);
    const command = Object.assign(new EventEmitter(), {
      exitCode: null as number | null
    });
    let killCalls = 0;
    let probeCalls = 0;
    child.kill = () => {
      killCalls += 1;
      return true;
    };

    await fixture.terminateElectronProcess(child, executablePath, {
      platform: 'win32',
      gracefulExitTimeoutMs: 1,
      taskkillTimeoutMs: 20,
      processExitTimeoutMs: 30,
      probeIntervalMs: 1,
      spawnCommand: () => {
        queueMicrotask(() => emitFakeExit(command, 255));
        return command;
      },
      processProbe: async () => {
        probeCalls += 1;
        return probeCalls <= 2
          ? { status: 'running', executablePath }
          : { status: 'absent' };
      }
    });

    expect(killCalls).toBe(1);
    expect(probeCalls).toBe(3);
    expect(child.exitCode).toBeNull();
  });

  test('OS 进程探针：PID 被其他路径复用时不得 kill 新进程', async () => {
    const fixture = await loadElectronFixtureModule();
    expect(typeof fixture?.terminateElectronProcess).toBe('function');
    if (!fixture?.terminateElectronProcess) return;

    const executablePath = resolve('C:\\project\\electron.exe');
    const child = fakeElectronProcess(6112, executablePath);
    const command = Object.assign(new EventEmitter(), {
      exitCode: null as number | null
    });
    const diagnostics: string[] = [];
    let spawnCalls = 0;
    let killCalls = 0;
    child.kill = () => {
      killCalls += 1;
      return true;
    };

    await fixture.terminateElectronProcess(child, executablePath, {
      platform: 'win32',
      gracefulExitTimeoutMs: 1,
      taskkillTimeoutMs: 20,
      processExitTimeoutMs: 10,
      spawnCommand: () => {
        spawnCalls += 1;
        queueMicrotask(() => emitFakeExit(command, 255));
        return command;
      },
      processProbe: async () => ({
        status: 'running',
        executablePath: resolve('C:\\other\\not-electron.exe')
      }),
      onDiagnostic: message => diagnostics.push(message)
    });

    expect(spawnCalls).toBe(0);
    expect(killCalls).toBe(0);
    expect(diagnostics).toEqual(['ELECTRON_PROCESS_PID_REUSED:6112']);
    expect(diagnostics.join('')).not.toContain('not-electron.exe');
  });

  test('OS 进程探针：访问失败或路径不可验证时不 kill 并明确失败', async () => {
    const fixture = await loadElectronFixtureModule();
    expect(typeof fixture?.terminateElectronProcess).toBe('function');
    if (!fixture?.terminateElectronProcess) return;

    const executablePath = resolve('C:\\project\\electron.exe');
    const child = fakeElectronProcess(6113, executablePath);
    const command = Object.assign(new EventEmitter(), {
      exitCode: null as number | null
    });
    let spawnCalls = 0;
    let killCalls = 0;
    child.kill = () => {
      killCalls += 1;
      return true;
    };

    await expect(fixture.terminateElectronProcess(child, executablePath, {
      platform: 'win32',
      gracefulExitTimeoutMs: 1,
      taskkillTimeoutMs: 20,
      processExitTimeoutMs: 10,
      spawnCommand: () => {
        spawnCalls += 1;
        queueMicrotask(() => emitFakeExit(command, 255));
        return command;
      },
      processProbe: async () => { throw new Error('ACCESS_DENIED'); }
    })).rejects.toThrow('ELECTRON_PROCESS_PROBE_FAILED:6113');
    expect(spawnCalls).toBe(0);
    expect(killCalls).toBe(0);
  });

  test('默认 OS 进程探针：命令失败诊断保留退出码并截断脱敏 stderr', async () => {
    const fixture = await loadElectronFixtureModule();
    expect(typeof fixture?.probeWindowsProcess).toBe('function');
    if (!fixture?.probeWindowsProcess) return;

    const apiKey = runtimeDiagnosticKey();
    const authorizedRootDirectory = resolve(
      'C:\\Temp\\myself-e2e-probe-diagnostic\\authorized-root'
    );
    const rawStderr = [
      `Authorization: Bearer ${apiKey}`,
      `root=${authorizedRootDirectory}`,
      'x'.repeat(5_000)
    ].join('\n');
    let caught: unknown;
    try {
      await fixture.probeWindowsProcess(6114, {
        runCommand: async () => ({
          exitCode: 7,
          stdout: '',
          stderr: rawStderr
        })
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain('WINDOWS_PROCESS_PROBE_COMMAND_FAILED:exit=7');
    expect(message).toContain('[已脱敏]');
    expect(message).not.toContain(apiKey);
    expect(message).not.toContain(authorizedRootDirectory);
    expect(message).not.toMatch(/Authorization\s*:/iu);
    expect(message.length).toBeLessThan(1_200);
  });

  test('默认 OS 进程探针：AbortSignal 传给 runner 并等待取消回调 settle', async () => {
    const fixture = await loadElectronFixtureModule();
    expect(typeof fixture?.probeWindowsProcess).toBe('function');
    if (!fixture?.probeWindowsProcess) return;

    const apiKey = runtimeDiagnosticKey();
    const controller = new AbortController();
    let runnerSignal: AbortSignal | undefined;
    let abortObserved = false;
    let runnerSettled = false;
    let markRunnerReady: (() => void) | undefined;
    const runnerReady = new Promise<void>(resolveReady => {
      markRunnerReady = resolveReady;
    });
    const probePromise = fixture.probeWindowsProcess(6115, {
      signal: controller.signal,
      runCommand: async (_file, _args, signal) => {
        runnerSignal = signal;
        markRunnerReady?.();
        if (!signal) {
          return { exitCode: 9, stdout: '', stderr: 'RUNNER_SIGNAL_MISSING' };
        }
        return new Promise(resolveCommand => {
          signal.addEventListener('abort', () => {
            abortObserved = true;
            runnerSettled = true;
            resolveCommand({
              exitCode: -1,
              stdout: '',
              stderr: `Authorization: Bearer ${apiKey}`
            });
          }, { once: true });
        });
      }
    });

    await runnerReady;
    controller.abort();
    let caught: unknown;
    try {
      await probePromise;
    } catch (error) {
      caught = error;
    }

    expect(runnerSignal).toBe(controller.signal);
    expect(abortObserved).toBe(true);
    expect(runnerSettled).toBe(true);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('WINDOWS_PROCESS_PROBE_COMMAND_FAILED:exit=-1');
    expect((caught as Error).message).toContain('[已脱敏]');
    expect((caught as Error).message).not.toContain(apiKey);
  });

  test('OS 进程探针：超时后 abort 并等待 respecting probe settle', async () => {
    const fixture = await loadElectronFixtureModule();
    expect(typeof fixture?.terminateElectronProcess).toBe('function');
    if (!fixture?.terminateElectronProcess) return;

    const executablePath = resolve('C:\\project\\electron.exe');
    const child = fakeElectronProcess(6116, executablePath);
    let abortObserved = false;
    let probeSettled = false;
    let spawnCalls = 0;
    let killCalls = 0;
    child.kill = () => {
      killCalls += 1;
      return true;
    };

    await expect(fixture.terminateElectronProcess(child, executablePath, {
      platform: 'win32',
      gracefulExitTimeoutMs: 1,
      probeTimeoutMs: 5,
      helperExitTimeoutMs: 20,
      spawnCommand: () => {
        spawnCalls += 1;
        return Object.assign(new EventEmitter(), { exitCode: null as number | null });
      },
      processProbe: (_processId, signal) => new Promise((_resolveProbe, rejectProbe) => {
        signal?.addEventListener('abort', () => {
          abortObserved = true;
          setTimeout(() => {
            probeSettled = true;
            rejectProbe(new Error('ABORTED_AFTER_SETTLE'));
          }, 5);
        }, { once: true });
      })
    })).rejects.toThrow('PROCESS_PROBE_TIMEOUT');

    expect(abortObserved).toBe(true);
    expect(probeSettled).toBe(true);
    expect(spawnCalls).toBe(0);
    expect(killCalls).toBe(0);
  });

  test('OS 进程探针：忽略 AbortSignal 时有界报告契约违规且不继续破坏操作', async () => {
    const fixture = await loadElectronFixtureModule();
    expect(typeof fixture?.terminateElectronProcess).toBe('function');
    if (!fixture?.terminateElectronProcess) return;

    const executablePath = resolve('C:\\project\\electron.exe');
    const child = fakeElectronProcess(6117, executablePath);
    let spawnCalls = 0;
    let killCalls = 0;
    child.kill = () => {
      killCalls += 1;
      return true;
    };

    await expect(fixture.terminateElectronProcess(child, executablePath, {
      platform: 'win32',
      gracefulExitTimeoutMs: 1,
      probeTimeoutMs: 5,
      helperExitTimeoutMs: 5,
      spawnCommand: () => {
        spawnCalls += 1;
        return Object.assign(new EventEmitter(), { exitCode: null as number | null });
      },
      processProbe: () => new Promise(() => undefined)
    })).rejects.toThrow('PROCESS_PROBE_CONTRACT_VIOLATION');

    expect(spawnCalls).toBe(0);
    expect(killCalls).toBe(0);
  });

  test('taskkill 成功且原 child 在监听前按信号退出时不误报仍存活', async () => {
    const fixture = await loadElectronFixtureModule();
    expect(typeof fixture?.terminateElectronProcess).toBe('function');
    if (!fixture?.terminateElectronProcess) return;

    const executablePath = resolve('C:\\project\\electron.exe');
    const child = fakeElectronProcess(6104, executablePath);
    const command = Object.assign(new EventEmitter(), {
      exitCode: null as number | null
    });
    let fallbackKillCalls = 0;
    child.kill = () => {
      fallbackKillCalls += 1;
      return true;
    };

    await fixture.terminateElectronProcess(child, executablePath, {
      platform: 'win32',
      gracefulExitTimeoutMs: 1,
      taskkillTimeoutMs: 20,
      processExitTimeoutMs: 5,
      spawnCommand: () => {
        queueMicrotask(() => {
          // 精确复现：原 child 的 exit 先发生，helper 随后才开始等待原 child。
          child.signalCode = 'SIGTERM';
          child.emit('exit', null, 'SIGTERM');
          emitFakeExit(command, 0);
        });
        return command;
      },
      processProbe: async () => ({ status: 'running', executablePath })
    });

    expect(child.exitCode).toBeNull();
    expect(child.signalCode).toBe('SIGTERM');
    expect(fallbackKillCalls).toBe(0);
  });

  test('taskkill 超时时回退 SIGKILL，原 child 仍存活则明确失败', async () => {
    const fixture = await loadElectronFixtureModule();
    expect(typeof fixture?.terminateElectronProcess).toBe('function');
    if (!fixture?.terminateElectronProcess) return;

    const executablePath = resolve('C:\\project\\electron.exe');
    const child = fakeElectronProcess(6102, executablePath);
    const command = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      kill: () => {
        queueMicrotask(() => emitFakeExit(command, 137));
        return true;
      }
    });
    const killSignals: Array<NodeJS.Signals | number | undefined> = [];
    child.kill = signal => {
      killSignals.push(signal);
      return true;
    };

    await expect(fixture.terminateElectronProcess(child, executablePath, {
      platform: 'win32',
      gracefulExitTimeoutMs: 1,
      taskkillTimeoutMs: 5,
      helperExitTimeoutMs: 5,
      processExitTimeoutMs: 5,
      probeIntervalMs: 1,
      spawnCommand: () => command,
      processProbe: async () => ({ status: 'running', executablePath })
    })).rejects.toThrow('ELECTRON_PROCESS_STILL_RUNNING');
    expect(killSignals).toEqual(['SIGKILL']);
    expect(child.exitCode).toBeNull();
  });

  test('taskkill helper 收到 SIGKILL 后仍不退出时停止后续探针与破坏操作', async () => {
    const fixture = await loadElectronFixtureModule();
    expect(typeof fixture?.terminateElectronProcess).toBe('function');
    if (!fixture?.terminateElectronProcess) return;

    const executablePath = resolve('C:\\project\\electron.exe');
    const child = fakeElectronProcess(6106, executablePath);
    const helperKillSignals: Array<NodeJS.Signals | number | undefined> = [];
    const command = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      kill: (signal?: NodeJS.Signals | number) => {
        helperKillSignals.push(signal);
        return true;
      }
    });
    let probeCalls = 0;
    let processKillCalls = 0;
    child.kill = () => {
      processKillCalls += 1;
      return true;
    };

    await expect(fixture.terminateElectronProcess(child, executablePath, {
      platform: 'win32',
      gracefulExitTimeoutMs: 1,
      taskkillTimeoutMs: 5,
      helperExitTimeoutMs: 5,
      processExitTimeoutMs: 5,
      spawnCommand: () => command,
      processProbe: async () => {
        probeCalls += 1;
        return { status: 'running', executablePath };
      }
    })).rejects.toThrow('TASKKILL_HELPER_STILL_RUNNING');

    expect(helperKillSignals).toEqual(['SIGKILL']);
    expect(probeCalls).toBe(1);
    expect(processKillCalls).toBe(0);
  });

  test('路径不匹配时在启动 taskkill 或发送信号前拒绝，绝不误伤其他进程', async () => {
    const fixture = await loadElectronFixtureModule();
    expect(typeof fixture?.terminateElectronProcess).toBe('function');
    if (!fixture?.terminateElectronProcess) return;

    const child = fakeElectronProcess(6103, resolve('C:\\other\\electron.exe'));
    let spawnCalls = 0;
    let killCalls = 0;
    child.kill = () => {
      killCalls += 1;
      return true;
    };

    await expect(fixture.terminateElectronProcess(
      child,
      resolve('C:\\project\\electron.exe'),
      {
        platform: 'win32',
        gracefulExitTimeoutMs: 1,
        spawnCommand: () => {
          spawnCalls += 1;
          return Object.assign(new EventEmitter(), { exitCode: null as number | null });
        }
      }
    )).rejects.toThrow('ELECTRON_PROCESS_PATH_MISMATCH');
    expect(spawnCalls).toBe(0);
    expect(killCalls).toBe(0);
  });

  test('直接 spawn 后连接 CDP，并在释放时按精确 Electron 路径和 PID 清理', async () => {
    const fixtureModule = await loadElectronFixtureModule();
    expect(typeof fixtureModule?.createElectronAppFixture).toBe('function');
    if (!fixtureModule?.createElectronAppFixture) return;

    const workspaceRoot = resolve(process.cwd());
    const requireFromDesktop = createRequire(resolve(workspaceRoot, 'apps/desktop/package.json'));
    const expectedExecutable = requireFromDesktop('electron') as string;
    const fakeProcess = fakeElectronProcess(4242, expectedExecutable);
    const baseDirectory = resolve('C:\\Temp\\myself-fixture');
    const userDataDirectory = resolve(baseDirectory, 'user-data');
    const authorizedRootDirectory = resolve(baseDirectory, 'authorized-root');
    const spawnedPlans: ElectronLaunchPlan[] = [];
    const waitedEndpoints: string[] = [];
    const connectedEndpoints: string[] = [];
    const terminated: Array<{ pid: number; executablePath: string }> = [];
    const removed: string[] = [];
    const browserCloseCalls: number[] = [];
    const apiKey = runtimeDiagnosticKey();

    const fixture = await fixtureModule.createElectronAppFixture({
      workspaceRoot,
      apiKey,
      dependencies: {
        allocateLoopbackPort: async () => 43124,
        createTemporaryDirectories: async () => ({
          baseDirectory,
          userDataDirectory,
          authorizedRootDirectory
        }),
        spawnProcess: plan => {
          spawnedPlans.push(plan);
          queueMicrotask(() => {
            fakeProcess.stdout.write(`Authorization: Bearer ${apiKey}\n`);
            fakeProcess.stderr.write(`root=${authorizedRootDirectory}\n`);
          });
          return fakeProcess;
        },
        waitForReady: async options => {
          waitedEndpoints.push(options.endpoint);
        },
        connectOverCdp: async endpoint => {
          connectedEndpoints.push(endpoint);
          return { close: async () => { browserCloseCalls.push(1); } };
        },
        terminateProcess: async (child, executablePath) => {
          terminated.push({ pid: child.pid, executablePath });
        },
        removeTemporaryBase: async directory => {
          removed.push(directory);
        }
      }
    });

    expect(spawnedPlans).toHaveLength(1);
    expect(spawnedPlans[0]?.executablePath).toBe(expectedExecutable);
    expect(waitedEndpoints).toEqual(['http://127.0.0.1:43124']);
    expect(connectedEndpoints).toEqual(['http://127.0.0.1:43124']);
    expect(fixture.processId).toBe(4242);
    expect(fixture.executablePath).toBe(expectedExecutable);
    expect(fixture.logs.join('\n')).not.toContain(apiKey);
    expect(fixture.logs.join('\n')).not.toContain(authorizedRootDirectory);

    await fixture.dispose();

    expect(browserCloseCalls).toHaveLength(1);
    expect(terminated).toEqual([{ pid: 4242, executablePath: expectedExecutable }]);
    expect(removed).toEqual([baseDirectory]);
  });

  test('进程终止使用自身有界契约，不被通用 operationTimeoutMs 提前截断', async () => {
    const fixtureModule = await loadElectronFixtureModule();
    expect(typeof fixtureModule?.createElectronAppFixture).toBe('function');
    if (!fixtureModule?.createElectronAppFixture) return;

    const workspaceRoot = resolve(process.cwd());
    const requireFromDesktop = createRequire(resolve(workspaceRoot, 'apps/desktop/package.json'));
    const expectedExecutable = requireFromDesktop('electron') as string;
    const fakeProcess = fakeElectronProcess(4243, expectedExecutable);
    const baseDirectory = resolve('C:\\Temp\\myself-fixture-terminate-owner');
    let terminateCalls = 0;
    const removed: string[] = [];

    const fixture = await fixtureModule.createElectronAppFixture({
      workspaceRoot,
      apiKey: runtimeDiagnosticKey(),
      operationTimeoutMs: 5,
      dependencies: {
        allocateLoopbackPort: async () => 43129,
        createTemporaryDirectories: async () => ({
          baseDirectory,
          userDataDirectory: resolve(baseDirectory, 'user-data'),
          authorizedRootDirectory: resolve(baseDirectory, 'authorized-root')
        }),
        spawnProcess: () => fakeProcess,
        waitForReady: async () => undefined,
        connectOverCdp: async () => ({ close: async () => undefined }),
        terminateProcess: async child => {
          terminateCalls += 1;
          // 模拟终止器超过通用阶段预算，但仍在自身有界契约内成功。
          await new Promise<void>(resolveDelay => setTimeout(resolveDelay, 25));
          emitFakeExit(child, 0);
        },
        removeTemporaryBase: async directory => {
          removed.push(directory);
        }
      }
    });

    await fixture.dispose();
    await fixture.dispose();

    expect(terminateCalls).toBe(1);
    expect(removed).toEqual([baseDirectory]);
    expect(() => fixture.processId).toThrow('ELECTRON_PROCESS_PID_INVALID');
    expect(() => fixture.executablePath).toThrow('ELECTRON_LAUNCH_PLAN_UNAVAILABLE');
  });

  test('CDP 连接失败时仍清理精确进程和临时目录且不留残余', async () => {
    const fixtureModule = await loadElectronFixtureModule();
    expect(typeof fixtureModule?.createElectronAppFixture).toBe('function');
    if (!fixtureModule?.createElectronAppFixture) return;

    const workspaceRoot = resolve(process.cwd());
    const requireFromDesktop = createRequire(resolve(workspaceRoot, 'apps/desktop/package.json'));
    const expectedExecutable = requireFromDesktop('electron') as string;
    const fakeProcess = fakeElectronProcess(4343, expectedExecutable);
    const baseDirectory = resolve('C:\\Temp\\myself-fixture-failure');
    const terminated: Array<{ pid: number; executablePath: string }> = [];
    const removed: string[] = [];

    await expect(fixtureModule.createElectronAppFixture({
      workspaceRoot,
      apiKey: runtimeDiagnosticKey(),
      launchTimeoutMs: 50,
      dependencies: {
        allocateLoopbackPort: async () => 43125,
        createTemporaryDirectories: async () => ({
          baseDirectory,
          userDataDirectory: resolve(baseDirectory, 'user-data'),
          authorizedRootDirectory: resolve(baseDirectory, 'authorized-root')
        }),
        spawnProcess: () => fakeProcess,
        waitForReady: async () => undefined,
        connectOverCdp: async () => { throw new Error('CDP_CONNECT_FAILED'); },
        terminateProcess: async (child, executablePath) => {
          terminated.push({ pid: child.pid, executablePath });
        },
        removeTemporaryBase: async directory => {
          removed.push(directory);
        }
      }
    })).rejects.toThrow('CDP_CONNECT_FAILED');

    expect(terminated).toEqual([{ pid: 4343, executablePath: expectedExecutable }]);
    expect(removed).toEqual([baseDirectory]);
  });

  test('清理阶段超时时报告阶段与脱敏 stderr，并继续回收进程和目录', async () => {
    const fixtureModule = await loadElectronFixtureModule();
    expect(typeof fixtureModule?.createElectronAppFixture).toBe('function');
    if (!fixtureModule?.createElectronAppFixture) return;

    const workspaceRoot = resolve(process.cwd());
    const requireFromDesktop = createRequire(resolve(workspaceRoot, 'apps/desktop/package.json'));
    const expectedExecutable = requireFromDesktop('electron') as string;
    const fakeProcess = fakeElectronProcess(4444, expectedExecutable);
    const baseDirectory = resolve('C:\\Temp\\myself-fixture-timeout');
    const authorizedRootDirectory = resolve(baseDirectory, 'authorized-root');
    const apiKey = runtimeDiagnosticKey();
    const terminated: number[] = [];
    const removed: string[] = [];

    const fixture = await fixtureModule.createElectronAppFixture({
      workspaceRoot,
      apiKey,
      operationTimeoutMs: 20,
      dependencies: {
        allocateLoopbackPort: async () => 43126,
        createTemporaryDirectories: async () => ({
          baseDirectory,
          userDataDirectory: resolve(baseDirectory, 'user-data'),
          authorizedRootDirectory
        }),
        spawnProcess: () => {
          queueMicrotask(() => {
            fakeProcess.stderr.write(
              `Authorization: Bearer ${apiKey}\nroot=${authorizedRootDirectory}\n`
            );
          });
          return fakeProcess;
        },
        waitForReady: async () => undefined,
        connectOverCdp: async () => ({
          close: () => new Promise<void>(() => undefined)
        }),
        terminateProcess: async child => {
          terminated.push(child.pid);
        },
        removeTemporaryBase: async directory => {
          removed.push(directory);
        }
      }
    });

    const guardedDispose = Promise.race([
      fixture.dispose(),
      new Promise<never>((_resolveGuard, rejectGuard) => {
        setTimeout(() => rejectGuard(new Error('UNIT_GUARD_TIMEOUT')), 200);
      })
    ]);
    let caught: unknown;
    try {
      await guardedDispose;
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    const message = (caught as Error).message;
    expect(message).toContain('ELECTRON_STAGE_TIMEOUT:cleanup_browser_close');
    expect(message).toContain('[已脱敏]');
    expect(message).not.toContain(apiKey);
    expect(message).not.toContain(authorizedRootDirectory);
    expect(terminated).toEqual([4444]);
    expect(removed).toEqual([baseDirectory]);
  });

  test('首次 dispose 进程清理失败后保留资源，第二次可重试并完成目录清理', async () => {
    const fixtureModule = await loadElectronFixtureModule();
    expect(typeof fixtureModule?.createElectronAppFixture).toBe('function');
    if (!fixtureModule?.createElectronAppFixture) return;

    const workspaceRoot = resolve(process.cwd());
    const requireFromDesktop = createRequire(resolve(workspaceRoot, 'apps/desktop/package.json'));
    const expectedExecutable = requireFromDesktop('electron') as string;
    const fakeProcess = fakeElectronProcess(6201, expectedExecutable);
    const baseDirectory = resolve('C:\\Temp\\myself-fixture-dispose-retry');
    let terminateCalls = 0;
    const removed: string[] = [];

    const fixture = await fixtureModule.createElectronAppFixture({
      workspaceRoot,
      apiKey: runtimeDiagnosticKey(),
      dependencies: {
        allocateLoopbackPort: async () => 43127,
        createTemporaryDirectories: async () => ({
          baseDirectory,
          userDataDirectory: resolve(baseDirectory, 'user-data'),
          authorizedRootDirectory: resolve(baseDirectory, 'authorized-root')
        }),
        spawnProcess: () => fakeProcess,
        waitForReady: async () => undefined,
        connectOverCdp: async () => ({ close: async () => undefined }),
        terminateProcess: async child => {
          terminateCalls += 1;
          if (terminateCalls === 1) throw new Error('TERMINATE_FIRST_FAILED');
          emitFakeExit(child, 0);
        },
        removeTemporaryBase: async directory => {
          removed.push(directory);
        }
      }
    });

    await expect(fixture.dispose()).rejects.toThrow('TERMINATE_FIRST_FAILED');
    expect(terminateCalls).toBe(1);
    expect(removed).toEqual([]);
    expect(fixture.processId).toBe(6201);

    await fixture.dispose();
    await fixture.dispose();
    expect(terminateCalls).toBe(2);
    expect(removed).toEqual([baseDirectory]);
  });

  test('create 的 CDP 主错误与清理错误并发时以主错误为 cause 并保留清理诊断', async () => {
    const fixtureModule = await loadElectronFixtureModule();
    expect(typeof fixtureModule?.createElectronAppFixture).toBe('function');
    if (!fixtureModule?.createElectronAppFixture) return;

    const workspaceRoot = resolve(process.cwd());
    const requireFromDesktop = createRequire(resolve(workspaceRoot, 'apps/desktop/package.json'));
    const expectedExecutable = requireFromDesktop('electron') as string;
    const fakeProcess = fakeElectronProcess(6301, expectedExecutable);
    const baseDirectory = resolve('C:\\Temp\\myself-fixture-primary-create');
    let caught: unknown;

    try {
      await fixtureModule.createElectronAppFixture({
        workspaceRoot,
        apiKey: runtimeDiagnosticKey(),
        dependencies: {
          allocateLoopbackPort: async () => 43128,
          createTemporaryDirectories: async () => ({
            baseDirectory,
            userDataDirectory: resolve(baseDirectory, 'user-data'),
            authorizedRootDirectory: resolve(baseDirectory, 'authorized-root')
          }),
          spawnProcess: () => fakeProcess,
          waitForReady: async () => undefined,
          connectOverCdp: async () => { throw new Error('PRIMARY_CDP_CONNECT_FAILED'); },
          terminateProcess: async () => { throw new Error('CLEANUP_TERMINATE_FAILED'); },
          removeTemporaryBase: async () => undefined
        }
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    const aggregate = caught as AggregateError;
    expect(aggregate.cause).toBeInstanceOf(Error);
    expect((aggregate.cause as Error).message).toContain('PRIMARY_CDP_CONNECT_FAILED');
    expect(aggregate.errors.map(error => String(error))).toEqual(expect.arrayContaining([
      expect.stringContaining('PRIMARY_CDP_CONNECT_FAILED'),
      expect.stringContaining('CLEANUP_TERMINATE_FAILED')
    ]));
  });

  test('restart 的 CDP 主错误与新进程清理错误并发时仍保留主错误', async () => {
    const fixtureModule = await loadElectronFixtureModule();
    expect(typeof fixtureModule?.createElectronAppFixture).toBe('function');
    if (!fixtureModule?.createElectronAppFixture) return;

    const workspaceRoot = resolve(process.cwd());
    const requireFromDesktop = createRequire(resolve(workspaceRoot, 'apps/desktop/package.json'));
    const expectedExecutable = requireFromDesktop('electron') as string;
    const processes = [
      fakeElectronProcess(6302, expectedExecutable),
      fakeElectronProcess(6303, expectedExecutable)
    ];
    const baseDirectory = resolve('C:\\Temp\\myself-fixture-primary-restart');
    let connectCalls = 0;
    let failedRestartCleanup = false;
    const fixture = await fixtureModule.createElectronAppFixture({
      workspaceRoot,
      apiKey: runtimeDiagnosticKey(),
      dependencies: {
        allocateLoopbackPort: async () => 43129 + connectCalls,
        createTemporaryDirectories: async () => ({
          baseDirectory,
          userDataDirectory: resolve(baseDirectory, 'user-data'),
          authorizedRootDirectory: resolve(baseDirectory, 'authorized-root')
        }),
        spawnProcess: () => {
          const child = processes.shift();
          if (!child) throw new Error('缺少测试进程');
          return child;
        },
        waitForReady: async () => undefined,
        connectOverCdp: async () => {
          connectCalls += 1;
          if (connectCalls === 2) throw new Error('PRIMARY_RESTART_CDP_FAILED');
          return { close: async () => undefined };
        },
        terminateProcess: async child => {
          if (child.pid === 6303 && !failedRestartCleanup) {
            failedRestartCleanup = true;
            throw new Error('RESTART_CLEANUP_TERMINATE_FAILED');
          }
          emitFakeExit(child, 0);
        },
        removeTemporaryBase: async () => undefined
      }
    });

    let caught: unknown;
    try {
      await fixture.restart();
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    const aggregate = caught as AggregateError;
    expect((aggregate.cause as Error).message).toContain('PRIMARY_RESTART_CDP_FAILED');
    expect(aggregate.errors.map(error => String(error))).toEqual(expect.arrayContaining([
      expect.stringContaining('PRIMARY_RESTART_CDP_FAILED'),
      expect.stringContaining('RESTART_CLEANUP_TERMINATE_FAILED')
    ]));
    await fixture.dispose();
  });

  test('重启时复用隔离目录、重新分配回环端口并分别清理精确 PID', async () => {
    const fixtureModule = await loadElectronFixtureModule();
    expect(typeof fixtureModule?.createElectronAppFixture).toBe('function');
    if (!fixtureModule?.createElectronAppFixture) return;

    const workspaceRoot = resolve(process.cwd());
    const requireFromDesktop = createRequire(resolve(workspaceRoot, 'apps/desktop/package.json'));
    const expectedExecutable = requireFromDesktop('electron') as string;
    const baseDirectory = resolve('C:\\Temp\\myself-fixture-restart');
    const userDataDirectory = resolve(baseDirectory, 'user-data');
    const authorizedRootDirectory = resolve(baseDirectory, 'authorized-root');
    const ports = [43130, 43131];
    const processes = [
      fakeElectronProcess(5001, expectedExecutable),
      fakeElectronProcess(5002, expectedExecutable)
    ];
    const plans: ElectronLaunchPlan[] = [];
    const terminated: number[] = [];
    const removed: string[] = [];

    const fixture = await fixtureModule.createElectronAppFixture({
      workspaceRoot,
      apiKey: runtimeDiagnosticKey(),
      dependencies: {
        allocateLoopbackPort: async () => {
          const port = ports.shift();
          if (!port) throw new Error('缺少测试端口');
          return port;
        },
        createTemporaryDirectories: async () => ({
          baseDirectory,
          userDataDirectory,
          authorizedRootDirectory
        }),
        spawnProcess: plan => {
          plans.push(plan);
          const child = processes.shift();
          if (!child) throw new Error('缺少测试进程');
          return child;
        },
        waitForReady: async () => undefined,
        connectOverCdp: async () => ({ close: async () => undefined }),
        terminateProcess: async child => {
          terminated.push(child.pid);
        },
        removeTemporaryBase: async directory => {
          removed.push(directory);
        }
      }
    });

    expect(typeof fixture.restart).toBe('function');
    if (!fixture.restart) return;
    await fixture.restart();

    expect(plans).toHaveLength(2);
    expect(plans.map(plan => plan.environment['MYSELF_E2E_USER_DATA']))
      .toEqual([userDataDirectory, userDataDirectory]);
    expect(plans.map(plan => plan.environment['MYSELF_E2E_AUTHORIZED_ROOT']))
      .toEqual([authorizedRootDirectory, authorizedRootDirectory]);
    expect(plans.map(plan => plan.cdpEndpoint)).toEqual([
      'http://127.0.0.1:43130',
      'http://127.0.0.1:43131'
    ]);
    expect(terminated).toEqual([5001]);
    expect(removed).toEqual([]);

    await fixture.dispose();

    expect(terminated).toEqual([5001, 5002]);
    expect(removed).toEqual([baseDirectory]);
  });
});

test.describe('真实 Electron CDP smoke', () => {
  test('直接启动构建产物并连接可见桌宠 Renderer', async () => {
    const fixtureModule = await loadElectronFixtureModule();
    expect(typeof fixtureModule?.createElectronAppFixture).toBe('function');
    if (!fixtureModule?.createElectronAppFixture) return;

    const fixture = await fixtureModule.createElectronAppFixture({
      workspaceRoot: resolve(process.cwd()),
      apiKey: runtimeDiagnosticKey(),
      launchTimeoutMs: 15_000
    });
    try {
      const rendererPages = (): Page[] => fixture.browser.contexts()
        .flatMap(context => context.pages());
      await expect.poll(() => rendererPages().some(page => (
        new URL(page.url()).searchParams.get('view') === 'pet'
      ))).toBe(true);
      const petPage = rendererPages().find(page => (
        new URL(page.url()).searchParams.get('view') === 'pet'
      ));
      expect(petPage).toBeDefined();
      await expect(petPage!.getByRole('main', { name: 'Myself 桌宠' })).toBeVisible();
    } finally {
      await fixture.dispose();
    }
  });
});

test.describe('真实 Provider 业务闭环', () => {
  test('通过正式白名单完成设置、文件操作与聊天窗口状态', async () => {
    test.setTimeout(120_000);
    const fixtureModule = await loadElectronFixtureModule();
    expect(typeof fixtureModule?.createElectronAppFixture).toBe('function');
    if (!fixtureModule?.createElectronAppFixture) return;

    const providerSteps: ProviderStep[] = [
      { response: { type: 'text', text: '本地连接正常' } },
      {
        response: toolResponse('list-root', 'list_directory', { relativePath: '.' }),
        inspect: request => {
          const names = request.tools.map(
            (tool: { function: { name: string } }) => tool.function.name
          );
          if (!names.includes('list_directory') || !names.includes('create_file')) {
            throw new Error('Provider 未收到正式文件工具白名单');
          }
        }
      },
      {
        response: { type: 'text', text: '目录里有 docs 文件夹。' },
        inspect: request => {
          const result = lastToolResult(request) as {
            toolName?: string;
            entries?: Array<{ name?: string; type?: string }>;
          };
          if (result.toolName !== 'list_directory'
            || !result.entries?.some(entry => entry.name === 'docs' && entry.type === 'directory')) {
            throw new Error('列目录工具结果不符合脚本预期');
          }
        }
      },
      {
        response: toolResponse('create-file', 'create_file', { relativePath: 'created.txt' })
      },
      {
        response: { type: 'text', text: '空文件已创建。' },
        inspect: request => {
          const result = lastToolResult(request) as { toolName?: string; targetRelativePath?: string };
          if (result.toolName !== 'create_file' || result.targetRelativePath !== 'created.txt') {
            throw new Error('创建文件结果不符合脚本预期');
          }
        }
      },
      {
        response: toolResponse('rename-file', 'rename_entry', {
          sourceRelativePath: 'created.txt',
          targetRelativePath: 'renamed.txt'
        })
      },
      {
        response: { type: 'text', text: '重命名已完成。' },
        inspect: request => {
          const result = lastToolResult(request) as {
            toolName?: string;
            sourceRelativePath?: string;
            targetRelativePath?: string;
          };
          if (result.toolName !== 'rename_entry'
            || result.sourceRelativePath !== 'created.txt'
            || result.targetRelativePath !== 'renamed.txt') {
            throw new Error('重命名结果不符合脚本预期');
          }
        }
      },
      {
        response: toolResponse('cancel-file', 'create_file', { relativePath: 'cancelled.txt' })
      }
    ];

    const provider = await startProviderServer(providerSteps);
    let fixture: Awaited<ReturnType<ElectronFixtureModule['createElectronAppFixture']>>;
    try {
      fixture = await fixtureModule.createElectronAppFixture({
        workspaceRoot: resolve(process.cwd()),
        apiKey: provider.apiKey,
        launchTimeoutMs: 15_000
      });
    } catch (error) {
      await provider.close();
      throw error;
    }
    const userDataDirectory = fixture.userDataDirectory;
    const authorizedRootDirectory = fixture.authorizedRootDirectory;
    const rendererDiagnostics: string[] = [];

    const rendererPages = (): Page[] => fixture.browser.contexts()
      .flatMap(context => context.pages());
    const pageFor = (view: 'pet' | 'chat' | 'settings'): Page | undefined => (
      rendererPages().find(page => {
        try {
          return new URL(page.url()).searchParams.get('view') === view;
        } catch {
          return false;
        }
      })
    );
    const waitForPage = async (view: 'pet' | 'chat' | 'settings'): Promise<Page> => {
      await expect.poll(() => Boolean(pageFor(view))).toBe(true);
      const page = pageFor(view);
      if (!page) throw new Error(`缺少 ${view} Renderer`);
      return page;
    };
    const captureRendererDiagnostics = (pages: Page[]): void => {
      for (const page of pages) {
        page.on('console', message => {
          rendererDiagnostics.push(sanitizeCapturedDiagnostic(
            message.text(),
            provider.apiKey,
            authorizedRootDirectory
          ));
        });
        page.on('pageerror', error => {
          rendererDiagnostics.push(sanitizeCapturedDiagnostic(
            error.message,
            provider.apiKey,
            authorizedRootDirectory
          ));
        });
      }
    };

    let primaryError: unknown;
    try {
      await mkdir(join(authorizedRootDirectory, 'docs'), { recursive: true });

      const petPage = await waitForPage('pet');
      const chatPage = await waitForPage('chat');
      const settingsPage = await waitForPage('settings');
      captureRendererDiagnostics(rendererPages());

      await expect(petPage.getByRole('main', { name: 'Myself 桌宠' })).toBeVisible();
      await petPage.getByRole('button', { name: '打开与 Myself 的聊天' }).click();
      await expect.poll(() => chatPage.evaluate(() => document.visibilityState)).toBe('visible');

      await submitChatMessage(chatPage, '请列出工作目录');
      await expect(chatPage.getByText('请先完成模型服务和授权目录设置。')).toBeVisible();

      await chatPage.getByRole('button', { name: '设置' }).click();
      await expect.poll(() => settingsPage.evaluate(() => document.visibilityState)).toBe('visible');
      await settingsPage.getByLabel('显示名称').fill('任务九本地服务');
      await settingsPage.getByLabel('模型名称').fill('task-9b2-model');
      await settingsPage.getByLabel('Base URL').fill(provider.baseUrl);
      await settingsPage.getByLabel('API Key', { exact: true }).fill(provider.apiKey);
      await settingsPage.getByRole('button', { name: '保存模型配置' }).click();
      await expect(settingsPage.getByText('模型配置已安全保存。')).toBeVisible();

      await settingsPage.getByRole('button', { name: '测试连接' }).click();
      await expect(settingsPage.getByText('连接成功。')).toBeVisible();

      await settingsPage.getByRole('button', { name: '选择工作目录' }).click();
      await expect(settingsPage.getByText('工作目录已更新。')).toBeVisible();
      await expect(settingsPage.getByText('authorized-root', { exact: true })).toBeVisible();
      await settingsPage.getByRole('button', { name: '关闭设置' }).click();

      await submitChatMessage(chatPage, '列出授权根目录');
      await expect(chatPage.getByText('目录里有 docs 文件夹。')).toBeVisible();

      await submitChatMessage(chatPage, '新建空文件 created.txt');
      const createCard = chatPage.getByRole('region', { name: '创建文件 created.txt' });
      await expect(createCard).toBeVisible();
      await createCard.getByRole('button', { name: '确认创建文件' }).click();
      await expect(chatPage.getByText('空文件已创建。')).toBeVisible();
      expect(await pathExistsForAssertion(join(authorizedRootDirectory, 'created.txt'))).toBe(true);
      expect(await readTextForAssertion(join(authorizedRootDirectory, 'created.txt'))).toBe('');

      await submitChatMessage(chatPage, '把 created.txt 重命名为 renamed.txt');
      const renameCard = chatPage.getByRole('region', {
        name: '将 created.txt 重命名为 renamed.txt'
      });
      await expect(renameCard).toBeVisible();
      await renameCard.getByRole('button', { name: '确认重命名' }).click();
      await expect(chatPage.getByText('重命名已完成。')).toBeVisible();
      expect(await pathExistsForAssertion(join(authorizedRootDirectory, 'created.txt'))).toBe(false);
      expect(await pathExistsForAssertion(join(authorizedRootDirectory, 'renamed.txt'))).toBe(true);

      await submitChatMessage(chatPage, '新建 cancelled.txt，但先让我确认');
      const cancelCard = chatPage.getByRole('region', { name: '创建文件 cancelled.txt' });
      await expect(cancelCard).toBeVisible();
      await cancelCard.getByRole('button', { name: '先不创建' }).click();
      await expect(cancelCard).toHaveCount(0);
      expect(await pathExistsForAssertion(join(authorizedRootDirectory, 'cancelled.txt'))).toBe(false);

      await chatPage.getByRole('button', { name: '关闭聊天气泡' }).click();
      expect(chatPage.isClosed()).toBe(false);
      await expect(chatPage.getByText('重命名已完成。')).toBeVisible();
      await petPage.getByRole('button', { name: '打开与 Myself 的聊天' }).click();
      expect(chatPage.isClosed()).toBe(false);
      await expect(chatPage.getByText('重命名已完成。')).toBeVisible();
      const reopenedComposer = chatPage.getByLabel('和我说点什么');
      await reopenedComposer.fill('聊天重开命令路径验证');
      await expect(reopenedComposer).toHaveValue('聊天重开命令路径验证');
      await reopenedComposer.fill('');

      expect(provider.inspectionErrors).toEqual([]);
      expect(provider.remainingSteps()).toBe(0);
      provider.assertComplete();
      expect(provider.requests).toHaveLength(8);
      for (const request of provider.requests) {
        expect(request).toMatchObject({
          method: 'POST',
          pathname: '/v1/chat/completions',
          authorizationPresent: true
        });
      }

      const captured = [...rendererDiagnostics, ...fixture.logs].join('\n');
      expect(captured).not.toContain(provider.apiKey);
      expect(captured).not.toContain(authorizedRootDirectory);
      expect(captured).not.toMatch(/authorization\s*:/iu);
    } catch (error) {
      primaryError = error;
    }

    const supplementalErrors: unknown[] = [];
    if (provider.remainingSteps() > 0) {
      try {
        provider.assertComplete();
      } catch (error) {
        supplementalErrors.push(error);
      }
    }
    try {
      await fixture.dispose();
    } catch (error) {
      supplementalErrors.push(error);
    }
    try {
      await provider.close();
    } catch (error) {
      supplementalErrors.push(error);
    }
    try {
      expect(await pathExistsForAssertion(userDataDirectory)).toBe(false);
      expect(await pathExistsForAssertion(authorizedRootDirectory)).toBe(false);
    } catch (error) {
      supplementalErrors.push(error);
    }

    if (primaryError) {
      if (primaryError instanceof Error && supplementalErrors.length > 0) {
        const diagnostics = supplementalErrors.map(error => sanitizeCapturedDiagnostic(
          error instanceof Error ? error.message : String(error),
          provider.apiKey,
          authorizedRootDirectory
        ));
        primaryError.message += `\n附加清理诊断：${diagnostics.join('；')}`;
      }
      throw primaryError;
    }
    if (supplementalErrors[0]) throw supplementalErrors[0];
  });
});

test.describe('真实桌宠位置重启恢复', () => {
  test('移动并等待持久化后使用同一 userData 重启恢复位置', async () => {
    test.setTimeout(120_000);
    const fixtureModule = await loadElectronFixtureModule();
    expect(typeof fixtureModule?.createElectronAppFixture).toBe('function');
    if (!fixtureModule?.createElectronAppFixture) return;

    const fixture = await fixtureModule.createElectronAppFixture({
      workspaceRoot: resolve(process.cwd()),
      apiKey: runtimeDiagnosticKey(),
      launchTimeoutMs: 15_000
    });
    const userDataDirectory = fixture.userDataDirectory;
    const authorizedRootDirectory = fixture.authorizedRootDirectory;
    const rendererPages = (): Page[] => fixture.browser.contexts()
      .flatMap(context => context.pages());
    const petPageForCurrentLaunch = (): Page | undefined => (
      rendererPages().find(page => {
        try {
          return new URL(page.url()).searchParams.get('view') === 'pet';
        } catch {
          return false;
        }
      })
    );
    const waitForPetPage = async (): Promise<Page> => {
      await expect.poll(() => Boolean(petPageForCurrentLaunch())).toBe(true);
      const page = petPageForCurrentLaunch();
      if (!page) throw new Error('缺少 pet Renderer');
      return page;
    };

    try {
      const petPage = await waitForPetPage();
      const originalPosition = await petPage.evaluate(() => ({
        x: window.screenX,
        y: window.screenY
      }));
      await petPage.evaluate(({ offsetX, offsetY }) => {
        const currentScreen = window.screen as Screen & {
          availLeft?: number;
          availTop?: number;
        };
        const minX = currentScreen.availLeft ?? 0;
        const minY = currentScreen.availTop ?? 0;
        const maxX = Math.max(minX, minX + currentScreen.availWidth - window.outerWidth);
        const maxY = Math.max(minY, minY + currentScreen.availHeight - window.outerHeight);
        const targetX = window.screenX - minX >= offsetX
          ? window.screenX - offsetX
          : Math.min(maxX, window.screenX + offsetX);
        const targetY = window.screenY - minY >= offsetY
          ? window.screenY - offsetY
          : Math.min(maxY, window.screenY + offsetY);
        window.moveTo(targetX, targetY);
      }, { offsetX: 64, offsetY: 48 });
      await expect.poll(async () => {
        const current = await petPage.evaluate(() => ({
          x: window.screenX,
          y: window.screenY
        }));
        return current.x !== originalPosition.x || current.y !== originalPosition.y;
      }).toBe(true);
      const savedPosition = await petPage.evaluate(() => ({
        x: window.screenX,
        y: window.screenY
      }));
      await petPage.waitForTimeout(500);

      await fixture.restart();
      const restartedPetPage = await waitForPetPage();
      const restoredPosition = await restartedPetPage.evaluate(() => ({
        x: window.screenX,
        y: window.screenY
      }));
      expect(Math.abs(restoredPosition.x - savedPosition.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(restoredPosition.y - savedPosition.y)).toBeLessThanOrEqual(1);

      const diagnostics = fixture.logs.join('\n');
      expect(diagnostics).not.toMatch(/myself-e2e-[a-f0-9]{48}/u);
      expect(diagnostics).not.toContain(authorizedRootDirectory);
      expect(diagnostics).not.toMatch(/authorization\s*:/iu);
    } finally {
      await fixture.dispose();
      expect(await pathExistsForAssertion(userDataDirectory)).toBe(false);
      expect(await pathExistsForAssertion(authorizedRootDirectory)).toBe(false);
    }
  });
});
