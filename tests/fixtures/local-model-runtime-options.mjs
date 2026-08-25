import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:net';

export const LOCAL_MODEL_TEST_ASSEMBLER_PRIVATE_MARKER = 'local-model-test-assembler-only';

function parseConfig(path) {
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (!value || typeof value !== 'object') throw new Error('LOCAL_MODEL_E2E_CONFIG_INVALID');
  return value;
}

function argumentValue(args, name) {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`LOCAL_MODEL_E2E_ARGUMENT_MISSING:${name}`);
  }
  return value;
}

function waitForValidation(file, signal) {
  if (existsSync(file)) return Promise.resolve();
  return new Promise((resolveReady, rejectReady) => {
    const poll = () => {
      if (signal.aborted) {
        rejectReady(signal.reason);
        return;
      }
      if (existsSync(file)) {
        resolveReady();
        return;
      }
      setTimeout(poll, 25);
    };
    poll();
  });
}

function sleep(milliseconds, signal) {
  return new Promise((resolveSleep, rejectSleep) => {
    const onAbort = () => {
      clearTimeout(timeout);
      rejectSleep(signal.reason);
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolveSleep();
    }, milliseconds);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function availablePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(error => {
        if (error) rejectPort(error);
        else if (!address || typeof address === 'string') rejectPort(new Error('PORT_UNAVAILABLE'));
        else resolvePort(address.port);
      });
    });
  });
}

/** 仅由未打包 E2E 动态加载；返回正式 Runtime 的既有构造 seam。 */
export function createLocalModelRuntimeOptions(configPath) {
  const config = parseConfig(configPath);
  const spawnedProcesses = new Map();
  const processPort = {
    spawn(input) {
      const probe = input.args.includes('--list-devices');
      const actualArgs = probe
        ? [config.serverScriptPath, '--mode=probe', `--stderr-canary=${config.stderrCanary}`]
        : [
            config.serverScriptPath,
            '--mode=server',
            `--port=${argumentValue(input.args, '--port')}`,
            `--token-file=${argumentValue(input.args, '--api-key-file')}`,
            `--ready-file=${config.readyFile}`,
            `--stderr-canary=${config.stderrCanary}`
          ];
      const actualOptions = {
        cwd: input.cwd,
        env: { ...input.env, ELECTRON_RUN_AS_NODE: '1' },
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      };
      const child = spawn(process.execPath, actualArgs, actualOptions);
      if (Number.isSafeInteger(child.pid) && child.pid > 0) {
        spawnedProcesses.set(child.pid, child);
        child.once('close', () => {
          if (spawnedProcesses.get(child.pid) === child) spawnedProcesses.delete(child.pid);
        });
      }
      if (!probe) {
        const port = Number(argumentValue(input.args, '--port'));
        const tokenFilePath = argumentValue(input.args, '--api-key-file');
        writeFileSync(config.evidenceFile, JSON.stringify({
          processId: child.pid,
          port,
          token: readFileSync(tokenFilePath, 'utf8'),
          fixtureScriptPath: config.serverScriptPath,
          modelPath: argumentValue(input.args, '--model'),
          requestedRuntimePath: input.file,
          actualRuntimePath: process.execPath,
          resourceRoot: config.root,
          tokenFilePath,
          stderrCanary: config.stderrCanary,
          requestedSpawnOptions: { shell: input.shell, windowsHide: input.windowsHide },
          actualSpawnOptions: {
            shell: actualOptions.shell,
            windowsHide: actualOptions.windowsHide
          }
        }), 'utf8');
      }
      return child;
    },
    findAvailablePort: availablePort,
    async getHealth(url, signal) {
      const response = await fetch(url, { method: 'GET', signal });
      const text = await response.text();
      try {
        return { status: response.status, body: JSON.parse(text) };
      } catch {
        return { status: response.status, body: null };
      }
    },
    sleep,
    randomBytes,
    async killTree(pid) {
      // fixture server 没有后代；该 seam 模拟正式 taskkill 对精确 PID 的树终止语义。
      const child = spawnedProcesses.get(pid);
      if (child) child.kill('SIGTERM');
    }
  };
  return {
    root: config.root,
    applicationVersion: config.applicationVersion,
    cachePath: config.cachePath,
    tokenRoot: config.tokenRoot,
    releasePolicy: config.releasePolicy,
    processPort,
    healthPollIntervalMs: 25,
    loadTimeoutMs: 15_000,
    cleanupTimeoutMs: 5_000,
    async manifestHashFile(path, signal) {
      await waitForValidation(config.validationReadyFile, signal);
      const bytes = await readFile(path);
      return createHash('sha256').update(bytes).digest('hex');
    }
  };
}
