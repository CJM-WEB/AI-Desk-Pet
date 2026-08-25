import { createHash } from 'node:crypto';
import { access, mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, test, vi } from 'vitest';

import type {
  LocalModelManifestDocument,
  LocalModelReleasePolicy
} from '../src/main/local-model/local-model-manifest';
import { LocalModelRuntime } from '../src/main/local-model/local-model-runtime';
import {
  FakeLocalModelProcessPort,
  type FakeProcessScenario
} from './fixtures/fake-llama-server';

const temporaryDirectories: string[] = [];
const runtimeRevision = 'b95502ba9aa0eb73a2f4fc8878d7fbe6a847a0b9';
const modelRevision = '851bf6e806efd8d0a36b00ddf55e13ccb7b8cd0a';
const quantizationRevision = 'e87f176479d0855a907a41277aca2f8ee7a09523';
const fileContents = {
  cpuExe: 'cpu-exe', cpuDll: 'cpu-dll', vulkanExe: 'vulkan-exe', vulkanDll: 'vulkan-dll',
  model: 'small-gguf', runtimeLicense: 'mit', modelLicense: 'apache'
} as const;

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

const releasePolicy: LocalModelReleasePolicy = {
  schemaVersion: 1,
  platform: 'win32',
  arch: 'x64',
  runtimeRevision,
  model: {
    id: 'ai-pet-local',
    sourceRepository: 'Qwen/Qwen3.5-4B',
    sourceRevision: modelRevision,
    quantizationRepository: 'unsloth/Qwen3.5-4B-GGUF',
    quantizationRevision,
    fileName: 'Qwen3.5-4B-Q4_K_M.gguf',
    size: Buffer.byteLength(fileContents.model),
    sha256: sha256(fileContents.model)
  }
};

async function writeResource(root: string, path: string, content: string): Promise<void> {
  const file = join(root, ...path.split('/'));
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
}

async function createResourceFixture(): Promise<{ root: string; tokenRoot: string; cachePath: string }> {
  const workspace = await realpath(await mkdtemp(join(tmpdir(), 'ai-pet-local-runtime-')));
  temporaryDirectories.push(workspace);
  const root = join(workspace, 'resources');
  const tokenRoot = join(workspace, 'tokens');
  await mkdir(root, { recursive: true });
  await mkdir(tokenRoot, { recursive: true });
  const entry = (path: string, content: string) => ({
    path,
    size: Buffer.byteLength(content),
    sha256: sha256(content)
  });
  const manifest: LocalModelManifestDocument = {
    schemaVersion: 1,
    platform: 'win32',
    arch: 'x64',
    runtime: {
      revision: runtimeRevision,
      license: entry('licenses/llama.cpp-MIT.txt', fileContents.runtimeLicense),
      backends: {
        cpu: {
          executable: 'payload/cpu/llama-server.exe',
          files: [
            entry('payload/cpu/llama-server.exe', fileContents.cpuExe),
            entry('payload/cpu/ggml-cpu.dll', fileContents.cpuDll)
          ]
        },
        vulkan: {
          executable: 'payload/vulkan/llama-server.exe',
          files: [
            entry('payload/vulkan/llama-server.exe', fileContents.vulkanExe),
            entry('payload/vulkan/ggml-vulkan.dll', fileContents.vulkanDll)
          ]
        }
      }
    },
    model: {
      id: releasePolicy.model.id,
      sourceRepository: releasePolicy.model.sourceRepository,
      sourceRevision: modelRevision,
      quantizationRepository: releasePolicy.model.quantizationRepository,
      quantizationRevision,
      file: entry(`payload/model/${releasePolicy.model.fileName}`, fileContents.model),
      license: entry('licenses/Qwen3.5-4B-Apache-2.0.txt', fileContents.modelLicense)
    }
  };
  await writeResource(root, 'payload/cpu/llama-server.exe', fileContents.cpuExe);
  await writeResource(root, 'payload/cpu/ggml-cpu.dll', fileContents.cpuDll);
  await writeResource(root, 'payload/vulkan/llama-server.exe', fileContents.vulkanExe);
  await writeResource(root, 'payload/vulkan/ggml-vulkan.dll', fileContents.vulkanDll);
  await writeResource(root, `payload/model/${releasePolicy.model.fileName}`, fileContents.model);
  await writeResource(root, 'licenses/llama.cpp-MIT.txt', fileContents.runtimeLicense);
  await writeResource(root, 'licenses/Qwen3.5-4B-Apache-2.0.txt', fileContents.modelLicense);
  await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest), 'utf8');
  return { root, tokenRoot, cachePath: join(workspace, 'model-cache.json') };
}

