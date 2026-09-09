// helper 只在构建机编译；安装包消费固定二进制和哈希，不在目标机调用编译器。
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const crypto = require('node:crypto');
if (process.platform !== 'win32') throw new Error('Windows helper 必须在 Windows 构建');
const output = path.join(__dirname, 'dist', 'windows-job-helper.exe');
fs.mkdirSync(path.dirname(output), { recursive: true });
const compiler = path.join(process.env.SystemRoot || 'C:/Windows', 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
cp.execFileSync(compiler, ['/nologo', '/optimize+', '/target:exe', '/platform:x64', '/r:System.Web.Extensions.dll', '/out:' + output, path.join(__dirname, 'native/windows-job-helper.cs')], { stdio: 'inherit', windowsHide: true });
const manifest = { file: 'windows-job-helper.exe', sha256: crypto.createHash('sha256').update(fs.readFileSync(output)).digest('hex') };
fs.writeFileSync(path.join(path.dirname(output), 'windows-job-helper.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest));
