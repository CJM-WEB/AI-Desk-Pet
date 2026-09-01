import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// 只报告本地容器运行时身份；包扫描结论由候选验证脚本直接检查 CLI 退出码与输出。
const clamavOutput = execFileSync('clamscan', ['--version'], {
  encoding: 'utf8',
}).trim();
const version = /ClamAV\s+([^/]+)\/(\d+)\//u.exec(clamavOutput);
if (!version) throw new Error(`无法解析 ClamAV 病毒库版本：${clamavOutput}`);

const databaseDirectory = '/var/lib/clamav';
const dailyDatabaseFiles = readdirSync(databaseDirectory)
  .filter(fileName => /^daily\.(?:cvd|cld)$/u.test(fileName))
  .map(fileName => statSync(join(databaseDirectory, fileName)))
  .filter(information => information.isFile());
if (dailyDatabaseFiles.length === 0) {
  throw new Error('ClamAV daily 病毒库文件缺失');
}
const latestDatabaseTime = Math.max(
  ...dailyDatabaseFiles.map(information => information.mtimeMs)
);
if (!Number.isFinite(latestDatabaseTime) || latestDatabaseTime <= 0) {
  throw new Error('ClamAV daily 病毒库时间无效');
}

process.stdout.write(`${JSON.stringify({
  nodeVersion: process.version,
  clamavVersion: `ClamAV ${version[1]}`,
  clamavDatabaseVersion: version[2],
  clamavDatabaseUpdatedAt: new Date(latestDatabaseTime).toISOString(),
  uid: process.getuid?.(),
})}\n`);
