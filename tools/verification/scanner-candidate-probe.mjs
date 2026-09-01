import { execFileSync } from 'node:child_process';

// 只报告本地容器运行时身份；包扫描结论由候选验证脚本直接检查 CLI 退出码与输出。
const clamavOutput = execFileSync('clamscan', ['--version'], {
  encoding: 'utf8',
}).trim();
const version = /ClamAV\s+([^/]+)\/(\d+)\//u.exec(clamavOutput);
if (!version) throw new Error(`无法解析 ClamAV 病毒库版本：${clamavOutput}`);

process.stdout.write(`${JSON.stringify({
  nodeVersion: process.version,
  clamavVersion: `ClamAV ${version[1]}`,
  clamavDatabaseVersion: version[2],
  uid: process.getuid?.(),
})}\n`);
