import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import {
  createProviderResponseGate,
  startProviderServer,
  type ProviderStep
} from '../fixtures/provider-server';
import { snapshotCharacterPersistence } from '../fixtures/character-storage-snapshot';

type CharacterBehaviorProbe = {
  revision: number;
  primaryStateId: string;
  modifierStateIds: string[];
  actionId: string | null;
  playbackStatus: 'scheduled' | 'started' | 'completed' | 'interrupted' | 'failed' | null;
};

type ElectronFixtureModule = {
  writeMainE2eExplorerEvent(
    userDataDirectory: string,
    event: 'wrong-directory' | 'stale-revision' | 'background-window'
      | 'ambiguous' | 'exact-foreground' | 'minimized' | 'blurred' | 'crash'
  ): Promise<void>;
  createElectronLaunchPlan(options: {
    workspaceRoot: string;
    cdpPort: number;
    userDataDirectory: string;
    authorizedRootDirectory: string;
    habitatDirectory?: string;
    recycleBinDirectory?: string;
    characterAssetsDirectory?: string;
    parentEnvironment?: NodeJS.ProcessEnv;
    enableSoftwareRasterizer?: boolean;
  }): {
    executablePath: string;
    applicationEntry: string;
    cdpEndpoint: string;
    args: string[];
    environment: NodeJS.ProcessEnv;
  };
  redactElectronLog(
    text: string,
    secrets: {
      apiKey: string;
      authorizedRootDirectory: string;
      recycleBinDirectory?: string;
      userDataDirectory?: string;
      characterAssetsDirectory?: string;
      safeCharacterPackage?: string;
      maliciousCharacterPackage?: string;
      characterExportDestination?: string;
    }
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
  inspectWindowsElectronDescendants(
    processId: number,
    options?: {
      runCommand?(file: string, args: string[], signal?: AbortSignal): Promise<{
        exitCode: number;
        stdout: string;
        stderr: string;
      }>;
    }
  ): Promise<Array<{
    processId: number;
    name: string;
    powershell: boolean;
    explorerBridge: boolean;
  }>>;
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
    prepareUserData?(directories: {
      baseDirectory: string;
      userDataDirectory: string;
      authorizedRootDirectory: string;
      characterAssetsDirectory?: string;
      packagesDirectory?: string;
      exportsDirectory?: string;
    }): Promise<void>;
    beforeRestart?(directories: {
      baseDirectory: string;
      userDataDirectory: string;
      authorizedRootDirectory: string;
    }): Promise<void>;
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
    habitatDirectory?: string;
    recycleBinDirectory?: string;
    safeCharacterPackage?: string;
    maliciousCharacterPackage?: string;
    characterExportDestination?: string;
    logs: readonly string[];
    sendExplorerEvent(
      event: 'wrong-directory' | 'stale-revision' | 'background-window'
        | 'ambiguous' | 'exact-foreground' | 'minimized' | 'blurred'
        | 'crash'
    ): Promise<void>;
    getMainE2eState(): Promise<{
      revision: number;
      petWindowVisible: boolean;
      processedExplorerEventRevision: number;
      processedExplorerEvent: string | null;
      bridge: {
        state: 'idle' | 'ready' | 'failed' | 'closed';
        observing: boolean;
        polling: boolean;
        eventRevision: number;
      };
    }>;
    getMainDescendantProcesses(): Promise<Array<{
      processId: number;
      name: string;
      powershell: boolean;
      explorerBridge: boolean;
    }>>;
    getPetInteractionProbe(): Promise<{ passthrough: boolean; dragging: boolean }>;
    getCharacterBehaviorProbe(): Promise<CharacterBehaviorProbe>;
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

type JourneyToolName =
  | 'list_directory'
  | 'create_file'
  | 'rename_entry'
  | 'move_to_recycle_bin'
  | 'builtin.files.move_to_recycle_bin';

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
  ...sensitiveValues: Array<string | undefined>
): string {
  return sensitiveValues
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => right.length - left.length)
    .reduce(
      (sanitized, value) => sanitized.replaceAll(value, '[已脱敏]'),
      text.replace(/authorization\s*:[^\r\n]*/giu, '[已脱敏]')
    );
}

/** 捕获边界只保留脱敏后的新错误，禁止原始 message、stack 或 cause 继续传播。 */
function sanitizedCapturedError(
  error: unknown,
  sanitize: (text: string) => string
): Error {
  const message = error instanceof Error ? error.message : String(error);
  const sanitized = new Error(sanitize(message));
  if (error instanceof Error) sanitized.name = error.name;
  return sanitized;
}

async function submitChatMessage(page: Page, text: string): Promise<void> {
  await page.getByLabel('和我说点什么').fill(text);
  await page.getByRole('button', { name: '发送给 AI Pet' }).click();
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
    const habitatDirectory = resolve('C:\\Temp\\myself-habitat');
    const requireFromDesktop = createRequire(resolve(workspaceRoot, 'apps/desktop/package.json'));
    const expectedExecutable = requireFromDesktop('electron') as string;
    const plan = fixture.createElectronLaunchPlan({
      workspaceRoot,
      cdpPort: 43123,
      userDataDirectory,
      authorizedRootDirectory,
      habitatDirectory,
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
      MYSELF_E2E_AUTHORIZED_ROOT: authorizedRootDirectory,
      MYSELF_E2E_HABITAT_DIRECTORY: habitatDirectory
    });
    expect(Object.keys(plan.environment)).not.toContain('MYSELF_E2E_EXPLORER_SCRIPT');

    const visualPlan = fixture.createElectronLaunchPlan({
      workspaceRoot,
      cdpPort: 43124,
      userDataDirectory,
      authorizedRootDirectory,
      parentEnvironment: { PATH: process.env['PATH'] },
      enableSoftwareRasterizer: true
    });
    expect(visualPlan.args).not.toContain('--disable-software-rasterizer');
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
    const userDataDirectory = 'C:\\Temp\\ai-pet-user-data';
    const characterAssetsDirectory = 'C:\\Temp\\ai-pet-assets';
    const safeCharacterPackage = 'C:\\Temp\\safe-character.zip';
    const maliciousCharacterPackage = 'C:\\Temp\\malicious-character.zip';
    const characterExportDestination = 'C:\\Temp\\exported-character.zip';
    const sanitized = fixture.redactElectronLog(
      [
        `Authorization: Bearer ${apiKey}`,
        `root=${authorizedRootDirectory}`,
        `key=${apiKey}`,
        userDataDirectory,
        characterAssetsDirectory,
        safeCharacterPackage,
        maliciousCharacterPackage,
        characterExportDestination
      ].join('\n'),
      {
        apiKey,
        authorizedRootDirectory,
        userDataDirectory,
        characterAssetsDirectory,
        safeCharacterPackage,
        maliciousCharacterPackage,
        characterExportDestination
      }
    );

    expect(sanitized).not.toContain(apiKey);
    expect(sanitized).not.toContain(authorizedRootDirectory);
    expect(sanitized).not.toContain(userDataDirectory);
    expect(sanitized).not.toContain(characterAssetsDirectory);
    expect(sanitized).not.toContain(safeCharacterPackage);
    expect(sanitized).not.toContain(maliciousCharacterPackage);
    expect(sanitized).not.toContain(characterExportDestination);
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

  test('OS 进程探针：退出期间路径短暂不可用时有限重试且不误杀', async () => {
    const fixture = await loadElectronFixtureModule();
    expect(typeof fixture?.terminateElectronProcess).toBe('function');
    if (!fixture?.terminateElectronProcess) return;

    const executablePath = resolve('C:\\project\\electron.exe');
    const child = fakeElectronProcess(6118, executablePath);
    let probeCalls = 0;
    let spawnCalls = 0;
    let killCalls = 0;
    child.kill = () => {
      killCalls += 1;
      return true;
    };

    await fixture.terminateElectronProcess(child, executablePath, {
      platform: 'win32',
      gracefulExitTimeoutMs: 1,
      probeIntervalMs: 1,
      probeTimeoutMs: 20,
      processProbe: async () => {
        probeCalls += 1;
        if (probeCalls < 3) {
          throw new Error('WINDOWS_PROCESS_PATH_TEMPORARILY_UNAVAILABLE');
        }
        return { status: 'absent' };
      },
      spawnCommand: () => {
        spawnCalls += 1;
        throw new Error('不应启动 taskkill');
      }
    });

    expect(probeCalls).toBe(3);
    expect(spawnCalls).toBe(0);
    expect(killCalls).toBe(0);
  });

  test('Main 后代进程探针能从人为进程树发现 bridge PowerShell 子进程', async () => {
    const fixture = await loadElectronFixtureModule();
    expect(typeof fixture?.inspectWindowsElectronDescendants).toBe('function');
    if (!fixture?.inspectWindowsElectronDescendants) return;

    const descendants = await fixture.inspectWindowsElectronDescendants(6114, {
      runCommand: async () => ({
        exitCode: 0,
        stdout: JSON.stringify([
          { ProcessId: 6114, ParentProcessId: 100, Name: 'electron.exe', CommandLine: 'app' },
          { ProcessId: 6115, ParentProcessId: 6114, Name: 'electron.exe', CommandLine: 'renderer' },
          {
            ProcessId: 6116,
            ParentProcessId: 6115,
            Name: 'powershell.exe',
            CommandLine: 'powershell.exe -File explorer-space-bridge.ps1'
          },
          {
            ProcessId: 7000,
            ParentProcessId: 999,
            Name: 'powershell.exe',
            CommandLine: 'unrelated.ps1'
          }
        ]),
        stderr: ''
      })
    });

    expect(descendants).toEqual([
      { processId: 6115, name: 'electron.exe', powershell: false, explorerBridge: false },
      { processId: 6116, name: 'powershell.exe', powershell: true, explorerBridge: true }
    ]);
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

  test('默认 OS 进程探针：退出期间空路径映射为可重试过渡态', async () => {
    const fixture = await loadElectronFixtureModule();
    expect(typeof fixture?.probeWindowsProcess).toBe('function');
    if (!fixture?.probeWindowsProcess) return;

    await expect(fixture.probeWindowsProcess(6119, {
      runCommand: async () => ({
        exitCode: 4,
        stdout: '',
        stderr: ''
      })
    })).rejects.toThrow('WINDOWS_PROCESS_PATH_TEMPORARILY_UNAVAILABLE');
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
      await expect(petPage!.getByRole('main', { name: 'AI Pet 桌宠' })).toBeVisible();
      const layout = await petPage!.evaluate(() => {
        const measure = (selector: string): { width: number; height: number } => {
          const element = document.querySelector<HTMLElement>(selector);
          if (!element) throw new Error(`缺少布局元素：${selector}`);
          const rect = element.getBoundingClientRect();
          return { width: rect.width, height: rect.height };
        };
        const canvas = document.querySelector<HTMLCanvasElement>(
          '.character-player-host canvas'
        );
        return {
          shell: measure('.pet-shell'),
          surface: measure('.pet-character-surface'),
          player: measure('.character-player'),
          host: measure('.character-player-host'),
          stage: measure('.character-player-stage'),
          canvas: canvas
            ? {
                box: measure('.character-player-host canvas'),
                width: canvas.width,
                height: canvas.height
              }
            : null
        };
      });

      expect(layout.shell).toEqual({ width: 180, height: 220 });
      expect(layout.surface).toEqual({ width: 156, height: 192 });
      expect(layout.player).toEqual(layout.surface);
      expect(layout.host).toEqual(layout.surface);
      expect(layout.stage).toEqual(layout.surface);
      if (layout.canvas) {
        expect(layout.canvas.box).toEqual(layout.surface);
        expect({
          width: layout.canvas.width,
          height: layout.canvas.height
        }).toEqual(layout.surface);
      }
    } finally {
      await fixture.dispose();
    }
  });
});