async function createRuntime(
  processPort: FakeLocalModelProcessPort,
  overrides: { loadTimeoutMs?: number; cleanupTimeoutMs?: number } = {}
): Promise<{ runtime: LocalModelRuntime; root: string }> {
  const fixture = await createResourceFixture();
  return {
    root: fixture.root,
    runtime: new LocalModelRuntime({
      root: fixture.root,
      applicationVersion: '1.0.0',
      cachePath: fixture.cachePath,
      tokenRoot: fixture.tokenRoot,
      releasePolicy,
      processPort,
      healthPollIntervalMs: 1,
      loadTimeoutMs: overrides.loadTimeoutMs ?? 100,
      cleanupTimeoutMs: overrides.cleanupTimeoutMs ?? 100
    })
  };
}

function queueVulkanReady(port: FakeLocalModelProcessPort, health503 = false): void {
  port.queueProcess({ stdout: 'Vulkan0: Fixture GPU\n', exitCode: 0 }, {});
  port.queuePorts(43123);
  if (health503) port.queueHealth({ status: 503, body: { status: 'loading model' } });
  port.queueHealth({ status: 200, body: { status: 'ok' } });
}

function queueCpuReady(port: FakeLocalModelProcessPort): void {
  port.queueProcess({ stderr: 'no Vulkan device', exitCode: 1 }, {});
  port.queuePorts(43124);
  port.queueHealth({ status: 200, body: { status: 'ok' } });
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function expectMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' });
}

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe('LocalModelRuntime', () => {
  test('Vulkan 探针解析真实设备并以固定安全 argv 进入 ready', async () => {
    const port = new FakeLocalModelProcessPort();
    queueVulkanReady(port, true);
    const { runtime, root } = await createRuntime(port);
    const phases: string[] = [];
    runtime.subscribe(status => phases.push(status.phase));

    await runtime.start();

    expect(runtime.getStatus()).toEqual({ enabled: true, phase: 'ready', backend: 'vulkan', reasonCode: null });
    expect(phases).toEqual(['validating', 'loading', 'ready']);
    expect(port.spawnInputs[0]).toMatchObject({
      file: join(root, 'payload/vulkan/llama-server.exe'),
      args: ['--list-devices'],
      shell: false,
      windowsHide: true
    });
    expect(port.spawnInputs[1]).toMatchObject({ shell: false, windowsHide: true });
    expect(port.spawnInputs[1]?.args).toEqual(expect.arrayContaining([
      '--reasoning', 'off', '--host', '127.0.0.1', '--device', 'Vulkan0', '--gpu-layers', 'all',
      '--offline', '--no-ui', '--no-slots', '--no-cors-credentials'
    ]));
    expect(port.sleepCalls).toEqual([1]);
    expect(runtime.getReadyConnection()).toMatchObject({
      baseUrl: 'http://127.0.0.1:43123/v1', modelId: 'ai-pet-local'
    });
  });

  test('Vulkan 探针失败后仅启动 CPU 兼容模式', async () => {
    const port = new FakeLocalModelProcessPort();
    queueCpuReady(port);
    const { runtime } = await createRuntime(port);

    await runtime.start();

    expect(runtime.getStatus()).toEqual({ enabled: true, phase: 'ready', backend: 'cpu', reasonCode: null });
    expect(port.spawnInputs[1]?.args).toEqual(expect.arrayContaining([
      '--device', 'none', '--gpu-layers', '0', '--reasoning', 'off'
    ]));
  });

  test('Vulkan server 加载失败自然退出后不再操作旧 PID，并以 CPU ready', async () => {
    const port = new FakeLocalModelProcessPort();
    port.queueProcess(
      { stdout: 'Vulkan2: Fixture GPU\n', exitCode: 0 },
      { stderr: 'model load failed', exitCode: 1, pid: 5101 },
      { pid: 5102 }
    );
    port.queuePorts(43125, 43126);
    port.queueHealth(new Error('connection reset'), { status: 200, body: { status: 'ok' } });
    const { runtime } = await createRuntime(port);

    await runtime.start();

    expect(runtime.getStatus()).toMatchObject({ phase: 'ready', backend: 'cpu' });
    expect(port.killedPids).not.toContain(5101);
    expect(port.spawnInputs[2]?.args).toEqual(expect.arrayContaining(['--device', 'none']));
  });

  test('Vulkan 与 CPU 双失败后进入 faulted 且不循环重启', async () => {
    const port = new FakeLocalModelProcessPort();
    port.queueProcess(
      { stderr: 'Vulkan unavailable', exitCode: 1 },
      { stderr: 'cpu load failed', exitCode: 1, pid: 5201 }
    );
    port.queuePorts(43127);
    port.queueHealth(new Error('connection reset'));
    const { runtime } = await createRuntime(port);

    await expect(runtime.start()).rejects.toMatchObject({ code: 'CPU_START_FAILED' });

    expect(runtime.getStatus()).toEqual({
      enabled: true, phase: 'faulted', backend: 'cpu', reasonCode: 'CPU_START_FAILED'
    });
    expect(port.spawnInputs).toHaveLength(2);
  });

  test('端口占用仅按日志和退出事实重试三次，之后稳定失败', async () => {
    const port = new FakeLocalModelProcessPort();
    const conflicts: FakeProcessScenario[] = [5301, 5302, 5303].map(pid => ({
      pid,
      stderr: 'bind failed: address already in use',
      exitCode: 1
    }));
    port.queueProcess({ stdout: 'Vulkan0\n', exitCode: 0 }, ...conflicts);
    port.queuePorts(44001, 44002, 44003);
    port.queueHealth(new Error('closed'), new Error('closed'), new Error('closed'));
    const { runtime } = await createRuntime(port);

    await expect(runtime.start()).rejects.toMatchObject({ code: 'PORT_CONFLICT' });

    expect(port.spawnInputs.slice(1)).toHaveLength(3);
    expect(port.spawnInputs.slice(1).map(input => input.args[input.args.indexOf('--port') + 1]))
      .toEqual(['44001', '44002', '44003']);
    expect(runtime.getStatus()).toMatchObject({ phase: 'faulted', reasonCode: 'PORT_CONFLICT' });
  });

  test('仅有端口冲突字样但进程正常退出时不换端口，直接降级 CPU', async () => {
    const port = new FakeLocalModelProcessPort();
    port.queueProcess(
      { stdout: 'Vulkan0\n', exitCode: 0 },
      { stderr: 'address already in use', exitCode: 0 },
      {}
    );
    port.queuePorts(44010, 44011);
    port.queueHealth(new Error('closed'), { status: 200, body: { status: 'ok' } });
    const { runtime } = await createRuntime(port);

    await runtime.start();

    expect(runtime.getStatus()).toMatchObject({ phase: 'ready', backend: 'cpu' });
    expect(port.spawnInputs).toHaveLength(3);
    expect(port.spawnInputs[2]?.args).toEqual(expect.arrayContaining(['--port', '44011', '--device', 'none']));
  });

  test('stderr 环形尾缓冲会淘汰旧标记，不让超限历史触发端口重试', async () => {
    const port = new FakeLocalModelProcessPort();
    port.queueProcess(
      { stdout: 'Vulkan0\n', exitCode: 0 },
      { stderr: `address already in use${'x'.repeat(70 * 1024)}`, exitCode: 1 },
      {}
    );
    port.queuePorts(44015, 44016);
    port.queueHealth(new Error('closed'), { status: 200, body: { status: 'ok' } });
    const { runtime } = await createRuntime(port);

    await runtime.start();

    expect(runtime.getStatus()).toMatchObject({ phase: 'ready', backend: 'cpu' });
    expect(port.spawnInputs).toHaveLength(3);
  });

  test('Vulkan 探针超时后清理探针 PID 并进入 CPU', async () => {
    const port = new FakeLocalModelProcessPort();
    port.queueProcess({ pid: 5351 }, {});
    port.queuePorts(44020);
    port.queueHealth({ status: 200, body: { status: 'ok' } });
    const { runtime } = await createRuntime(port, { loadTimeoutMs: 50 });
    vi.useFakeTimers();

    const starting = runtime.start();
    await vi.waitFor(() => expect(port.spawnInputs).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(50);
    await expect(starting).resolves.toBeUndefined();

    expect(runtime.getStatus()).toMatchObject({ phase: 'ready', backend: 'cpu' });
    expect(port.killedPids).toContain(5351);
  });

  test('CPU 模型加载超过边界时间后清理进程并进入 faulted', async () => {
    const port = new FakeLocalModelProcessPort();
    port.queueProcess({ stderr: 'no Vulkan', exitCode: 1 }, { pid: 5401 });
    port.queuePorts(44100);
    const { runtime } = await createRuntime(port, { loadTimeoutMs: 50 });
    vi.useFakeTimers();

    const starting = runtime.start();
    await vi.waitFor(() => expect(port.spawnInputs).toHaveLength(2));
    await vi.advanceTimersByTimeAsync(50);
    await expect(starting).rejects.toMatchObject({ code: 'MODEL_LOAD_TIMEOUT' });

    expect(runtime.getStatus()).toMatchObject({ phase: 'faulted', reasonCode: 'MODEL_LOAD_TIMEOUT' });
    expect(port.killedPids).toContain(5401);
  });

  test('ready 进程随后崩溃时失效 generation 并发布脱敏 faulted', async () => {
    const port = new FakeLocalModelProcessPort();
    queueVulkanReady(port);
    const { runtime } = await createRuntime(port);
    await runtime.start();
    const connection = runtime.getReadyConnection();

    port.processes[1]?.stderr.write('stderr-private-marker');
    port.processes[1]?.finish(9);
    await flush();

    expect(runtime.getStatus()).toEqual({
      enabled: true, phase: 'faulted', backend: 'vulkan', reasonCode: 'PROCESS_CRASHED'
    });
    expect(() => runtime.getReadyConnection()).toThrow('LOCAL_MODEL_NOT_READY');
    expect(JSON.stringify(runtime.getStatus())).not.toContain(connection.token);
    expect(JSON.stringify(runtime.getStatus())).not.toContain('stderr-private-marker');
    expect(JSON.stringify(runtime.getStatus())).not.toContain('43123');
    expect(JSON.stringify(runtime.getStatus())).not.toContain('4101');
  });

  test('Abort 启动会清理精确 PID、删除 Token 并回到 disabled', async () => {
    const port = new FakeLocalModelProcessPort();
    port.queueProcess({ stderr: 'no Vulkan', exitCode: 1 }, { pid: 5501 });
    port.queuePorts(44200);
    const { runtime } = await createRuntime(port);
    const controller = new AbortController();
    const starting = runtime.start(controller.signal);
    await vi.waitFor(() => expect(port.spawnInputs).toHaveLength(2));
    const tokenFile = port.spawnInputs[1]?.args[port.spawnInputs[1].args.indexOf('--api-key-file') + 1];
    expect(tokenFile).toBeTypeOf('string');

    controller.abort();
    await expect(starting).rejects.toMatchObject({ name: 'AbortError' });

    expect(port.killedPids).toContain(5501);
    await expectMissing(String(tokenFile));
    expect(runtime.getStatus()).toEqual({ enabled: false, phase: 'disabled', backend: null, reasonCode: null });
  });

  test('Vulkan spawn 边界同步发生 Abort 时不等待探针 timeout', async () => {
    const port = new FakeLocalModelProcessPort();
    const controller = new AbortController();
    port.queueProcess({ pid: 5551, onSpawn: () => controller.abort() });
    const { runtime } = await createRuntime(port, { loadTimeoutMs: 10_000 });
    const statuses: Array<{ phase: string; backend: string | null }> = [];
    runtime.subscribe(status => statuses.push({ phase: status.phase, backend: status.backend }));

    await expect(runtime.start(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });

    expect(port.killedPids).toContain(5551);
    expect(statuses).not.toContainEqual({ phase: 'loading', backend: 'cpu' });
    expect(runtime.getStatus()).toEqual({ enabled: false, phase: 'disabled', backend: null, reasonCode: null });
  }, 500);

  test('stop/close 幂等共享清理，Token 删除且重启会递增 generation', async () => {
    const port = new FakeLocalModelProcessPort();
    queueVulkanReady(port);
    const { runtime } = await createRuntime(port);
    await runtime.start();
    const firstConnection = runtime.getReadyConnection();
    const tokenFile = port.spawnInputs[1]?.args[port.spawnInputs[1].args.indexOf('--api-key-file') + 1];
    expect(await readFile(String(tokenFile), 'utf8')).toBe(firstConnection.token);

    const firstStop = runtime.stop();
    const secondStop = runtime.stop();
    expect(secondStop).toBe(firstStop);
    await firstStop;
    await expectMissing(String(tokenFile));
    expect(port.killedPids).toEqual([4101]);

    queueVulkanReady(port);
    await runtime.start();
    expect(runtime.getReadyConnection().generation).not.toBe(firstConnection.generation);

    const firstClose = runtime.close();
    const secondClose = runtime.close();
    expect(secondClose).toBe(firstClose);
    await firstClose;
    expect(() => runtime.start()).toThrow('LOCAL_MODEL_RUNTIME_CLOSED');
  });

  test('stop 等待托管 child 退出后才删除 Token 并发布 disabled', async () => {
    const port = new FakeLocalModelProcessPort();
    port.queueProcess({ stdout: 'Vulkan0\n', exitCode: 0 }, { closeOnKill: false, pid: 5601 });
    port.queuePorts(44300);
    port.queueHealth({ status: 200, body: { status: 'ok' } });
    const { runtime } = await createRuntime(port);
    await runtime.start();
    const tokenFile = port.spawnInputs[1]?.args[port.spawnInputs[1].args.indexOf('--api-key-file') + 1];

    let stopped = false;
    const stopping = runtime.stop().then(() => { stopped = true; });
    await vi.waitFor(() => expect(port.killedPids).toContain(5601));
    await flush();
    expect(stopped).toBe(false);
    await expect(access(String(tokenFile))).resolves.toBeUndefined();

    port.processes[1]?.finish(null);
    await stopping;
    await expectMissing(String(tokenFile));
    expect(runtime.getStatus()).toEqual({ enabled: false, phase: 'disabled', backend: null, reasonCode: null });
  });

  test('stop 期间排队的 start 在 close 后不能复活 Runtime', async () => {
    const port = new FakeLocalModelProcessPort();
    port.queueProcess({ stdout: 'Vulkan0\n', exitCode: 0 }, { closeOnKill: false, pid: 5701 });
    port.queuePorts(44400);
    port.queueHealth({ status: 200, body: { status: 'ok' } });
    const { runtime } = await createRuntime(port);
    await runtime.start();

    const stopping = runtime.stop();
    const queuedStart = runtime.start();
    const closing = runtime.close();
    port.processes[1]?.finish(null);

    await stopping;
    await closing;
    await expect(queuedStart).rejects.toThrow('LOCAL_MODEL_RUNTIME_CLOSED');
    expect(port.spawnInputs).toHaveLength(2);
    expect(runtime.getStatus()).toEqual({ enabled: false, phase: 'disabled', backend: null, reasonCode: null });
  });

  test('旧进程 error 清理延迟时不会删除重试 generation 的新 Token', async () => {
    const port = new FakeLocalModelProcessPort();
    port.queueProcess({ stdout: 'Vulkan0\n', exitCode: 0 }, { closeOnKill: false, pid: 5801 });
    port.queuePorts(44500);
    port.queueHealth({ status: 200, body: { status: 'ok' } });
    const { runtime } = await createRuntime(port);
    await runtime.start();
    const oldTokenFile = port.spawnInputs[1]?.args[port.spawnInputs[1].args.indexOf('--api-key-file') + 1];
    const oldChild = port.processes[1];

    oldChild?.emit('error', new Error('fixture crash'));
    expect(runtime.getStatus()).toMatchObject({ phase: 'faulted', reasonCode: 'PROCESS_CRASHED' });
    port.queueProcess({ stdout: 'Vulkan0\n', exitCode: 0 }, {});
    port.queuePorts(44501);
    port.queueHealth({ status: 200, body: { status: 'ok' } });
    const restarting = runtime.start();
    await flush();
    expect(port.spawnInputs).toHaveLength(2);

    oldChild?.finish(null);
    await restarting;
    const newTokenFile = port.spawnInputs[3]?.args[port.spawnInputs[3].args.indexOf('--api-key-file') + 1];
    await expect(access(String(newTokenFile))).resolves.toBeUndefined();
    await new Promise<void>(resolve => setImmediate(resolve));

    await expectMissing(String(oldTokenFile));
    await expect(access(String(newTokenFile))).resolves.toBeUndefined();
    expect(runtime.getStatus()).toMatchObject({ phase: 'ready' });
  });

  test('stdout/stderr 保持有界且任何公开状态都只有严格脱敏字段', async () => {
    const port = new FakeLocalModelProcessPort();
    queueVulkanReady(port);
    const { runtime, root } = await createRuntime(port);
    const snapshots: unknown[] = [];
    runtime.subscribe(status => snapshots.push(status));
    await runtime.start();
    const connection = runtime.getReadyConnection();
    const child = port.processes[1];
    child?.stdout.write(`private-path=${root} token=${connection.token} ${'x'.repeat(256 * 1024)}`);
    child?.stderr.write(`stderr-canary pid=${child.pid} port=43123 ${'y'.repeat(256 * 1024)}`);
    await runtime.stop();

    for (const snapshot of snapshots) {
      expect(Object.keys(snapshot as object).sort()).toEqual(['backend', 'enabled', 'phase', 'reasonCode']);
    }
    const publicJson = JSON.stringify(snapshots);
    expect(publicJson.length).toBeLessThan(2_000);
    expect(publicJson).not.toContain(root);
    expect(publicJson).not.toContain(connection.token);
    expect(publicJson).not.toContain('stderr-canary');
    expect(publicJson).not.toContain('43123');
    expect(publicJson).not.toContain(String(child?.pid));
  });

  test('单个订阅者抛错不会阻断其他通知或生命周期清理', async () => {
    const port = new FakeLocalModelProcessPort();
    queueVulkanReady(port);
    const { runtime } = await createRuntime(port);
    const phases: string[] = [];
    runtime.subscribe(() => { throw new Error('subscriber-fixture-error'); });
    runtime.subscribe(status => phases.push(status.phase));

    await runtime.start();
    await runtime.close();

    expect(phases).toEqual(['validating', 'loading', 'ready', 'stopping', 'disabled']);
    expect(runtime.getStatus()).toEqual({ enabled: false, phase: 'disabled', backend: null, reasonCode: null });
    expect(port.killedPids).toEqual([4101]);
  });
});
