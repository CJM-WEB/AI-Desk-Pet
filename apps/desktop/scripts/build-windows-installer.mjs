import { execFile } from 'node:child_process';
import { readFile, rm, stat } from 'node:fs/promises';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const defaultDesktopRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function runCompiler(executable, args, options) {
  return new Promise((resolve, reject) => {
    execFile(executable, args, options, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(error, { stdout, stderr }));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function requirePath(path, label) {
  try {
    return await stat(path);
  } catch {
    throw new Error(`${label}不存在：${path}`);
  }
}

// 主流程只接受调用方已验证的绝对编译器文件，并以独立 argv 传递固定构建边界。
export async function buildWindowsInstaller({
  desktopRoot = defaultDesktopRoot,
  environment = process.env,
  runCompiler: compile = runCompiler
} = {}) {
  const compilerPath = environment.AI_PET_ISCC;
  if (!compilerPath) {
    throw new Error('缺少 AI_PET_ISCC。请将其设置为已验证的 Inno Setup 7.1.0 x64 ISCC.exe 绝对路径后重试。');
  }
  if (!isAbsolute(compilerPath)) {
    throw new Error(`AI_PET_ISCC 必须是绝对路径：${compilerPath}`);
  }

  const sourceDir = join(desktopRoot, 'dist', 'win-unpacked');
  const outputDir = join(desktopRoot, 'dist');
  const scriptPath = join(desktopRoot, 'resources', 'windows', 'installer.iss');
  const packagePath = join(desktopRoot, 'package.json');
  const sourceStat = await requirePath(sourceDir, '完整发行目录');
  if (!sourceStat.isDirectory()) throw new Error(`完整发行目录不是目录：${sourceDir}`);
  await requirePath(scriptPath, 'Inno Setup 脚本');
  const compilerStat = await requirePath(compilerPath, 'Inno Setup 编译器');
  if (!compilerStat.isFile()) throw new Error(`Inno Setup 编译器必须是普通文件：${compilerPath}`);

  const packageJson = JSON.parse(await readFile(packagePath, 'utf8'));
  const version = packageJson.version;
  const numericParts = typeof version === 'string' ? /^(\d+)\.(\d+)\.(\d+)/u.exec(version) : null;
  if (!numericParts) throw new Error(`桌面版本无法转换为 Windows 数字版本：${String(version)}`);
  const numericVersion = `${numericParts[1]}.${numericParts[2]}.${numericParts[3]}.0`;
  const outputPath = join(outputDir, `AI-Pet-${version}-windows-x64.exe`);
  const args = [
    `--define=AppVersion=${version}`,
    `--define=AppVersionNumeric=${numericVersion}`,
    `--define=SourceDir=${sourceDir}`,
    `--define=OutputDir=${outputDir}`,
    scriptPath
  ];

  // 只移除本次构建的明确单文件目标，防止旧产物掩盖编译器未输出的问题。
  await rm(outputPath, { force: true });
  try {
    await compile(compilerPath, args, { cwd: desktopRoot, windowsHide: true });
  } catch (error) {
    throw new Error(`Inno Setup 编译失败：${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }

  await requirePath(outputPath, 'Inno Setup 编译完成但未生成预期安装包');
  return outputPath;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildWindowsInstaller()
    .then(outputPath => console.log(`Windows 离线安装包已生成：${outputPath}`))
    .catch(error => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