test.describe('真实桌宠像素命中与左键拖拽', () => {
  test('像素命中探针保持透明穿透、可见拖拽和左键无聊天副作用', async () => {
    test.setTimeout(120_000);
    const fixtureModule = await loadElectronFixtureModule();
    expect(typeof fixtureModule?.createElectronAppFixture).toBe('function');
    if (!fixtureModule?.createElectronAppFixture) return;

    const fixture = await fixtureModule.createElectronAppFixture({
      workspaceRoot: resolve(process.cwd()),
      apiKey: runtimeDiagnosticKey(),
      launchTimeoutMs: 15_000
    });
    try {
      const pages = (): Page[] => fixture.browser.contexts()
        .flatMap(context => context.pages());
      await expect.poll(() => pages().some(page => {
        try {
          return new URL(page.url()).searchParams.get('view') === 'pet';
        } catch {
          return false;
        }
      })).toBe(true);
      const pet = pages().find(page => (
        new URL(page.url()).searchParams.get('view') === 'pet'
      ))!;
      await pet.emulateMedia({ reducedMotion: 'reduce' });
      await expect(pet.getByRole('main', { name: 'AI Pet 桌宠' })).toBeVisible();
      await expect(pet.locator('.character-player')).toHaveAttribute(
        'data-status',
        'ready',
        { timeout: 20_000 }
      );
      const shell = pet.getByRole('main', { name: 'AI Pet 桌宠' });
      const dispatchPointer = async (
        type: 'pointermove' | 'pointerdown' | 'pointerup' | 'contextmenu',
        point: { x: number; y: number },
        button = 0,
        buttons = 0
      ): Promise<void> => {
        await shell.evaluate((element, input) => {
          const EventConstructor = input.type === 'contextmenu'
            ? MouseEvent
            : PointerEvent;
          element.dispatchEvent(new EventConstructor(input.type, {
            bubbles: true,
            cancelable: true,
            clientX: input.point.x,
            clientY: input.point.y,
            button: input.button,
            buttons: input.buttons,
            ...(input.type === 'contextmenu' ? {} : { pointerId: 41 })
          }));
        }, { type, point, button, buttons });
      };

      const transparent = { x: 1, y: 1 };
      await dispatchPointer('pointermove', transparent);
      await expect.poll(() => fixture.getPetInteractionProbe()).toEqual({
        passthrough: true,
        dragging: false
      });
      await dispatchPointer('pointerdown', transparent, 0, 1);
      await dispatchPointer('pointerup', transparent);
      await dispatchPointer('pointerdown', transparent, 0, 1);
      await dispatchPointer('pointerup', transparent);
      await dispatchPointer('contextmenu', transparent, 2);
      await expect.poll(() => fixture.getPetInteractionProbe()).toEqual({
        passthrough: true,
        dragging: false
      });

      let visible: { x: number; y: number } | undefined;
      for (let y = 6; y < 220 && !visible; y += 8) {
        for (let x = 6; x < 180; x += 8) {
          const candidate = { x, y };
          await dispatchPointer('pointermove', candidate);
          const probe = await fixture.getPetInteractionProbe();
          if (!probe.passthrough) {
            visible = candidate;
            break;
          }
        }
      }
      expect(visible, '应在官方默认角色渲染区域中命中可见像素').toBeDefined();
      if (!visible) return;

      const initialState = await shell.getAttribute('data-character-state');
      await expect(pet.getByRole('button', {
        name: '打开与 AI Pet 的聊天'
      })).toHaveCount(0);
      await dispatchPointer('pointermove', visible);
      await dispatchPointer('pointerdown', visible, 0, 1);
      await expect.poll(() => fixture.getPetInteractionProbe()).toEqual({
        passthrough: false,
        dragging: true
      });
      await dispatchPointer('pointermove', transparent, 0, 1);
      await expect.poll(() => fixture.getPetInteractionProbe()).toEqual({
        passthrough: false,
        dragging: true
      });
      await dispatchPointer('pointerup', transparent);
      await expect.poll(() => fixture.getPetInteractionProbe()).toEqual({
        passthrough: true,
        dragging: false
      });

      await dispatchPointer('pointermove', visible);
      await dispatchPointer('pointerdown', visible, 0, 1);
      await dispatchPointer('pointerup', visible);
      await dispatchPointer('pointerdown', visible, 0, 1);
      await dispatchPointer('pointerup', visible);
      await expect(shell).toHaveAttribute(
        'data-character-state',
        initialState ?? 'idle'
      );
      await dispatchPointer('contextmenu', visible, 2);
      await pet.keyboard.press('Escape');
    } finally {
      await fixture.dispose();
    }
  });
});

