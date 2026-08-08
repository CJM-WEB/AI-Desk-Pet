import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';

import electronExecutable from 'electron';

const route = process.argv[2];
const mode = process.argv[3];
if (route !== 'electron') throw new Error('VALIDATION_ROUTE_INVALID');
if (!['manual', 'smoke', 'lifecycle', 'negative', 'accuracy-core'].includes(mode)) {
  throw new Error('VALIDATION_MODE_INVALID');
}

// 固定包装进程持有控制台 stdin；Electron GUI 子进程只接收包装进程转发的固定行。
const bundle = join(process.env.TEMP, 'ai-pet-explorer-layer-validation.cjs');
const manualToken = randomBytes(16).toString('hex');
const manualPipe = `\\\\.\\pipe\\ai-pet-task0e-manual-${process.pid}-${manualToken}`;
let signalSocket;
let pendingInput = '';
const signalServer = createServer(socket => {
  let handshake = '';
  const onData = chunk => {
    handshake += chunk.toString();
    const newline = handshake.indexOf('\n');
    if (newline < 0) return;
    socket.off('data', onData);
    if (handshake.slice(0, newline).replace(/\r$/u, '') !== manualToken || signalSocket !== undefined) {
      socket.destroy();
      return;
    }
    signalSocket = socket;
    socket.write('accepted\n');
    if (pendingInput !== '') {
      socket.write(pendingInput);
      pendingInput = '';
    }
  };
  socket.on('data', onData);
});
await new Promise((resolveListening, reject) => {
  signalServer.once('error', reject);
  signalServer.listen(manualPipe, resolveListening);
});
const child = spawn(electronExecutable, [bundle, route, mode], {
  stdio: ['pipe', 'inherit', 'inherit'],
  windowsHide: true,
  env: {
    ...process.env,
    AI_PET_TASK0E_MANUAL_PIPE: manualPipe,
    AI_PET_TASK0E_MANUAL_TOKEN: manualToken
  }
});

const forwardInput = chunk => {
  if (signalSocket !== undefined && !signalSocket.destroyed) signalSocket.write(chunk);
  else pendingInput += chunk.toString();
};
process.stdin.on('data', forwardInput);
process.stdin.resume();

const exitCode = await new Promise((resolveExit, reject) => {
  child.once('error', reject);
  child.once('exit', code => resolveExit(code ?? 1));
});
process.stdin.off('data', forwardInput);
process.stdin.pause();
signalSocket?.destroy();
await new Promise(resolveClosed => signalServer.close(resolveClosed));
process.exitCode = exitCode;
