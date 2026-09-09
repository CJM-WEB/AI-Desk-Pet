import { spawn } from 'node:child_process';
import type { EventEmitter } from 'node:events';

export interface ExactPidChildProcess extends EventEmitter {
  readonly pid?: number;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface WindowsProcessTreePort {
  killTree(pid: number): Promise<void>;
}

export type TaskkillSpawner = (
  file: 'taskkill.exe',
  args: readonly string[],
  options: Readonly<{ shell: false; windowsHide: true; stdio: 'ignore' }>
) => EventEmitter;

export type ExactPidTerminationResult = Readonly<{
  ok: true;
}> | Readonly<{
  ok: false;
  reason: 'pid_unavailable' | 'failed' | 'timeout';
}>;

/**
 * Main 的 Windows 进程树终止只接受当前 child 记录里的精确 PID，不支持进程名或命令行匹配。
 * 破坏操作只交给 taskkill /T：若先单杀主进程，taskkill 会因 PID 消失误报失败且无法再证明子树退出。
 * 调用方可选择是否等待 child 自身 close：Runtime 必须严格等待，PowerShell 保持既有尽力清理语义。
 */
export function terminateExactPidProcessTree(options: {
  child: ExactPidChildProcess;
  processTreePort: WindowsProcessTreePort;
  cleanupTimeoutMs: number;
  alreadyExited?: boolean;
  waitForChildExit: boolean;
}): Promise<ExactPidTerminationResult> {
  if (options.alreadyExited === true) return Promise.resolve({ ok: true });
  return new Promise(resolve => {
    let settled = false;
    let childExited = !options.waitForChildExit;
    let treeExited = false;
    const finish = (result: ExactPidTerminationResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      options.child.off('close', onChildExit);
      options.child.off('error', onChildError);
      resolve(result);
    };
    const maybeFinish = (): void => {
      if (childExited && treeExited) finish({ ok: true });
    };
    const onChildExit = (): void => {
      childExited = true;
      maybeFinish();
    };
    const onChildError = (): void => {
      // error 只说明进程对象异常，不能单独证明精确 PID 及其子树均已退出。
    };
    const timeout = setTimeout(() => finish({ ok: false, reason: 'timeout' }), options.cleanupTimeoutMs);
    if (options.waitForChildExit) {
      options.child.once('close', onChildExit);
      options.child.once('error', onChildError);
    }
    const pid = options.child.pid;
    if (pid === undefined || !Number.isSafeInteger(pid) || pid <= 0) {
      finish({ ok: false, reason: 'pid_unavailable' });
      return;
    }
    try {
      void options.processTreePort.killTree(pid).then(() => {
        treeExited = true;
        maybeFinish();
      }, () => finish({ ok: false, reason: 'failed' }));
    } catch {
      finish({ ok: false, reason: 'failed' });
    }
  });
}

/** 默认端口固定调用 taskkill.exe /PID <exact child.pid> /T /F。 */
export function createNodeWindowsProcessTreePort(spawnTaskkill?: TaskkillSpawner): WindowsProcessTreePort {
  const spawnProcess = spawnTaskkill ?? spawn;
  return {
    killTree(pid): Promise<void> {
      if (!Number.isSafeInteger(pid) || pid <= 0) return Promise.reject(new Error('PROCESS_PID_INVALID'));
      return new Promise((resolve, reject) => {
        let taskkill: EventEmitter;
        try {
          taskkill = spawnProcess('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
            shell: false,
            windowsHide: true,
            stdio: 'ignore'
          });
        } catch (error) {
          reject(error);
          return;
        }
        taskkill.once('error', reject);
        taskkill.once('close', (exitCode: number | null) => {
          if (exitCode === 0) resolve();
          else reject(new Error('TASKKILL_FAILED'));
        });
      });
    }
  };
}