test.describe('真实角色工作室闭环', () => {
  test('V2 人设、皮肤和精确表现重启后保留且导出回导等价', async () => {
    test.setTimeout(300_000);
    const fixtureModule = await loadElectronFixtureModule();
    expect(typeof fixtureModule?.createElectronAppFixture).toBe('function');
    if (!fixtureModule?.createElectronAppFixture) return;

    const workspaceRoot = resolve(process.cwd());
    const apiKey = runtimeDiagnosticKey();
    const fixture = await fixtureModule.createElectronAppFixture({
      workspaceRoot,
      apiKey,
      launchTimeoutMs: 15_000,
      enableSoftwareRasterizer: true
    });
    type AppFixture = Awaited<
      ReturnType<ElectronFixtureModule['createElectronAppFixture']>
    >;
    const diagnostics: string[] = [];
    const sensitiveFixtures: AppFixture[] = [fixture];
    let exportedPackage = '';
    let exportedBytes: Uint8Array | null = null;
    let recoverySnapshot = '';
    const sanitizeDiagnostic = (text: string): string => sanitizeCapturedDiagnostic(
      text,
      apiKey,
      recoverySnapshot,
      exportedPackage,
      ...sensitiveFixtures.flatMap(candidate => [
        candidate.authorizedRootDirectory,
        candidate.userDataDirectory,
        candidate.characterAssetsDirectory,
        candidate.safeCharacterPackage,
        candidate.maliciousCharacterPackage,
        candidate.characterExportDestination
      ])
    );
    const observedPages = new WeakSet<Page>();
    const observeFixturePages = (appFixture: AppFixture, phase: string): Page[] => {
      const currentPages = appFixture.browser.contexts()
        .flatMap(context => context.pages());
      for (const page of currentPages) {
        if (observedPages.has(page)) continue;
        observedPages.add(page);
        page.setDefaultTimeout(15_000);
        page.on('console', message => {
          diagnostics.push(sanitizeDiagnostic(
            `[${phase}:${page.url()}] console ${message.type()}: ${message.text()}`
          ));
        });
        page.on('pageerror', error => {
          diagnostics.push(sanitizeDiagnostic(
            `[${phase}:${page.url()}] pageerror: ${error.message}`
          ));
        });
      }
      return currentPages;
    };
    const pageFor = (
      appFixture: AppFixture,
      view: string,
      phase: string
    ): Page | undefined => observeFixturePages(appFixture, phase).find(page => {
      try {
        return new URL(page.url()).searchParams.get('view') === view;
      } catch {
        return false;
      }
    });
    const waitForPage = async (
      appFixture: AppFixture,
      view: string,
      step: string
    ): Promise<Page> => {
      try {
        await expect.poll(async () => {
          const page = pageFor(appFixture, view, step);
          return page ? page.locator('main').count() : 0;
        }, {
          timeout: 15_000,
          message: `E2E 步骤“${step}”未等到 ${view} Renderer 的 main`
        }).toBeGreaterThan(0);
        return pageFor(appFixture, view, step)!;
      } catch (error) {
        throw new Error(
          sanitizeDiagnostic(`${String(error)}\nE2E 诊断：${diagnostics.join(' | ')}`)
        );
      }
    };
    const waitForVisibleView = async (page: Page, step: string): Promise<void> => {
      await expect.poll(
        () => page.evaluate(() => document.visibilityState),
        {
          timeout: 15_000,
          message: `E2E 步骤“${step}”的窗口未进入可见状态`
        }
      ).toBe('visible');
      await expect(page.locator('main'), `E2E 步骤“${step}”的 main 不可见`)
        .toBeVisible({ timeout: 15_000 });
    };
    const clickReadyButton = async (
      page: Page,
      name: string,
      step: string
    ): Promise<void> => {
      const button = page.getByRole('button', { name });
      await expect(button, `E2E 步骤“${step}”的按钮不可见`)
        .toBeVisible({ timeout: 15_000 });
      await expect(button, `E2E 步骤“${step}”的按钮不可操作`)
        .toBeEnabled({ timeout: 15_000 });
      await button.click({ timeout: 15_000 });
    };
    const closeWorkshopToast = async (
      page: Page,
      text: string
    ): Promise<void> => {
      const close = page.getByRole('button', {
        name: `关闭提示：${text}`
      });
      await expect(close).toBeVisible({ timeout: 15_000 });
      await close.click();
    };
    const expectExactIdlePresentation = async (page: Page): Promise<void> => {
      await expect(page.getByRole('region', { name: '序列帧时间轴' }).locator('li'))
        .toHaveCount(4);
      await expect(page.getByLabel('ground X')).toHaveValue('0.45');
      await expect(page.getByLabel('ground Y')).toHaveValue('0.95');
    };
    const openWorkshop = async (
      appFixture: AppFixture,
      phase: string
    ): Promise<Page> => {
      const pet = await waitForPage(appFixture, 'pet', `${phase}：等待桌宠`);
      await waitForVisibleView(pet, `${phase}：桌宠就绪`);
      await pet.evaluate(() => window.myself.openChat());
      const chat = await waitForPage(appFixture, 'chat', `${phase}：等待聊天`);
      await waitForVisibleView(chat, `${phase}：聊天就绪`);
      await clickReadyButton(chat, '设置', `${phase}：打开设置`);
      const settings = await waitForPage(appFixture, 'settings', `${phase}：等待设置`);
      await waitForVisibleView(settings, `${phase}：设置就绪`);
      await clickReadyButton(settings, '角色工作室', `${phase}：打开工作室`);
      const workshop = await waitForPage(
        appFixture,
        'characters',
        `${phase}：等待角色工作室`
      );
      await waitForVisibleView(workshop, `${phase}：角色工作室就绪`);
      return workshop;
    };
    observeFixturePages(fixture, '初始启动');

    let primaryError: unknown = null;
    let recoveryCleanupError: unknown = null;
    try {
    try {
      const workshop = await openWorkshop(fixture, '初始启动');
      const petDiagnostics: string[] = [];
      const diagnosticPet = await waitForPage(fixture, 'pet', '初始启动：读取桌宠诊断');
      diagnosticPet.on('console', message => petDiagnostics.push(
        sanitizeDiagnostic(message.text())
      ));
      diagnosticPet.on('pageerror', error => petDiagnostics.push(
        sanitizeDiagnostic(error.message)
      ));
      await workshop.getByRole('button', { name: '新建角色' }).click();
      await workshop.getByLabel('角色名称').fill('E2E 工作室角色');
      await workshop.getByRole('button', { name: '创建角色' }).click();
      await expect(workshop.getByRole('button', { name: /^E2E 工作室角色/ }))
        .toBeVisible();

      // 人设与皮肤均通过正式受控表单写入，后续由同一闭环验证持久化与包等价。
      await workshop.getByRole('button', { name: '编辑角色人设' }).click();
      await workshop.getByLabel('角色描述').fill('喜欢整理桌面的伙伴');
      await workshop.getByLabel('角色背景').fill('从冬日窗边来到桌面的伙伴');
      await workshop.getByLabel('语言风格').fill('温和而简洁');
      await workshop.getByRole('button', { name: '添加性格标签' }).click();
      await workshop.getByRole('group', { name: '性格标签' })
        .getByRole('textbox')
        .fill('细心');
      await workshop.getByRole('button', { name: '新增皮肤' }).click();
      await workshop.getByLabel('皮肤名称').fill('冬装');
      await workshop.getByLabel('皮肤说明').fill('适合冬日桌面的保暖外观');
      const winterSkinItem = workshop.getByRole('list', { name: '皮肤列表' })
        .getByRole('listitem')
        .filter({ hasText: '冬装' });
      await winterSkinItem.getByRole('button', { name: '设为默认' }).click();
      await expect(winterSkinItem).toContainText('默认皮肤');

      await workshop.getByRole('button', {
        name: '向“待机”添加动作'
      }).click();
      await workshop.getByRole('button', { name: '导入素材' }).click();
      await workshop.getByLabel('已导入素材').selectOption({ label: 'idle.png' });
      await workshop.getByLabel('行数').fill('2');
      await workshop.getByLabel('列数').fill('2');
      await workshop.getByLabel('有效帧数').fill('4');
      await workshop.getByRole('button', { name: '应用到当前动作' }).click();
      await expect(workshop.getByText('精灵图网格已应用到当前动作。')).toBeVisible();
      await closeWorkshopToast(workshop, '精灵图网格已应用到当前动作。');
      const idleActionDelete = workshop.getByRole('button', {
        name: '删除动作“动作 1”'
      });
      await workshop.getByRole('button', {
        name: '向“待机”添加动作'
      }).click();
      const emptyActionDelete = workshop.getByRole('button', {
        name: '删除动作“动作 2”'
      });
      await expect(emptyActionDelete).toBeVisible();
      await emptyActionDelete.click();
      const emptyActionDeleteDialog = workshop.getByRole('dialog', {
        name: '删除动作“动作 2”'
      });
      await expect(emptyActionDeleteDialog).toContainText('states.0.actionIds');
      await emptyActionDeleteDialog.getByRole('button', { name: '确认删除' }).click();
      await expect(emptyActionDelete).toHaveCount(0);
      await idleActionDelete.click();
      const configuredActionDeleteDialog = workshop.getByRole('dialog', {
        name: '删除动作“动作 1”'
      });
      await expect(configuredActionDeleteDialog).toContainText('skins.1.presentations');
      await configuredActionDeleteDialog.getByRole('button', { name: '取消' }).click();
      await expect(configuredActionDeleteDialog).toHaveCount(0);
      await expect(idleActionDelete).toBeVisible();
      const draftPreview = workshop.locator('[data-preview-status]');
      await expect(draftPreview).toHaveAttribute('data-preview-status', 'ready');
      await expect(workshop.getByText('当前使用：当前皮肤精确表现')).toBeVisible();
      await workshop.getByRole('button', { name: '切换左右方向' }).click();
      await expect(draftPreview).toHaveAttribute('data-preview-direction', 'left');
      await workshop.locator('.preview-controls input[type="range"]').fill('1.5');
      await expect(draftPreview).toHaveAttribute('data-preview-speed', '1.5');
      await workshop.getByLabel('ground X').fill('0.45');
      await workshop.getByLabel('ground Y').fill('0.95');
      await expectExactIdlePresentation(workshop);

      // 保留旧闭环的非 idle 投影价值：通过正式 V2 UI 建立搬运状态及可播放动作。
      await workshop.getByRole('button', { name: '添加扩展状态' }).click();
      await workshop.getByLabel('状态名称').fill('搬运状态');
      await workshop.getByLabel('状态类别').selectOption('modifier');
      await workshop.getByLabel('标准语义').selectOption('carry');
      await workshop.getByLabel('状态名称').press('Enter');
      const carryingState = workshop.getByRole('list', { name: '状态与动作列表' })
        .getByRole('listitem')
        .filter({ has: workshop.getByRole('button', { name: /^搬运状态/ }) });
      await carryingState.getByRole('button', { name: '向“搬运状态”添加动作' }).click();
      await workshop.getByLabel('动作名称').fill('搬运行走');
      await workshop.getByLabel('已导入素材').selectOption({ label: 'idle.png' });
      await workshop.getByRole('button', { name: '应用到当前动作' }).click();
      await expect(workshop.getByText('精灵图网格已应用到当前动作。')).toBeVisible();
      await closeWorkshopToast(workshop, '精灵图网格已应用到当前动作。');
      await workshop.getByRole('button', { name: /^待机/ }).click();
      await workshop.getByRole('button', { name: /^动作 1/ }).click();
      await expectExactIdlePresentation(workshop);
      await workshop.getByRole('button', { name: '编译并发布' }).click();
      await expect(workshop.getByText('运行版本已编译并发布。')).toBeVisible();
      await closeWorkshopToast(workshop, '运行版本已编译并发布。');

      const createdCharacterItem = workshop.getByRole('list', { name: '角色列表' })
        .getByRole('listitem')
        .filter({ has: workshop.getByRole('button', { name: /^E2E 工作室角色/ }) });
      await expect(createdCharacterItem)
        .toHaveAttribute('data-character-completeness', 'complete');
      await workshop.getByRole('button', { name: '启用角色' }).click();
      await expect(workshop.getByText('角色已启用。')).toBeVisible();
      await closeWorkshopToast(workshop, '角色已启用。');

      const pet = await waitForPage(fixture, 'pet', '初始启动：验证角色播放器');
      try {
        await expect(pet.locator('.character-player')).toHaveAttribute('data-status', 'ready');
      } catch (error) {
        throw new Error(sanitizeDiagnostic(
          `${String(error)}\n角色播放器诊断：${petDiagnostics.join(' | ')}`
        ));
      }
      const legacyRuntime = await pet.evaluate(async () => {
        const snapshot = await window.myself.getCharacterRuntimeSnapshot();
        return snapshot ? {
          version: snapshot.manifest.version,
          idleActionCount: snapshot.manifest.states
            .find(state => state.id === 'idle')?.actions.length ?? 0,
          carryingActionCount: snapshot.manifest.states
            .find(state => state.id === 'carrying')?.actions.length ?? 0
        } : null;
      });
      expect(legacyRuntime).toEqual({
        version: 1,
        idleActionCount: 1,
        carryingActionCount: 1
      });
      await pet.evaluate(() => window.myself.openChat());
      const chat = await waitForPage(fixture, 'chat', '初始启动：验证聊天降级');
      await submitChatMessage(chat, 'thinking 降级期间继续验证 Agent');
      await expect(chat.getByText('请先完成模型服务和授权目录设置。')).toBeVisible();

      await workshop.getByRole('button', { name: '导出角色包' }).click();
      await expect(workshop.getByText('角色包已导出。')).toBeVisible();
      await closeWorkshopToast(workshop, '角色包已导出。');
      exportedPackage = fixture.characterExportDestination!;
      exportedBytes = await readFile(exportedPackage);
      expect(exportedBytes.byteLength).toBeGreaterThan(0);

      await workshop.getByLabel('动作名称').fill('冬日待机');
      await workshop.getByRole('button', { name: '保存草稿' }).click();
      await expect(workshop.getByText('草稿已保存', { exact: true })).toBeVisible();
      await expect(workshop.getByRole('button', {
        name: '关闭提示：草稿已保存'
      })).toHaveCount(0);
      recoverySnapshot = await mkdtemp(join(tmpdir(), 'ai-pet-character-recovery-'));
      await cp(
        join(fixture.userDataDirectory, 'characters'),
        join(recoverySnapshot, 'characters'),
        { recursive: true }
      );
    } finally {
      await fixture.dispose();
    }

    const recovered = await fixtureModule.createElectronAppFixture({
      workspaceRoot,
      apiKey,
      launchTimeoutMs: 15_000,
      enableSoftwareRasterizer: true,
      prepareUserData: async directories => {
        await cp(
          join(recoverySnapshot, 'characters'),
          join(directories.userDataDirectory, 'characters'),
          {
            recursive: true,
            force: true
          }
        );
      }
    });
    sensitiveFixtures.push(recovered);
    observeFixturePages(recovered, '重启恢复');
    try {
      const workshop = await openWorkshop(recovered, '重启恢复');
      const pet = await waitForPage(recovered, 'pet', '重启恢复：读取活动角色');
      const recoveredCharacter = workshop.getByRole('button', {
        name: /^E2E 工作室角色/
      });
      await expect(recoveredCharacter).toBeVisible({ timeout: 15_000 });
      await recoveredCharacter.click();
      await workshop.getByRole('button', { name: '编辑角色人设' }).click();
      await expect(workshop.getByLabel('角色描述'))
        .toHaveValue('喜欢整理桌面的伙伴');
      await expect(workshop.getByLabel('角色背景'))
        .toHaveValue('从冬日窗边来到桌面的伙伴');
      await expect(workshop.getByLabel('语言风格')).toHaveValue('温和而简洁');
      await expect(workshop.getByRole('group', { name: '性格标签' })
        .getByRole('textbox')).toHaveValue('细心');
      const recoveredWinterSkin = workshop.getByRole('list', { name: '皮肤列表' })
        .getByRole('listitem')
        .filter({ hasText: '冬装' });
      await expect(recoveredWinterSkin).toContainText('默认皮肤');
      await recoveredWinterSkin.getByRole('button', { name: /冬装/ }).click();
      await expect(workshop.getByLabel('皮肤说明'))
        .toHaveValue('适合冬日桌面的保暖外观');
      await workshop.getByRole('button', { name: /^待机/ }).click();
      await workshop.getByRole('button', { name: /^冬日待机/ }).click();
      await expect(workshop.getByLabel('已导入素材')).toContainText('idle.png');
      await expect(workshop.getByLabel('动作名称'))
        .toHaveValue('冬日待机', { timeout: 15_000 });
      await expect(workshop.getByText('当前使用：当前皮肤精确表现')).toBeVisible();
      const recoveredPreview = workshop.locator('[data-preview-status]');
      await expect(recoveredPreview).toHaveAttribute('data-preview-status', 'ready');
      await expectExactIdlePresentation(workshop);
      await expect(workshop.getByRole('button', {
        name: '向“待机”添加动作'
      })).toBeVisible();
      await expect(workshop.getByRole('button', {
        name: '删除动作“冬日待机”'
      })).toBeVisible();
      await expect(
        workshop.getByRole('region', { name: '序列帧时间轴' })
          .locator('li')
          .first()
          .getByRole('button')
      ).toHaveAttribute('aria-pressed', 'true');
      const active = await pet.evaluate(async () => (
        (await window.myself.getCharacterRuntimeSnapshot())?.activeCharacterId
      ));
      expect(active).not.toBe('builtin-default');
    } finally {
      await recovered.dispose();
    }

    const isolated = await fixtureModule.createElectronAppFixture({
      workspaceRoot,
      apiKey,
      launchTimeoutMs: 15_000,
      enableSoftwareRasterizer: true,
      prepareUserData: async directories => {
        if (!directories.packagesDirectory) {
          throw new Error('缺少隔离角色包目录');
        }
        if (!exportedBytes) throw new Error('缺少已导出的角色包');
        await writeFile(
          join(directories.packagesDirectory, 'safe-character.zip'),
          exportedBytes
        );
      }
    });
    sensitiveFixtures.push(isolated);
    observeFixturePages(isolated, '隔离导入');
    try {
      const workshop = await openWorkshop(isolated, '隔离导入');
      const pet = await waitForPage(isolated, 'pet', '隔离导入：读取桌宠状态');

      await clickReadyButton(workshop, '导入角色包', '隔离导入：导入安全角色包');
      const importedCharacter = workshop.getByRole('button', { name: /^E2E 工作室角色/ });
      await expect(importedCharacter).toBeVisible({ timeout: 15_000 });
      await importedCharacter.click();
      await workshop.getByRole('button', { name: '编辑角色人设' }).click();
      await expect(workshop.getByLabel('角色描述'))
        .toHaveValue('喜欢整理桌面的伙伴');
      await expect(workshop.getByLabel('角色背景'))
        .toHaveValue('从冬日窗边来到桌面的伙伴');
      await expect(workshop.getByLabel('语言风格')).toHaveValue('温和而简洁');
      await expect(workshop.getByRole('group', { name: '性格标签' })
        .getByRole('textbox')).toHaveValue('细心');
      const importedWinterSkin = workshop.getByRole('list', { name: '皮肤列表' })
        .getByRole('listitem')
        .filter({ hasText: '冬装' });
      await expect(importedWinterSkin).toContainText('默认皮肤');
      await importedWinterSkin.getByRole('button', { name: /冬装/ }).click();
      await expect(workshop.getByLabel('皮肤说明'))
        .toHaveValue('适合冬日桌面的保暖外观');
      await workshop.getByRole('button', { name: /^待机/ }).click();
      await workshop.getByRole('button', { name: /^动作 1/ }).click();
      await expect(workshop.getByText('当前使用：当前皮肤精确表现')).toBeVisible();
      await expectExactIdlePresentation(workshop);
      const characterList = workshop.getByRole('list', { name: '角色列表' });
      const summariesBefore = await characterList.getByRole('listitem').evaluateAll(items => (
        items.map(item => ({
          id: (item as HTMLElement).dataset.characterId,
          active: (item as HTMLElement).dataset.characterActive,
          completeness: (item as HTMLElement).dataset.characterCompleteness,
          text: item.textContent
        }))
      ));
      const runtimeBefore = await pet.evaluate(async () => ({
        activeCharacterId: (
          await window.myself.getCharacterRuntimeSnapshot()
        )?.activeCharacterId ?? null,
        state: document.querySelector('main[data-character-state]')
          ?.getAttribute('data-character-state') ?? null
      }));
      const isolatedCharactersDirectory = join(
        isolated.userDataDirectory,
        'characters'
      );
      await expect.poll(async () => (
        await snapshotCharacterPersistence(isolatedCharactersDirectory)
      ).tree.some(entry => (
        entry.type === 'file' && entry.path.startsWith('.locks/')
      )), {
        message: '安全角色包导入锁应在持久化快照前释放'
      }).toBe(false);
      const persistenceBefore = await snapshotCharacterPersistence(
        isolatedCharactersDirectory
      );
      await clickReadyButton(workshop, '导入角色包', '隔离导入：拒绝恶意角色包');
      await expect(workshop.getByRole('alert'))
        .toContainText('角色包包含不安全路径，已拒绝导入。', { timeout: 15_000 });
      expect(await characterList.getByRole('listitem').evaluateAll(items => (
        items.map(item => ({
          id: (item as HTMLElement).dataset.characterId,
          active: (item as HTMLElement).dataset.characterActive,
          completeness: (item as HTMLElement).dataset.characterCompleteness,
          text: item.textContent
        }))
      ))).toEqual(summariesBefore);
      expect(await pet.evaluate(async () => ({
        activeCharacterId: (
          await window.myself.getCharacterRuntimeSnapshot()
        )?.activeCharacterId ?? null,
        state: document.querySelector('main[data-character-state]')
          ?.getAttribute('data-character-state') ?? null
      }))).toEqual(runtimeBefore);
      expect(await snapshotCharacterPersistence(
        isolatedCharactersDirectory
      )).toEqual(persistenceBefore);
    } finally {
      await isolated.dispose();
    }
    } catch (error) {
      primaryError = sanitizedCapturedError(error, sanitizeDiagnostic);
    } finally {
      if (recoverySnapshot) {
        try {
          await rm(recoverySnapshot, { recursive: true, force: true });
        } catch (error) {
          recoveryCleanupError = sanitizedCapturedError(error, sanitizeDiagnostic);
        }
      }
    }

    if (primaryError && recoveryCleanupError) {
      throw new AggregateError(
        [primaryError, recoveryCleanupError],
        sanitizeDiagnostic(
          `角色工作室闭环失败：${String(primaryError)}\n附加清理诊断：${String(recoveryCleanupError)}`
        ),
        { cause: primaryError }
      );
    }
    if (primaryError) throw primaryError;
    if (recoveryCleanupError) throw recoveryCleanupError;
  });

  test('fake bridge 脚本只向隔离目录写入固定无参数事件令牌', async () => {
    const fixture = await loadElectronFixtureModule();
    expect(typeof fixture?.writeMainE2eExplorerEvent).toBe('function');
    if (!fixture?.writeMainE2eExplorerEvent) return;
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'myself-e2e-explorer-events-'));
    try {
      await fixture.writeMainE2eExplorerEvent(temporaryDirectory, 'ambiguous');
      await fixture.writeMainE2eExplorerEvent(temporaryDirectory, 'exact-foreground');

      await expect(readFile(
        join(temporaryDirectory, 'main-e2e-explorer-events'),
        'utf8'
      )).resolves.toBe('ambiguous\nexact-foreground\n');
      await expect(fixture.writeMainE2eExplorerEvent(
        temporaryDirectory,
        'C:\\Private\\Habitat' as never
      )).rejects.toThrow('E2E_EXPLORER_EVENT_INVALID');
    } finally {
      await rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  test('工作室清理的单错误、聚合 errors 与 cause 均只保留脱敏错误', () => {
    const userDataDirectory = 'C:\\Temp\\private-user-data';
    const recoverySnapshot = 'C:\\Temp\\private-recovery';
    const safePackage = 'C:\\Temp\\private-package.zip';
    const sanitize = (text: string): string => sanitizeCapturedDiagnostic(
      text,
      userDataDirectory,
      recoverySnapshot,
      safePackage
    );
    const primary = sanitizedCapturedError(
      new Error(`主失败 ${userDataDirectory}`),
      sanitize
    );
    const cleanup = sanitizedCapturedError(
      new Error(`清理失败 ${recoverySnapshot} ${safePackage}`),
      sanitize
    );
    const aggregate = new AggregateError(
      [primary, cleanup],
      sanitize(`主失败 ${userDataDirectory}；清理失败 ${recoverySnapshot} ${safePackage}`),
      { cause: primary }
    );
    const observable = [
      primary.message,
      primary.stack,
      cleanup.message,
      cleanup.stack,
      aggregate.message,
      ...aggregate.errors.map(error => error instanceof Error ? error.message : String(error)),
      aggregate.cause instanceof Error ? aggregate.cause.message : String(aggregate.cause)
    ].join('\n');

    expect(observable).not.toContain(userDataDirectory);
    expect(observable).not.toContain(recoverySnapshot);
    expect(observable).not.toContain(safePackage);
    expect(observable).toContain('[已脱敏]');
  });
});

test.describe('自主行为最小闭环', () => {
  test('E2E 只读探针观察默认角色待机播放', async () => {
    test.setTimeout(60_000);
    const fixtureModule = await loadElectronFixtureModule();
    expect(typeof fixtureModule?.createElectronAppFixture).toBe('function');
    if (!fixtureModule?.createElectronAppFixture) return;
    const fixture = await fixtureModule.createElectronAppFixture({
      workspaceRoot: resolve(process.cwd()),
      apiKey: runtimeDiagnosticKey(),
      launchTimeoutMs: 15_000
    });

    try {
      await expect.poll(() => fixture.getCharacterBehaviorProbe()).toMatchObject({
        primaryStateId: 'idle',
        actionId: 'idle-main',
        playbackStatus: expect.stringMatching(/^(started|completed)$/u)
      });
      const probe = await fixture.getCharacterBehaviorProbe();
      expect(probe.revision).toBeGreaterThan(0);
      expect(probe.modifierStateIds).toEqual([]);
      expect(Object.keys(probe).sort()).toEqual([
        'actionId',
        'modifierStateIds',
        'playbackStatus',
        'primaryStateId',
        'revision'
      ]);
    } finally {
      await fixture.dispose();
    }
  });

  test('聊天、移动、错误降级与角色切换保持 Main 到 Renderer 闭环', async () => {
    test.setTimeout(120_000);
    const firstResponseGate = createProviderResponseGate();
    const provider = await startProviderServer([
      {
        response: { type: 'text', text: '无意图本地降级完成' },
        gate: firstResponseGate
      },
      {
        response: {
          type: 'text',
          text: '非法意图已忽略',
          behaviorIntent: {
            stateIntent: { stateId: 'missing-state' },
            actionSemantic: 'think',
            urgency: 50,
            explanation: '测试非法状态回退'
          }
        }
      },
      {
        response: {
          type: 'text',
          text: '开始移动',
          behaviorIntent: {
            stateIntent: { semantic: 'move' },
            actionSemantic: 'move',
            urgency: 80,
            explanation: '测试移动闭环'
          }
        }
      }
    ]);
    const fixtureModule = await loadElectronFixtureModule();
    expect(typeof fixtureModule?.createElectronAppFixture).toBe('function');
    if (!fixtureModule?.createElectronAppFixture) {
      await provider.close();
      return;
    }
    const fixture = await fixtureModule.createElectronAppFixture({
      workspaceRoot: resolve(process.cwd()),
      apiKey: provider.apiKey,
      launchTimeoutMs: 15_000,
      enableSoftwareRasterizer: true
    });
    const pages = (): Page[] => fixture.browser.contexts().flatMap(context => context.pages());
    const pageFor = (view: 'pet' | 'chat'): Page | undefined => pages().find(page => {
      try {
        return new URL(page.url()).searchParams.get('view') === view;
      } catch {
        return false;
      }
    });

    try {
      await expect.poll(() => Boolean(pageFor('pet') && pageFor('chat'))).toBe(true);
      const pet = pageFor('pet')!;
      const chat = pageFor('chat')!;
      await pet.evaluate(() => {
        const scope = globalThis as typeof globalThis & {
          __behaviorActions?: Array<{ stateId: string; actionId: string }>;
        };
        scope.__behaviorActions = [];
        window.myself.subscribeCharacterMotion(event => {
          if (event.type !== 'behavior-action') return;
          scope.__behaviorActions?.push({ stateId: event.stateId, actionId: event.actionId });
        });
      });
      await chat.evaluate(() => {
        const scope = globalThis as typeof globalThis & { __taskPhases?: string[] };
        scope.__taskPhases = [];
        window.myself.onTaskEvent(event => {
          if (event.type === 'phase') scope.__taskPhases?.push(event.phase);
        });
      });
      const imported = await pet.evaluate(async () => window.myself.importCharacterPackage());
      expect(imported.kind).toBe('imported');
      if (imported.kind !== 'imported') return;
      await pet.evaluate(async characterId => {
        await window.myself.activateCharacter(characterId);
      }, imported.characterId);
      await expect.poll(() => fixture.getCharacterBehaviorProbe()).toMatchObject({
        primaryStateId: 'idle',
        actionId: 'safe-idle-action',
        playbackStatus: 'started'
      });

      const idleProbe = await fixture.getCharacterBehaviorProbe();
      await pet.evaluate(async () => {
        await window.myself.beginPetDrag();
        await window.myself.endPetDrag();
      });
      await expect.poll(async () => {
        const probe = await fixture.getCharacterBehaviorProbe();
        return {
          revisionAdvanced: probe.revision > idleProbe.revision,
          primaryStateId: probe.primaryStateId,
          actionId: probe.actionId,
          playbackStatus: probe.playbackStatus
        };
      }).toEqual({
        revisionAdvanced: true,
        primaryStateId: 'idle',
        actionId: 'safe-idle-action',
        playbackStatus: 'started'
      });

      await pet.evaluate(async ({ baseUrl, apiKey }) => {
        await window.myself.saveProviderProfile({
          profile: {
            id: 'behavior-e2e',
            displayName: '自主行为 E2E',
            mode: 'custom',
            protocol: 'openai-compatible',
            baseUrl,
            modelId: 'behavior-e2e-model',
            additionalParameters: {},
            capabilities: ['chat', 'tools']
          },
          secret: apiKey,
          persistSecret: false
        });
        await window.myself.saveModelRoute({
          primaryProfileId: 'behavior-e2e',
          chatProfileId: 'behavior-e2e',
          agentProfileId: 'behavior-e2e',
          visionProfileId: null,
          fallbackProfileIds: [],
          allowCrossProviderFallback: false
        });
        await window.myself.chooseAuthorizedRoot();
      }, { baseUrl: provider.baseUrl, apiKey: provider.apiKey });
      await pet.evaluate(() => window.myself.openChat());
      await expect.poll(() => chat.evaluate(() => document.visibilityState)).toBe('visible');

      const phaseOffset = await chat.evaluate(() => (
        (globalThis as typeof globalThis & { __taskPhases?: string[] }).__taskPhases?.length ?? 0
      ));
      const conversationActionOffset = await pet.evaluate(() => (
        (globalThis as typeof globalThis & { __behaviorActions?: unknown[] })
          .__behaviorActions?.length ?? 0
      ));
      await submitChatMessage(chat, '验证模型无意图降级');
      await expect.poll(() => firstResponseGate.isWaiting()).toBe(true);
      await expect.poll(() => fixture.getCharacterBehaviorProbe(), {
        intervals: [10, 20, 50, 100]
      }).toMatchObject({
        primaryStateId: 'thinking',
        actionId: 'safe-think-action'
      });
      firstResponseGate.release();
      await expect(chat.getByText('无意图本地降级完成')).toBeVisible();
      await expect.poll(() => fixture.getCharacterBehaviorProbe()).toMatchObject({
        primaryStateId: 'success',
        actionId: 'safe-celebrate-action',
        playbackStatus: expect.stringMatching(/^(started|completed)$/u)
      });
      const phases = await chat.evaluate(offset => (
        (globalThis as typeof globalThis & { __taskPhases?: string[] })
          .__taskPhases?.slice(offset) ?? []
      ), phaseOffset);
      expect(phases.indexOf('listening')).toBeGreaterThanOrEqual(0);
      expect(phases.indexOf('thinking')).toBeGreaterThan(phases.indexOf('listening'));
      const conversationActions = await pet.evaluate(offset => (
        (globalThis as typeof globalThis & {
          __behaviorActions?: Array<{ stateId: string; actionId: string }>;
        }).__behaviorActions?.slice(offset) ?? []
      ), conversationActionOffset);
      expect(conversationActions).toEqual(expect.arrayContaining([
        { stateId: 'listening', actionId: 'safe-listen-action' },
        { stateId: 'thinking', actionId: 'safe-think-action' },
        { stateId: 'success', actionId: 'safe-celebrate-action' }
      ]));

      const invalidActionOffset = await pet.evaluate(() => (
        (globalThis as typeof globalThis & { __behaviorActions?: unknown[] })
          .__behaviorActions?.length ?? 0
      ));
      await submitChatMessage(chat, '验证非法意图');
      await expect(chat.getByText('非法意图已忽略')).toBeVisible();
      const invalidActions = await pet.evaluate(offset => (
        (globalThis as typeof globalThis & {
          __behaviorActions?: Array<{ stateId: string; actionId: string }>;
        }).__behaviorActions?.slice(offset) ?? []
      ), invalidActionOffset);
      expect(invalidActions.filter(action => action.stateId === 'thinking')).toHaveLength(3);
      expect(invalidActions).not.toContainEqual(expect.objectContaining({ stateId: 'missing-state' }));
      const invalidFallback = await fixture.getCharacterBehaviorProbe();
      expect(invalidFallback.primaryStateId).not.toBe('missing-state');
      expect(invalidFallback.actionId).toBe('safe-celebrate-action');

      const positionBeforeMove = await pet.evaluate(() => ({ x: window.screenX, y: window.screenY }));
      await submitChatMessage(chat, '验证移动');
      await expect(chat.getByText('开始移动')).toBeVisible();
      await expect.poll(() => fixture.getCharacterBehaviorProbe()).toMatchObject({
        primaryStateId: 'moving',
        actionId: 'safe-move-action',
        playbackStatus: expect.stringMatching(/^(started|completed)$/u)
      });
      await expect.poll(async () => {
        const current = await pet.evaluate(() => ({ x: window.screenX, y: window.screenY }));
        return current.x !== positionBeforeMove.x || current.y !== positionBeforeMove.y;
      }).toBe(true);

      await expect(chat.getByLabel('和我说点什么')).toBeEnabled();
      await submitChatMessage(chat, '验证模型不可用');
      await expect(chat.getByText('模型服务发生错误，请稍后重试。')).toBeVisible();
      await expect.poll(() => fixture.getCharacterBehaviorProbe()).toMatchObject({
        primaryStateId: 'error',
        actionId: 'safe-fail-action',
        playbackStatus: expect.stringMatching(/^(started|completed)$/u)
      });

      // 角色切换断言使用静止前置条件，避免仍在进行的 wander 被合法继承为移动语义。
      await pet.evaluate(async () => {
        await window.myself.beginPetDrag();
        await window.myself.endPetDrag();
      });
      await expect.poll(() => pet.evaluate(async () => (
        await window.myself.getCharacterMotionSnapshot()
      ).moving)).toBe(false);

      const characters = await pet.evaluate(() => window.myself.listCharacters());
      const builtin = characters.find(character => character.id === 'builtin-default');
      expect(builtin).toBeDefined();
      await pet.evaluate(async characterId => {
        await window.myself.activateCharacter(characterId);
      }, builtin!.id);
      await expect.poll(() => fixture.getCharacterBehaviorProbe()).toMatchObject({
        primaryStateId: 'idle',
        actionId: 'idle-main',
        playbackStatus: expect.stringMatching(/^(started|completed)$/u)
      });
      expect((await fixture.getCharacterBehaviorProbe()).actionId).not.toBe('safe-fail-action');
      expect(provider.inspectionErrors).toEqual([]);
    } finally {
      firstResponseGate.release();
      await fixture.dispose();
      await provider.close();
    }
  });
});

test.describe('真实 Provider 业务闭环', () => {
  test('回收站搬运闭环只在提交帧后写入隔离适配器并安全处理中断与失败', async () => {
    test.setTimeout(120_000);
    const provider = await startProviderServer([
      {
        response: toolResponse(
          'recycle-success',
          'builtin.files.move_to_recycle_bin',
          { relativePath: 'success.txt' }
        )
      },
      {
        response: { type: 'text', text: 'success.txt 已移入回收站。' },
        inspect: request => {
          const result = lastToolResult(request) as {
            toolName?: string;
            targetRelativePath?: string;
          };
          if (
            result.toolName !== 'move_to_recycle_bin'
            || result.targetRelativePath !== 'success.txt'
          ) throw new Error('回收站结果不符合脚本预期');
        }
      },
      {
        response: toolResponse(
          'recycle-switch',
          'builtin.files.move_to_recycle_bin',
          { relativePath: 'switch.txt' }
        )
      },
      {
        response: toolResponse(
          'recycle-drag',
          'builtin.files.move_to_recycle_bin',
          { relativePath: 'drag.txt' }
        )
      },
      {
        response: toolResponse(
          'recycle-failure',
          'builtin.files.move_to_recycle_bin',
          { relativePath: 'failure.txt' }
        )
      }
    ]);
    const fixtureModule = await loadElectronFixtureModule();
    expect(typeof fixtureModule?.createElectronAppFixture).toBe('function');
    if (!fixtureModule?.createElectronAppFixture) {
      await provider.close();
      return;
    }
    const fixture = await fixtureModule.createElectronAppFixture({
      workspaceRoot: resolve(process.cwd()),
      apiKey: provider.apiKey,
      launchTimeoutMs: 15_000,
      enableSoftwareRasterizer: true
    });
    const recycleBinDirectory = fixture.recycleBinDirectory;
    if (!recycleBinDirectory) throw new Error('缺少隔离回收站目录');
    const pages = (): Page[] => fixture.browser.contexts().flatMap(context => context.pages());
    const pageFor = (view: 'pet' | 'chat'): Page | undefined => pages().find(page => {
      try {
        return new URL(page.url()).searchParams.get('view') === view;
      } catch {
        return false;
      }
    });

    try {
      await expect.poll(() => Boolean(pageFor('pet') && pageFor('chat'))).toBe(true);
      const pet = pageFor('pet')!;
      const chat = pageFor('chat')!;
      await pet.evaluate(() => {
        const scope = globalThis as typeof globalThis & {
          __recycleCarryEvents?: Array<{
            playbackToken: string;
            actionId: string;
            commitFrameId: string | null;
          }>;
        };
        scope.__recycleCarryEvents = [];
        window.myself.subscribeCharacterMotion(event => {
          if (event.type !== 'behavior-action' || event.stateId !== 'carrying') return;
          scope.__recycleCarryEvents?.push({
            playbackToken: event.playbackToken,
            actionId: event.actionId,
            commitFrameId: event.commitFrameId ?? null
          });
        });
      });
      const imported = await pet.evaluate(() => window.myself.importCharacterPackage());
      expect(imported.kind).toBe('imported');
      if (imported.kind !== 'imported') return;
      await pet.evaluate(async ({ characterId, baseUrl, apiKey }) => {
        await window.myself.activateCharacter(characterId);
        await window.myself.saveProviderProfile({
          profile: {
            id: 'recycle-e2e',
            displayName: '回收站 E2E',
            mode: 'custom',
            protocol: 'openai-compatible',
            baseUrl,
            modelId: 'recycle-e2e-model',
            additionalParameters: {},
            capabilities: ['chat', 'tools']
          },
          secret: apiKey,
          persistSecret: false
        });
        await window.myself.saveModelRoute({
          primaryProfileId: 'recycle-e2e',
          chatProfileId: 'recycle-e2e',
          agentProfileId: 'recycle-e2e',
          visionProfileId: null,
          fallbackProfileIds: [],
          allowCrossProviderFallback: false
        });
        await window.myself.savePrivacySettings({
          dataCategories: {
            file: true,
            screenshot: false,
            clipboard: false,
            memory: false
          },
          longTermMemory: false,
          proactivityMode: 'passive'
        });
        await window.myself.chooseAuthorizedRoot();
        await window.myself.openChat();
      }, {
        characterId: imported.characterId,
        baseUrl: provider.baseUrl,
        apiKey: provider.apiKey
      });
      await expect.poll(() => chat.evaluate(() => document.visibilityState)).toBe('visible');

      const carryEventCount = async (): Promise<number> => pet.evaluate(() => (
        (globalThis as typeof globalThis & { __recycleCarryEvents?: unknown[] })
          .__recycleCarryEvents?.length ?? 0
      ));
      const waitForCarry = async (offset: number) => {
        await expect.poll(() => fixture.getCharacterBehaviorProbe(), {
          intervals: [10, 20, 50, 100]
        }).toMatchObject({
          primaryStateId: 'carrying',
          actionId: 'safe-carry-action',
          playbackStatus: 'started'
        });
        return pet.evaluate(index => {
          const events = (globalThis as typeof globalThis & {
            __recycleCarryEvents?: Array<{
              playbackToken: string;
              actionId: string;
              commitFrameId: string | null;
            }>;
          }).__recycleCarryEvents ?? [];
          const event = events[index];
          if (!event) throw new Error('缺少搬运授权事件');
          return event;
        }, offset);
      };
      const beginRecycle = async (fileName: string): Promise<{
        source: string;
        carryOffset: number;
      }> => {
        const source = join(fixture.authorizedRootDirectory, fileName);
        await writeFile(source, `${fileName} 内容`, 'utf8');
        const carryOffset = await carryEventCount();
        await submitChatMessage(chat, `把 ${fileName} 移入回收站`);
        const card = chat.getByRole('region', { name: `将 ${fileName} 移入回收站` });
        await expect(card).toBeVisible();
        await expect(card.getByText(fileName, { exact: true })).toBeVisible();
        await expect(card.getByText('将移入 Windows 回收站，可从回收站恢复；执行前还会再次检查。'))
          .toBeVisible();
        expect(await pathExistsForAssertion(source)).toBe(true);
        await card.getByRole('button', { name: '确认移入回收站' }).click();
        return { source, carryOffset };
      };

      const success = await beginRecycle('success.txt');
      const successGrant = await waitForCarry(success.carryOffset);
      expect(await pathExistsForAssertion(success.source)).toBe(true);
      expect((await readdir(recycleBinDirectory)).filter(name => name.startsWith('.attempt-')))
        .toEqual([]);
      await pet.evaluate(async grant => {
        for (const candidate of [
          { ...grant, playbackToken: 'forged-token', kind: 'commit-frame' as const },
          { ...grant, actionId: 'cross-character-action', kind: 'commit-frame' as const },
          { ...grant, commitFrameId: 'stale-frame', kind: 'commit-frame' as const }
        ]) {
          try {
            await window.myself.reportCharacterActionMilestone({
              playbackToken: candidate.playbackToken,
              actionId: candidate.actionId,
              kind: candidate.kind,
              frameId: candidate.commitFrameId ?? 'missing-frame'
            });
          } catch {
            // 伪造反馈必须由 Main 拒绝；测试只观察拒绝后无文件副作用。
          }
        }
      }, successGrant);
      expect(await pathExistsForAssertion(success.source)).toBe(true);
      expect((await readdir(recycleBinDirectory)).filter(name => name.startsWith('.attempt-')))
        .toEqual([]);
      await expect.poll(() => pathExistsForAssertion(success.source)).toBe(false);
      await expect(chat.getByText('success.txt 已移入回收站。')).toBeVisible();
      await expect.poll(() => fixture.getCharacterBehaviorProbe()).toMatchObject({
        primaryStateId: 'success',
        actionId: 'safe-celebrate-action',
        playbackStatus: expect.stringMatching(/^(started|completed)$/u)
      });
      expect((await readdir(recycleBinDirectory)).filter(name => name.startsWith('.attempt-')))
        .toEqual(['.attempt-1']);
      await pet.evaluate(async grant => {
        try {
          await window.myself.reportCharacterActionMilestone({
            playbackToken: grant.playbackToken,
            actionId: grant.actionId,
            kind: 'commit-frame',
            frameId: grant.commitFrameId ?? 'missing-frame'
          });
        } catch {
          // 已完成事务的重复里程碑必须被拒绝。
        }
      }, successGrant);
      expect((await readdir(recycleBinDirectory)).filter(name => name.startsWith('.attempt-')))
        .toEqual(['.attempt-1']);

      const switched = await beginRecycle('switch.txt');
      const switchedGrant = await waitForCarry(switched.carryOffset);
      await pet.evaluate(async oldGrant => {
        try {
          await window.myself.reportCharacterActionMilestone({
            playbackToken: oldGrant.playbackToken,
            actionId: oldGrant.actionId,
            kind: 'commit-frame',
            frameId: oldGrant.commitFrameId ?? 'missing-frame'
          });
        } catch {
          // 上一事务真实授权不得提交当前事务。
        }
      }, successGrant);
      expect(await pathExistsForAssertion(switched.source)).toBe(true);
      expect((await readdir(recycleBinDirectory)).filter(name => name.startsWith('.attempt-')))
        .toHaveLength(1);
      const characters = await pet.evaluate(() => window.myself.listCharacters());
      const builtin = characters.find(character => character.id === 'builtin-default');
      if (!builtin) throw new Error('缺少内置角色');
      await pet.evaluate(characterId => window.myself.activateCharacter(characterId), builtin.id);
      await expect(chat.getByText('搬运动画未完成，文件未被移动。')).toBeVisible();
      await pet.evaluate(async oldGrant => {
        try {
          await window.myself.reportCharacterActionMilestone({
            playbackToken: oldGrant.playbackToken,
            actionId: oldGrant.actionId,
            kind: 'commit-frame',
            frameId: oldGrant.commitFrameId ?? 'missing-frame'
          });
        } catch {
          // 角色切换后原角色真实授权必须立即失效。
        }
      }, switchedGrant);
      expect(await pathExistsForAssertion(switched.source)).toBe(true);
      expect((await readdir(recycleBinDirectory)).filter(name => name.startsWith('.attempt-')))
        .toHaveLength(1);

      await pet.evaluate(characterId => window.myself.activateCharacter(characterId), imported.characterId);
      await expect.poll(() => fixture.getCharacterBehaviorProbe()).toMatchObject({
        primaryStateId: 'idle',
        actionId: 'safe-idle-action',
        playbackStatus: 'started'
      });
      const dragged = await beginRecycle('drag.txt');
      await waitForCarry(dragged.carryOffset);
      await pet.evaluate(async () => {
        await window.myself.beginPetDrag();
        await window.myself.endPetDrag();
      });
      await expect(chat.getByText('搬运动画未完成，文件未被移动。')).toHaveCount(2);
      expect(await pathExistsForAssertion(dragged.source)).toBe(true);
      expect((await readdir(recycleBinDirectory)).filter(name => name.startsWith('.attempt-')))
        .toHaveLength(1);

      await writeFile(join(recycleBinDirectory, '.force-failure'), '', 'utf8');
      const failed = await beginRecycle('failure.txt');
      await waitForCarry(failed.carryOffset);
      await expect(chat.getByText('移入回收站失败，文件仍保留在原位置。')).toBeVisible({
        timeout: 10_000
      });
      await expect.poll(() => fixture.getCharacterBehaviorProbe()).toMatchObject({
        primaryStateId: 'error',
        actionId: 'safe-fail-action',
        playbackStatus: expect.stringMatching(/^(started|completed)$/u)
      });
      expect(await pathExistsForAssertion(failed.source)).toBe(true);
      expect((await readdir(recycleBinDirectory)).filter(name => name.startsWith('.attempt-')))
        .toEqual(['.attempt-1', '.attempt-2']);

      provider.assertComplete();
      expect(provider.requests).toHaveLength(5);
      expect(provider.inspectionErrors).toEqual([]);
      const captured = fixture.logs.join('\n');
      expect(captured).not.toContain(fixture.authorizedRootDirectory);
      expect(captured).not.toContain(recycleBinDirectory);
      // 四条事务分别使用唯一正文哨兵，确保成功、中断和失败路径都不会记录文件内容。
      for (const fileName of ['success.txt', 'switch.txt', 'drag.txt', 'failure.txt']) {
        expect(captured).not.toContain(`${fileName} 内容`);
      }
    } finally {
      await fixture.dispose();
      await provider.close();
    }
  });

  test('通过正式白名单完成设置、文件操作与聊天窗口状态', async () => {
    test.setTimeout(120_000);
    const fixtureModule = await loadElectronFixtureModule();
    expect(typeof fixtureModule?.createElectronAppFixture).toBe('function');
    if (!fixtureModule?.createElectronAppFixture) return;

    const providerSteps: ProviderStep[] = [
      { response: { type: 'text', text: '本地连接正常' } },
      {
        response: toolResponse(
          'list-root',
          'builtin.files.list_directory',
          { relativePath: '.' }
        ),
        inspect: request => {
          const names = request.tools.map(
            (tool: { function: { name: string } }) => tool.function.name
          );
          if (
            !names.includes('builtin.files.list_directory')
            || !names.includes('builtin.files.create_file')
          ) {
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
        response: toolResponse(
          'create-file',
          'builtin.files.create_file',
          { relativePath: 'created.txt' }
        )
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
        response: toolResponse('rename-file', 'builtin.files.rename_entry', {
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
        response: toolResponse(
          'cancel-file',
          'builtin.files.create_file',
          { relativePath: 'cancelled.txt' }
        )
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

      await expect(petPage.getByRole('main', { name: 'AI Pet 桌宠' })).toBeVisible();
      await petPage.evaluate(() => window.myself.openChat());
      await expect.poll(() => chatPage.evaluate(() => document.visibilityState)).toBe('visible');

      await submitChatMessage(chatPage, '请列出工作目录');
      await expect(chatPage.getByText('请先完成模型服务和授权目录设置。')).toBeVisible();

      await chatPage.getByRole('button', { name: '设置' }).click();
      await expect.poll(() => settingsPage.evaluate(() => document.visibilityState)).toBe('visible');
      await settingsPage.getByLabel('自定义').check();
      await settingsPage.getByText('高级设置', { exact: true }).click();
      await settingsPage.getByLabel('档案名称').fill('任务九本地服务');
      await settingsPage.getByLabel('Base URL').fill(provider.baseUrl);
      await settingsPage.getByLabel('Model ID').fill('task-9b2-model');
      await settingsPage.getByLabel('API Key', { exact: true }).fill(provider.apiKey);
      await settingsPage.getByRole('button', { name: '保存档案' }).click();
      await expect(settingsPage.getByText('模型档案已保存。')).toBeVisible();

      await settingsPage.getByRole('button', { name: '测试 任务九本地服务 连接' }).click();
      await expect(settingsPage.getByText('连接测试完成。')).toBeVisible();
      await settingsPage.getByRole('combobox', { name: '主模型', exact: true })
        .selectOption({ label: '任务九本地服务' });
      await settingsPage.getByRole('combobox', { name: 'Agent 模型', exact: true })
        .selectOption({ label: '任务九本地服务' });
      await settingsPage.getByRole('button', { name: '保存路由' }).click();
      await expect(settingsPage.getByText('模型路由已保存。')).toBeVisible();

      await settingsPage.getByRole('button', { name: '隐私' }).click();
      await settingsPage.getByRole('checkbox', { name: '文件数据授权' }).check();
      await settingsPage.getByRole('button', { name: '保存隐私设置' }).click();
      await expect(settingsPage.getByText('隐私设置已保存。')).toBeVisible();
      await settingsPage.getByRole('button', { name: '选择目录' }).click();
      await expect(settingsPage.getByText('授权目录已更新。')).toBeVisible();
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
      await petPage.evaluate(() => window.myself.openChat());
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
