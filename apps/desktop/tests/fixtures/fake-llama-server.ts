import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import type {
  LocalModelChildProcess,
  LocalModelHealthResult,
  LocalModelProcessPort,
  LocalModelSpawnInput
} from '../../src/main/local-model/local-model-runtime';

export interface FakeProcessScenario {
  stdout?: string;
  stderr?: string;
  exitCode?: number;
  pid?: number;
  closeOnKill?: boolean;
  onSpawn?: () => void;
}

type FakeHealthResult = LocalModelHealthResult | Error;

/** 小型 llama-server 替身只模拟进程边界，不启动或下载真实模型。 */
export class FakeLlamaProcess extends EventEmitter implements LocalModelChildProcess {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid: number;
  killCalls = 0;

  constructor(pid: number, private readonly closeOnKill: boolean) {
    super();
    this.pid = pid;
  }

  kill(): boolean {
    this.killCalls += 1;
    if (this.closeOnKill) queueMicrotask(() => this.finish(null));
    return true;
  }

  terminateTree(): void {
    if (this.closeOnKill) queueMicrotask(() => this.finish(null));
  }

  finish(exitCode: number | null): void {
    this.emit('close', exitCode);
  }
}

export class FakeLocalModelProcessPort implements LocalModelProcessPort {
  readonly spawnInputs: LocalModelSpawnInput[] = [];
  readonly processes: FakeLlamaProcess[] = [];
  readonly killedPids: number[] = [];
  readonly healthUrls: string[] = [];
  readonly sleepCalls: number[] = [];
  readonly #spawnScenarios: FakeProcessScenario[] = [];
  readonly #healthResults: FakeHealthResult[] = [];
  readonly #ports: Array<number | Error> = [];
  #nextPid = 4100;

  queueProcess(...scenarios: FakeProcessScenario[]): void {
    this.#spawnScenarios.push(...(scenarios.length === 0 ? [{}] : scenarios));
  }

  queueHealth(...results: FakeHealthResult[]): void {
    this.#healthResults.push(...results);
  }

  queuePorts(...ports: Array<number | Error>): void {
    this.#ports.push(...ports);
  }

  spawn(input: LocalModelSpawnInput): LocalModelChildProcess {
    const scenario = this.#spawnScenarios.shift();
    if (scenario === undefined) throw new Error('FAKE_PROCESS_SCENARIO_MISSING');
    const process = new FakeLlamaProcess(scenario.pid ?? this.#nextPid++, scenario.closeOnKill ?? true);
    this.spawnInputs.push(input);
    this.processes.push(process);
    scenario.onSpawn?.();
    queueMicrotask(() => {
      if (scenario.stdout !== undefined) process.stdout.write(scenario.stdout);
      if (scenario.stderr !== undefined) process.stderr.write(scenario.stderr);
      if (scenario.exitCode !== undefined) process.finish(scenario.exitCode);
    });
    return process;
  }

  async findAvailablePort(): Promise<number> {
    const result = this.#ports.shift();
    if (result === undefined) throw new Error('FAKE_PORT_MISSING');
    if (result instanceof Error) throw result;
    return result;
  }

  async getHealth(url: string, signal: AbortSignal): Promise<LocalModelHealthResult> {
    this.healthUrls.push(url);
    if (signal.aborted) throw signal.reason;
    const result = this.#healthResults.shift();
    if (result === undefined) return new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    });
    if (result instanceof Error) throw result;
    return result;
  }

  async sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
    this.sleepCalls.push(milliseconds);
    if (signal.aborted) throw signal.reason;
  }

  randomBytes(size: number): Buffer {
    return Buffer.alloc(size, 0xab);
  }

  async killTree(pid: number): Promise<void> {
    this.killedPids.push(pid);
    this.processes.find(process => process.pid === pid)?.terminateTree();
  }
}
